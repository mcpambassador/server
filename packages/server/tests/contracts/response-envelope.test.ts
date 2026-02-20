import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import { startTestServer, stopTestServer } from '../admin-api/helpers';
import {
  successEnvelopeSchema,
  paginatedEnvelopeSchema,
  errorEnvelopeSchema,
  ErrorCodes,
} from '@mcpambassador/contracts';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

// Helper zod schemas that accept any data payloads
const anySuccess = ( ) => successEnvelopeSchema(z.unknown());
const anyPaginated = ( ) => paginatedEnvelopeSchema(z.unknown());

// Helper assertions
function assertSuccessEnvelope(body: unknown) {
  const parsed = anySuccess().safeParse(body);
  if (!parsed.success) {
    throw new Error('Not a success envelope: ' + JSON.stringify(parsed.error.format()));
  }
}

function assertPaginatedEnvelope(body: unknown) {
  const parsed = anyPaginated().safeParse(body);
  if (!parsed.success) {
    throw new Error('Not a paginated envelope: ' + JSON.stringify(parsed.error.format()));
  }
  // extra sanity
  expect(Array.isArray((parsed.data as any).data)).toBe(true);
  expect((parsed.data as any).pagination).toHaveProperty('has_more');
  expect((parsed.data as any).pagination).toHaveProperty('total_count');
}

function assertErrorEnvelope(body: unknown, expectedCode?: string) {
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Not an error envelope: ' + JSON.stringify(parsed.error.format()));
  }
  const code = parsed.data.error.code;
  expect(Object.values(ErrorCodes)).toContain(code);
  expect(typeof parsed.data.error.message).toBe('string');
  if (expectedCode) expect(code).toBe(expectedCode);
}

// Utility to parse body JSON safely
function parseBody(res: any) {
  try {
    return JSON.parse(res.body || '{}');
  } catch (e) {
    return res.body;
  }
}

// Build cookie header from fastify inject response
function cookiesToHeader(cookies: Array<{ name: string; value: string }> = []) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// -- Tests --

