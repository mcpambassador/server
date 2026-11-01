/**
 * ADR-025 / FB-032 black-box: per-tool group policy (all | allow | deny), union across the user's
 * granting active groups, applied at call time on every surface. Denied looks exactly like a
 * nonexistent tool; a policy-denied approval-gated tool never creates an approval row.
 */
import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { AGENT_GRANTS_ROUTE } from '@mcpambassador/contracts';
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
  mcpToolNames,
  isDenied,
  type FakeMcp,
} from './fake-mcp-world.js';

let s: AgentTestServer;
let alice: UserSession;
let aliceId: string;
let restoreEnv: () => void;
let mp: FakeMcp; // the policy MCP
let other: FakeMcp; // an MCP with its own policy-free grant
let g1: string;
let client: { clientId: string; key: string };
let tokFull: string;
let tokProg: string;
let stdioTok: string;

const ALL = ['t1', 't2', 't3', 't4'];
const adm = () => ({ 'X-Admin-Key': s.adminKey });
const raw = (): any => (s.db as any).session.client;
const approvalRows = (tool: string): any[] =>
  raw().prepare('SELECT * FROM approval_requests WHERE tool_name=?').all(tool);

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'alice');
  aliceId = u.userId;
  alice = await loginSession(s, u);
  mp = await createFakeMcp(s, { name: 'tp-main', tools: ALL });
  other = await createFakeMcp(s, { name: 'tp-other', tools: ['otool'] });
  g1 = await grantUserAccess(s, aliceId, mp.mcpId);
  await grantUserAccess(s, aliceId, other.mcpId);
  await applyCatalog(s);
  // the marketplace reads the admin-visible catalog column; seed it like discovery would
  raw()
    .prepare('UPDATE mcp_catalog SET tool_catalog=? WHERE mcp_id=?')
    .run(JSON.stringify(ALL.map(name => ({ name, description: `${name} tool` }))), mp.mcpId);
  client = await createClientWithKey(alice, 'tp-client');
  await subscribe(alice, client.clientId, mp.mcpId);
  await subscribe(alice, client.clientId, other.mcpId);
  const grant = async (mode: string): Promise<string> => {
    const r = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: {
        bound_client_id: client.clientId,
        label: `tp-${mode}`,
        scopes: ['mcp:*'],
        disclosure_mode: mode,
      },
    });
    if (r.statusCode !== 201) throw new Error(`grant: ${r.statusCode} ${r.body}`);
    return JSON.parse(r.body).data.access_token as string;
  };
  tokFull = await grant('full');
  tokProg = await grant('progressive');
  stdioTok = await stdioSession(s, client.key);
});
afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
});

async function setPolicy(g: string, mode: 'all' | 'allow' | 'deny', tools: string[]) {
  const r = await s.admin.inject({
    method: 'PUT',
    url: `/v1/admin/groups/${g}/mcps/${mp.mcpId}/tools`,
    headers: adm(),
    payload: { tool_mode: mode, tools },
  });
  expect(r.statusCode, `PUT policy ${mode} ${tools}: ${r.body}`).toBe(200);
}
afterEach(async () => {
  await setPolicy(g1, 'all', []);
  await s.admin.inject({
    method: 'PUT',
    url: `/v1/admin/mcps/${mp.mcpId}/tool-policies/t3`,
    headers: adm(),
    payload: { requires_approval: false, approver: 'owner' },
  });
});

const mine = (names: string[]) => names.filter(n => ALL.includes(n)).sort();

async function marketplaceTools(): Promise<string[]> {
  const out: string[][] = [];
  const list = await alice.request({ method: 'GET', url: '/v1/marketplace' });
  expect(list.statusCode).toBe(200);
  const items = (JSON.parse(list.body).data ?? []) as any[];
  const it0 = items.find(m => (m.mcp_id ?? m.id) === mp.mcpId);
  expect(it0, 'marketplace lists the MCP').toBeTruthy();
  out.push((it0.tools ?? []).map((t: any) => t.name));
  const one = await alice.request({ method: 'GET', url: `/v1/marketplace/${mp.mcpId}` });
  expect(one.statusCode).toBe(200);
  out.push((JSON.parse(one.body).data.tools ?? []).map((t: any) => t.name));
  expect(mine(out[0]!)).toEqual(mine(out[1]!)); // list == detail
  return mine(out[0]!);
}

