/**
 * ADR-021 verifier tests for the pin service (PR #121 / 3a). GATED: they describe behaviour that
 * lands after the contract commit, so they run as `it.fails` until PINS_IMPL=1 (then as normal tests).
 * Black-box over the real servers with real fake-mcp processes.
 *
 * Interface assumptions (from contracts/src/tool-pins.ts and ADR-021):
 *  - admin routes GET /v1/admin/tool-pins?mcp_id=&status=, POST .../:id/approve|confirm-baseline,
 *    PATCH /v1/admin/mcps/:id/pin-policy {pin_policy}
 *  - pin_policy 'review' => first-seen tools start pending_review and are hidden
 *  - baseline: server_settings key tool_pin_baseline_done, pins approved_by 'system:migration'
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
const itPins: typeof it = (process.env['PINS_IMPL'] === '1' ? it : it.fails) as typeof it;

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
  policy: 'review' | 'auto' = 'review'
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
      isolation_mode: 'shared',
      config: {
        command: ['node', FAKE_MCP_PATH],
        env: { FAKE_MCP_TOOLS: tools.join(','), FAKE_MCP_LOG: log, FAKE_MCP_DESC_FILE: descFile },
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
  for (const step of ['validate', 'publish']) {
    const r = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/${step}`,
      headers: adm(),
    });
    if (r.statusCode !== 200) throw new Error(`${name} ${step}: ${r.statusCode} ${r.body}`);
  }
  return { mcpId, name, log, descFile };
}

const pins = async (q: string): Promise<any[]> =>
  J(await s.admin.inject({ method: 'GET', url: `${ADMIN_TOOL_PINS_ROUTE}?${q}`, headers: adm() }))
    .data;
const pinOf = async (m: M, tool: string): Promise<any> =>
  (await pins(`mcp_id=${m.mcpId}`)).find(p => p.tool_name === tool);

async function approve(m: M, tool: string): Promise<void> {
  const p = await pinOf(m, tool);
  expect(p?.status).toBe('pending_review');
  const r = await s.admin.inject({
    method: 'POST',
    url: `${ADMIN_TOOL_PINS_ROUTE}/${p.pin_id}/approve`,
    headers: adm(),
    payload: { expected_hash: p.pending_hash },
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
  return { stdio: await stdioSession(s, c.key), token: J(g).data.access_token as string };
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

describe('D2 name shadowing', () => {
  for (const [approved, pendingName] of [
    ['A', 'B'],
    ['B', 'A'],
  ] as const) {
    itPins(
      `${approved}.foo approved, ${pendingName}.foo pending: foo routes to ${approved} and only its text is served`,
      async () => {
        const tag = `${approved.toLowerCase()}${Date.now() % 100000}`;
        const A = await mkMcp(`sha-a-${tag}`, ['foo'], 'TEXT-FROM-A');
        const B = await mkMcp(`sha-b-${tag}`, ['foo'], 'TEXT-FROM-B');
        const [ok, no] = approved === 'A' ? [A, B] : [B, A];
        await approve(ok, 'foo');
        expect((await pinOf(no, 'foo')).status).toBe('pending_review');
        const { stdio, token } = await agentFor([A, B]);
        await settle();

        const okText = `TEXT-FROM-${approved}`;
        const noText = `TEXT-FROM-${pendingName}`;
        const rest = await stdioTools(s, stdio);
        expect(rest.body).toContain(okText);
        expect(rest.body).not.toContain(noText);
        expect((await v1Tools(stdio)).filter(t => t.name === 'foo')).toHaveLength(1);

        const list = await rpc(s, token, 'tools/list', {});
        expect(list.body).toContain(okText);
        expect(list.body).not.toContain(noText);
        expect((list.json.result.tools as any[]).filter(t => t.name === 'foo')).toHaveLength(1);

        const beforeOk = callsTo(ok, 'foo');
        const beforeNo = callsTo(no, 'foo');
        expect(isDenied(await rpc(s, token, 'tools/call', { name: 'foo', arguments: {} }))).toBe(
          false
        );
        expect((await stdioInvoke(s, stdio, 'foo')).statusCode).toBe(200);
        await settle(300);
        expect(callsTo(ok, 'foo') - beforeOk).toBe(2);
        expect(callsTo(no, 'foo') - beforeNo).toBe(0);
      }
    );
  }
});

describe('D3 hidden on every path', () => {
  itPins(
    'a pending-only tool is invisible and uncallable on /v1/tools, /mcp, invoke, and the scope pre-check',
    async () => {
      const tag = String(Date.now() % 100000);
      const P = await mkMcp(`sha-p-${tag}`, ['sneaky'], 'PENDING-TEXT');
      const other = await mkMcp(`sha-o-${tag}`, ['plain'], 'other');
      await approve(other, 'plain');
      expect((await pinOf(P, 'sneaky')).status).toBe('pending_review');
      const full = await agentFor([P, other]);
      const narrow = await agentFor([P, other], [`mcp:${other.name}`]); // scope excludes P
      await settle();

      // listings
      for (const body of [
        (await stdioTools(s, full.stdio)).body,
        (await rpc(s, full.token, 'tools/list', {})).body,
      ]) {
        expect(body).not.toContain('sneaky');
        expect(body).not.toContain('PENDING-TEXT');
        expect(body).toContain('plain');
      }

      // invoke by name: fails as unknown at routing, nothing reaches the downstream
      const inv = await stdioInvoke(s, full.stdio, 'sneaky');
      expect(inv.statusCode).toBeGreaterThanOrEqual(400);
      const mcpCall = await rpc(s, full.token, 'tools/call', { name: 'sneaky', arguments: {} });
      expect(isDenied(mcpCall)).toBe(true);
      await settle(300);
      expect(callsTo(P, 'sneaky')).toBe(0);

      // pre-check: a pending tool and a nonexistent tool must look the same to an out-of-scope token
      const norm = (r: { status: number; json: any }, name: string): string =>
        JSON.stringify([
          r.status,
          r.json?.error?.code,
          String(r.json?.error?.message ?? '')
            .split(name)
            .join('<T>'),
          r.json?.result?.isError,
        ]);
      const pend = await rpc(s, narrow.token, 'tools/call', { name: 'sneaky', arguments: {} });
      const ghost = await rpc(s, narrow.token, 'tools/call', {
        name: 'no_such_tool_zz',
        arguments: {},
      });
      expect(norm(pend, 'sneaky')).toBe(norm(ghost, 'no_such_tool_zz'));
      expect(JSON.stringify(pend.json)).not.toMatch(/scope|pending|pin/i);
    }
  );

  itPins(
    'a changed tool keeps serving its approved text while the new text is pending, never the live one',
    async () => {
      const tag = String(Date.now() % 100000);
      const M1 = await mkMcp(`sha-c-${tag}`, ['chg'], 'GOOD-TEXT');
      await approve(M1, 'chg');
      const { stdio, token } = await agentFor([M1]);
      expect((await stdioTools(s, stdio)).body).toContain('GOOD-TEXT');

      fs.writeFileSync(M1.descFile, 'EVIL-TEXT'); // rug pull
      const ap = await s.admin.inject({
        method: 'POST',
        url: '/v1/admin/catalog/apply',
        headers: adm(),
      });
      expect([200, 409]).toContain(ap.statusCode);
      await settle(1500);
      const p = await pinOf(M1, 'chg');
      expect(p.status).toBe('pending_review');
      expect(p.pending_hash).not.toBe(p.approved_hash);
      for (const body of [
        (await stdioTools(s, stdio)).body,
        (await rpc(s, token, 'tools/list', {})).body,
      ]) {
        expect(body).toContain('GOOD-TEXT');
        expect(body).not.toContain('EVIL-TEXT');
      }
    }
  );
});

describe('D6 baseline', () => {
  itPins(
    'runs once: clean -> approved by system:migration, drifted -> pending; never re-arms',
    async () => {
      const tag = String(Date.now() % 100000);
      const clean = await mkMcp(`sha-bc-${tag}`, ['stable'], 'STABLE-TEXT', 'auto');
      const drift = await mkMcp(`sha-bd-${tag}`, ['moved'], 'V1-TEXT', 'auto');
      await agentFor([clean, drift]);

      // Simulate the pre-upgrade world: no pins, baseline not done; the drifted MCP changed since publish.
      const raw = (s.db as any).session.client;
      raw.prepare('DELETE FROM tool_pins').run();
      raw.prepare('DELETE FROM server_settings WHERE key = ?').run(TOOL_PIN_BASELINE_SETTING_KEY);
      fs.writeFileSync(drift.descFile, 'V2-DRIFTED-TEXT');

      s = await restartAgentTestServer(s, opts);
      await settle(2500);

      const c1 = await pinOf(clean, 'stable');
      expect(c1.status).toBe('approved');
      expect(c1.approved_by).toBe(SYSTEM_MIGRATION_ACTOR);
      expect(c1.baseline_unreviewed).toBe(true);
      const d1 = await pinOf(drift, 'moved');
      expect(d1.status).toBe('pending_review');
      expect(d1.flags.codes).toContain('baseline_mismatch');
      expect(
        raw
          .prepare('SELECT value FROM server_settings WHERE key = ?')
          .get(TOOL_PIN_BASELINE_SETTING_KEY)
      ).toBeTruthy();

      // hidden vs served after the baseline
      const u2 = await createUser(s, 'bl');
      alice = await loginSession(s, u2);
      aliceId = u2.userId;
      const ag = await agentFor([clean, drift]);
      const names = (await v1Tools(ag.stdio)).map(t => t.name);
      expect(names).toContain('stable');
      expect(names).not.toContain('moved');
      expect(await mcpToolNames(s, ag.token)).not.toContain('moved');

      const sum = J(
        await s.admin.inject({
          method: 'GET',
          url: `${ADMIN_TOOL_PINS_ROUTE}/summary`,
          headers: adm(),
        })
      ).data;
      expect(sum.baseline_unreviewed_count).toBeGreaterThanOrEqual(1);
      expect(sum.pending_count).toBeGreaterThanOrEqual(1);

      // never re-arms: a later change to the clean MCP is a normal pending, not a silent system:migration approval
      fs.writeFileSync(clean.descFile, 'STABLE-CHANGED');
      s = await restartAgentTestServer(s, opts);
      await settle(2500);
      const c2 = await pinOf(clean, 'stable');
      expect(c2.pending_hash).not.toBe(c2.approved_hash);
      expect(c2.status).toBe('pending_review');
      const sys = (await pins(`mcp_id=${clean.mcpId}`)).filter(
        p => p.approved_by === SYSTEM_MIGRATION_ACTOR
      );
      expect(sys.every(p => p.approved_hash === c1.approved_hash)).toBe(true);
    }
  );

  itPins('a human confirming a baseline pin clears it from the unreviewed list', async () => {
    const tag = String(Date.now() % 100000);
    const m = await mkMcp(`sha-bf-${tag}`, ['conf'], 'CONF-TEXT', 'auto');
    const raw = (s.db as any).session.client;
    raw.prepare('DELETE FROM tool_pins').run();
    raw.prepare('DELETE FROM server_settings WHERE key = ?').run(TOOL_PIN_BASELINE_SETTING_KEY);
    s = await restartAgentTestServer(s, opts);
    await settle(2500);
    const p = await pinOf(m, 'conf');
    expect(p.baseline_unreviewed).toBe(true);
    const r = await s.admin.inject({
      method: 'POST',
      url: `${ADMIN_TOOL_PINS_ROUTE}/${p.pin_id}/confirm-baseline`,
      headers: adm(),
      payload: { expected_hash: p.approved_hash },
    });
    expect(r.statusCode).toBe(200);
    expect((await pinOf(m, 'conf')).baseline_unreviewed).toBe(false);
    const stale = await s.admin.inject({
      method: 'POST',
      url: `${ADMIN_TOOL_PINS_ROUTE}/${p.pin_id}/confirm-baseline`,
      headers: adm(),
      payload: { expected_hash: 'f'.repeat(64) },
    });
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
  });
});
