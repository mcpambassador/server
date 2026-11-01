/**
 * ADR-021 reviewer-block follow-ups (G1 revoke, G2 baseline hardening, Ajv ReDoS). Black-box.
 * Interface assumption (revoke): POST /v1/admin/tool-pins/:pinId/revoke {expected_hash, reason?}.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADMIN_TOOL_PINS_ROUTE,
  ADMIN_MCP_PIN_POLICY_ROUTE,
  AGENT_GRANTS_ROUTE,
  SYSTEM_MIGRATION_ACTOR,
  TOOL_PIN_BASELINE_SETTING_KEY,
} from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  restartAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
  type UserSession,
} from '../agent-endpoint/helpers.js';
import {
  allowFakeMcpCommand,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  stdioInvoke,
  rpc,
  mcpToolNames,
  isDenied,
  FAKE_MCP_PATH,
} from '../agent-endpoint/fake-mcp-world.js';

vi.setConfig({ testTimeout: 90_000 });

let s: AgentTestServer;
let restoreEnv: () => void;
let dir: string;
let alice: UserSession;
let aliceId: string;
const opts = agentEndpointOpts();
const adm = () => ({ 'X-Admin-Key': s.adminKey });
const J = (r: { body: string }): any => JSON.parse(r.body);

interface M {
  mcpId: string;
  name: string;
  log: string;
  descFile: string;
}

/** create -> (policy) -> validate -> publish a shared fake MCP with a controllable description. */
async function mkMcp(
  name: string,
  tools: string[],
  desc: string,
  policy: 'review' | 'auto',
  o: { isolation?: 'shared' | 'per_user'; schema?: unknown } = {}
): Promise<M> {
  const log = path.join(dir, `${name}.log`);
  const descFile = path.join(dir, `${name}.desc`);
  fs.writeFileSync(descFile, desc);
  const c = await s.admin.inject({
    method: 'POST',
    url: '/v1/admin/mcps',
    headers: adm(),
    payload: {
      name,
      display_name: name,
      transport_type: 'stdio',
      isolation_mode: o.isolation ?? 'shared',
      config: {
        command: ['node', FAKE_MCP_PATH],
        env: {
          FAKE_MCP_TOOLS: tools.join(','),
          FAKE_MCP_LOG: log,
          FAKE_MCP_DESC_FILE: descFile,
          ...(o.schema ? { FAKE_MCP_SCHEMA: JSON.stringify(o.schema) } : {}),
        },
      },
    },
  });
  if (c.statusCode !== 201) throw new Error(`create ${name}: ${c.statusCode} ${c.body}`);
  const mcpId = J(c).data.mcp_id as string;
  const pol = await s.admin.inject({
    method: 'PATCH',
    url: ADMIN_MCP_PIN_POLICY_ROUTE.replace(':mcpId', mcpId),
    headers: adm(),
    payload: { pin_policy: policy },
  });
  if (pol.statusCode !== 200) throw new Error(`pin-policy ${name}: ${pol.statusCode} ${pol.body}`);
  for (const step of ['validate', 'discover', 'publish']) {
    const r = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/${step}`,
      headers: adm(),
    });
    if (r.statusCode !== 200) throw new Error(`${name} ${step}: ${r.statusCode} ${r.body}`);
  }
  await applyCatalog(s);
  return { mcpId, name, log, descFile };
}

const pins = async (q: string): Promise<any[]> =>
  J(await s.admin.inject({ method: 'GET', url: `${ADMIN_TOOL_PINS_ROUTE}?${q}`, headers: adm() }))
    .data;
const pinOf = async (m: M, tool: string): Promise<any> =>
  (await pins(`mcp_id=${m.mcpId}`)).find(p => p.tool_name === tool);

async function approve(m: M, tool: string, applyTo?: 'all_users'): Promise<void> {
  const p = await pinOf(m, tool);
  expect(p?.status).toBe('pending_review');
  const r = await s.admin.inject({
    method: 'POST',
    url: `${ADMIN_TOOL_PINS_ROUTE}/${p.pin_id}/approve`,
    headers: adm(),
    payload: { expected_hash: p.pending_hash, ...(applyTo ? { apply_to: applyTo } : {}) },
  });
  expect(r.statusCode).toBe(200);
}

const callsTo = (m: M, tool: string): number =>
  fs.existsSync(m.log)
    ? fs
        .readFileSync(m.log, 'utf8')
        .split('\n')
        .filter(l => l.includes('"tools/call"') && l.includes(`"name":"${tool}"`)).length
    : 0;

async function agentFor(mcps: M[], scopes = ['mcp:*']) {
  const c = await createClientWithKey(alice, `c-${Math.random().toString(36).slice(2, 8)}`);
  for (const m of mcps) {
    await grantUserAccess(s, aliceId, m.mcpId);
    await subscribe(alice, c.clientId, m.mcpId);
  }
  const g = await alice.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: c.clientId, label: 'pins', scopes },
  });
  if (g.statusCode !== 201) throw new Error(`grant ${g.statusCode} ${g.body}`);
  return {
    key: c.key as string,
    stdio: await stdioSession(s, c.key),
    token: J(g).data.access_token as string,
  };
}
/** Pins are created lazily when a user's catalog is built: list tools once as an agent to observe. */
const observe = async (stdio: string): Promise<void> => {
  await stdioTools(s, stdio);
  await settle(300);
};
async function freshUser(name: string): Promise<void> {
  const u = await createUser(s, name);
  alice = await loginSession(s, u);
  aliceId = u.userId;
}
const v1Tools = async (tok: string): Promise<any[]> => J(await stdioTools(s, tok)).tools ?? [];
const settle = (ms = 600) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v121-'));
  s = await startAgentTestServer(opts);
  const u = await createUser(s, 'alice');
  aliceId = u.userId;
  alice = await loginSession(s, u);
});
afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pinRoute = (id: string, verb: string): string => `${ADMIN_TOOL_PINS_ROUTE}/${id}/${verb}`;
const post = (url: string, payload: unknown) =>
  s.admin.inject({ method: 'POST', url, headers: adm(), payload: payload as never });
/** Simulate the upgrade: no pins, baseline not done. Re-take the db handle after each restart. */
const rawDb = (): any => (s.db as any).session.client;
const resetBaseline = (): void => {
  rawDb().prepare('DELETE FROM tool_pins').run();
  rawDb().prepare('DELETE FROM server_settings WHERE key = ?').run(TOOL_PIN_BASELINE_SETTING_KEY);
};
const discover = async (m: M): Promise<void> => {
  const r = await s.admin.inject({
    method: 'POST',
    url: `/v1/admin/mcps/${m.mcpId}/discover`,
    headers: adm(),
  });
  expect(r.statusCode).toBe(200);
};
/** Dummy per-user credentials row (puts the user in the frozen baseline scope set). */
const addCred = (userId: string, mcpId: string): void => {
  const ts = new Date().toISOString();
  rawDb()
    .prepare(
      `INSERT INTO user_mcp_credentials (credential_id, user_id, mcp_id, encrypted_credentials, encryption_iv, credential_type, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(`cred-${Math.random().toString(36).slice(2)}`, userId, mcpId, 'x', 'x', 'static', ts, ts);
};
/** Per-user catalogs build lazily and can take >300 ms under load: re-observe until the pin exists. */
const observeUntilPin = async (stdio: string, m: M, tool: string): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await observe(stdio);
    if ((await pins(`mcp_id=${m.mcpId}`)).some(x => x.tool_name === tool)) return;
    await settle(500);
  }
};
const nm = () => String(Date.now() % 100000) + Math.floor(Math.random() * 1000);

