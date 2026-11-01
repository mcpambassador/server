/**
 * TD-034 black-box: the real approve -> revoke -> re-discover -> approve flow over the admin API,
 * with the served tool list/invoke and the audit trail observed from outside.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ADMIN_TOOL_PINS_ROUTE } from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
} from '../agent-endpoint/helpers.js';
import {
  FAKE_MCP_PATH,
  allowFakeMcpCommand,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  stdioInvoke,
  auditLines,
} from '../agent-endpoint/fake-mcp-world.js';

vi.setConfig({ testTimeout: 60_000 });

let s: AgentTestServer;
let restoreEnv: () => void;
let dir: string;
let mcpId: string;
let stdioTok: string;
let descFile: string;
let puMcpId: string;
let aliceId: string;
let bobId: string;
let aliceTok: string;
let bobTok: string;

const adm = () => ({ 'X-Admin-Key': s.adminKey });
const J = (r: { body: string }): any => JSON.parse(r.body);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const V1 = 'FLOWV1 find things.';
const V2 = 'FLOWV2 find other things.';

const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  s.admin.inject({ method, url, headers: adm(), payload: payload as never });

const pinOf = async (tool: string): Promise<any> =>
  J(await admin('GET', `${ADMIN_TOOL_PINS_ROUTE}?mcp_id=${mcpId}`)).data.find(
    (p: any) => p.tool_name === tool
  );
const pinOfScope = async (userId: string, tool: string): Promise<any> =>
  J(await admin('GET', `${ADMIN_TOOL_PINS_ROUTE}?mcp_id=${puMcpId}`)).data.find(
    (p: any) => p.tool_name === tool && p.scope_user_id === userId
  );
const servedAs = async (tok: string, tool: string): Promise<boolean> => {
  const names = J(await stdioTools(s, tok)).tools.map((t: { name: string }) => t.name);
  const invoked = Array.isArray(J(await stdioInvoke(s, tok, tool)).result);
  expect(names.includes(tool), `listed(${tool}) must agree with invoke`).toBe(invoked);
  return invoked;
};
const detail = async (pinId: string): Promise<any> =>
  J(await admin('GET', `${ADMIN_TOOL_PINS_ROUTE}/${pinId}`)).data;
const approve = (pinId: string, hash: string, force?: boolean) =>
  admin('POST', `${ADMIN_TOOL_PINS_ROUTE}/${pinId}/approve`, {
    expected_hash: hash,
    ...(force === undefined ? {} : { force }),
  });
const revoke = (pinId: string, hash: string) =>
  admin('POST', `${ADMIN_TOOL_PINS_ROUTE}/${pinId}/revoke`, {
    expected_hash: hash,
    reason: 'td034-flow',
  });
const rediscover = async (desc: string) => {
  fs.writeFileSync(descFile, desc);
  expect((await admin('POST', `/v1/admin/mcps/${mcpId}/discover`)).statusCode).toBe(200);
  await sleep(500);
  await stdioTools(s, stdioTok); // an agent listing tools is what surfaces the live definition
};
const served = async (tool: string): Promise<boolean> => {
  const names = J(await stdioTools(s, stdioTok)).tools.map((t: { name: string }) => t.name);
  const inv = J(await stdioInvoke(s, stdioTok, tool));
  const listed = names.includes(tool);
  const invoked = Array.isArray(inv.result);
  expect(listed, `listed(${tool}) must agree with invoke`).toBe(invoked);
  return invoked;
};
const auditSince = async (before: number, needle: string): Promise<string[]> => {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const hits = auditLines(s)
      .slice(before)
      .filter(l => l.includes(needle));
    if (hits.length || Date.now() > deadline) return hits;
    await sleep(250);
  }
};

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td34-'));
  descFile = path.join(dir, 'm.desc');
  fs.writeFileSync(descFile, V1);
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'alice');
  const alice = await loginSession(s, u);
  const create = async (name: string, tools: string, isolation: 'shared' | 'per_user') => {
    const c = await admin('POST', '/v1/admin/mcps', {
      name,
      display_name: name,
      transport_type: 'stdio',
      isolation_mode: isolation,
      config: {
        command: ['node', FAKE_MCP_PATH],
        env: { FAKE_MCP_TOOLS: tools, FAKE_MCP_DESC_FILE: descFile },
      },
    });
    if (c.statusCode !== 201) throw new Error(`create: ${c.statusCode} ${c.body}`);
    const id = J(c).data.mcp_id as string;
    for (const [m, url, p] of [
      ['PATCH', `/v1/admin/mcps/${id}/pin-policy`, { pin_policy: 'review' }],
      ['POST', `/v1/admin/mcps/${id}/validate`],
      ['POST', `/v1/admin/mcps/${id}/discover`],
      ['POST', `/v1/admin/mcps/${id}/publish`],
    ] as const) {
      const r = await admin(m, url, p);
      if (r.statusCode !== 200) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
    }
    return id;
  };
  mcpId = await create('td34', 'flowt,plain', 'shared');
  puMcpId = await create('td34pu', 'xtool', 'per_user');
  const bu = await createUser(s, 'bob');
  const bob = await loginSession(s, bu);
  aliceId = u.userId;
  bobId = bu.userId;
  for (const id of [mcpId, puMcpId]) {
    await grantUserAccess(s, aliceId, id);
    await grantUserAccess(s, bobId, id);
  }
  await applyCatalog(s);
  const ca = await createClientWithKey(alice, 'td34-a');
  const cb = await createClientWithKey(bob, 'td34-b');
  for (const id of [mcpId, puMcpId]) {
    await subscribe(alice, ca.clientId, id);
    await subscribe(bob, cb.clientId, id);
  }
  aliceTok = await stdioSession(s, ca.key);
  bobTok = await stdioSession(s, cb.key);
  stdioTok = aliceTok;
  await stdioTools(s, aliceTok);
  await stdioTools(s, bobTok);
}, 120_000);

afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TD-034 revoked-hash approval flow', () => {
  it('an ordinary pending pin needs no force and carries no previously_revoked flag', async () => {
    const p = await pinOf('plain');
    expect(p.status).toBe('pending_review');
    expect(p.previously_revoked).not.toBe(true);
    expect((await detail(p.pin_id)).previously_revoked).not.toBe(true);
    const before = auditLines(s).length;
    expect((await approve(p.pin_id, p.pending_hash)).statusCode).toBe(200);
    expect(await served('plain')).toBe(true);
    const lines = await auditSince(before, 'approve');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('forced_previously_revoked');
  });

  it('single scope: revoked V1 coming back is not re-raised; a new V2 needs no force', async () => {
    const p = await pinOf('flowt');
    expect((await approve(p.pin_id, p.pending_hash)).statusCode).toBe(200);
    expect(await served('flowt')).toBe(true);
    const v1Hash = (await pinOf('flowt')).approved_hash as string;
    expect((await revoke(p.pin_id, v1Hash)).statusCode).toBe(200);
    expect(await served('flowt')).toBe(false);
    await rediscover(V1);
    const back = await pinOf('flowt');
    expect(back.status).not.toBe('approved');
    expect(back.pending_hash ?? null).toBeNull();
    expect(await served('flowt')).toBe(false);
    await rediscover(V2);
    let nv = await pinOf('flowt');
    for (let i = 0; i < 20 && nv.status !== 'pending_review'; i++) {
      await sleep(500);
      await stdioTools(s, stdioTok);
      nv = await pinOf('flowt');
    }
    console.log(
      'DBG',
      JSON.stringify({ ...nv, pending_definition: undefined, approved_definition: undefined })
    );
    expect(nv.status).toBe('pending_review');
    expect(nv.pending_hash).not.toBe(v1Hash);
    expect(nv.previously_revoked).not.toBe(true);
    const before = auditLines(s).length;
    expect((await approve(p.pin_id, nv.pending_hash)).statusCode).toBe(200);
    expect(await served('flowt')).toBe(true);
    await sleep(2500);
    expect(auditLines(s).slice(before).join('\n')).not.toContain('forced_previously_revoked');
  });

  it("another scope's pending V1 is flagged after V1 is revoked: 409 without force, 200 with force + audit", async () => {
    // bob's per-user pin holds V1 pending; alice approves and revokes V1 in her scope.
    const bobPin = await pinOfScope(bobId, 'xtool');
    expect(bobPin.status).toBe('pending_review');
    expect(bobPin.previously_revoked).not.toBe(true);
    const ap = await pinOfScope(aliceId, 'xtool');
    expect(ap.pending_hash).toBe(bobPin.pending_hash); // same definition
    expect((await approve(ap.pin_id, ap.pending_hash)).statusCode).toBe(200);
    expect(await servedAs(aliceTok, 'xtool')).toBe(true);
    const h = (await pinOfScope(aliceId, 'xtool')).approved_hash as string;
    expect((await revoke(ap.pin_id, h)).statusCode).toBe(200);
    expect(await servedAs(aliceTok, 'xtool')).toBe(false);

    const flagged = await pinOfScope(bobId, 'xtool');
    expect(flagged.status).toBe('pending_review');
    expect((await detail(bobPin.pin_id)).previously_revoked).toBe(true);

    const nf = await approve(bobPin.pin_id, flagged.pending_hash);
    expect(nf.statusCode).toBe(409);
    expect(nf.body).toContain('previously_revoked');
    expect((await approve(bobPin.pin_id, flagged.pending_hash, false)).statusCode).toBe(409);
    expect(await servedAs(bobTok, 'xtool')).toBe(false);
    expect((await pinOfScope(bobId, 'xtool')).status).toBe('pending_review');

    const before = auditLines(s).length;
    expect((await approve(bobPin.pin_id, flagged.pending_hash, true)).statusCode).toBe(200);
    expect(await servedAs(bobTok, 'xtool')).toBe(true);
    expect((await pinOfScope(bobId, 'xtool')).status).toBe('approved');
    const lines = await auditSince(before, 'forced_previously_revoked');
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain('FLOWV1');
  });
});
