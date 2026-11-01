/**
 * TD-037 / ADR-025 M2+M4 black-box: group membership, group grants and group status are
 * evaluated at call time. Revoked access never mutates the subscription row, is reflected as
 * access:'revoked' on the list endpoints, is not offered on the consent screen, and looks
 * exactly like a nonexistent tool. Re-adding / re-granting / reactivating restores everything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { registerAdminClient, startAuthorize, pkce } from './oauth-flow-helpers.js';

let s: AgentTestServer;
let alice: UserSession;
let aliceId: string;
let restoreEnv: () => void;
let ma: FakeMcp; // granted through group gA
let mb: FakeMcp; // granted through group gB
let gA: string;
let gB: string;
let client: { clientId: string; key: string };
let tokFull: string;
let tokProg: string;
let stdioTok: string;
let oauthClient: string;

const adm = () => ({ 'X-Admin-Key': s.adminKey });

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'alice');
  aliceId = u.userId;
  alice = await loginSession(s, u);
  ma = await createFakeMcp(s, { name: 'rv-a', tools: ['atool'] });
  mb = await createFakeMcp(s, { name: 'rv-b', tools: ['btool'] });
  gA = await grantUserAccess(s, aliceId, ma.mcpId);
  gB = await grantUserAccess(s, aliceId, mb.mcpId);
  await applyCatalog(s);
  client = await createClientWithKey(alice, 'rv-client');
  await subscribe(alice, client.clientId, ma.mcpId);
  await subscribe(alice, client.clientId, mb.mcpId);
  const grant = async (mode: string): Promise<string> => {
    const r = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: {
        bound_client_id: client.clientId,
        label: `rv-${mode}`,
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
  oauthClient = await registerAdminClient(s);
});
afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
});

const patchGroup = (g: string, status: 'active' | 'suspended') =>
  s.admin.inject({
    method: 'PATCH',
    url: `/v1/admin/groups/${g}`,
    headers: adm(),
    payload: { status },
  });
const addMember = (g: string) =>
  s.admin.inject({
    method: 'POST',
    url: `/v1/admin/groups/${g}/members`,
    headers: adm(),
    payload: { user_id: aliceId },
  });
const rmMember = (g: string) =>
  s.admin.inject({
    method: 'DELETE',
    url: `/v1/admin/groups/${g}/members/${aliceId}`,
    headers: adm(),
  });
const addMcp = (g: string, m: FakeMcp) =>
  s.admin.inject({
    method: 'POST',
    url: `/v1/admin/groups/${g}/mcps`,
    headers: adm(),
    payload: { mcp_id: m.mcpId },
  });
const rmMcp = (g: string, m: FakeMcp) =>
  s.admin.inject({
    method: 'DELETE',
    url: `/v1/admin/groups/${g}/mcps/${m.mcpId}`,
    headers: adm(),
  });

async function consentScopes(): Promise<string> {
  const { challenge } = pkce();
  const { requestId } = await startAuthorize(s, alice, {
    client_id: oauthClient,
    code_challenge: challenge,
  });
  const r = await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const subAccess = async (): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const url of [
    '/v1/users/me/subscriptions',
    `/v1/users/me/clients/${client.clientId}/subscriptions`,
  ]) {
    const r = await alice.request({ method: 'GET', url });
    expect(r.statusCode).toBe(200);
    const rows = (JSON.parse(r.body).data ?? []) as { mcpId: string; access: string }[];
    expect(rows.map(x => x.mcpId).sort()).toEqual([ma.mcpId, mb.mcpId].sort()); // rows persist
    for (const x of rows) out[`${url}|${x.mcpId}`] = x.access;
  }
  return out;
};

/** Everything an MCP-user can see, for the expected granted/revoked state of A and B. */
async function expectState(label: string, wantA: boolean, wantB: boolean): Promise<void> {
  const names = await mcpToolNames(s, tokFull);
  expect(names.includes('atool'), `${label}: /mcp list atool`).toBe(wantA);
  expect(names.includes('btool'), `${label}: /mcp list btool`).toBe(wantB);
  for (const [tool, want] of [
    ['atool', wantA],
    ['btool', wantB],
  ] as const) {
    const call = await rpc(s, tokFull, 'tools/call', { name: tool, arguments: {} });
    expect(isDenied(call), `${label}: /mcp call ${tool}`).toBe(!want);
    const inv = await stdioInvoke(s, stdioTok, tool);
    const body = JSON.parse(inv.body);
    expect(Array.isArray(body.result), `${label}: stdio invoke ${tool}`).toBe(want);
  }
  const tl = JSON.parse((await stdioTools(s, stdioTok)).body).tools.map(
    (t: { name: string }) => t.name
  );
  expect(tl.includes('atool'), `${label}: /v1/tools atool`).toBe(wantA);
  expect(tl.includes('btool'), `${label}: /v1/tools btool`).toBe(wantB);
  const search = await rpc(s, tokProg, 'tools/call', {
    name: 'ambassador__search_tools',
    arguments: { query: 'tool' },
  });
  const st = JSON.stringify(search.json?.result ?? {});
  expect(st.includes('atool'), `${label}: progressive search atool`).toBe(wantA);
  expect(st.includes('btool'), `${label}: progressive search btool`).toBe(wantB);
  const acc = await subAccess();
  for (const [k, v] of Object.entries(acc)) {
    const want = k.endsWith(ma.mcpId) ? wantA : wantB;
    expect(v, `${label}: ${k}`).toBe(want ? 'granted' : 'revoked');
  }
  const consent = await consentScopes();
  expect(consent.includes('mcp:rv-a'), `${label}: consent offers mcp:rv-a`).toBe(wantA);
  expect(consent.includes('mcp:rv-b'), `${label}: consent offers mcp:rv-b`).toBe(wantB);
}

