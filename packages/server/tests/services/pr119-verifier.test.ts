/**
 * PR #119 verifier tests (real stdio fake MCP, real servers):
 *  - publish/archive hot-apply: tools appear/disappear on /v1/tools and /mcp with NO manual apply
 *  - admin-created user is in all-users and can subscribe immediately
 *  - removing the last group is 409
 *  - publish (9443) racing apply (8443) never double-spawns
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
  type UserSession,
} from '../agent-endpoint/helpers.js';
import {
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  rpc,
  mcpToolNames,
  FAKE_MCP_PATH,
} from '../agent-endpoint/fake-mcp-world.js';
import { AGENT_GRANTS_ROUTE } from '@mcpambassador/contracts';

vi.setConfig({ testTimeout: 60_000 });

let s: AgentTestServer;
let restoreEnv: () => void;
let logDir: string;
let alice: UserSession;
let aliceId: string;

const adm = () => ({ 'X-Admin-Key': s.adminKey });
const names = async (tok: string) =>
  (JSON.parse((await stdioTools(s, tok)).body).tools ?? []).map((t: any) => t.name).sort();

async function oneShot(sess: UserSession, clientId: string): Promise<string> {
  const res = await sess.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: clientId, label: 'v119', scopes: ['mcp:*'] },
  });
  if (res.statusCode !== 201) throw new Error(`oneShot ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).data.access_token as string;
}

const starts = (log: string): number =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(l => l.includes('"kind":"start"')).length
    : 0;

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v119-'));
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'alice');
  aliceId = u.userId;
  alice = await loginSession(s, u);
});
afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('publish/archive hot-apply (no manual apply)', () => {
  it('publish makes tools appear on /v1/tools and /mcp; archive removes them', async () => {
    const fk = await createFakeMcp(s, { name: 'hot-a', tools: ['hot_echo'] }); // create+validate+publish only
    await grantUserAccess(s, aliceId, fk.mcpId);
    const c = await createClientWithKey(alice, 'hot-client');
    await subscribe(alice, c.clientId, fk.mcpId);
    const stdio = await stdioSession(s, c.key);
    const tok = await oneShot(alice, c.clientId);

    expect(await names(stdio)).toContain('hot_echo');
    expect(await mcpToolNames(s, tok)).toContain('hot_echo');
    const st = await s.admin.inject({
      method: 'GET',
      url: '/v1/admin/catalog/status',
      headers: adm(),
    });
    expect(JSON.parse(st.body).data.has_changes).toBe(false);

    const arch = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${fk.mcpId}/archive`,
      headers: adm(),
    });
    expect(arch.statusCode).toBe(200);
    expect(await names(stdio)).not.toContain('hot_echo');
    expect(await mcpToolNames(s, tok)).not.toContain('hot_echo');
  });
});

describe('admin-created users', () => {
  it('are in all-users, can subscribe immediately, and cannot be removed from their last group (409)', async () => {
    const fk = await createFakeMcp(s, { name: 'for-all', tools: ['all_echo'] });
    const allUsers = await s.db.query.groups.findFirst({
      where: (g: any, { eq }: any) => eq(g.name, 'all-users'),
    });
    expect(allUsers).toBeTruthy();
    const gid = allUsers!.group_id;
    const grant = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/groups/${gid}/mcps`,
      headers: adm(),
      payload: { mcp_id: fk.mcpId },
    });
    expect(grant.statusCode).toBe(201);

    const bob = await createUser(s, 'bob'); // POST /v1/admin/users, no manual group step
    const bs = await loginSession(s, bob);
    const c = await createClientWithKey(bs, 'bob-c');
    const sub = await bs.request({
      method: 'POST',
      url: `/v1/users/me/clients/${c.clientId}/subscriptions`,
      payload: { mcp_id: fk.mcpId },
    });
    expect(sub.statusCode).toBe(201);

    const del = await s.admin.inject({
      method: 'DELETE',
      url: `/v1/admin/groups/${gid}/members/${bob.userId}`,
      headers: adm(),
    });
    expect(del.statusCode).toBe(409);
    // still subscribed/member after the refused removal
    const again = await bs.request({
      method: 'GET',
      url: `/v1/users/me/clients/${c.clientId}/subscriptions`,
    });
    expect(again.statusCode).toBe(200);
  });
});

describe('concurrent reload', () => {
  it('publish on 9443 racing apply on 8443 never double-spawns', async () => {
    const log = path.join(logDir, 'race.log');
    const create = await s.admin.inject({
      method: 'POST',
      url: '/v1/admin/mcps',
      headers: adm(),
      payload: {
        name: 'race-a',
        display_name: 'race-a',
        transport_type: 'stdio',
        isolation_mode: 'shared',
        config: {
          command: ['node', FAKE_MCP_PATH],
          env: { FAKE_MCP_TOOLS: 'race_echo', FAKE_MCP_LOG: log },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const id = JSON.parse(create.body).data.mcp_id as string;
    const val = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${id}/validate`,
      headers: adm(),
    });
    expect(val.statusCode).toBe(200);
    const base = starts(log); // validation may itself spawn the fake

    const [pub, apply] = await Promise.all([
      s.admin.inject({ method: 'POST', url: `/v1/admin/mcps/${id}/publish`, headers: adm() }),
      s.api.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: adm() }),
    ]);
    expect(pub.statusCode).toBe(200); // hot-apply is best effort and never fails the publish
    expect([200, 409]).toContain(apply.statusCode);

    // converge: one more apply (409 only if something is still running)
    for (let i = 0; i < 20; i++) {
      const r = await s.admin.inject({
        method: 'POST',
        url: '/v1/admin/catalog/apply',
        headers: adm(),
      });
      if (r.statusCode === 200) break;
      expect(r.statusCode).toBe(409);
      await new Promise(r2 => setTimeout(r2, 250));
    }
    await new Promise(r => setTimeout(r, 500));
    expect(starts(log) - base).toBe(1);

    const st = await s.admin.inject({
      method: 'GET',
      url: '/v1/admin/catalog/status',
      headers: adm(),
    });
    expect(JSON.parse(st.body).data.has_changes).toBe(false);
  });

  it('two simultaneous applies: at most one runs, the other is 409 or a no-op 200', async () => {
    const rs = await Promise.all([
      s.admin.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: adm() }),
      s.api.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: adm() }),
      s.admin.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: adm() }),
    ]);
    for (const r of rs) expect([200, 409]).toContain(r.statusCode);
    expect(rs.some(r => r.statusCode === 200)).toBe(true);
  });
});