describe('G1 revoke', () => {
  it('revoke hides an approved tool immediately; the same hash is not re-raised', async () => {
    const R = await mkMcp(`sha-rv-${nm()}`, ['rvk'], 'RVK-TEXT', 'review');
    const { stdio, token } = await agentFor([R]);
    await observe(stdio);
    await approve(R, 'rvk');
    expect((await stdioTools(s, stdio)).body).toContain('rvk');
    const p = await pinOf(R, 'rvk');
    const rv = await post(pinRoute(p.pin_id, 'revoke'), {
      expected_hash: p.approved_hash,
      reason: 'verifier',
    });
    expect(rv.statusCode, rv.body.slice(0, 300)).toBe(200);

    for (const body of [
      (await stdioTools(s, stdio)).body,
      (await rpc(s, token, 'tools/list', {})).body,
    ]) {
      expect(body).not.toContain('rvk');
      expect(body).not.toContain('RVK-TEXT');
    }
    const before = callsTo(R, 'rvk');
    expect(isDenied(await rpc(s, token, 'tools/call', { name: 'rvk', arguments: {} }))).toBe(true);
    await stdioInvoke(s, stdio, 'rvk');
    await settle(300);
    expect(callsTo(R, 'rvk')).toBe(before);

    // re-observation of the identical definition must not bring it back as pending or approved
    await applyCatalog(s);
    await observe(stdio);
    const after = await pinOf(R, 'rvk');
    expect(after.status, JSON.stringify(after)).toBe('rejected');
    expect(
      (await pins(`mcp_id=${R.mcpId}&status=pending_review`)).filter(x => x.tool_name === 'rvk')
    ).toHaveLength(0);
    expect((await stdioTools(s, stdio)).body).not.toContain('rvk');
  });

  it('a stale expected_hash cannot revoke', async () => {
    const R = await mkMcp(`sha-rs-${nm()}`, ['rvs'], 'RVS-TEXT', 'review');
    const { stdio } = await agentFor([R]);
    await observe(stdio);
    await approve(R, 'rvs');
    const p = await pinOf(R, 'rvs');
    const rv = await post(pinRoute(p.pin_id, 'revoke'), { expected_hash: 'f'.repeat(64) });
    expect(rv.statusCode).toBeGreaterThanOrEqual(400);
    expect((await pinOf(R, 'rvs')).status).toBe('approved');
  });

  it('revoking a NULL-scope (all users) approval hides the tool for per-user scopes', async () => {
    await freshUser(`ru${nm()}`); // alice's catalog was already built by earlier tests
    const U = await mkMcp(`sha-ru-${nm()}`, ['pu'], 'PU-TEXT', 'review', { isolation: 'per_user' });
    const { stdio } = await agentFor([U]);
    await observeUntilPin(stdio, U, 'pu');
    await approve(U, 'pu', 'all_users');
    expect((await stdioTools(s, stdio)).body).toContain('pu');
    const all = await pins(`mcp_id=${U.mcpId}`);
    const global = all.find(x => x.tool_name === 'pu' && x.scope_user_id === null);
    expect(global, JSON.stringify(all.map(x => [x.scope_user_id, x.status]))).toBeTruthy();
    const rv = await post(pinRoute(global.pin_id, 'revoke'), {
      expected_hash: global.approved_hash,
    });
    expect(rv.statusCode, rv.body.slice(0, 300)).toBe(200);
    await observe(stdio);
    expect((await stdioTools(s, stdio)).body).not.toContain('PU-TEXT');
    expect((await v1Tools(stdio)).map(t => t.name)).not.toContain('pu');
  });
});