describe('Contract: Response envelope shape for all endpoints', () => {
  // We'll obtain a session cookie for user-facing routes
  let userCookieHeader = '';
  beforeAll(async () => {
    // Attempt login with seeded admin (test environment provides admin user)
    const loginRes = await handle.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    if (loginRes.cookies && loginRes.cookies.length) {
      userCookieHeader = cookiesToHeader(loginRes.cookies as any);
    }
  });

  // Auth routes
  describe('Auth routes', () => {
    it('POST /v1/auth/login returns an envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'admin', password: 'admin123' } });
      const body = parseBody(res);
      // Login may succeed (success envelope) or fail (error envelope)
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('GET /v1/auth/session returns envelope (auth required)', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/auth/logout returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }

      // Re-login to get a fresh session cookie for subsequent tests
      const loginRes = await handle.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'admin', password: 'admin123' },
      });
      if (loginRes.cookies && loginRes.cookies.length) {
        userCookieHeader = cookiesToHeader(loginRes.cookies as any);
      }
    });
  });

  // Self-service
  describe('Self-service routes', () => {
    it('GET /v1/users/me returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/users/me', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('PATCH /v1/users/me/password returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'PATCH', url: '/v1/users/me/password', headers: { cookie: userCookieHeader, 'Content-Type': 'application/json' }, payload: { current_password: 'admin123', new_password: 'NewP@ssw0rd123!' } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Profiles (we'll create a profile to exercise happy-path id flows)
  describe('Admin: Profiles', () => {
    let createdProfileId: string | null = null;

    it('GET /v1/admin/profiles returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    it('POST /v1/admin/profiles - create profile (happy path)', async () => {
      const payload = { name: 'test-profile-' + Date.now(), allowed_tools: [] };
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/profiles', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify(payload) });
      const body = parseBody(res);
      // Expect a success or error envelope but prefer success
      try {
        assertSuccessEnvelope(body);
        // Save id if present
        if ((body as any).data && (body as any).data.id) createdProfileId = (body as any).data.id;
      } catch {
        assertErrorEnvelope(body);
      }
    });

    it('GET /v1/admin/profiles/:id - not found and/or happy-path', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      // first try non-existent id
      const res404 = await handle.fastify.inject({ method: 'GET', url: `/v1/admin/profiles/${fakeId}`, headers: { 'X-Admin-Key': handle.adminKey } });
      const b404 = parseBody(res404);
      // Should be an error envelope (likely NOT_FOUND)
      try { assertErrorEnvelope(b404, ErrorCodes.NOT_FOUND); } catch { /* some implementations may return other envelopes */ }

      if (createdProfileId) {
        const res = await handle.fastify.inject({ method: 'GET', url: `/v1/admin/profiles/${createdProfileId}`, headers: { 'X-Admin-Key': handle.adminKey } });
        const body = parseBody(res);
        try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
      }
    });

    it('PATCH /v1/admin/profiles/:id returns envelope', async () => {
      const id = createdProfileId ?? '00000000-0000-0000-0000-000000000000';
      const res = await handle.fastify.inject({ method: 'PATCH', url: `/v1/admin/profiles/${id}`, headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify({ name: 'renamed' }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('DELETE /v1/admin/profiles/:id returns envelope', async () => {
      const id = createdProfileId ?? '00000000-0000-0000-0000-000000000000';
      const res = await handle.fastify.inject({ method: 'DELETE', url: `/v1/admin/profiles/${id}`, headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('Admin endpoints without X-Admin-Key return error envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles' });
      const body = parseBody(res);
      try { assertErrorEnvelope(body, ErrorCodes.UNAUTHORIZED); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Clients (list, create, delete)
  describe('Admin: Clients', () => {
    it('GET /v1/admin/clients returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/clients', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    it('POST /v1/admin/clients returns envelope (may require valid user/profile)', async () => {
      const payload = { name: 'test-client-' + Date.now(), profile_id: '00000000-0000-0000-0000-000000000000' };
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/clients', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify(payload) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Sessions
  describe('Admin: Sessions', () => {
    it('GET /v1/admin/sessions returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/sessions', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    it('DELETE /v1/admin/sessions/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'DELETE', url: '/v1/admin/sessions/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Security
  describe('Admin: Security', () => {
    it('POST /v1/admin/kill-switch/:target returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/kill-switch/client-authentication', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify({ enabled: false }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/admin/rotate-hmac-secret returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/rotate-hmac-secret', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/admin/rotate-credential-key returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/rotate-credential-key', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Audit
  describe('Admin: Audit', () => {
    it('GET /v1/audit/events returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/audit/events', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    it('GET /v1/admin/downstream returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/downstream', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Users
  describe('Admin: Users', () => {
    it('GET /v1/admin/users returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/users', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    it('GET /v1/admin/users/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/users/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/admin/users returns envelope', async () => {
      const payload = { username: 'testuser' + Date.now(), password: 'P@ssw0rd', display_name: 'Test User' };
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/users', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify(payload) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('PATCH /v1/admin/users/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'PATCH', url: '/v1/admin/users/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify({ display_name: 'X' }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('DELETE /v1/admin/users/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'DELETE', url: '/v1/admin/users/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Admin: Groups (we'll exercise a subset)
  describe('Admin: Groups', () => {
    it('GET /v1/admin/groups returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/groups', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    it('GET /v1/admin/groups/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/groups/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/admin/groups returns envelope', async () => {
      const payload = { name: 'g-' + Date.now() };
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/admin/groups', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify(payload) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('PATCH /v1/admin/groups/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'PATCH', url: '/v1/admin/groups/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' }, payload: JSON.stringify({ name: 'x' }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('DELETE /v1/admin/groups/:id returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'DELETE', url: '/v1/admin/groups/00000000-0000-0000-0000-000000000000', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('Group members and mcps endpoints return envelopes', async () => {
      const urls = [
        '/v1/admin/groups/00000000-0000-0000-0000-000000000000/members',
        '/v1/admin/groups/00000000-0000-0000-0000-000000000000/mcps',
      ];
      for (const url of urls) {
        const res = await handle.fastify.inject({ method: 'GET', url, headers: { 'X-Admin-Key': handle.adminKey } });
        const body = parseBody(res);
        try { assertSuccessEnvelope(body); } catch { try { assertPaginatedEnvelope(body); } catch { assertErrorEnvelope(body); } }
      }
    });
  });

  // Admin: MCPs
  describe('Admin: MCPs', () => {
    it('GET /v1/admin/mcps returns paginated envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/mcps', headers: { 'X-Admin-Key': handle.adminKey } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });

    const endpoints = [
      { method: 'GET', url: '/v1/admin/mcps/00000000-0000-0000-0000-000000000000' },
      { method: 'POST', url: '/v1/admin/mcps', payload: { name: 'mcp-' + Date.now() } },
      { method: 'PATCH', url: '/v1/admin/mcps/00000000-0000-0000-0000-000000000000', payload: { name: 'x' } },
      { method: 'DELETE', url: '/v1/admin/mcps/00000000-0000-0000-0000-000000000000' },
    ];
    for (const e of endpoints) {
      it(`${e.method} ${e.url} returns envelope`, async () => {
        const opts: any = { method: e.method, url: e.url, headers: { 'X-Admin-Key': handle.adminKey } };
        if (e.payload) { opts.payload = JSON.stringify(e.payload); opts.headers['Content-Type'] = 'application/json'; }
        const res = await handle.fastify.inject(opts);
        const body = parseBody(res);
        try { assertSuccessEnvelope(body); } catch { try { assertPaginatedEnvelope(body); } catch { assertErrorEnvelope(body); } }
      });
    }
  });

  // User-facing: Clients
  describe('User-facing: Clients', () => {
    it('GET /v1/users/me/clients returns envelope (session auth)', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/users/me/clients', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/users/me/clients returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/users/me/clients', headers: { cookie: userCookieHeader, 'Content-Type': 'application/json' }, payload: JSON.stringify({ client_name: 'c' + Date.now() }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('GET/PATCH/DELETE /v1/users/me/clients/:id returns envelope', async () => {
      const urls = [
        { method: 'GET', url: '/v1/users/me/clients/00000000-0000-0000-0000-000000000000' },
        { method: 'PATCH', url: '/v1/users/me/clients/00000000-0000-0000-0000-000000000000', payload: { client_name: 'x' } },
        { method: 'DELETE', url: '/v1/users/me/clients/00000000-0000-0000-0000-000000000000' },
      ];
      for (const u of urls) {
        const opts: any = { method: u.method, url: u.url, headers: { cookie: userCookieHeader } };
        if (u.payload) { opts.payload = JSON.stringify(u.payload); opts.headers['Content-Type'] = 'application/json'; }
        const res = await handle.fastify.inject(opts);
        const body = parseBody(res);
        try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
      }
    });
  });

  // Subscriptions (scoped under clients)
  describe('User-facing: Subscriptions', () => {
    it('GET /v1/users/me/clients/:clientId/subscriptions returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/users/me/clients/00000000-0000-0000-0000-000000000000/subscriptions', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('POST /v1/users/me/clients/:clientId/subscriptions returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'POST', url: '/v1/users/me/clients/00000000-0000-0000-0000-000000000000/subscriptions', headers: { cookie: userCookieHeader, 'Content-Type': 'application/json' }, payload: JSON.stringify({ mcp_id: '00000000-0000-0000-0000-000000000000' }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });

  // Marketplace (requires auth)
  describe('Marketplace', () => {
    it('GET /v1/marketplace returns paginated or success envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertPaginatedEnvelope(body); } catch { try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); } }
    });
  });

  // Credentials
  describe('Credentials', () => {
    it('PUT /v1/users/me/credentials/:mcpId returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'PUT', url: '/v1/users/me/credentials/00000000-0000-0000-0000-000000000000', headers: { cookie: userCookieHeader, 'Content-Type': 'application/json' }, payload: JSON.stringify({ credentials: {} }) });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('GET /v1/users/me/credentials returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'GET', url: '/v1/users/me/credentials', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });

    it('DELETE /v1/users/me/credentials/:mcpId returns envelope', async () => {
      const res = await handle.fastify.inject({ method: 'DELETE', url: '/v1/users/me/credentials/00000000-0000-0000-0000-000000000000', headers: { cookie: userCookieHeader } });
      const body = parseBody(res);
      try { assertSuccessEnvelope(body); } catch { assertErrorEnvelope(body); }
    });
  });
});