/** What every surface offers for the policy MCP, as a sorted name list (and the call outcomes). */
async function expectOffered(label: string, want: string[]): Promise<void> {
  const w = [...want].sort();
  expect(mine(await mcpToolNames(s, tokFull)), `${label}: /mcp tools/list`).toEqual(w);
  const tl = JSON.parse((await stdioTools(s, stdioTok)).body).tools.map(
    (t: { name: string }) => t.name
  );
  expect(mine(tl), `${label}: /v1/tools`).toEqual(w);
  const search = await rpc(s, tokProg, 'tools/call', {
    name: 'ambassador__search_tools',
    arguments: { query: 'tool' },
  });
  const st = JSON.stringify(search.json?.result ?? {});
  for (const t of ALL)
    expect(st.includes(t), `${label}: progressive search ${t}`).toBe(w.includes(t));
  expect(await marketplaceTools(), `${label}: marketplace`).toEqual(w);
  for (const t of ALL) {
    const on = w.includes(t);
    const c = await rpc(s, tokFull, 'tools/call', { name: t, arguments: {} });
    expect(isDenied(c), `${label}: /mcp call ${t}`).toBe(!on);
    const i = JSON.parse((await stdioInvoke(s, stdioTok, t)).body);
    expect(Array.isArray(i.result), `${label}: stdio invoke ${t}`).toBe(on);
    const p = await rpc(s, tokProg, 'tools/call', {
      name: 'ambassador__call_tool',
      arguments: { name: t, mcp: 'tp-main', arguments: {} },
    });
    expect(isDenied(p), `${label}: progressive call_tool ${t}`).toBe(!on);
  }
  // the other MCP is never affected
  expect(await mcpToolNames(s, tokFull), `${label}: other MCP`).toContain('otool');
}

