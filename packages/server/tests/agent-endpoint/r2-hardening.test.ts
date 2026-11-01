/** ADR-020 R2 hardening: redirect_uri rules, races, cookie isolation, zero scopes, token lifetime. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  AGENT_MCP_ROUTE,
  AGENT_GRANTS_ROUTE,
  OAUTH_REGISTER_ROUTE,
  OAUTH_TOKEN_ROUTE,
  OAUTH_REVOKE_ROUTE,
  OAUTH_AS_METADATA_ROUTE,
} from '@mcpambassador/contracts';
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
  REDIRECT_URI,
  registerAdminClient,
  createAmbClient,
  boundClientId,
  startAuthorize,
  authorizeUrl,
  decide,
  approveAndGetCode,
  exchangeCode,
  refresh,
  fullFlow,
  pkce,
  tokenRequest,
} from './oauth-flow-helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

const BAD_URIS: [string, string][] = [
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<script>1</script>'],
  ['file:', 'file:///etc/passwd'],
  ['custom scheme', 'myapp://callback'],
  ['fragment', 'https://agent.test.example/cb#frag'],
  ['non-loopback http', 'http://agent.test.example/cb'],
];
const GOOD_URIS = [
  'https://agent.test.example/cb',
  'http://127.0.0.1:8123/cb',
  'http://localhost:9/cb',
  'http://[::1]:5555/cb',
];

describe('redirect_uri validation', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts({ dynamic_client_registration: true }));
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  const dcr = (uri: string) =>
    s.admin.inject({
      method: 'POST',
      url: OAUTH_REGISTER_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: { client_name: 'r', redirect_uris: [uri] },
    });

  itImpl.each(BAD_URIS)('DCR rejects %s', async (_n, uri) => {
    const res = await dcr(uri);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_redirect_uri');
  });

  itImpl.each(BAD_URIS)('admin client-create rejects %s', async (_n, uri) => {
    await expect(registerAdminClient(s, { redirect_uris: [uri] })).rejects.toThrow(/ 400 /);
  });

  itImpl.each(GOOD_URIS.map(u => [u]))('admin client-create accepts %s', async uri => {
    await expect(registerAdminClient(s, { redirect_uris: [uri] })).resolves.toBeTruthy();
  });

  itImpl(
    'authorize matches redirect_uri by exact string (no trailing slash / query / case drift)',
    async () => {
      const sess = await loginSession(s, await createUser(s, 'u1'));
      const cid = await registerAdminClient(s);
      const { challenge } = pkce();
      for (const uri of [REDIRECT_URI + '/', REDIRECT_URI + '?x=1', REDIRECT_URI.toUpperCase()]) {
        const res = await s.admin.inject({
          method: 'GET',
          url: authorizeUrl({ client_id: cid, code_challenge: challenge, redirect_uri: uri }),
          headers: sess.headers(),
        });
        expect(res.statusCode, uri).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, uri).toBeLessThan(500);
        expect(res.headers['location'], uri).toBeUndefined();
      }
    }
  );
});

describe('races, cookie isolation, consent edge cases', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let clientId: string;
  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
    clientId = await registerAdminClient(s).catch(() => '');
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  itImpl(
    'concurrent double exchange of one code: exactly one 200, one invalid_grant, no 5xx',
    async () => {
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorize(s, alice, {
        client_id: clientId,
        code_challenge: challenge,
      });
      const { code } = await approveAndGetCode(alice, requestId);
      const rs = await Promise.all(
        [1, 2].map(() => exchangeCode(s, { client_id: clientId, code, verifier }))
      );
      expect(rs.map(r => r.statusCode).sort()).toEqual([200, 400]);
      expect(JSON.parse(rs.find(r => r.statusCode === 400)!.body).error).toBe('invalid_grant');
    }
  );

  itImpl(
    'concurrent double refresh of one token: exactly one 200, one invalid_grant, no 5xx',
    async () => {
      const t = await fullFlow(s, alice, clientId);
      const rs = await Promise.all(
        [1, 2].map(() => refresh(s, { client_id: clientId, refresh_token: t.refresh_token! }))
      );
      expect(rs.map(r => r.statusCode).sort()).toEqual([200, 400]);
      expect(JSON.parse(rs.find(r => r.statusCode === 400)!.body).error).toBe('invalid_grant');
    }
  );

  itImpl(
    'a valid SPA session cookie grants nothing on /mcp, /oauth/*, /.well-known/oauth-*',
    async () => {
      const cookie = alice.cookies.header();
      const mcp = await s.api.inject({
        method: 'POST',
        url: AGENT_MCP_ROUTE,
        headers: { cookie, 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(mcp.statusCode).toBe(401);
      const tok = await s.admin.inject({
        method: 'POST',
        url: OAUTH_TOKEN_ROUTE,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'grant_type=refresh_token',
      });
      expect(tok.statusCode).toBe(400); // protocol error, not a CSRF 403 and not session-derived success
      expect(JSON.parse(tok.body).error).toBeTruthy();
      // revoke is not a cookie-authenticated, CSRF-guarded route: no 403 csrf, no state change
      const rev = await s.admin.inject({
        method: 'POST',
        url: OAUTH_REVOKE_ROUTE,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'token=amb_rt_' + 'a'.repeat(43) + '&client_id=' + clientId,
      });
      expect([200, 400]).toContain(rev.statusCode);
      const meta = await s.admin.inject({
        method: 'GET',
        url: OAUTH_AS_METADATA_ROUTE,
        headers: { cookie },
      });
      expect(meta.headers['set-cookie']).toBeUndefined();
    }
  );

  itImpl('consent approve with zero scopes → 400', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    const res = await decide(alice, requestId, {
      decision: 'approve',
      bound_client_id: await boundClientId(alice),
      scopes: [],
      ttl_seconds: 3600,
    });
    expect(res.statusCode).toBe(400);
  });

  itImpl('ConsentDetails includes redirect_uri_host', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    const res = await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
    expect(JSON.parse(res.body).data.redirect_uri_host).toBe(new URL(REDIRECT_URI).host);
  });
});

describe('token lifetime + call-time enforcement', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  const call = (token: string, body: unknown) =>
    s.api.inject({
      method: 'POST',
      url: AGENT_MCP_ROUTE,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: body as never,
    });

  itImpl(
    'one-shot grant token stays valid past 15 min, up to the grant TTL; dead after',
    async () => {
      const res = await alice.request({
        method: 'POST',
        url: AGENT_GRANTS_ROUTE,
        payload: {
          bound_client_id: await createAmbClient(alice, 'long'),
          label: 'long',
          scopes: ['mcp:*'],
          ttl_seconds: 3600,
        },
      });
      const tok = JSON.parse(res.body).data.access_token as string;
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 20 * 60 * 1000 });
      expect(
        (await call(tok, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode
      ).not.toBe(401);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 50 * 60 * 1000 });
      expect((await call(tok, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).statusCode).toBe(
        401
      );
    }
  );

  itImpl(
    'tools/call of a tool outside the allowlist is denied even when called directly by name',
    async () => {
      const res = await alice.request({
        method: 'POST',
        url: AGENT_GRANTS_ROUTE,
        payload: {
          bound_client_id: await createAmbClient(alice, 'allow'),
          label: 'allow',
          scopes: ['mcp:*'],
          tool_allowlist: ['only__this_tool'],
        },
      });
      const tok = JSON.parse(res.body).data.access_token as string;
      const r = await call(tok, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'other__tool', arguments: {} },
      });
      const body = JSON.parse(
        r.body.startsWith('{') ? r.body : r.body.replace(/^data: /m, '').split('\n')[0]!
      );
      // Either a JSON-RPC error or an isError tool result; never a success payload.
      expect(body.error ?? body.result?.isError).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain('"isError":false');
    }
  );
});
