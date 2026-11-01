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
});
