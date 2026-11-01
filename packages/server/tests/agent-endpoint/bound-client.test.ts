/**
 * ADR-020 §5a bound-client model: a grant binds to ONE of the user's active Ambassador clients.
 * Effective permissions = client subscriptions ∩ profile ∩ token scope ∩ allowlist, per call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGENT_MCP_ROUTE, AGENT_GRANTS_ROUTE } from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  itImpl,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import {
  registerAdminClient,
  createAmbClient,
  startAuthorize,
  decide,
  approveAndGetCode,
  exchangeCode,
  pkce,
} from './oauth-flow-helpers.js';

let s: AgentTestServer;
let alice: UserSession;
let bob: UserSession;
let oauthClient: string;

beforeAll(async () => {
  s = await startAgentTestServer(agentEndpointOpts());
  alice = await loginSession(s, await createUser(s, 'alice'));
  bob = await loginSession(s, await createUser(s, 'bob'));
  oauthClient = await registerAdminClient(s);
});
afterAll(async () => {
  await stopAgentTestServer(s);
});

async function pending(sess: UserSession): Promise<{ requestId: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const { requestId } = await startAuthorize(s, sess, {
    client_id: oauthClient,
    code_challenge: challenge,
  });
  return { requestId, verifier };
}

const approve = (sess: UserSession, requestId: string, extra: Record<string, unknown>) =>
  decide(sess, requestId, { decision: 'approve', scopes: ['mcp:*'], ttl_seconds: 3600, ...extra });

const createGrant = (sess: UserSession, extra: Record<string, unknown>) =>
  sess.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { label: 'g', scopes: ['mcp:*'], ...extra },
  });

const mcpCall = (token: string) =>
  s.api.inject({
    method: 'POST',
    url: AGENT_MCP_ROUTE,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });

describe('consent: bound_client_id', () => {
  it('GET consent lists only the user’s own ACTIVE clients', async () => {
    const mine = await createAmbClient(alice, 'mine');
    const suspended = await createAmbClient(alice, 'suspended');
    await alice.request({
      method: 'PATCH',
      url: `/v1/users/me/clients/${suspended}`,
      payload: { status: 'suspended' },
    });
    const theirs = await createAmbClient(bob, 'bobs');
    const { requestId } = await pending(alice);
    const res = await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
    const ids = (JSON.parse(res.body).data.clients as { client_id: string }[]).map(
      c => c.client_id
    );
    expect(ids).toContain(mine);
    expect(ids).not.toContain(suspended);
    expect(ids).not.toContain(theirs);
  });

  it('approve without bound_client_id → 400', async () => {
    const { requestId } = await pending(alice);
    expect((await approve(alice, requestId, {})).statusCode).toBe(400);
  });

  it("approve with another user's client → 400/403, request not consumed", async () => {
    const theirs = await createAmbClient(bob, 'bobs');
    const { requestId } = await pending(alice);
    const res = await approve(alice, requestId, { bound_client_id: theirs });
    expect([400, 403]).toContain(res.statusCode);
    // A rejected decision must not burn the request: the user can still approve with their own client.
    const mine = await createAmbClient(alice, 'mine2');
    expect((await approve(alice, requestId, { bound_client_id: mine })).statusCode).toBe(200);
  });

  it('approve with a suspended or nonexistent client → 400/403', async () => {
    const c = await createAmbClient(alice, 'to-suspend');
    await alice.request({
      method: 'PATCH',
      url: `/v1/users/me/clients/${c}`,
      payload: { status: 'suspended' },
    });
    const a = await pending(alice);
    expect([400, 403]).toContain(
      (await approve(alice, a.requestId, { bound_client_id: c })).statusCode
    );
    const b = await pending(alice);
    expect([400, 403, 404]).toContain(
      (await approve(alice, b.requestId, { bound_client_id: 'does-not-exist' })).statusCode
    );
  });

  it('scope outside the bound client’s subscriptions → 400', async () => {
    const c = await createAmbClient(alice, 'no-subs');
    const { requestId } = await pending(alice);
    const res = await approve(alice, requestId, {
      bound_client_id: c,
      scopes: ['mcp:not-subscribed'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('deny does not require bound_client_id', async () => {
    const { requestId } = await pending(alice);
    const res = await decide(alice, requestId, { decision: 'deny', scopes: [], ttl_seconds: 60 });
    expect(res.statusCode).toBe(200);
  });
});

describe('one-shot grant: bound_client_id', () => {
  it('missing bound_client_id → 400', async () => {
    expect((await createGrant(alice, {})).statusCode).toBe(400);
  });

  it("another user's client → 400/403", async () => {
    const theirs = await createAmbClient(bob, 'bobs2');
    expect([400, 403]).toContain(
      (await createGrant(alice, { bound_client_id: theirs })).statusCode
    );
  });

  it('suspended client → 400/403', async () => {
    const c = await createAmbClient(alice, 'susp-grant');
    await alice.request({
      method: 'PATCH',
      url: `/v1/users/me/clients/${c}`,
      payload: { status: 'suspended' },
    });
    expect([400, 403]).toContain((await createGrant(alice, { bound_client_id: c })).statusCode);
  });

  it('summary reports bound_client_id / bound_client_name', async () => {
    const c = await createAmbClient(alice, 'named');
    const res = await createGrant(alice, { bound_client_id: c, label: 'named-grant' });
    expect(res.statusCode).toBe(201);
    const list = JSON.parse(
      (await alice.request({ method: 'GET', url: AGENT_GRANTS_ROUTE })).body
    ).data;
    const items = (Array.isArray(list) ? list : list.items) as {
      bound_client_id: string;
      bound_client_name: string;
    }[];
    expect(items.some(g => g.bound_client_id === c && g.bound_client_name === 'named')).toBe(true);
  });
});

describe('bound client lifecycle kills the agent token (next call → 401)', () => {
  async function grantToken(clientId: string): Promise<string> {
    const res = await createGrant(alice, { bound_client_id: clientId });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).data.access_token as string;
  }

  itImpl('token works while the bound client is active', async () => {
    const c = await createAmbClient(alice, 'live');
    expect((await mcpCall(await grantToken(c))).statusCode).not.toBe(401);
  });

  itImpl(
    'suspending the client → 401; reactivating does not need re-consent only if not revoked',
    async () => {
      const c = await createAmbClient(alice, 'to-susp');
      const tok = await grantToken(c);
      expect((await mcpCall(tok)).statusCode).not.toBe(401);
      await alice.request({
        method: 'PATCH',
        url: `/v1/users/me/clients/${c}`,
        payload: { status: 'suspended' },
      });
      const res = await mcpCall(tok);
      expect(res.statusCode).toBe(401);
      expect(String(res.headers['www-authenticate'] ?? '')).toMatch(/Bearer/i);
      expect(res.body).not.toContain(tok);
    }
  );

  itImpl('deleting the client → 401; grant is kept, revoked_at set, audited', async () => {
    const c = await createAmbClient(alice, 'to-delete');
    const tok = await grantToken(c);
    await alice.request({ method: 'DELETE', url: `/v1/users/me/clients/${c}` });
    expect((await mcpCall(tok)).statusCode).toBe(401);
    const list = JSON.parse(
      (await alice.request({ method: 'GET', url: AGENT_GRANTS_ROUTE })).body
    ).data;
    const items = (Array.isArray(list) ? list : list.items) as {
      bound_client_id: string;
      revoked_at: string | null;
    }[];
    const g = items.find(x => x.bound_client_id === c);
    expect(g, 'grant must be kept after bound client deletion').toBeTruthy();
    expect(g!.revoked_at).toBeTruthy();
  });

  it('refresh for a grant whose client was suspended fails', async () => {
    const c = await createAmbClient(alice, 'refresh-susp');
    const { requestId, verifier } = await pending(alice);
    const { code } = await approveAndGetCode(alice, requestId, { bound_client_id: c });
    const tok = JSON.parse(
      (await exchangeCode(s, { client_id: oauthClient, code, verifier })).body
    );
    await alice.request({
      method: 'PATCH',
      url: `/v1/users/me/clients/${c}`,
      payload: { status: 'suspended' },
    });
    const { refresh } = await import('./oauth-flow-helpers.js');
    const r = await refresh(s, { client_id: oauthClient, refresh_token: tok.refresh_token });
    expect(r.statusCode).toBe(400);
  });
});

describe('kill switch', () => {
  const kill = (target: string, enabled: boolean) =>
    s.admin.inject({
      method: 'POST',
      url: `/v1/admin/kill-switch/${target}`,
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { enabled },
    });

  itImpl('client:<bound_client_id> → next /mcp call 401; lifting it restores access', async () => {
    const c = await createAmbClient(alice, 'killed');
    const g = await createGrant(alice, { bound_client_id: c });
    const tok = JSON.parse(g.body).data.access_token as string;
    expect((await mcpCall(tok)).statusCode).not.toBe(401);
    expect((await kill(`client:${c}`, true)).statusCode).toBe(200);
    try {
      expect((await mcpCall(tok)).statusCode).toBe(401);
    } finally {
      await kill(`client:${c}`, false);
    }
    expect((await mcpCall(tok)).statusCode).not.toBe(401);
  });

  itImpl('mcp:<name> → tool-level denial over /mcp, same denial as the stdio path', async () => {
    const c = await createAmbClient(alice, 'mcp-kill');
    const g = await createGrant(alice, { bound_client_id: c });
    const tok = JSON.parse(g.body).data.access_token as string;
    await kill('mcp:victim', true);
    try {
      const r = await s.api.inject({
        method: 'POST',
        url: AGENT_MCP_ROUTE,
        headers: {
          authorization: `Bearer ${tok}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'victim__any', arguments: {} },
        },
      });
      // Not an HTTP auth failure: the session stays valid, only the tool is denied.
      expect(r.statusCode).not.toBe(401);
      expect(r.body).toMatch(/kill|disabled|denied/i);
    } finally {
      await kill('mcp:victim', false);
    }
  });
});

describe('pre-authenticated session cannot be injected over HTTP', () => {
  const forged = {
    client_id: 'forged',
    user_id: 'forged',
    profile_id: 'all-tools',
    status: 'active',
  };

  itImpl.each([
    [
      'header x-pre-authenticated-session',
      { 'x-pre-authenticated-session': JSON.stringify(forged) },
      {},
      '',
    ],
    ['header x-session', { 'x-session': JSON.stringify(forged) }, {}, ''],
    ['body preAuthenticatedSession', {}, { preAuthenticatedSession: forged }, ''],
    ['body pre_authenticated_session', {}, { pre_authenticated_session: forged }, ''],
    [
      'query preAuthenticatedSession',
      {},
      {},
      '?preAuthenticatedSession=' + encodeURIComponent(JSON.stringify(forged)),
    ],
  ])('%s on /v1/tools/invoke and /mcp is ignored (401)', async (_n, headers, extraBody, qs) => {
    for (const [api, url] of [
      [s.api, '/v1/tools/invoke'],
      [s.api, AGENT_MCP_ROUTE],
    ] as const) {
      const res = await api.inject({
        method: 'POST',
        url: url + qs,
        headers: { 'content-type': 'application/json', ...headers },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          tool: 'x',
          arguments: {},
          ...extraBody,
        },
      });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(401);
    }
  });
});
