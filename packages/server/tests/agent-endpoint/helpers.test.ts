import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startAgentTestServer,
  stopAgentTestServer,
  createUser,
  loginSession,
  type AgentTestServer,
} from './helpers.js';

describe('agent-endpoint test helpers (session + CSRF)', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer();
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('logs in and gets an authenticated session', async () => {
    const u = await createUser(s);
    const sess = await loginSession(s, u);
    const me = await sess.request({ method: 'GET', url: '/v1/users/me' });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).data.username).toBe(u.username);
  });

  it('cookie-authenticated mutation without CSRF header is rejected; with it succeeds', async () => {
    const u = await createUser(s);
    const sess = await loginSession(s, u);
    const bad = await s.admin.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: sess.headers(false),
    });
    expect(bad.statusCode).toBe(403);
    const ok = await sess.request({ method: 'POST', url: '/v1/auth/logout' });
    expect(ok.statusCode).toBeLessThan(300);
  });
});