describe('call-time group access (TD-037)', () => {
  it('baseline: both granted', async () => {
    await expectState('baseline', true, true);
  });

  it('removing the user from a group revokes its MCP; re-adding restores it', async () => {
    expect((await rmMember(gA)).statusCode).toBe(204);
    await expectState('member removed', false, true);
    expect((await addMember(gA)).statusCode).toBe(201);
    await expectState('member re-added', true, true);
  });

  it("revoking the group's grant on the MCP revokes it; re-granting restores it", async () => {
    expect((await rmMcp(gB, mb)).statusCode).toBe(204);
    await expectState('grant revoked', true, false);
    expect((await addMcp(gB, mb)).statusCode).toBe(201);
    await expectState('grant restored', true, true);
  });

  it('a suspended group grants nothing; reactivation restores access', async () => {
    expect((await patchGroup(gA, 'suspended')).statusCode).toBe(200);
    await expectState('group suspended', false, true);
    expect((await patchGroup(gA, 'active')).statusCode).toBe(200);
    await expectState('group reactivated', true, true);
  });

  it('a second active group still grants the MCP while the first is suspended', async () => {
    const gA2 = await grantUserAccess(s, aliceId, ma.mcpId);
    expect((await patchGroup(gA, 'suspended')).statusCode).toBe(200);
    await expectState('A via second group', true, true);
    expect((await patchGroup(gA2, 'suspended')).statusCode).toBe(200);
    await expectState('both A groups suspended', false, true);
    expect((await patchGroup(gA, 'active')).statusCode).toBe(200);
    expect((await patchGroup(gA2, 'active')).statusCode).toBe(200);
    await expectState('restored', true, true);
    expect((await rmMember(gA2)).statusCode).toBe(204); // leave only gA for later tests
    await expectState('gA2 left, gA still grants', true, true);
  });

  it('denied looks the same as nonexistent on every endpoint', async () => {
    expect((await rmMember(gA)).statusCode).toBe(204);
    try {
      const norm = (t: string, n: string): string =>
        t.replace(new RegExp(n, 'g'), 'X').replace(/"id":\d+/g, '');
      const d = await rpc(s, tokFull, 'tools/call', { name: 'atool', arguments: {} });
      const n = await rpc(s, tokFull, 'tools/call', { name: 'nosuchtool', arguments: {} });
      expect(norm(JSON.stringify(d.json), 'atool')).toBe(
        norm(JSON.stringify(n.json), 'nosuchtool')
      );
      const strip = (b: string, name: string): string =>
        norm(
          JSON.stringify(JSON.parse(b), (k, v) =>
            k === 'request_id' || k === 'timestamp' || k === 'duration_ms' ? undefined : v
          ),
          name
        );
      const di = await stdioInvoke(s, stdioTok, 'atool');
      const ni = await stdioInvoke(s, stdioTok, 'nosuchtool');
      expect(di.statusCode).toBe(ni.statusCode);
      expect(strip(di.body, 'atool')).toBe(strip(ni.body, 'nosuchtool'));
      const pd = await rpc(s, tokProg, 'tools/call', {
        name: 'ambassador__call_tool',
        arguments: { name: 'atool', mcp: 'rv-a', arguments: {} },
      });
      const pn = await rpc(s, tokProg, 'tools/call', {
        name: 'ambassador__call_tool',
        arguments: { name: 'atool', mcp: 'nosuchmcp', arguments: {} },
      });
      expect(norm(JSON.stringify(pd.json), 'rv-a')).toBe(
        norm(JSON.stringify(pn.json), 'nosuchmcp')
      );
    } finally {
      expect((await addMember(gA)).statusCode).toBe(201);
    }
  });

  it.todo(
    'TD-040: POST /v1/sessions/register must not spawn a per-user MCP for a user without a grant (repro: g144b.mjs)'
  );
});