describe('per-tool group policy (ADR-025 / FB-032)', () => {
  it('all (default): every tool on every surface', async () => {
    await expectOffered('all', ALL);
  });

  it('allow lists and calls only the listed tools', async () => {
    await setPolicy(g1, 'allow', ['t1', 't2']);
    await expectOffered('allow[t1,t2]', ['t1', 't2']);
  });

  it('deny hides the listed tools and nothing else', async () => {
    await setPolicy(g1, 'deny', ['t1', 't4']);
    await expectOffered('deny[t1,t4]', ['t2', 't3']);
  });

  it('allow of a name that matches no tool offers nothing from that MCP (names are exact)', async () => {
    await setPolicy(g1, 'allow', ['T1', 't1 ', 'nope']);
    await expectOffered('allow[no match]', []);
  });

  it('union across two groups: allow+allow adds, deny+allow combines, an `all` beats a deny', async () => {
    const g2 = await grantUserAccess(s, aliceId, mp.mcpId); // policy all
    try {
      await setPolicy(g1, 'allow', ['t1']);
      await setPolicy(g2, 'allow', ['t2']);
      await expectOffered('allow t1 + allow t2', ['t1', 't2']);
      await setPolicy(g1, 'deny', ['t1', 't2']);
      await setPolicy(g2, 'allow', ['t2']);
      await expectOffered('deny t1,t2 + allow t2', ['t2', 't3', 't4']);
      await setPolicy(g1, 'deny', ['t1', 't2', 't3', 't4']);
      await setPolicy(g2, 'all', []);
      await expectOffered('deny everything + all', ALL);
      await setPolicy(g2, 'allow', ['t3']);
      await expectOffered('deny everything + allow t3', ['t3']);
      // suspending the group with the wider policy narrows the union
      await setPolicy(g1, 'deny', ['t1']);
      await setPolicy(g2, 'all', []);
      expect(
        (
          await s.admin.inject({
            method: 'PATCH',
            url: `/v1/admin/groups/${g2}`,
            headers: adm(),
            payload: { status: 'suspended' },
          })
        ).statusCode
      ).toBe(200);
      await expectOffered('all group suspended, deny t1 remains', ['t2', 't3', 't4']);
    } finally {
      await s.admin.inject({
        method: 'DELETE',
        url: `/v1/admin/groups/${g2}/members/${aliceId}`,
        headers: adm(),
      });
    }
  });

  it('a policy change mid-session takes effect on the very next call (same tokens, same session)', async () => {
    expect(isDenied(await rpc(s, tokFull, 'tools/call', { name: 't2', arguments: {} }))).toBe(
      false
    );
    await setPolicy(g1, 'deny', ['t2']);
    expect(isDenied(await rpc(s, tokFull, 'tools/call', { name: 't2', arguments: {} }))).toBe(true);
    expect(Array.isArray(JSON.parse((await stdioInvoke(s, stdioTok, 't2')).body).result)).toBe(
      false
    );
    await setPolicy(g1, 'all', []);
    expect(isDenied(await rpc(s, tokFull, 'tools/call', { name: 't2', arguments: {} }))).toBe(
      false
    );
    expect(Array.isArray(JSON.parse((await stdioInvoke(s, stdioTok, 't2')).body).result)).toBe(
      true
    );
  });

  it('denied is byte-identical to nonexistent on /mcp, stdio and progressive', async () => {
    await setPolicy(g1, 'allow', ['t1']);
    const norm = (t: string, n: string): string =>
      t.replace(new RegExp(n, 'g'), 'X').replace(/"id":\d+/g, '');
    const d = await rpc(s, tokFull, 'tools/call', { name: 't2', arguments: {} });
    const n = await rpc(s, tokFull, 'tools/call', { name: 'nosuch', arguments: {} });
    expect(norm(JSON.stringify(d.json), 't2')).toBe(norm(JSON.stringify(n.json), 'nosuch'));
    const strip = (b: string, name: string): string =>
      norm(
        JSON.stringify(JSON.parse(b), (k, v) =>
          k === 'request_id' || k === 'timestamp' || k === 'duration_ms' ? undefined : v
        ),
        name
      );
    const di = await stdioInvoke(s, stdioTok, 't2');
    const ni = await stdioInvoke(s, stdioTok, 'nosuch');
    expect(di.statusCode).toBe(ni.statusCode);
    expect(strip(di.body, 't2')).toBe(strip(ni.body, 'nosuch'));
    const pd = await rpc(s, tokProg, 'tools/call', {
      name: 'ambassador__call_tool',
      arguments: { name: 't2', mcp: 'tp-main', arguments: {} },
    });
    const pn = await rpc(s, tokProg, 'tools/call', {
      name: 'ambassador__call_tool',
      arguments: { name: 't2', mcp: 'nosuchmcp', arguments: {} },
    });
    expect(norm(JSON.stringify(pd.json), 'tp-main')).toBe(
      norm(JSON.stringify(pn.json), 'nosuchmcp')
    );
  });

  it('a policy-denied approval-gated tool creates no approval row; once allowed it gates normally', async () => {
    const put = await s.admin.inject({
      method: 'PUT',
      url: `/v1/admin/mcps/${mp.mcpId}/tool-policies/t3`,
      headers: adm(),
      payload: { requires_approval: true, approver: 'owner' },
    });
    expect(put.statusCode).toBe(200);
    await setPolicy(g1, 'allow', ['t1']);
    const before = approvalRows('t3').length;
    const denied = await rpc(s, tokFull, 'tools/call', { name: 't3', arguments: { a: 1 } });
    expect(isDenied(denied)).toBe(true);
    expect(JSON.stringify(denied.json)).not.toMatch(/approval/i);
    const di = JSON.parse((await stdioInvoke(s, stdioTok, 't3', { a: 1 })).body);
    expect(di.metadata?.approval).toBeUndefined();
    const dp = await rpc(s, tokProg, 'tools/call', {
      name: 'ambassador__call_tool',
      arguments: { name: 't3', mcp: 'tp-main', arguments: { a: 1 } },
    });
    expect(JSON.stringify(dp.json)).not.toMatch(/approval/i);
    expect(approvalRows('t3')).toHaveLength(before); // no row on any surface
    await setPolicy(g1, 'deny', ['t1']); // now t3 is permitted -> gated
    const gated = await rpc(s, tokFull, 'tools/call', { name: 't3', arguments: { a: 1 } });
    expect(JSON.stringify(gated.json)).toMatch(/approval/i);
    expect(approvalRows('t3').length).toBe(before + 1);
    // narrowing the policy afterwards: the open request can no longer be used through a denied tool
    await setPolicy(g1, 'allow', ['t1']);
    const after = await rpc(s, tokFull, 'tools/call', { name: 't3', arguments: { a: 1 } });
    expect(isDenied(after)).toBe(true);
    expect(approvalRows('t3').length).toBe(before + 1);
  });
});
void fs;
