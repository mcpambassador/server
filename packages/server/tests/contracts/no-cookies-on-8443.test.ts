/**
 * F1: the client-facing 8443 listener serves no browser cookie-session API.
 * Cookie/CSRF routes exist ONLY on the 9443 admin/SPA listener.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';

const COOKIE_ROUTES: Array<[string, string]> = [
  ['POST', '/v1/auth/login'],
  ['POST', '/v1/auth/logout'],
  ['GET', '/v1/auth/session'],
  ['GET', '/v1/csrf-token'],
  ['GET', '/v1/users/me'],
  ['PATCH', '/v1/users/me/password'],
  ['GET', '/v1/users/me/clients'],
  ['POST', '/v1/users/me/clients'],
  ['GET', '/v1/users/me/credentials'],
  ['GET', '/v1/marketplace'],
];

let s: TestServerHandle;

beforeAll(async () => {
  s = await startTestServer();
  await createUser(s.db, {
    username: 'f1user',
    password: 'f1pass1234',
    display_name: 'F1',
    is_admin: false,
  });
});
afterAll(async () => {
  await stopTestServer(s);
});

describe('F1: no cookie-session API on 8443', () => {
  it.each(COOKIE_ROUTES)('%s %s → 404 on 8443, no Set-Cookie', async (method, url) => {
    const res = await s.fastify.inject({
      method: method as 'GET',
      url,
      payload: method === 'GET' ? undefined : { username: 'f1user', password: 'f1pass1234' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a successful login on 9443 sets the session cookie, the same attempt on 8443 does not', async () => {
    const creds = { username: 'f1user', password: 'f1pass1234' };
    const on8443 = await s.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: creds,
    });
    expect(on8443.statusCode).toBe(404);
    expect(on8443.headers['set-cookie']).toBeUndefined();

    const on9443 = await s.admin.inject({ method: 'POST', url: '/v1/auth/login', payload: creds });
    expect(on9443.statusCode).toBe(200);
    expect(on9443.headers['set-cookie']).toBeDefined();
  });

  it('a valid 9443 session cookie grants nothing on 8443', async () => {
    const login = await s.admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'f1user', password: 'f1pass1234' },
    });
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)]).map(c => c.split(';')[0]).join('; ');
    const res = await s.fastify.inject({ method: 'GET', url: '/v1/users/me', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('no response from the client-facing listener sets a cookie (health, tools, sessions, unknown)', async () => {
    for (const [method, url] of [
      ['GET', '/health'],
      ['GET', '/v1/tools'],
      ['POST', '/v1/sessions/register'],
      ['GET', '/does-not-exist'],
    ] as const) {
      const res = await s.fastify.inject({
        method,
        url,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.headers['set-cookie'], `${method} ${url}`).toBeUndefined();
    }
  });

  it('a valid 9443 ADMIN session cookie sent to /v1/admin/* on 8443 gets 401', async () => {
    await createUser(s.db, {
      username: 'f1admin',
      password: 'f1admin1234',
      display_name: 'F1 Admin',
      is_admin: true,
    });
    const login = await s.admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'f1admin', password: 'f1admin1234' },
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)]).map(c => c.split(';')[0]).join('; ');
    // sanity: the same cookie is accepted on 9443
    const ok = await s.admin.inject({
      method: 'GET',
      url: '/v1/admin/clients',
      headers: { cookie },
    });
    expect(ok.statusCode).toBeLessThan(300);
    for (const url of ['/v1/admin/clients', '/v1/admin/kill-switches']) {
      const res = await s.fastify.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['set-cookie'], url).toBeUndefined();
    }
  });
});

describe('percent-encoded paths cannot dodge the CSRF skip or the cookie-free guard', () => {
  const sessionCookie = async (): Promise<string> => {
    const login = await s.admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'f1user', password: 'f1pass1234' },
    });
    const raw = login.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : [String(raw)]).map(c => c.split(';')[0]).join('; ');
  };

  it.each(['/%6Fauth/token', '/%6Dcp', '/oauth/%74oken', '/%4Dcp'])(
    '%s on 8443 behaves like the decoded path and never sets a cookie',
    async url => {
      for (const method of ['GET', 'POST'] as const) {
        const res = await s.fastify.inject({
          method,
          url,
          payload: method === 'POST' ? {} : undefined,
        });
        expect(res.headers['set-cookie'], `${method} ${url}`).toBeUndefined();
        expect(res.statusCode, `${method} ${url}`).not.toBeGreaterThanOrEqual(500);
      }
    }
  );

  it.each([
    '/v1/users/me/%63lients',
    '/v1/%75sers/me/clients',
    '/v1/users/me/clients/',
    '/%76%31/users/me/clients',
  ])(
    'state-changing cookie-authenticated POST %s on 9443 without CSRF is still refused',
    async url => {
      const cookie = await sessionCookie();
      const res = await s.admin.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: { name: 'csrf-probe' },
      });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).not.toBe(201);
    }
  );

  it.each(['/%6Fauth/token', '/%6Dcp', '/oauth/%74oken'])(
    '%s on 9443 with a session cookie: no CSRF bypass for cookie-authed requests',
    async url => {
      const cookie = await sessionCookie();
      const res = await s.admin.inject({ method: 'POST', url, headers: { cookie }, payload: {} });
      // whatever it is, it must not be treated as an authenticated 2xx via the cookie
      expect(res.statusCode, url).not.toBeLessThan(300);
    }
  );
});