describe('G2 baseline hardening', () => {
  it('a user first seen AFTER the baseline was armed is not baselined (per-user scope goes to review)', async () => {
    const U = await mkMcp(`sha-nu-${nm()}`, ['nuser'], 'NU-TEXT', 'review', {
      isolation: 'per_user',
    });
    resetBaseline();
    s = await restartAgentTestServer(s, opts);
    await freshUser('late');
    const { stdio } = await agentFor([U]);
    await observe(stdio);
    const mine = (await pins(`mcp_id=${U.mcpId}`)).filter(
      x => x.tool_name === 'nuser' && x.scope_user_id === aliceId
    );
    expect(mine, 'a scoped pin exists for the new user').toHaveLength(1);
    expect(mine[0].approved_by, JSON.stringify(mine[0])).not.toBe(SYSTEM_MIGRATION_ACTOR);
    expect(mine[0].status).toBe('pending_review');
    expect((await stdioTools(s, stdio)).body).not.toContain('nuser');
  });

  it('a snapshot changed after arming is not used (re-discovery cannot launder a drifted tool)', async () => {
    const D = await mkMcp(`sha-sn-${nm()}`, ['snap'], 'SNAP-V1', 'review');
    resetBaseline();
    fs.writeFileSync(D.descFile, 'SNAP-V2-EVIL'); // drifted since publish
    s = await restartAgentTestServer(s, opts);
    await freshUser('snap1');
    await observe((await agentFor([D])).stdio);
    const first = await pinOf(D, 'snap');
    expect(first.status, JSON.stringify(first)).toBe('pending_review');
    expect(first.flags.codes).toContain('baseline_mismatch');

    await discover(D); // admin re-discovery rewrites mcp_catalog.tool_catalog := live (V2)
    rawDb().prepare('DELETE FROM tool_pins').run(); // pin rows lost; setting stays => already armed
    s = await restartAgentTestServer(s, opts);
    await freshUser('snap2');
    const ag = await agentFor([D]);
    await observe(ag.stdio);
    const again = await pinOf(D, 'snap');
    expect(again.approved_by, JSON.stringify(again)).not.toBe(SYSTEM_MIGRATION_ACTOR);
    expect(again.status).toBe('pending_review');
    expect((await stdioTools(s, ag.stdio)).body).not.toContain('SNAP-V2-EVIL');
  });

  it('a rejected pin stays rejected through re-discovery and restart (drifted)', async () => {
    const D = await mkMcp(`sha-rj-${nm()}`, ['rejd'], 'REJ-V1', 'review');
    resetBaseline();
    fs.writeFileSync(D.descFile, 'REJ-V2-EVIL');
    s = await restartAgentTestServer(s, opts);
    await freshUser('rej1');
    await observe((await agentFor([D])).stdio);
    const p = await pinOf(D, 'rejd');
    expect(p.status).toBe('pending_review');
    const rj = await post(pinRoute(p.pin_id, 'reject'), { expected_hash: p.pending_hash });
    expect(rj.statusCode).toBe(200);
    const rejectedHash = p.pending_hash;

    await discover(D); // snapshot := the rejected definition
    s = await restartAgentTestServer(s, opts);
    await freshUser('rej2');
    const ag = await agentFor([D]);
    await observe(ag.stdio);
    const after = await pinOf(D, 'rejd');
    expect(after.status, JSON.stringify(after)).toBe('rejected');
    expect(after.approved_hash).not.toBe(rejectedHash);
    expect((await stdioTools(s, ag.stdio)).body).not.toContain('REJ-V2-EVIL');
  });
  /**
   * Isolates rule (c): the live definition equals the snapshot (no drift, no flags), so the baseline
   * WOULD approve it for bob's empty scope. The only thing that can keep it unapproved is that the same
   * hash was rejected in another scope (alice). The control run deletes that rejected row and must
   * baseline-approve, which proves the setup reaches the baseline at all.
   */
  const rejectedElsewhere = async (withRejected: boolean) => {
    const U = await mkMcp(`sha-rc-${nm()}`, ['rjx'], 'RJX-TEXT', 'review', {
      isolation: 'per_user',
    });
    await freshUser(`rcA${nm()}`);
    const aId = aliceId;
    await observe((await agentFor([U])).stdio);
    const ap = (await pins(`mcp_id=${U.mcpId}`)).find(
      x => x.tool_name === 'rjx' && x.scope_user_id === aId
    );
    expect(ap?.status, 'alice pin precondition').toBe('pending_review');
    const rejectedHash = ap.pending_hash;
    expect(
      (await post(pinRoute(ap.pin_id, 'reject'), { expected_hash: rejectedHash })).statusCode
    ).toBe(200);

    await freshUser(`rcB${nm()}`); // bob: exists before arming, no pin rows yet
    const bId = aliceId;
    const bob = await agentFor([U]);
    addCred(bId, U.mcpId); // bob is in the frozen baseline scope set (credentials row), with no pin rows
    if (!withRejected) rawDb().prepare('DELETE FROM tool_pins WHERE scope_user_id = ?').run(aId);
    rawDb().prepare('DELETE FROM server_settings WHERE key = ?').run(TOOL_PIN_BASELINE_SETTING_KEY);
    s = await restartAgentTestServer(s, opts);
    const bobStdio = await stdioSession(s, bob.key); // new session on the restarted server
    await observe(bobStdio);
    const bp = (await pins(`mcp_id=${U.mcpId}`)).find(
      x => x.tool_name === 'rjx' && x.scope_user_id === bId
    );
    return { bp, rejectedHash, listed: (await stdioTools(s, bobStdio)).body };
  };

  it('rule (c): an unflagged, undrifted hash rejected in another scope is not baseline-approved', async () => {
    const { bp, rejectedHash, listed } = await rejectedElsewhere(true);
    expect(bp, 'bob pin exists').toBeTruthy();
    expect(bp.approved_by, JSON.stringify(bp)).not.toBe(SYSTEM_MIGRATION_ACTOR);
    expect(bp.approved_hash).not.toBe(rejectedHash);
    expect(['pending_review', 'rejected']).toContain(bp.status);
    expect(listed).not.toContain('rjx');
  });

  it('rule (c) control: same setup without the rejected row IS baseline-approved', async () => {
    const { bp } = await rejectedElsewhere(false);
    expect(bp, 'bob pin exists').toBeTruthy();
    expect(
      bp.status,
      `control must baseline-approve or the rule (c) test is vacuous: ${JSON.stringify(bp)}`
    ).toBe('approved');
    expect(bp.approved_by).toBe(SYSTEM_MIGRATION_ACTOR);
  });
  it('scope freezing: a user created AFTER arming (clean, unrejected hash) is not baseline-approved', async () => {
    const U = await mkMcp(`sha-fz-${nm()}`, ['frz'], 'FRZ-TEXT', 'review', {
      isolation: 'per_user',
    });
    rawDb().prepare('DELETE FROM server_settings WHERE key = ?').run(TOOL_PIN_BASELINE_SETTING_KEY);
    s = await restartAgentTestServer(s, opts); // arms
    await freshUser(`fzC${nm()}`); // carol: created after arming
    const carolId = aliceId;
    const carol = await agentFor([U]);
    addCred(carolId, U.mcpId); // even with a credentials row, she is outside the frozen set
    await observe(carol.stdio);
    const cp = (await pins(`mcp_id=${U.mcpId}`)).find(
      x => x.tool_name === 'frz' && x.scope_user_id === carolId
    );
    expect(cp, 'carol pin exists').toBeTruthy();
    expect(cp.approved_by, JSON.stringify(cp)).not.toBe(SYSTEM_MIGRATION_ACTOR);
    expect(cp.status).toBe('pending_review');
    expect((await stdioTools(s, carol.stdio)).body).not.toContain('frz');
  });
});

