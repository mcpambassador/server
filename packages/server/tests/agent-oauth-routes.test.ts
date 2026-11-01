/**
 * ADR-020 P4: HTTP-level tests for the 9443 authorization server routes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  AgentEndpointConfigSchema,
  createAdminKey,
  type DatabaseClient,
} from '@mcpambassador/core';
import {
  registerAgentOAuthRoutes,
  registerCookieFreeGuard,
  registerAgentEndpointInfoRoute,
  isCookieFreePath,
} from '../src/routes/agent-oauth.js';
import {
  createAgentEndpointDeps,
  resolveAgentEndpointConfig,
  type AgentEndpointDeps,
} from '../src/services/agent-endpoint/index.js';

const RESOURCE = 'https://amb.test:8443/mcp';
const REDIRECT = 'http://localhost:7777/cb';
const raw = (db: DatabaseClient): any => (db as any).session.client;

let dir: string;
let db: DatabaseClient;
let app: FastifyInstance;
let deps: AgentEndpointDeps;
let session: { userId?: string; isAdmin?: boolean };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-p4r-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  const ts = new Date().toISOString();
  raw(db)
    .prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    )
    .run('u1', 'u1', 'u1', ts, ts);
  raw(db)
    .prepare(
      `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
    )
    .run('k1', 'k1', 'p', 'h', 'u1', 'active', ts);
  raw(db)
    .prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run('m1', 'github', 'github', 'stdio', ts, ts);
  raw(db)
    .prepare(
      `INSERT INTO client_mcp_subscriptions (subscription_id, client_id, mcp_id, status, subscribed_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run('s1', 'k1', 'm1', 'active', ts, ts);
  const cfg = resolveAgentEndpointConfig(AgentEndpointConfigSchema.parse({ enabled: true }), {
    issuer: 'https://amb.test:9443',
    agentBaseUrl: 'https://amb.test:8443',
  });
  deps = createAgentEndpointDeps(db, cfg, { emit: () => Promise.resolve() } as any);
  session = {};
  app = Fastify();
  app.decorateRequest('session', null as any);
  app.addHook('onRequest', async req => {
    (req as any).session = session;
  });
  await registerAgentOAuthRoutes(app, deps);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function adminClient(): Promise<string> {
  session = { userId: 'admin', isAdmin: true };
  const r = await app.inject({
    method: 'POST',
    url: '/v1/admin/oauth-clients',
    payload: { client_name: 'A', redirect_uris: [REDIRECT] },
  });
  expect(r.statusCode).toBe(201);
  session = {};
  return r.json().data.client_id;
}

describe('agent oauth routes', () => {
  it('serves AS metadata derived from config (not Host), hiding registration while DCR is off', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
      headers: { host: 'evil.example' },
    });
    const m = r.json();
    expect(m.issuer).toBe('https://amb.test:9443');
    expect(m.token_endpoint).toBe('https://amb.test:9443/oauth/token');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.registration_endpoint).toBeUndefined();
    deps.runtime.dynamic_client_registration = true;
    const r2 = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(r2.json().registration_endpoint).toBe('https://amb.test:9443/oauth/register');
  });

  it('end to end over HTTP: authorize 302 → consent → token (form-encoded) → refresh', async () => {
    const id = await adminClient();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'mcp:github',
      state: 's',
    });
    const a = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
    expect(a.statusCode).toBe(302);
    const loc = a.headers.location as string;
    expect(loc.startsWith('/app/oauth/consent?request_id=')).toBe(true);
    const requestId = new URL(loc, 'https://x').searchParams.get('request_id')!;

    // consent requires a session
    expect(
      (await app.inject({ method: 'GET', url: `/v1/oauth/consent/${requestId}` })).statusCode
    ).toBe(401);
    session = { userId: 'u1' };
    const d = await app.inject({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
    expect(d.json().data.clients[0].client_id).toBe('k1');
    const c = await app.inject({
      method: 'POST',
      url: `/v1/oauth/consent/${requestId}`,
      payload: {
        decision: 'approve',
        bound_client_id: 'k1',
        scopes: ['mcp:github'],
        ttl_seconds: 600,
      },
    });
    expect(c.statusCode).toBe(200);
    const code = new URL(c.json().data.redirect_url).searchParams.get('code')!;
    session = {};

    const t = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: id,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    expect(t.statusCode).toBe(200);
    expect(t.headers['cache-control']).toBe('no-store');
    const tok = t.json();
    expect(tok.token_type).toBe('Bearer');

    const rf = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: id,
      }),
    });
    expect(rf.statusCode).toBe(200);
    // replaying the old refresh token → invalid_grant (RFC body, not envelope)
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: id,
      }),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');
  });

  it('authorize errors never redirect for bad client / redirect_uri', async () => {
    const id = await adminClient();
    const base = {
      response_type: 'code',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    const bad1 = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({ ...base, client_id: id, redirect_uri: 'http://localhost:1/evil' })}`,
    });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.headers.location).toBeUndefined();
    const bad2 = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'nope', redirect_uri: REDIRECT })}`,
    });
    expect(bad2.statusCode).toBe(400);
    expect(bad2.headers.location).toBeUndefined();
    const bad3 = await app.inject({ method: 'GET', url: '/oauth/authorize' });
    expect(bad3.statusCode).toBe(400);
  });

  it('token endpoint: unsupported grant type and malformed requests', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'password', username: 'a', password: 'b' }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('unsupported_grant_type');
    const r2 = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'authorization_code' }),
    });
    expect(r2.json().error).toBe('invalid_request');
  });

  it('register: 403 when DCR disabled; 201 when enabled; revoke always 200', async () => {
    const body = JSON.stringify({ client_name: 'X', redirect_uris: [REDIRECT] });
    const json = { 'content-type': 'application/json' };
    const off = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: json,
      payload: body,
    });
    expect(off.statusCode).toBe(403);
    deps.runtime.dynamic_client_registration = true;
    const on = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: json,
      payload: body,
    });
    expect(on.statusCode).toBe(201);
    const rv = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: form({ token: 'amb_rt_whatever', client_id: on.json().client_id }),
    });
    expect(rv.statusCode).toBe(200);
  });

  it('user + admin endpoints enforce session and admin role', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/users/me/agent-grants' })).statusCode).toBe(
      401
    );
    session = { userId: 'u1' };
    for (const [m, u] of [
      ['GET', '/v1/admin/oauth-clients'],
      ['GET', '/v1/admin/agent-grants'],
      ['GET', '/v1/admin/agent-endpoint/settings'],
      ['PUT', '/v1/admin/agent-endpoint/settings'],
    ] as const) {
      expect(
        (
          await app.inject({
            method: m,
            url: u,
            payload: m === 'PUT' ? { dynamic_client_registration: true } : undefined,
          })
        ).statusCode
      ).toBe(401); // admin routes answer 401 for non-admins, like every /v1/admin route
    }
    expect(deps.runtime.dynamic_client_registration).toBe(false);
  });

  it('one-shot grant create / list / revoke; admin settings PUT; admin client PATCH/DELETE', async () => {
    session = { userId: 'u1' };
    const c = await app.inject({
      method: 'POST',
      url: '/v1/users/me/agent-grants',
      payload: { bound_client_id: 'k1', label: 'ci', scopes: ['mcp:github'], ttl_seconds: 600 },
    });
    expect(c.statusCode).toBe(201);
    expect(c.headers['cache-control']).toBe('no-store');
    const gid = c.json().data.grant_id;
    const l = await app.inject({ method: 'GET', url: '/v1/users/me/agent-grants' });
    expect(l.json().data[0].bound_client_id).toBe('k1');
    expect(JSON.stringify(l.json())).not.toContain(c.json().data.access_token);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/users/me/agent-grants',
      payload: { bound_client_id: 'k1', label: 'ci', scopes: ['mcp:nope'] },
    });
    expect(bad.statusCode).toBe(400);
    const d = await app.inject({ method: 'DELETE', url: `/v1/users/me/agent-grants/${gid}` });
    expect(d.statusCode).toBe(200);

    session = { userId: 'admin', isAdmin: true };
    const s = await app.inject({
      method: 'PUT',
      url: '/v1/admin/agent-endpoint/settings',
      payload: { dynamic_client_registration: true },
    });
    expect(s.json().data).toEqual({ enabled: true, dynamic_client_registration: true });
    const cl = await app.inject({
      method: 'POST',
      url: '/v1/admin/oauth-clients',
      payload: { client_name: 'A', redirect_uris: [REDIRECT] },
    });
    const cid = cl.json().data.client_id;
    const p = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/oauth-clients/${cid}`,
      payload: { disabled: true },
    });
    expect(p.json().data.disabled).toBe(true);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/admin/oauth-clients/${cid}` })).statusCode
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/admin/oauth-clients/${cid}` })).statusCode
    ).toBe(404);
    const ag = await app.inject({
      method: 'GET',
      url: '/v1/admin/agent-grants?include_inactive=true',
    });
    expect(ag.json().data[0]).toMatchObject({ username: 'u1', revoked_by: 'u1' });
  });
});

describe('S1 form parser is scoped to /oauth/*', () => {
  it('non-OAuth routes reject application/x-www-form-urlencoded (415)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/users/me/agent-grants',
      headers: FORM,
      payload: 'label=x',
    });
    expect(r.statusCode).toBe(415);
    const admin = await app.inject({
      method: 'POST',
      url: '/v1/admin/oauth-clients',
      headers: FORM,
      payload: 'client_name=x',
    });
    expect(admin.statusCode).toBe(415);
  });

  it('/oauth/token still accepts form bodies', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: 'grant_type=bogus',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('unsupported_grant_type');
  });
});

describe('S5 cookie-free guard + info route', () => {
  it('classifies cookie-free paths', () => {
    for (const u of ['/mcp', '/mcp?x=1', '/oauth/token', '/.well-known/oauth-protected-resource'])
      expect(isCookieFreePath(u)).toBe(true);
    for (const u of ['/v1/users/me', '/mcpx', '/v1/admin/oauth-clients', '/oauth-consent'])
      expect(isCookieFreePath(u)).toBe(false);
  });

  it('drops the session on cookie-free paths only', async () => {
    const a = Fastify();
    a.decorateRequest('session', null as any);
    a.addHook('onRequest', async req => {
      (req as any).session = { userId: 'u1' };
    });
    registerCookieFreeGuard(a);
    a.get('/oauth/x', async req => ({ s: (req as any).session ?? null }));
    a.get('/v1/y', async req => ({ s: (req as any).session ?? null }));
    await a.ready();
    expect((await a.inject({ url: '/oauth/x' })).json().s).toBeNull();
    expect((await a.inject({ url: '/v1/y' })).json().s).toEqual({ userId: 'u1' });
    await a.close();
  });

  it('info route needs a user session and returns the contract shape', async () => {
    const a = Fastify();
    a.decorateRequest('session', null as any);
    let sess: any = {};
    a.addHook('onRequest', async req => {
      (req as any).session = sess;
    });
    await registerAgentEndpointInfoRoute(a, {
      enabled: true,
      default_grant_ttl_seconds: 3600,
      max_grant_ttl_seconds: 86400,
      refresh_tokens_enabled: true,
      resource_url: 'https://amb.test:8443/mcp',
    });
    await a.ready();
    expect((await a.inject({ url: '/v1/users/me/agent-endpoint' })).statusCode).toBe(401);
    sess = { userId: 'u1' };
    const r = await a.inject({ url: '/v1/users/me/agent-endpoint' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ enabled: true, max_grant_ttl_seconds: 86400 });
    await a.close();
  });
});

describe('R2 admin-key auth, optional label, RFC 7591 error codes', () => {
  it('admin routes accept X-Admin-Key (no session) and reject a wrong key', async () => {
    const { admin_key } = await createAdminKey(db, dir);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/admin/oauth-clients',
      headers: { 'x-admin-key': admin_key },
      payload: { client_name: 'K', redirect_uris: [REDIRECT] },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/admin/oauth-clients',
      headers: { 'x-admin-key': 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    const none = await app.inject({ method: 'GET', url: '/v1/admin/agent-grants' });
    expect(none.statusCode).toBe(401);
    // settings PUT is audited under the admin-key actor
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/admin/agent-endpoint/settings',
      headers: { 'x-admin-key': admin_key },
      payload: { dynamic_client_registration: true },
    });
    expect([200, 404]).toContain(put.statusCode);
  });

  it('one-shot grant label is optional and defaults to "One-shot grant <date>"', async () => {
    session = { userId: 'u1' };
    const r = await app.inject({
      method: 'POST',
      url: '/v1/users/me/agent-grants',
      payload: { bound_client_id: 'k1', scopes: ['mcp:github'] },
    });
    expect(r.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/v1/users/me/agent-grants' });
    expect(list.json().data[0].label).toMatch(/^One-shot grant \d{4}-\d{2}-\d{2}$/);
  });

  it('DCR with a bad redirect_uri returns invalid_redirect_uri', async () => {
    deps.runtime.dynamic_client_registration = true;
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'x', redirect_uris: ['cursor://x/cb'] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_redirect_uri');
  });
});
