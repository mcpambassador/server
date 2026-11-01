/**
 * ADR-022 (3b) progressive tool disclosure over a REAL downstream MCP (tests/fixtures/fake-mcp.mjs):
 * the three meta-tools, scope matrix in both modes, hidden (pending / revoked / reserved / out-of-scope)
 * tools being indistinguishable from nonexistent ones, P3 ambiguity, limits, audit metadata, rate-limit
 * buckets, and the serve-time-only 500 code-point description cut.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  ADMIN_MCP_PIN_POLICY_ROUTE,
  ADMIN_TOOL_PINS_ROUTE,
  AGENT_GRANTS_ROUTE,
} from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import {
  FAKE_MCP_PATH,
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  rpc,
  mcpToolNames,
  auditLines,
  waitForAudit,
} from './fake-mcp-world.js';
import {
  registerAdminClient,
  pkce,
  startAuthorize,
  approveAndGetCode,
  exchangeCode,
} from './oauth-flow-helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const SEARCH = 'ambassador__search_tools';
const DESCRIBE = 'ambassador__describe_tool';
const CALL = 'ambassador__call_tool';

let s: AgentTestServer;
let restoreEnv: () => void;
let dir: string;
let alice: UserSession;
let aliceId: string;
let client: { clientId: string; key: string };
let stdio: string;
const adm = () => ({ 'X-Admin-Key': s.adminKey });
const J = (r: { body: string }): any => JSON.parse(r.body);

const LONG = 'a'.repeat(499) + '\u{1F600}' + 'TAIL-BEYOND-500'; // emoji straddles code point 500
const callLog = (name: string): string => path.join(dir, `${name}.log`);
const callsTo = (mcp: string, tool: string): number =>
  fs.existsSync(callLog(mcp))
    ? fs
        .readFileSync(callLog(mcp), 'utf8')
        .split('\n')
        .filter(l => l.includes('"tools/call"') && l.includes(`"name":"${tool}"`)).length
    : 0;

async function grant(
  clientId: string,
  extra: Record<string, unknown> = {}
): Promise<{ grantId: string; token: string }> {
  const res = await alice.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: clientId, label: '3b', scopes: ['mcp:*'], ...extra },
  });
  if (res.statusCode !== 201) throw new Error(`grant: ${res.statusCode} ${res.body}`);
  const d = J(res).data;
  return { grantId: d.grant_id as string, token: d.access_token as string };
}

/** MCP with its own call log and description; policy decides whether tools start approved or pending. */
async function mkMcp(
  name: string,
  tools: string[],
  desc: string,
  policy: 'auto' | 'review'
): Promise<string> {
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
        env: { FAKE_MCP_TOOLS: tools.join(','), FAKE_MCP_LOG: callLog(name), FAKE_MCP_DESC: desc },
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
  if (pol.statusCode !== 200) throw new Error(`pin-policy ${name}: ${pol.statusCode}`);
  for (const step of ['validate', 'discover', 'publish']) {
    const r = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/${step}`,
      headers: adm(),
    });
    if (r.statusCode !== 200) throw new Error(`${name} ${step}: ${r.statusCode} ${r.body}`);
  }
  await grantUserAccess(s, aliceId, mcpId);
  await applyCatalog(s);
  await subscribe(alice, client.clientId, mcpId);
  return mcpId;
}

const pins = async (mcpId: string): Promise<any[]> =>
  J(
    await s.admin.inject({
      method: 'GET',
      url: `${ADMIN_TOOL_PINS_ROUTE}?mcp_id=${mcpId}`,
      headers: adm(),
    })
  ).data;
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Pins are created lazily when the user's catalog is built */
async function observe(mcpId: string, tool: string): Promise<any> {
  for (let i = 0; i < 10; i++) {
    await stdioTools(s, stdio);
    await settle(300);
    const p = (await pins(mcpId)).find(x => x.tool_name === tool);
    if (p) return p;
  }
  throw new Error(`no pin for ${tool}`);
}

const tool = (token: string, name: string, args: unknown) =>
  rpc(s, token, 'tools/call', { name, arguments: args });
const text = (r: { json: any }): string => r.json?.result?.content?.[0]?.text ?? '';
const isErr = (r: { json: any }): boolean => !!r.json?.result?.isError;
// the fake MCP always lists a built-in `__env` helper tool; it is noise for these assertions
const hits = (r: { json: any }): Array<{ name: string; mcp: string; summary: string }> =>
  (JSON.parse(text(r)).tools as Array<{ name: string; mcp: string; summary: string }>).filter(
    h => h.name !== '__env'
  );

let aId: string;
let bId: string;
let longId: string;
let pendId: string;
let revId: string;

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd3b-'));
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'alice');
  aliceId = u.userId;
  alice = await loginSession(s, u);
  client = await createClientWithKey(alice, 'pd-client');
  stdio = await stdioSession(s, client.key);

  aId = await mkMcp('pd-a', ['echo', 'other'], 'Handles input. Second sentence here.', 'auto');
  bId = await mkMcp('pd-b', ['echo', 'btool'], 'B tool description.', 'auto'); // `echo` in two MCPs
  longId = await mkMcp('pd-long', ['longtool'], LONG, 'auto');
  pendId = await mkMcp('pd-pend', ['pendtool'], 'PEND-TEXT', 'review'); // stays pending_review
  revId = await mkMcp('pd-rev', ['revtool'], 'REV-TEXT', 'review');
  const rp = await observe(revId, 'revtool');
  expect(
    (
      await s.admin.inject({
        method: 'POST',
        url: `${ADMIN_TOOL_PINS_ROUTE}/${rp.pin_id}/approve`,
        headers: adm(),
        payload: { expected_hash: rp.pending_hash },
      })
    ).statusCode
  ).toBe(200);
  const approved = (await pins(revId)).find(x => x.tool_name === 'revtool');
  expect(
    (
      await s.admin.inject({
        method: 'POST',
        url: `${ADMIN_TOOL_PINS_ROUTE}/${approved.pin_id}/revoke`,
        headers: adm(),
        payload: { expected_hash: approved.approved_hash, reason: '3b test' },
      })
    ).statusCode
  ).toBe(200);
  await observe(pendId, 'pendtool');
}, 180_000);

afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('disclosure_mode on grants', () => {
  it('defaults to full and persists progressive (one-shot), shown in the grant summary', async () => {
    const full = await grant(client.clientId);
    const prog = await grant(client.clientId, { disclosure_mode: 'progressive' });
    const list = J(await alice.request({ method: 'GET', url: AGENT_GRANTS_ROUTE })).data as any[];
    const modeOf = (id: string) => list.find(g => g.grant_id === id)?.disclosure_mode;
    expect(modeOf(full.grantId)).toBe('full');
    expect(modeOf(prog.grantId)).toBe('progressive');
  });

  it('consent persists the choice onto the minted grant (default full)', async () => {
    const oauthClient = await registerAdminClient(s);
    const run = async (extra: Record<string, unknown>): Promise<string> => {
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorize(s, alice, {
        client_id: oauthClient,
        code_challenge: challenge,
      });
      const { code } = await approveAndGetCode(alice, requestId, {
        bound_client_id: client.clientId,
        ...extra,
      });
      const res = await exchangeCode(s, { client_id: oauthClient, code, verifier });
      expect(res.statusCode, res.body).toBe(200);
      return J(res).access_token as string;
    };
    const prog = await run({ disclosure_mode: 'progressive' });
    expect(await mcpToolNames(s, prog)).toEqual([CALL, DESCRIBE, SEARCH].sort());
    const dflt = await run({});
    expect((await mcpToolNames(s, dflt)).some(n => n.startsWith('ambassador__'))).toBe(false);
    const modes = (
      (s.db as any).session.client
        .prepare(`SELECT DISTINCT disclosure_mode AS m FROM agent_grants WHERE kind = 'oauth'`)
        .all() as Array<{ m: string }>
    ).map(r => r.m);
    expect(modes.sort()).toEqual(['full', 'progressive']);
  });

  it('rejects an unknown disclosure_mode', async () => {
    const res = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: { bound_client_id: client.clientId, label: 'x', disclosure_mode: 'weird' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('migration 0005: column defaults to full and the CHECK is enforced', () => {
    const db = (s.db as any).session.client;
    const cols = db.prepare('PRAGMA table_info(agent_grants)').all() as any[];
    const col = cols.find(c => c.name === 'disclosure_mode');
    expect(col).toBeTruthy();
    expect(col.notnull).toBe(1);
    expect(String(col.dflt_value)).toContain('full');
    const codeCols = db.prepare('PRAGMA table_info(oauth_auth_codes)').all() as any[];
    expect(codeCols.some(c => c.name === 'disclosure_mode')).toBe(true);
    expect(() =>
      db.prepare(`UPDATE agent_grants SET disclosure_mode='bogus' WHERE grant_id IS NOT NULL`).run()
    ).toThrow(/CHECK/i);
  });
});

describe('tools/list by mode', () => {
  it('progressive lists exactly the three meta-tools; full lists real tools and no meta-tools', async () => {
    const p = await grant(client.clientId, { disclosure_mode: 'progressive' });
    expect(await mcpToolNames(s, p.token)).toEqual([CALL, DESCRIBE, SEARCH].sort());
    const f = await grant(client.clientId);
    const names = await mcpToolNames(s, f.token);
    expect(names).toEqual(expect.arrayContaining(['echo', 'btool', 'other']));
    expect(names.some(n => n.startsWith('ambassador__'))).toBe(false);
  });
});

describe('search / describe / call serve only approved, in-scope tools', () => {
  let tok: string;
  beforeAll(async () => {
    tok = (await grant(client.clientId, { disclosure_mode: 'progressive' })).token;
  });

  it('search finds real tools with mcp and a one-line summary', async () => {
    const r = await tool(tok, SEARCH, { query: 'echo' });
    expect(isErr(r)).toBe(false);
    const h = hits(r);
    expect(h.map(x => `${x.mcp}/${x.name}`).sort()).toEqual(['pd-a/echo', 'pd-b/echo']);
    expect(h.find(x => x.mcp === 'pd-a')!.summary).toBe('Handles input.');
  });

  it('pending, revoked and reserved-name tools are invisible to search, describe and call', async () => {
    for (const q of ['pendtool', 'revtool', 'PEND-TEXT', 'REV-TEXT']) {
      expect(hits(await tool(tok, SEARCH, { query: q }))).toEqual([]);
    }
    const before = [callsTo('pd-pend', 'pendtool'), callsTo('pd-rev', 'revtool')];
    const unknown = await tool(tok, DESCRIBE, { name: 'definitely-not-a-tool' });
    for (const name of ['pendtool', 'revtool']) {
      const d = await tool(tok, DESCRIBE, { name });
      const c = await tool(tok, CALL, { name, arguments: {} });
      for (const r of [d, c]) {
        expect(isErr(r)).toBe(true);
        expect(text(r)).toBe(text(unknown)); // same text as a nonexistent tool
      }
    }
    // reserved prefix: same answer as well
    for (const name of ['ambassador__anything', CALL, SEARCH]) {
      const d = await tool(tok, DESCRIBE, { name });
      const c = await tool(tok, CALL, { name, arguments: {} });
      expect(text(d)).toBe('Unknown tool');
      expect(text(c)).toBe('Unknown tool');
    }
    expect([callsTo('pd-pend', 'pendtool'), callsTo('pd-rev', 'revtool')]).toEqual(before);
  });

  it('describe returns the approved description (500 code points, surrogate-safe) and full schema', async () => {
    const r = await tool(tok, DESCRIBE, { name: 'longtool' });
    const d = JSON.parse(text(r));
    expect(d.mcp).toBe('pd-long');
    expect(Array.from(d.description as string)).toHaveLength(500);
    expect(d.description.endsWith('\u{1F600}')).toBe(true); // no half surrogate at the boundary
    expect(d.description).not.toContain('TAIL-BEYOND');
    expect(d.inputSchema).toBeTruthy();
    expect(Object.keys(d).sort()).toEqual(['description', 'inputSchema', 'mcp', 'name']);
  });

  it('the cut happens only at serve time: the stored catalog snapshot keeps the full text', async () => {
    const row = (s.db as any).session.client
      .prepare('SELECT tool_catalog FROM mcp_catalog WHERE mcp_id = ?')
      .get(longId) as { tool_catalog: string };
    expect(row.tool_catalog).toContain('TAIL-BEYOND-500');
    // and the direct (full-mode) listing is cut too, on whole code points
    const f = await grant(client.clientId);
    const list = await rpc(s, f.token, 'tools/list', {});
    const lt = (list.json.result.tools as any[]).find(t => t.name === 'longtool');
    expect(Array.from(lt.description as string)).toHaveLength(500);
    expect(lt.description.endsWith('\u{1F600}')).toBe(true);
  });

  it('call_tool executes through the pipeline; the mcp argument disambiguates a shared name', async () => {
    const amb = await tool(tok, CALL, { name: 'echo', arguments: { x: 1 } });
    expect(isErr(amb)).toBe(true);
    expect(text(amb)).toMatch(
      /^ambiguous: specify mcp \(candidates: (?:.*pd-a.*pd-b|.*pd-b.*pd-a)\)$/
    );
    const before = [callsTo('pd-a', 'echo'), callsTo('pd-b', 'echo')];
    expect(callsTo('pd-a', 'echo')).toBe(before[0]);
    const ok = await tool(tok, CALL, { name: 'echo', mcp: 'pd-b', arguments: { x: 1 } });
    expect(isErr(ok)).toBe(false);
    expect(callsTo('pd-b', 'echo')).toBe(before[1]! + 1);
    expect(callsTo('pd-a', 'echo')).toBe(before[0]); // not the shadowed/first-wins one
    const d = await tool(tok, DESCRIBE, { name: 'echo' });
    expect(text(d)).toMatch(/^ambiguous: specify mcp/);
    expect(JSON.parse(text(await tool(tok, DESCRIBE, { name: 'echo', mcp: 'pd-a' }))).mcp).toBe(
      'pd-a'
    );
  });

  it('meta-tools never recurse: call_tool → call_tool does not execute and answers Unknown tool', async () => {
    const before = callsTo('pd-a', 'other');
    const r = await tool(tok, CALL, { name: CALL, arguments: { name: 'other', arguments: {} } });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toBe('Unknown tool');
    expect(callsTo('pd-a', 'other')).toBe(before);
  });

  it('search limits: default 20, max 50, query ≤ 200 chars', async () => {
    const many = await mkMcp(
      'pd-many',
      Array.from({ length: 60 }, (_, i) => `bulk${String(i).padStart(2, '0')}`),
      'Bulk tool.',
      'auto'
    );
    expect(many).toBeTruthy();
    expect(hits(await tool(tok, SEARCH, { query: 'bulk' }))).toHaveLength(20);
    expect(hits(await tool(tok, SEARCH, { query: 'bulk', limit: 50 }))).toHaveLength(50);
    expect(hits(await tool(tok, SEARCH, { query: 'bulk', limit: 5 }))).toHaveLength(5);
    expect(isErr(await tool(tok, SEARCH, { query: 'bulk', limit: 51 }))).toBe(true);
    expect(isErr(await tool(tok, SEARCH, { query: 'x'.repeat(201) }))).toBe(true);
    expect(isErr(await tool(tok, SEARCH, { query: 'x'.repeat(200) }))).toBe(false);
    expect(hits(await tool(tok, SEARCH, { query: 'bulk', mcp: 'pd-a' }))).toEqual([]);
  });
});

describe('scope matrix holds in both modes', () => {
  for (const mode of ['full', 'progressive'] as const) {
    describe(mode, () => {
      let tok: string;
      beforeAll(async () => {
        tok = (await grant(client.clientId, { scopes: ['mcp:pd-b'], disclosure_mode: mode })).token;
      });
      // direct tools/call exists in both modes; wrapped via call_tool as well
      it('direct call to an out-of-scope tool is 403 insufficient_scope', async () => {
        const r = await rpc(s, tok, 'tools/call', { name: 'other', arguments: {} });
        expect(r.status).toBe(403);
        expect(String(r.headers['www-authenticate'])).toContain('insufficient_scope');
      });
      it('call_tool to an out-of-scope tool is 403 insufficient_scope and never runs', async () => {
        const before = callsTo('pd-a', 'other');
        const r = await rpc(s, tok, 'tools/call', {
          name: CALL,
          arguments: { name: 'other', arguments: {} },
        });
        expect(r.status).toBe(403);
        expect(String(r.headers['www-authenticate'])).toContain('insufficient_scope');
        expect(callsTo('pd-a', 'other')).toBe(before);
      });
      it('in-scope call_tool works; search does not reveal out-of-scope tools', async () => {
        expect(isErr(await tool(tok, CALL, { name: 'btool', arguments: {} }))).toBe(false);
        const s1 = hits(await tool(tok, SEARCH, { query: '' }));
        expect(s1.every(h => h.mcp === 'pd-b')).toBe(true);
        expect(s1.map(h => h.name).sort()).toEqual(['btool', 'echo']);
      });
      it('a batch with one out-of-scope call is rejected as a whole', async () => {
        const res = await s.api.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
            authorization: `Bearer ${tok}`,
          },
          payload: [
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'btool', arguments: {} },
            },
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: CALL, arguments: { name: 'other', arguments: {} } },
            },
          ] as never,
        });
        expect(res.statusCode).toBe(403);
      });
    });
  }

  it('an out-of-scope name answers exactly like a nonexistent one in describe', async () => {
    const tok = (
      await grant(client.clientId, { scopes: ['mcp:pd-b'], disclosure_mode: 'progressive' })
    ).token;
    const a = await tool(tok, DESCRIBE, { name: 'other' });
    const b = await tool(tok, DESCRIBE, { name: 'nope-nope' });
    expect(text(a)).toBe('Unknown tool');
    expect(text(a)).toBe(text(b));
  });
});

describe('audit', () => {
  it('records disclosure_mode and via on calls, and discovery with length+hash only', async () => {
    const tok = (await grant(client.clientId, { disclosure_mode: 'progressive' })).token;
    const secret = 'zzq-private-query-needle';
    await tool(tok, SEARCH, { query: secret });
    await tool(tok, CALL, { name: 'btool', arguments: {} });
    const fullGrant = await grant(client.clientId);
    await tool(fullGrant.token, 'btool', {});
    await waitForAudit(s, 'agent_tool_discovery');
    const viaLine = await waitForAudit(s, '"via":"ambassador__call_tool"');
    expect(viaLine).toContain('"disclosure_mode":"progressive"');
    // This test's own direct call: scope the line to this grant. (Earlier tests in the file write
    // full-mode lines WITH via into the shared audit file, so scanning it whole is order/flush dependent.)
    const directLine = await waitForAudit(
      s,
      `agent:${fullGrant.grantId}`,
      'btool',
      '"disclosure_mode":"full"'
    );
    const disc = auditLines(s).filter(l => l.includes('agent_tool_discovery'));
    expect(disc.length).toBeGreaterThan(0);
    expect(disc.some(l => l.includes('query_length') && l.includes('query_hash'))).toBe(true);
    expect(auditLines(s).join('\n')).not.toContain(secret);
    expect(directLine).not.toContain('"via"'); // direct calls carry no via
  });
});

describe('rate limits: discovery has its own, cheaper bucket', () => {
  let s2: AgentTestServer;
  let a2: UserSession;
  let token: string;
  beforeAll(async () => {
    s2 = await startAgentTestServer(
      agentEndpointOpts({
        rate_limits: { tool_calls_per_minute_per_grant: 2, tool_calls_per_minute_per_user: 100 },
      })
    );
    const u = await createUser(s2, 'rl');
    a2 = await loginSession(s2, u);
    const c = await createClientWithKey(a2, 'rl-client');
    const fk = await createFakeMcp(s2, { name: 'rl-fk', tools: ['echo'] });
    await grantUserAccess(s2, u.userId, fk.mcpId);
    await applyCatalog(s2);
    await subscribe(a2, c.clientId, fk.mcpId);
    const g = await a2.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: {
        bound_client_id: c.clientId,
        label: 'rl',
        scopes: ['mcp:*'],
        disclosure_mode: 'progressive',
      },
    });
    token = J(g).data.access_token;
  }, 120_000);
  afterAll(async () => {
    await stopAgentTestServer(s2);
  });

  it('search/describe allow 2× the call limit, then 429; call_tool has its own bucket of 1×', async () => {
    const st: number[] = [];
    for (let i = 0; i < 5; i++)
      st.push(
        (await rpc(s2, token, 'tools/call', { name: SEARCH, arguments: { query: '' } })).status
      );
    expect(st).toEqual([200, 200, 200, 200, 429]);
    const calls: number[] = [];
    for (let i = 0; i < 3; i++)
      calls.push(
        (await rpc(s2, token, 'tools/call', { name: CALL, arguments: { name: 'echo' } })).status
      );
    expect(calls).toEqual([200, 200, 429]);
  });
});
