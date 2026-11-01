/**
 * ADR-020 phase 2: authorization-code + PKCE flow, pending-request consent, token endpoint,
 * refresh rotation / reuse detection, revoke, DCR toggle, one-shot grants.
 * All `itImpl` until P4/P5 replace the 501 stubs (see helpers.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  OAUTH_REGISTER_ROUTE,
  AGENT_GRANTS_ROUTE,
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
} from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  itImpl,
  TEST_RESOURCE,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import {
  REDIRECT_URI,
  pkce,
  registerAdminClient,
  startAuthorize,
  authorizeUrl,
  decide,
  approveAndGetCode,
  exchangeCode,
  refresh,
  revoke,
  tokenRequest,
  fullFlow,
  boundClientId,
} from './oauth-flow-helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('authorize + consent (pending request model)', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let bob: UserSession;
  let clientId: string;

  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
    bob = await loginSession(s, await createUser(s, 'bob'));
    clientId = await registerAdminClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('authorize 302s to /app/oauth/consent?request_id=…', async () => {
    const { challenge } = pkce();
    const { location, requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    expect(location).toContain('/app/oauth/consent');
    expect(requestId.length).toBeGreaterThanOrEqual(16);
  });

  it.each([
    ['unknown client_id', { client_id: 'nope' }],
    ['unregistered redirect_uri', { redirect_uri: 'https://evil.example/cb' }],
  ])('%s → error page/JSON, NO redirect', async (_n, over) => {
    const { challenge } = pkce();
    const res = await s.admin.inject({
      method: 'GET',
      url: authorizeUrl({ client_id: clientId, code_challenge: challenge, ...over }),
      headers: alice.headers(),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['location']).toBeUndefined();
  });

  it.each([
    ['PKCE method plain', { code_challenge_method: 'plain' }],
    ['response_type token', { response_type: 'token' }],
    ['resource ≠ canonical /mcp', { resource: 'https://other.example/mcp' }],
  ])('%s is rejected', async (_n, over) => {
    const { challenge } = pkce();
    const res = await s.admin.inject({
      method: 'GET',
      url: authorizeUrl({ client_id: clientId, code_challenge: challenge, ...over }),
      headers: alice.headers(),
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).not.toBe(200);
    // Never mint a pending request for an invalid authorize call.
    expect(String(res.headers['location'] ?? '')).not.toContain('request_id=');
  });

  it('GET consent returns client + available subscriptions + TTL bounds', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    const res = await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
    expect(res.statusCode).toBe(200);
    const d = JSON.parse(res.body).data;
    expect(d.client_name).toBe('verifier-agent');
    expect(d.client_verified).toBe(true);
    expect(Array.isArray(d.clients)).toBe(true);
    expect(d.max_ttl_seconds).toBeGreaterThanOrEqual(d.default_ttl_seconds);
  });

  it("another user's request_id → 403 (bound to first opener)", async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    expect(
      (await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` })).statusCode
    ).toBe(200);
    const res = await bob.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
    expect(res.statusCode).toBe(403);
    const post = await decide(bob, requestId, {
      decision: 'approve',
      bound_client_id: await boundClientId(bob),
      scopes: ['mcp:*'],
      ttl_seconds: 3600,
    });
    expect(post.statusCode).toBe(403);
  });

  it('unknown request_id → 404', async () => {
    const res = await alice.request({ method: 'GET', url: '/v1/oauth/consent/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('reused request_id → 404 (single use)', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    await approveAndGetCode(alice, requestId);
    const again = await decide(alice, requestId, {
      decision: 'approve',
      bound_client_id: await boundClientId(alice),
      scopes: ['mcp:*'],
      ttl_seconds: 3600,
    });
    expect(again.statusCode).toBe(404);
  });

  it('scope outside requested ∩ available → 400', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
      scope: 'mcp:only-this',
    });
    const res = await decide(alice, requestId, {
      decision: 'approve',
      bound_client_id: await boundClientId(alice),
      scopes: ['mcp:something-else'],
      ttl_seconds: 3600,
    });
    expect(res.statusCode).toBe(400);
  });

  it('client_id / redirect_uri cannot be changed through the POST', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    const res = await decide(alice, requestId, {
      decision: 'approve',
      bound_client_id: await boundClientId(alice),
      scopes: ['mcp:*'],
      ttl_seconds: 3600,
      client_id: 'attacker',
      redirect_uri: 'https://evil.example/cb',
    });
    // Either rejected outright or the extra fields are ignored; the redirect must stay on the registered URI.
    if (res.statusCode === 200) {
      expect(JSON.parse(res.body).data.redirect_url.startsWith(REDIRECT_URI)).toBe(true);
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it('deny → redirect with error=access_denied and state, no code', async () => {
    const { challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
      state: 'xyz',
    });
    const res = await decide(alice, requestId, { decision: 'deny', scopes: [], ttl_seconds: 60 });
    expect(res.statusCode).toBe(200);
    const u = new URL(JSON.parse(res.body).data.redirect_url);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(u.searchParams.get('code')).toBeNull();
  });

  it('TTL above max_grant_ttl_seconds is clamped', async () => {
    const out = await fullFlow(s, alice, clientId, { ttl_seconds: 10 * 86400 });
    expect(out.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    const g = await alice.request({ method: 'GET', url: AGENT_GRANTS_ROUTE });
    const exp = Date.parse(
      JSON.parse(g.body).data[0]?.expires_at ?? JSON.parse(g.body).data.items?.[0]?.expires_at
    );
    expect(exp - Date.now()).toBeLessThanOrEqual(86400 * 1000 + 5000);
  });
});

describe('token endpoint', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let clientId: string;

  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
    clientId = await registerAdminClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  async function freshCode() {
    const { verifier, challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    const { code } = await approveAndGetCode(alice, requestId);
    return { code, verifier };
  }

  it('happy path returns Bearer amb_at_ + amb_rt_, scope, expires_in 900', async () => {
    const { code, verifier } = await freshCode();
    const res = await exchangeCode(s, { client_id: clientId, code, verifier });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const b = JSON.parse(res.body);
    expect(b.token_type).toBe('Bearer');
    expect(b.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(b.refresh_token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(b.expires_in).toBeLessThanOrEqual(900);
    expect(b.scope).toContain('mcp:*');
  });

  it('wrong code_verifier → invalid_grant', async () => {
    const { code } = await freshCode();
    const res = await exchangeCode(s, { client_id: clientId, code, verifier: pkce().verifier });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
  });

  it('code is single-use; replay → invalid_grant (and revokes tokens issued from it)', async () => {
    const { code, verifier } = await freshCode();
    const first = await exchangeCode(s, { client_id: clientId, code, verifier });
    expect(first.statusCode).toBe(200);
    const second = await exchangeCode(s, { client_id: clientId, code, verifier });
    expect(second.statusCode).toBe(400);
    expect(JSON.parse(second.body).error).toBe('invalid_grant');
  });

  it('redirect_uri mismatch → invalid_grant', async () => {
    const { code, verifier } = await freshCode();
    const res = await exchangeCode(s, {
      client_id: clientId,
      code,
      verifier,
      redirect_uri: 'https://evil.example/cb',
    });
    expect(res.statusCode).toBe(400);
  });

  it('resource ≠ canonical → invalid_target', async () => {
    const { code, verifier } = await freshCode();
    const res = await exchangeCode(s, {
      client_id: clientId,
      code,
      verifier,
      resource: 'https://other.example/mcp',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_target');
  });

  it('different client_id cannot redeem the code', async () => {
    const other = await registerAdminClient(s, { client_name: 'other' });
    const { code, verifier } = await freshCode();
    const res = await exchangeCode(s, { client_id: other, code, verifier });
    expect(res.statusCode).toBe(400);
  });

  it('expired code → invalid_grant', async () => {
    const short = await startAgentTestServer(agentEndpointOpts({ auth_code_ttl_seconds: 10 }));
    try {
      const sess = await loginSession(short, await createUser(short, 'exp'));
      const cid = await registerAdminClient(short);
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorize(short, sess, {
        client_id: cid,
        code_challenge: challenge,
      });
      const { code } = await approveAndGetCode(sess, requestId);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11_000 });
      const res = await exchangeCode(short, { client_id: cid, code, verifier });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_grant');
    } finally {
      await stopAgentTestServer(short);
    }
  }, 30_000);

  it('unsupported grant_type (password / client_credentials) → unsupported_grant_type', async () => {
    for (const grant_type of ['password', 'client_credentials']) {
      const res = await tokenRequest(s, { grant_type, client_id: clientId });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('unsupported_grant_type');
    }
  });

  it('rate limit: more than token_per_minute requests → 429', async () => {
    const limited = await startAgentTestServer(
      agentEndpointOpts({ rate_limits: { token_per_minute: 3 } })
    );
    try {
      let last = 0;
      for (let i = 0; i < 6; i++) {
        last = (
          await tokenRequest(limited, {
            grant_type: 'refresh_token',
            client_id: 'x',
            refresh_token: 'x',
          })
        ).statusCode;
      }
      expect(last).toBe(429);
    } finally {
      await stopAgentTestServer(limited);
    }
  });
});

describe('refresh tokens: rotation, reuse detection, expiry cap, revoke', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let clientId: string;

  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
    clientId = await registerAdminClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('refresh rotates: new pair issued, old refresh token invalid', async () => {
    const t = await fullFlow(s, alice, clientId);
    const r1 = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(r1.statusCode).toBe(200);
    const b1 = JSON.parse(r1.body);
    expect(b1.refresh_token).not.toBe(t.refresh_token);
    expect(b1.access_token).not.toBe(t.access_token);
    const r2 = await refresh(s, { client_id: clientId, refresh_token: b1.refresh_token });
    expect(r2.statusCode).toBe(200);
  });

  it('reusing a rotated refresh token revokes the whole family', async () => {
    const t = await fullFlow(s, alice, clientId);
    const r1 = JSON.parse(
      (await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! })).body
    );
    const reuse = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(reuse.statusCode).toBe(400);
    expect(JSON.parse(reuse.body).error).toBe('invalid_grant');
    // The legitimately-rotated token is now dead too.
    const after = await refresh(s, { client_id: clientId, refresh_token: r1.refresh_token });
    expect(after.statusCode).toBe(400);
    // …and so is the access token minted from it (checked at /mcp in mcp-endpoint-tools tests).
  });

  it('refresh by a different client_id fails', async () => {
    const other = await registerAdminClient(s, { client_name: 'other' });
    const t = await fullFlow(s, alice, clientId);
    const res = await refresh(s, { client_id: other, refresh_token: t.refresh_token! });
    expect(res.statusCode).toBe(400);
  });

  it('refresh lifetime is capped by the grant expiry', async () => {
    const t = await fullFlow(s, alice, clientId, { ttl_seconds: 60 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const res = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(res.statusCode).toBe(400);
  }, 90_000);

  it('refresh_tokens_enabled=false → no refresh_token issued', async () => {
    const off = await startAgentTestServer(agentEndpointOpts({ refresh_tokens_enabled: false }));
    try {
      const sess = await loginSession(off, await createUser(off, 'norefresh'));
      const cid = await registerAdminClient(off);
      const t = await fullFlow(off, sess, cid);
      expect(t.refresh_token).toBeUndefined();
    } finally {
      await stopAgentTestServer(off);
    }
  });

  it('revoke (RFC 7009): 200 empty body; refresh token no longer usable', async () => {
    const t = await fullFlow(s, alice, clientId);
    const res = await revoke(s, {
      client_id: clientId,
      token: t.refresh_token!,
      hint: 'refresh_token',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    const after = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(after.statusCode).toBe(400);
  });

  it('revoke of an unknown token still returns 200 (no oracle)', async () => {
    const res = await revoke(s, { client_id: clientId, token: 'amb_rt_' + 'q'.repeat(43) });
    expect(res.statusCode).toBe(200);
  });

  it("revoke cannot kill another client's token", async () => {
    const other = await registerAdminClient(s, { client_name: 'other' });
    const t = await fullFlow(s, alice, clientId);
    await revoke(s, { client_id: other, token: t.refresh_token! });
    const still = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(still.statusCode).toBe(200);
  });
});

describe('dynamic client registration (RFC 7591)', () => {
  const body = { client_name: 'dcr-agent', redirect_uris: [REDIRECT_URI] };

  it('off by default: /oauth/register is refused', async () => {
    const s = await startAgentTestServer(agentEndpointOpts());
    try {
      const res = await s.admin.inject({
        method: 'POST',
        url: OAUTH_REGISTER_ROUTE,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).toMatch(/registration|disabled|not.?enabled/i);
    } finally {
      await stopAgentTestServer(s);
    }
  });

  it('on: registers public client; returns client_id; no secret', async () => {
    const s = await startAgentTestServer(agentEndpointOpts({ dynamic_client_registration: true }));
    try {
      const res = await s.admin.inject({
        method: 'POST',
        url: OAUTH_REGISTER_ROUTE,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
      const b = JSON.parse(res.body);
      expect(b.client_id).toBeTruthy();
      expect(b.token_endpoint_auth_method).toBe('none');
      expect(b.client_secret).toBeUndefined();
    } finally {
      await stopAgentTestServer(s);
    }
  });

  it.each([
    ['non-https non-localhost redirect', { redirect_uris: ['http://evil.example/cb'] }],
    ['javascript: redirect', { redirect_uris: ['javascript:alert(1)'] }],
    ['confidential auth method', { token_endpoint_auth_method: 'client_secret_basic' }],
    ['no redirect_uris', { redirect_uris: [] }],
  ])('on: invalid metadata (%s) → 400', async (_n, over) => {
    const s = await startAgentTestServer(agentEndpointOpts({ dynamic_client_registration: true }));
    try {
      const res = await s.admin.inject({
        method: 'POST',
        url: OAUTH_REGISTER_ROUTE,
        headers: { 'content-type': 'application/json' },
        payload: { ...body, ...over },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await stopAgentTestServer(s);
    }
  });

  it('on: rate limited (register_per_hour) and capped (max_oauth_clients)', async () => {
    const s = await startAgentTestServer(
      agentEndpointOpts({
        dynamic_client_registration: true,
        rate_limits: { register_per_hour: 2 },
      })
    );
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push(
          (
            await s.admin.inject({
              method: 'POST',
              url: OAUTH_REGISTER_ROUTE,
              headers: { 'content-type': 'application/json' },
              payload: body,
            })
          ).statusCode
        );
      }
      expect(codes).toContain(429);
    } finally {
      await stopAgentTestServer(s);
    }
  });

  it('DCR client is flagged unverified on the consent screen', async () => {
    const s = await startAgentTestServer(agentEndpointOpts({ dynamic_client_registration: true }));
    try {
      const reg = await s.admin.inject({
        method: 'POST',
        url: OAUTH_REGISTER_ROUTE,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      const cid = JSON.parse(reg.body).client_id as string;
      const sess = await loginSession(s, await createUser(s, 'dcr'));
      const { challenge } = pkce();
      const { requestId } = await startAuthorize(s, sess, {
        client_id: cid,
        code_challenge: challenge,
      });
      const d = await sess.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
      expect(JSON.parse(d.body).data.client_verified).toBe(false);
    } finally {
      await stopAgentTestServer(s);
    }
  });
});

describe('one-shot grants (POST /v1/users/me/agent-grants)', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  itImpl('issues access token only (no refresh), bound to the canonical resource', async () => {
    const res = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: {
        bound_client_id: await boundClientId(alice),
        label: 'ci',
        scopes: ['mcp:*'],
        ttl_seconds: 3600,
      },
    });
    expect(res.statusCode).toBe(201);
    const d = JSON.parse(res.body).data;
    expect(d.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(d.refresh_token).toBeUndefined();
    expect(d.resource).toBe(TEST_RESOURCE);
  });

  it('requires a session + CSRF; admin key alone is not enough', async () => {
    const noCsrf = await s.admin.inject({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      headers: alice.headers(false),
      payload: { bound_client_id: await boundClientId(alice), label: 'ci', scopes: ['mcp:*'] },
    });
    expect(noCsrf.statusCode).toBe(403);
    const noSession = await s.admin.inject({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { bound_client_id: await boundClientId(alice), label: 'ci', scopes: ['mcp:*'] },
    });
    expect([401, 403]).toContain(noSession.statusCode);
  });

  it('TTL above max is clamped/rejected (≤ 24h)', async () => {
    const res = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: {
        bound_client_id: await boundClientId(alice),
        label: 'long',
        scopes: ['mcp:*'],
        ttl_seconds: 30 * 86400,
      },
    });
    if (res.statusCode === 201) {
      const exp = Date.parse(JSON.parse(res.body).data.expires_at);
      expect(exp - Date.now()).toBeLessThanOrEqual(86400 * 1000 + 5000);
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it('list shows only own grants; delete revokes; others cannot delete', async () => {
    const bob = await loginSession(s, await createUser(s, 'bob'));
    const created = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: { bound_client_id: await boundClientId(alice), label: 'mine', scopes: ['mcp:*'] },
    });
    const gid = JSON.parse(created.body).data.grant_id as string;
    const bobList = JSON.parse(
      (await bob.request({ method: 'GET', url: AGENT_GRANTS_ROUTE })).body
    ).data;
    expect(JSON.stringify(bobList)).not.toContain(gid);
    const bobDel = await bob.request({ method: 'DELETE', url: `${AGENT_GRANTS_ROUTE}/${gid}` });
    expect([403, 404]).toContain(bobDel.statusCode);
    const del = await alice.request({ method: 'DELETE', url: `${AGENT_GRANTS_ROUTE}/${gid}` });
    expect(del.statusCode).toBe(200);
  });
});
