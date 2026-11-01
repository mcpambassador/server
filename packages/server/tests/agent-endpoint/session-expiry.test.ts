/**
 * R1 blocker B1: admin/SPA sessions on 9443 must expire server-side.
 * Regression tests (plain `it`, RED until platform lands the fix): a session older than
 * session.ui_ttl_seconds is rejected even with a valid cookie; the cookie carries Max-Age;
 * a fresh login works; the TTL is absolute (activity does not extend it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  startAgentTestServer,
  stopAgentTestServer,
  createUser,
  loginSession,
  type AgentTestServer,
} from './helpers.js';

const TTL = 2;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let s: AgentTestServer | undefined;
afterEach(async () => {
  if (s) await stopAgentTestServer(s);
  s = undefined;
});

async function start(): Promise<AgentTestServer> {
  s = await startAgentTestServer({
    ambassadorConfig: { session: { ui_ttl_seconds: TTL } } as never,
  });
  return s;
}

const me = (srv: AgentTestServer, cookie: string) =>
  srv.admin.inject({ method: 'GET', url: '/v1/users/me', headers: { cookie } });

describe('SPA session expiry (session.ui_ttl_seconds)', () => {
  it('fresh login works', async () => {
    const srv = await start();
    const sess = await loginSession(srv, await createUser(srv, 'alice'));
    expect((await me(srv, sess.cookies.header())).statusCode).toBe(200);
  });

  it('session cookie is set with Max-Age <= ui_ttl_seconds', async () => {
    const srv = await start();
    const creds = await createUser(srv, 'alice');
    const pre = await srv.admin.inject({ method: 'GET', url: '/v1/csrf-token' });
    const csrf = (JSON.parse(pre.body) as { csrfToken: string }).csrfToken;
    const jar = (pre.headers['set-cookie'] as string[] | string | undefined) ?? [];
    const cookie = (Array.isArray(jar) ? jar : [jar]).map(c => c.split(';')[0]).join('; ');
    const login = await srv.admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: creds,
    });
    expect(login.statusCode).toBe(200);
    const raw = ([] as string[]).concat(
      (login.headers['set-cookie'] as string[] | string | undefined) ?? []
    );
    const sid = raw.find(c => !/^csrf|^_csrf/i.test(c) && /httponly/i.test(c));
    expect(sid, `no session cookie in ${JSON.stringify(raw)}`).toBeTruthy();
    const m = /max-age=(\d+)/i.exec(sid!);
    expect(m, `no Max-Age on ${sid}`).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(TTL);
  });

  it('a session older than the TTL is rejected even with a valid cookie', async () => {
    const srv = await start();
    const sess = await loginSession(srv, await createUser(srv, 'alice'));
    const cookie = sess.cookies.header();
    expect((await me(srv, cookie)).statusCode).toBe(200);
    await sleep((TTL + 1) * 1000);
    expect((await me(srv, cookie)).statusCode).toBe(401);
  }, 15_000);

  it('TTL is absolute: activity inside the window does not extend it', async () => {
    const srv = await start();
    const sess = await loginSession(srv, await createUser(srv, 'alice'));
    const cookie = sess.cookies.header();
    await sleep(1000);
    expect((await me(srv, cookie)).statusCode).toBe(200);
    await sleep(2200);
    expect((await me(srv, cookie)).statusCode).toBe(401);
  }, 15_000);

  it('after expiry the user can log in again and the old cookie stays dead', async () => {
    const srv = await start();
    const creds = await createUser(srv, 'alice');
    const old = await loginSession(srv, creds);
    await sleep((TTL + 1) * 1000);
    const fresh = await loginSession(srv, creds);
    expect((await me(srv, fresh.cookies.header())).statusCode).toBe(200);
    expect((await me(srv, old.cookies.header())).statusCode).toBe(401);
  }, 15_000);
});
