/**
 * S2/S4: admin-key auth on the 9443 listener.
 * - CSRF is skipped only when the key VALIDATES; an invalid key is 401 and never falls through to a cookie session.
 * - Key-authenticated requests carry the audit identity admin-key:<id>.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startAgentTestServer,
  stopAgentTestServer,
  loginSession,
  type AgentTestServer,
} from './agent-endpoint/helpers.js';
import { createUser as createDbUser } from '../src/auth/user-auth.js';
import { AgentEndpointConfigSchema } from '@mcpambassador/core';
import { verifyAdminKeyHeader, adminKeyActor } from '../src/admin/middleware.js';

let s: AgentTestServer;
const CLIENTS = '/v1/admin/oauth-clients';
const body = { client_name: 'S2', redirect_uris: ['http://localhost:7777/cb'] };

beforeAll(async () => {
  s = await startAgentTestServer({
    ambassadorConfig: {
      agent_endpoint: AgentEndpointConfigSchema.parse({
        enabled: true,
        issuer_url: 'https://amb.test:9443',
        resource_base_url: 'https://amb.test:8443',
      }),
    } as never,
  });
});
afterAll(async () => {
  await stopAgentTestServer(s);
});

describe('S2 admin key vs CSRF vs session', () => {
  it('valid key skips CSRF (201)', async () => {
    const r = await s.admin.inject({
      method: 'POST',
      url: CLIENTS,
      headers: { 'x-admin-key': s.adminKey },
      payload: body,
    });
    expect(r.statusCode).toBe(201);
  });

  it('invalid key without CSRF token → 401 (not a CSRF pass-through)', async () => {
    const r = await s.admin.inject({
      method: 'POST',
      url: CLIENTS,
      headers: { 'x-admin-key': 'amb_ak_wrong' },
      payload: body,
    });
    expect(r.statusCode).toBe(401);
  });

  it('invalid key + valid ADMIN session + valid CSRF → 401 (never falls through to the cookie session)', async () => {
    const u = { username: `adm_${Date.now()}`, password: 'Adm1n-Passw0rd-xyz!' };
    await createDbUser(s.db, {
      username: u.username,
      password: u.password,
      display_name: 'Adm',
      is_admin: true,
    });
    const sess = await loginSession(s, u);
    // sanity: the same session works as admin without a key
    const ok = await s.admin.inject({
      method: 'POST',
      url: CLIENTS,
      headers: sess.headers(true),
      payload: body,
    });
    expect([ok.statusCode, ok.body]).toEqual([201, expect.anything()]);
    const bad = await s.admin.inject({
      method: 'POST',
      url: CLIENTS,
      headers: { ...sess.headers(true), 'x-admin-key': 'amb_ak_wrong' },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);
    const badGet = await s.admin.inject({
      method: 'GET',
      url: CLIENTS,
      headers: { ...sess.headers(), 'x-admin-key': 'amb_ak_wrong' },
    });
    expect(badGet.statusCode).toBe(401);
  });
});

describe('S4 key identity', () => {
  it('verified key sets admin-key:<id>; invalid sets nothing; no header is none', async () => {
    const req: any = { headers: { 'x-admin-key': s.adminKey } };
    expect(await verifyAdminKeyHeader(s.db, req)).toBe('valid');
    expect(adminKeyActor(req)).toMatch(/^admin-key:\d+$/);
    expect(adminKeyActor(req)).not.toContain(s.adminKey.slice(0, 8));

    const bad: any = { headers: { 'x-admin-key': 'nope' } };
    expect(await verifyAdminKeyHeader(s.db, bad)).toBe('invalid');
    expect(adminKeyActor(bad)).toBeUndefined();
    expect(await verifyAdminKeyHeader(s.db, { headers: {} } as any)).toBe('none');
  });
});

describe('S6 admin key pre-check + rate limit', () => {
  // Last in the file: the limiter state lives in the server's own module instance (dist) and cannot be reset from here.
  it('malformed keys are rejected without argon2; 20+ bad attempts from one IP also block a valid key', async () => {
    const bad = ['amb_ak_short', 'x'.repeat(200), 'amb_ak_' + '!'.repeat(48)];
    for (const k of bad) {
      const r = await s.admin.inject({
        method: 'GET',
        url: '/v1/admin/oauth-clients',
        headers: { 'x-admin-key': k },
      });
      expect(r.statusCode).toBe(401);
    }
    // well-formed but wrong keys count too
    const wrong = 'amb_ak_' + 'A'.repeat(48);
    for (let i = 0; i < 20; i++) {
      await s.admin.inject({
        method: 'GET',
        url: '/v1/admin/oauth-clients',
        headers: { 'x-admin-key': wrong },
      });
    }
    const limited = await s.admin.inject({
      method: 'GET',
      url: '/v1/admin/oauth-clients',
      headers: { 'x-admin-key': s.adminKey },
    });
    expect(limited.statusCode).toBe(401);
  });
});