describe('Ajv ReDoS', () => {
  it('a (a+)+$ pattern with a crafted argument returns within 50 ms', async () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string', pattern: '(a+)+$' } },
      additionalProperties: true,
    };
    const R = await mkMcp(`sha-re-${nm()}`, ['redos'], 'RE-TEXT', 'review', { schema });
    const { stdio } = await agentFor([R]);
    await observe(stdio);
    await approve(R, 'redos');
    // warm up: schema compile + a matching argument
    expect((await stdioInvoke(s, stdio, 'redos', { x: 'aaa' })).statusCode).toBe(200);
    const evil = 'a'.repeat(26) + '!'; // ~2^26 backtracking steps without a linear-time engine
    const t0 = performance.now();
    const r = await stdioInvoke(s, stdio, 'redos', { x: evil });
    const ms = performance.now() - t0;
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(50);
    expect(JSON.parse(r.body).result ?? null).toBeNull(); // rejected as invalid, not forwarded
  });
});

describe('R1 revoke on any pin with approved_hash', () => {
  const drift = async (m: M, text: string, stdio: string): Promise<void> => {
    fs.writeFileSync(m.descFile, text);
    const ap = await s.admin.inject({
      method: 'POST',
      url: '/v1/admin/catalog/apply',
      headers: adm(),
    });
    expect([200, 409]).toContain(ap.statusCode);
    await settle(1500);
    await observe(stdio);
  };
  const revoke = (p: any, hash: string) =>
    post(pinRoute(p.pin_id, 'revoke'), { expected_hash: hash });

  it('revoking a pending_review pin hides the tool, keeps the pending item; approving it later serves the new version', async () => {
    const R = await mkMcp(`sha-r1p-${nm()}`, ['rvp'], 'RVP-V1', 'review');
    const { stdio } = await agentFor([R]);
    await observe(stdio);
    await approve(R, 'rvp');
    await drift(R, 'RVP-V2', stdio);
    const p = await pinOf(R, 'rvp');
    expect(p.status, JSON.stringify(p)).toBe('pending_review');
    expect(p.approved_hash).toBeTruthy();
    const h2 = p.pending_hash;
    const rv = await revoke(p, p.approved_hash);
    expect(rv.statusCode, rv.body.slice(0, 300)).toBe(200);
    const body = (await stdioTools(s, stdio)).body;
    expect(body).not.toContain('rvp');
    const after = await pinOf(R, 'rvp');
    expect(after.status).toBe('pending_review');
    expect(after.pending_hash).toBe(h2);
    await approve(R, 'rvp');
    const served = (await stdioTools(s, stdio)).body;
    expect(served).toContain('RVP-V2');
    expect(served).not.toContain('RVP-V1');
  });

  it('revoking a rejected-status pin that still has approved_hash hides the tool and keeps rejected_hash', async () => {
    const R = await mkMcp(`sha-r1r-${nm()}`, ['rvr'], 'RVR-V1', 'review');
    const { stdio } = await agentFor([R]);
    await observe(stdio);
    await approve(R, 'rvr');
    await drift(R, 'RVR-V2', stdio);
    const p = await pinOf(R, 'rvr');
    expect(
      (await post(pinRoute(p.pin_id, 'reject'), { expected_hash: p.pending_hash })).statusCode
    ).toBe(200);
    const rej = await pinOf(R, 'rvr');
    expect(rej.status).toBe('rejected');
    expect(rej.approved_hash, 'rejected pin keeps approved_hash').toBeTruthy();
    const col = (id: string): any =>
      rawDb()
        .prepare('SELECT rejected_hash, revoked_hashes FROM tool_pins WHERE pin_id = ?')
        .get(id);
    const rejBefore = col(rej.pin_id).rejected_hash; // not exposed in ToolPinDetail: read the column
    expect(rejBefore, 'rejected_hash recorded by reject').toBeTruthy();
    const rv = await revoke(rej, rej.approved_hash);
    expect(rv.statusCode, rv.body.slice(0, 300)).toBe(200);
    expect((await stdioTools(s, stdio)).body).not.toContain('rvr');
    const after = await pinOf(R, 'rvr');
    const row = col(rej.pin_id);
    expect(row.rejected_hash, 'existing rejected_hash not lost').toBe(rejBefore);
    expect(JSON.parse(row.revoked_hashes ?? '[]'), 'revoked hash recorded').toContain(
      rej.approved_hash
    );
    expect(after.status).toBe('rejected');
  });

  it('a revoked hash is never re-raised or baseline-approved, even when the tool changes away and back', async () => {
    const R = await mkMcp(`sha-r1b-${nm()}`, ['rvb'], 'RVB-V1', 'review');
    const { stdio } = await agentFor([R]);
    await observe(stdio);
    await approve(R, 'rvb');
    const p = await pinOf(R, 'rvb');
    const h1 = p.approved_hash;
    expect((await revoke(p, h1)).statusCode).toBe(200);
    await drift(R, 'RVB-V2', stdio);
    await drift(R, 'RVB-V1', stdio); // back to the revoked definition
    const back = await pinOf(R, 'rvb');
    expect(back.pending_hash, JSON.stringify(back)).not.toBe(h1);
    expect(
      back.status === 'approved' && back.approved_hash === h1,
      'revoked hash must not be re-approved'
    ).toBe(false);
    expect((await stdioTools(s, stdio)).body).not.toContain('RVB-V1');

    rawDb().prepare('DELETE FROM server_settings WHERE key = ?').run(TOOL_PIN_BASELINE_SETTING_KEY);
    s = await restartAgentTestServer(s, opts); // re-arm: must not baseline-approve the revoked hash
    await freshUser(`rvbX${nm()}`);
    const ag = await agentFor([R]);
    await observe(ag.stdio);
    const end = await pinOf(R, 'rvb');
    expect(end.approved_by, JSON.stringify(end)).not.toBe(SYSTEM_MIGRATION_ACTOR);
    expect((await stdioTools(s, ag.stdio)).body).not.toContain('RVB-V1');
  });
});

describe('Ajv backreference (no native RegExp fallback)', () => {
  it('a backreference pattern with a catastrophic input returns fast and is flagged pattern_unsupported', async () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string', pattern: '^(a+)+\\1$' } },
      additionalProperties: true,
    };
    await freshUser(`bk${nm()}`); // earlier tests restarted the server
    const R = await mkMcp(`sha-bk-${nm()}`, ['bkr'], 'BK-TEXT', 'review', { schema });
    const { stdio } = await agentFor([R]);
    await observe(stdio);
    const p = await pinOf(R, 'bkr');
    expect(p.flags?.codes ?? [], JSON.stringify(p)).toContain('pattern_unsupported');
    await approve(R, 'bkr');
    await stdioInvoke(s, stdio, 'bkr', { x: 'aaa' }); // warm up
    const t0 = performance.now();
    await stdioInvoke(s, stdio, 'bkr', { x: 'a'.repeat(26) + '!' });
    const ms = performance.now() - t0;
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(50);
  });
});
