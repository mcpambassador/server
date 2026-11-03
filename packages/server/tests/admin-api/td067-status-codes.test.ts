/**
 * TD-067: unauthenticated admin POST -> 401, bad/missing CSRF on a real session -> 403,
 * empty/invalid JSON body -> 400. Exercises the real CSRF + session hooks on the 9443 listener.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from './helpers';
import { createUser } from '../../src/auth/user-auth.js';

let h: TestServerHandle;
const raw = () => h.admin.raw;
const cookiesOf = (sc: unknown): string[] =>
  (Array.isArray(sc) ? sc : sc ? [String(sc)] : []).map(c => String(c).split(';')[0]!);

/** csrf cookie + token pair, as the SPA obtains them. */
async function csrf(extraCookie = ''): Promise<{ cookie: string; token: string }> {
  const r = await raw().inject({
    method: 'GET',
    url: '/v1/csrf-token',
    headers: extraCookie ? { cookie: extraCookie } : {},
  });
  const cookie = [
    extraCookie,
    ...cookiesOf(r.headers['set-cookie']).filter(c => c.startsWith('_csrf=')),
  ]
    .filter(Boolean)
    .join('; ');
  return { cookie, token: (r.json() as { csrfToken: string }).csrfToken };
}

async function login(username: string, isAdmin: boolean): Promise<string> {
  await createUser(h.db, {
    username,
    password: 'pass1234',
    display_name: username,
    is_admin: isAdmin,
  });
  const c = await csrf();
  const r = await raw().inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { cookie: c.cookie, 'x-csrf-token': c.token },
    payload: { username, password: 'pass1234' },
  });
  expect(r.statusCode).toBe(200);
  return [c.cookie, ...cookiesOf(r.headers['set-cookie'])].join('; ');
}

beforeAll(async () => {
  h = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(h);
});

const URL_POST = '/v1/admin/mcps/00000000-0000-4000-8000-000000000000/discover';

describe('unauthenticated admin POST is 401, not 500', () => {
  it('no cookies at all', async () => {
    const r = await raw().inject({ method: 'POST', url: URL_POST, payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHORIZED');
  });
  it('csrf cookie+token but no session', async () => {
    const c = await csrf();
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: c.cookie, 'x-csrf-token': c.token },
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });
  it('invalid csrf token and no session is still 401', async () => {
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { 'x-csrf-token': 'nope' },
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });
  it('a non-admin user session is 401 on admin routes', async () => {
    const cookie = await login('td067user', false);
    const c = await csrf(cookie);
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: c.cookie, 'x-csrf-token': c.token },
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });
  it('an invalid admin key is still 401', async () => {
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { 'x-admin-key': 'invalid_key' },
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('authenticated admin session: CSRF and body errors', () => {
  let session: string;
  beforeAll(async () => {
    session = await login('td067admin', true);
  });

  it('missing csrf token -> 403', async () => {
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: session },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
  });
  it('missing csrf secret cookie (session only, token supplied) -> 403, not 500', async () => {
    const withCsrf = await csrf();
    const sessionOnly = session
      .split('; ')
      .filter(c => !c.startsWith('_csrf='))
      .join('; ');
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: sessionOnly, 'x-csrf-token': withCsrf.token },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });
  it('wrong csrf token -> 403', async () => {
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: session, 'x-csrf-token': 'wrong' },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });
  it('valid csrf + empty JSON body -> 400', async () => {
    const c = await csrf(session);
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: c.cookie, 'x-csrf-token': c.token, 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_REQUEST');
  });
  it('valid csrf + malformed JSON -> 400 without echoing the input', async () => {
    const c = await csrf(session);
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: c.cookie, 'x-csrf-token': c.token, 'content-type': 'application/json' },
      payload: '{"secret-marker": nope',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('secret-marker');
  });
  it('valid csrf + valid body reaches the route (404 for the unknown MCP)', async () => {
    const c = await csrf(session);
    const r = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { cookie: c.cookie, 'x-csrf-token': c.token },
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('admin key still bypasses CSRF', () => {
  it('valid key, no csrf token, reaches the route (404 unknown MCP)', async () => {
    const ok = await raw().inject({
      method: 'POST',
      url: URL_POST,
      headers: { 'x-admin-key': h.adminKey },
      payload: {},
    });
    expect(ok.statusCode).toBe(404);
  });
});
