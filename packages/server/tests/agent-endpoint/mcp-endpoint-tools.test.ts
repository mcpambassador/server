/**
 * ADR-020 test-plan #4 + #5 with a REAL downstream MCP (tests/fixtures/fake-mcp.mjs):
 * isolation between clients, per-user spawn over /mcp, call-time scope/allowlist, kill-switch
 * parity, /v1/tools parity, audit on client delete, and auth-failure reasons.
 * Kill-switch behaviour: hide, target validation, list, persistence.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AGENT_GRANTS_ROUTE, AGENT_MCP_ROUTE } from '@mcpambassador/contracts';
import { agent_grants } from '@mcpambassador/core';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  restartAgentTestServer,
  createUser,
  loginSession,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import {
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  stdioInvoke,
  rpc,
  MCP_HEADERS,
  mcpToolNames,
  isDenied,
  waitForAudit,
  type FakeMcp,
} from './fake-mcp-world.js';

// waitForAudit polls up to 15s (audit flushes on an interval)
vi.setConfig({ testTimeout: 30_000 });

let s: AgentTestServer;
let restoreEnv: () => void;
let logDir: string;
let alice: UserSession;
let aliceId: string;
let aliceCreds: { username: string; password: string };
let carol: UserSession;
let carolId: string;
let fkA: FakeMcp; // shared: echo, other
let fkB: FakeMcp; // shared: btool
let fkU: FakeMcp; // per_user: uecho
let cA: { clientId: string; key: string }; // alice: subscribed to fk-a only
let cB: { clientId: string; key: string }; // alice: subscribed to fk-b only
let cAB: { clientId: string; key: string }; // alice: subscribed to both
let cU: { clientId: string; key: string }; // carol: fk-u, never gets a stdio session
let stdioTok: string; // stdio session on cA
const fkALog = (): string => path.join(logDir, 'fk-a.log');

const sha8 = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 8);

async function oneShot(
  sess: UserSession,
  clientId: string,
  extra: Record<string, unknown> = {}
): Promise<{ grantId: string; token: string }> {
  const res = await sess.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: clientId, label: 'tools-test', scopes: ['mcp:*'], ...extra },
  });
  if (res.statusCode !== 201) throw new Error(`oneShot: ${res.statusCode} ${res.body}`);
  const d = JSON.parse(res.body).data;
  return { grantId: d.grant_id as string, token: d.access_token as string };
}

const kill = (target: string, enabled: boolean) =>
  s.admin.inject({
    method: 'POST',
    url: `/v1/admin/kill-switch/${target}`,
    headers: { 'X-Admin-Key': s.adminKey },
    payload: { enabled },
  });

const callText = (r: { json: any }): string => r.json?.result?.content?.[0]?.text ?? '';

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-mcp-logs-'));
  s = await startAgentTestServer(agentEndpointOpts());
  const au = await createUser(s, 'alice');
  aliceId = au.userId;
  aliceCreds = { username: au.username, password: au.password };
  alice = await loginSession(s, au);
  const cu = await createUser(s, 'carol');
  carolId = cu.userId;
  carol = await loginSession(s, cu);

  fkA = await createFakeMcp(s, {
    name: 'fk-a',
    tools: ['echo', 'other'],
    env: { FAKE_MCP_LOG: fkALog() },
  });
  fkB = await createFakeMcp(s, { name: 'fk-b', tools: ['btool'] });
  fkU = await createFakeMcp(s, { name: 'fk-u', isolation: 'per_user', tools: ['uecho'] });
  await grantUserAccess(s, aliceId, fkA.mcpId);
  await grantUserAccess(s, aliceId, fkB.mcpId);
  await grantUserAccess(s, carolId, fkU.mcpId);
  await applyCatalog(s);

  cA = await createClientWithKey(alice, 'c-a');
  cB = await createClientWithKey(alice, 'c-b');
  cAB = await createClientWithKey(alice, 'c-ab');
  await subscribe(alice, cA.clientId, fkA.mcpId);
  await subscribe(alice, cB.clientId, fkB.mcpId);
  await subscribe(alice, cAB.clientId, fkA.mcpId);
  await subscribe(alice, cAB.clientId, fkB.mcpId);
  cU = await createClientWithKey(carol, 'c-u');
  await subscribe(carol, cU.clientId, fkU.mcpId);
  stdioTok = await stdioSession(s, cA.key);
}, 120_000);

afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('client isolation over /mcp', () => {
  it("a token bound to client A never sees (or calls) client B's tools", async () => {
    const a = await oneShot(alice, cA.clientId);
    const names = await mcpToolNames(s, a.token);
    expect(names).toEqual(expect.arrayContaining(['echo', 'other']));
    expect(names).not.toContain('btool');
    expect(isDenied(await rpc(s, a.token, 'tools/call', { name: 'btool', arguments: {} }))).toBe(
      true
    );

    const b = await oneShot(alice, cB.clientId);
    const bNames = await mcpToolNames(s, b.token);
    expect(bNames).toContain('btool');
    expect(bNames).not.toContain('echo');
  });
});

describe('per-user MCP over /mcp with no stdio session', () => {
  it('spawns on demand, lists and calls the per-user tool', async () => {
    const before = await s.admin.inject({
      method: 'GET',
      url: '/v1/admin/sessions',
      headers: { 'X-Admin-Key': s.adminKey },
    });
    expect(before.body).not.toContain(carolId); // premise: no stdio session for carol

    const g = await oneShot(carol, cU.clientId);
    expect(await mcpToolNames(s, g.token)).toContain('uecho');
    const r = await rpc(s, g.token, 'tools/call', { name: 'uecho', arguments: { q: 'hi' } });
    expect(isDenied(r)).toBe(false);
    expect(JSON.parse(callText(r)).args).toEqual({ q: 'hi' });
  });

  it('the agent token never reaches the downstream process env', async () => {
    const g = await oneShot(carol, cU.clientId);
    const r = await rpc(s, g.token, 'tools/call', { name: '__env', arguments: {} });
    expect(isDenied(r)).toBe(false);
    const env = callText(r);
    expect(env).not.toContain(g.token);
    expect(env).not.toMatch(/amb_(at|rt)_/);
    expect(env).not.toMatch(/authorization/i);
  });
});

describe('scope and allowlist are enforced at call time on real tools', () => {
  it('scope mcp:fk-b: sees and calls only fk-b tools, fk-a tool is denied', async () => {
    const g = await oneShot(alice, cAB.clientId, { scopes: ['mcp:fk-b'] });
    const names = await mcpToolNames(s, g.token);
    expect(names).toContain('btool');
    expect(names).not.toContain('echo');
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} }))).toBe(
      true
    );
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'btool', arguments: {} }))).toBe(
      false
    );
  });

  it('allowlist [echo]: echo works, real tool "other" is denied and never reaches downstream', async () => {
    const g = await oneShot(alice, cA.clientId, { tool_allowlist: ['echo'] });
    expect(await mcpToolNames(s, g.token)).toEqual(['echo']);
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} }))).toBe(
      false
    );
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'other', arguments: {} }))).toBe(
      true
    );
    const log = fs.existsSync(fkALog()) ? fs.readFileSync(fkALog(), 'utf8') : '';
    const reachedOther = log
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .some(
        e => e.kind === 'req' && e.msg?.method === 'tools/call' && e.msg?.params?.name === 'other'
      );
    expect(reachedOther, 'denied tools/call must not be forwarded downstream').toBe(false);
  });
});

describe('kill switch parity with the stdio path', () => {
  it('mcp:fk-a → /mcp denial text equals the /v1/tools/invoke denial', async () => {
    const g = await oneShot(alice, cA.clientId);
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} }))).toBe(
      false
    );
    expect((await kill('mcp:fk-a', true)).statusCode).toBe(200);
    try {
      const viaStdio = await stdioInvoke(s, stdioTok, 'echo', {});
      expect(viaStdio.statusCode).toBeGreaterThanOrEqual(400);
      const stdioMsg = String(
        JSON.parse(viaStdio.body).message ?? JSON.parse(viaStdio.body).error ?? ''
      );
      expect(stdioMsg).toMatch(/kill/i);

      const viaMcp = await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} });
      expect(isDenied(viaMcp)).toBe(true);
      expect(viaMcp.status).not.toBe(401); // session still valid; only the tool is denied
      expect(viaMcp.body).toContain(stdioMsg);
    } finally {
      await kill('mcp:fk-a', false);
    }
  });
});

describe('parity with /v1/tools and /v1/tools/invoke', () => {
  it('tools/list matches /v1/tools for the same client', async () => {
    const stdio = JSON.parse((await stdioTools(s, stdioTok)).body).tools as {
      name: string;
      description?: string;
      input_schema?: unknown;
    }[];
    const g = await oneShot(alice, cA.clientId);
    const r = await rpc(s, g.token, 'tools/list', {});
    const mcp = r.json.result.tools as {
      name: string;
      description?: string;
      inputSchema?: unknown;
    }[];
    const by = <T extends { name: string }>(a: T[]) =>
      [...a].sort((x, y) => x.name.localeCompare(y.name));
    expect(by(mcp).map(t => t.name)).toEqual(by(stdio).map(t => t.name));
    for (const t of by(mcp)) {
      const st = stdio.find(x => x.name === t.name)!;
      expect(t.description).toBe(st.description);
      expect(t.inputSchema).toEqual(st.input_schema);
    }
  });

  it('tools/call result equals /v1/tools/invoke result', async () => {
    const g = await oneShot(alice, cA.clientId);
    const args = { x: 1, nested: { y: [1, 2] } };
    const r = await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: args });
    const st = await stdioInvoke(s, stdioTok, 'echo', args);
    expect(st.statusCode).toBe(200);
    const stdioText = (JSON.parse(st.body).result as { text: string }[])[0]!.text;
    expect(callText(r)).toBe(stdioText);
    expect(JSON.parse(callText(r)).args).toEqual(args);
  });
});

describe('kill switches: stdio path (/v1/tools/invoke) and /mcp', () => {
  const stdioKilled = async () => {
    const r = await stdioInvoke(s, stdioTok, 'echo', {});
    return { status: r.statusCode, body: r.body };
  };

  for (const target of ['mcp:fk-a', 'client:cA'] as const) {
    it(`${target} → /v1/tools/invoke is 403; lifting restores 200`, async () => {
      const key = target === 'client:cA' ? `client:${cA.clientId}` : target;
      expect((await stdioKilled()).status).toBe(200);
      expect((await kill(key, true)).statusCode).toBe(200);
      try {
        const r = await stdioKilled();
        expect(r.status).toBe(403);
        expect(r.body).toMatch(/kill/i);
      } finally {
        await kill(key, false);
      }
      expect((await stdioKilled()).status).toBe(200);
    });
  }

  it('client:<bound client> kill → /mcp tools/call is an isError with the stdio message; lifting restores', async () => {
    const g = await oneShot(alice, cA.clientId);
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} }))).toBe(
      false
    );
    expect((await kill(`client:${cA.clientId}`, true)).statusCode).toBe(200);
    try {
      const r = await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} });
      expect(r.status).toBe(200); // token still valid; the call is denied
      expect(r.json?.result?.isError).toBe(true);
      expect(callText(r)).toMatch(/kill/i);
    } finally {
      await kill(`client:${cA.clientId}`, false);
    }
    expect(isDenied(await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} }))).toBe(
      false
    );
  });

  // the fixture always lists a built-in __env tool; ignore it
  const visibleTools = async (tok: string): Promise<string[]> =>
    (await mcpToolNames(s, tok)).filter(n => n !== '__env');
  it('killed tools are hidden from /v1/tools and from /mcp tools/list', async () => {
    const g = await oneShot(alice, cA.clientId);
    expect((await visibleTools(g.token)).sort()).toEqual(['echo', 'other']);
    await kill('mcp:fk-a', true);
    try {
      expect(await visibleTools(g.token)).toEqual([]);
      const stdio = JSON.parse((await stdioTools(s, stdioTok)).body).tools as { name: string }[];
      expect(stdio.map(t => t.name)).not.toContain('echo');
    } finally {
      await kill('mcp:fk-a', false);
    }
    expect((await visibleTools(g.token)).sort()).toEqual(['echo', 'other']);
  });

  it.each(['fk-a', 'tool:echo', 'foo:bar', 'client:', ''])(
    'kill target %j that is not client:<id> or mcp:<name> → 400',
    async target => {
      const r = await kill(target || 'x', true);
      expect(r.statusCode).toBe(400);
    }
  );

  it('GET /v1/admin/kill-switches lists only the active switches', async () => {
    const list = () =>
      s.admin.inject({
        method: 'GET',
        url: '/v1/admin/kill-switches',
        headers: { 'X-Admin-Key': s.adminKey },
      });
    expect((await list()).statusCode).toBe(200);
    expect(JSON.stringify(JSON.parse((await list()).body))).not.toContain('mcp:fk-b');
    await kill('mcp:fk-b', true);
    try {
      expect((await list()).body).toContain('mcp:fk-b');
    } finally {
      await kill('mcp:fk-b', false);
    }
    expect((await list()).body).not.toContain('mcp:fk-b');
  });
});

describe('/mcp is POST-only (stateless)', () => {
  it.each(['GET', 'DELETE'] as const)('authenticated %s → 405 with Allow: POST', async method => {
    const g = await oneShot(alice, cA.clientId);
    const res = await s.api.inject({
      method,
      url: AGENT_MCP_ROUTE,
      headers: { accept: MCP_HEADERS.accept, authorization: `Bearer ${g.token}` },
    });
    expect(res.statusCode).toBe(405);
    expect(String(res.headers['allow'])).toMatch(/POST/);
  });
});

describe('audit', () => {
  it('deleting the bound client audits the revoked grant', async () => {
    const c = await createClientWithKey(alice, 'to-delete-audit');
    const g = await oneShot(alice, c.clientId);
    const del = await alice.request({
      method: 'DELETE',
      url: `/v1/users/me/clients/${c.clientId}`,
    });
    expect(del.statusCode).toBeLessThan(300);
    await waitForAudit(s, 'agent_grant_revoked', g.grantId);
  });

  describe('auth-failure reasons on real tokens', () => {
    const expectAudited = async (token: string, reason: string) => {
      await waitForAudit(s, 'agent_auth_failure', reason, sha8(token));
    };
    const expect401 = (r: { status: number; headers: Record<string, unknown> }) => {
      expect(r.status).toBe(401);
      expect(String(r.headers['www-authenticate'] ?? '')).toMatch(/Bearer/i);
    };

    it('revoked', async () => {
      const g = await oneShot(alice, cA.clientId);
      expect(isDenied(await rpc(s, g.token, 'tools/list', {}))).toBe(false);
      await alice.request({ method: 'DELETE', url: `${AGENT_GRANTS_ROUTE}/${g.grantId}` });
      expect401(await rpc(s, g.token, 'tools/list', {}));
      await expectAudited(g.token, 'revoked');
    });

    it('expired (Date only; ttl 60s then +2h)', async () => {
      const g = await oneShot(alice, cA.clientId, { ttl_seconds: 60 });
      vi.useFakeTimers({ toFake: ['Date'] });
      let r;
      try {
        vi.setSystemTime(new Date(Date.now() + 2 * 3600 * 1000));
        r = await rpc(s, g.token, 'tools/list', {});
      } finally {
        vi.useRealTimers();
      }
      expect401(r);
      await expectAudited(g.token, 'expired');
    });

    it('bad_audience (grant resource ≠ canonical /mcp)', async () => {
      const g = await oneShot(alice, cA.clientId);
      await (s.db as any)
        .update(agent_grants)
        .set({ resource: 'https://other.example/mcp' })
        .where(eq(agent_grants.grant_id, g.grantId));
      expect401(await rpc(s, g.token, 'tools/list', {}));
      await expectAudited(g.token, 'bad_audience');
    });

    it('insufficient_scope (tool outside token scope)', async () => {
      const g = await oneShot(alice, cAB.clientId, { scopes: ['mcp:fk-b'] });
      const r = await rpc(s, g.token, 'tools/call', { name: 'echo', arguments: {} });
      // MCP auth spec / ADR-020: scope shortfall is HTTP 403 + WWW-Authenticate, not a tool error
      expect(r.status).toBe(403);
      const www = String(r.headers['www-authenticate'] ?? '');
      expect(www).toContain('error="insufficient_scope"');
      expect(www).toContain('scope="mcp:fk-a"');
      expect(r.body).not.toContain(g.token);
      await expectAudited(g.token, 'insufficient_scope');
    });
  });
});

// Last on purpose: restarting replaces `s`, so earlier sessions/tokens stop being valid.
describe('persistence across restart', () => {
  it('kill switches survive a server restart (same DB, new instance)', async () => {
    expect((await kill('mcp:fk-b', true)).statusCode).toBe(200);
    const before = s;
    try {
      s = await restartAgentTestServer(before, agentEndpointOpts());
      const g = await oneShot(await loginSession(s, aliceCreds), cAB.clientId, {
        scopes: ['mcp:*'],
      });
      const r = await rpc(s, g.token, 'tools/call', { name: 'btool', arguments: {} });
      expect(isDenied(r)).toBe(true);
      expect(callText(r)).toMatch(/kill/i);
    } finally {
      await kill('mcp:fk-b', false);
    }
  });
});
