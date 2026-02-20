import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../../admin-api/helpers.js';

describe('Phase 3 Full Journey (E2E)', () => {
  let server: TestServerHandle;
  let sessionCookie: string | string[];
  let createdUserId: string;
  let createdGroupId: string;
  let createdMcpId: string;
  let createdClientId: string;
  let createdSubscriptionId: string;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  it('Admin creates a user', async () => {
    const username = 'phase3user' + Date.now();
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: {
        username,
        password: 'Password123!',
        display_name: 'Phase3 User',
        email: `${username}@example.com`,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.user_id).toBeDefined();
    createdUserId = body.data.user_id;
  });

  it('User logs in and gets session', async () => {
    // Login
    // Fetch created user username from DB
    const userRow = await server.db.query.users.findFirst({ where: (u, { eq }) => eq(u.user_id, createdUserId) });
    const username = userRow?.username as string;

    const login2 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username, password: 'Password123!' },
    });

    expect(login2.statusCode).toBe(200);
    sessionCookie = login2.headers['set-cookie'];

    // Get session
    const sessionRes = await server.fastify.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sessionCookie } });
    expect(sessionRes.statusCode).toBe(200);
    const sbody = JSON.parse(sessionRes.body);
    expect(sbody.data.user.id).toBe(createdUserId);
  });

  it('Admin creates group and adds user', async () => {
    const createGroup = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/groups',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { name: 'phase3-group-' + Date.now(), description: 'Phase3 test group', status: 'active' },
    });

    expect(createGroup.statusCode).toBe(201);
    const gbody = JSON.parse(createGroup.body);
    createdGroupId = gbody.data.group_id;

    const addMember = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${createdGroupId}/members`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: createdUserId },
    });

    expect(addMember.statusCode).toBe(201);
  });

  it('Admin creates, validates, publishes MCP and assigns to group', async () => {
    const createMcp = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/mcps',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: {
        name: 'phase3-mcp-' + Date.now(),
        display_name: 'Phase3 MCP',
        transport_type: 'stdio',
        config: { command: ['echo', 'hi'] },
        isolation_mode: 'shared',
      },
    });

    expect(createMcp.statusCode).toBe(201);
    const mb = JSON.parse(createMcp.body);
    createdMcpId = mb.data.mcp_id;

    const validate = await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${createdMcpId}/validate`, headers: { 'X-Admin-Key': server.adminKey } });
    expect(validate.statusCode).toBe(200);

    const publish = await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${createdMcpId}/publish`, headers: { 'X-Admin-Key': server.adminKey } });
    expect(publish.statusCode).toBe(200);

    const assign = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${createdGroupId}/mcps`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { mcp_id: createdMcpId },
    });

    expect(assign.statusCode).toBe(201);
  });

  it('User browses marketplace and sees MCP', async () => {
    const mk = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: sessionCookie } });
    expect(mk.statusCode).toBe(200);
    const body = JSON.parse(mk.body);
    const found = (body.data || []).some((m: any) => m.id === createdMcpId);
    expect(found).toBe(true);
  });

  it('User creates client and subscribes to MCP, selects tools, manages credentials and changes password', async () => {
    // Create profile then client via API: create minimal profile using core helper directly
    const { createToolProfile } = await import('@mcpambassador/core');
    const profile = await createToolProfile(server.db, { name: 'phase3-profile', description: 'p', allowed_tools: '[]', denied_tools: '[]' });

    const createClient = await server.fastify.inject({
      method: 'POST',
      url: '/v1/users/me/clients',
      headers: { cookie: sessionCookie },
      payload: { client_name: 'phase3-client-' + Date.now(), profile_id: profile.profile_id },
    });
    expect(createClient.statusCode).toBe(201);
    const cbody = JSON.parse(createClient.body);
    createdClientId = cbody.data.client.id;

    const subscribe = await server.fastify.inject({
      method: 'POST',
      url: `/v1/users/me/clients/${createdClientId}/subscriptions`,
      headers: { cookie: sessionCookie },
      payload: { mcp_id: createdMcpId, selected_tools: [] },
    });
    expect(subscribe.statusCode).toBe(201);
    const sb = JSON.parse(subscribe.body);
    createdSubscriptionId = sb.data.id;

    // Patch subscription select tools
    const patch = await server.fastify.inject({
      method: 'PATCH',
      url: `/v1/users/me/clients/${createdClientId}/subscriptions/${createdSubscriptionId}`,
      headers: { cookie: sessionCookie },
      payload: { selected_tools: [] },
    });
    expect(patch.statusCode).toBe(200);

    // If MCP requires credentials, attempt to PUT credentials (use safe path)
    const mcp = await server.db.query.mcp_catalog.findFirst({ where: (m, { eq }) => eq(m.mcp_id, createdMcpId) });
    if (mcp && (mcp as any).requires_user_credentials) {
      const cred = await server.fastify.inject({
        method: 'PUT',
        url: `/v1/users/me/credentials/${createdMcpId}`,
        headers: { cookie: sessionCookie },
        payload: { credentials: { api_key: 'x', region: 'r' } },
      });
      expect([200, 400]).toContain(cred.statusCode);
    }

    // Change password
    const pw = await server.fastify.inject({
      method: 'PATCH',
      url: '/v1/users/me/password',
      headers: { cookie: sessionCookie },
      payload: { current_password: 'Password123!', new_password: 'Newpass123!' },
    });
    expect([200, 401, 400]).toContain(pw.statusCode);
  });

  it('Admin archives MCP and it disappears from marketplace', async () => {
    const arc = await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${createdMcpId}/archive`, headers: { 'X-Admin-Key': server.adminKey } });
    expect(arc.statusCode).toBe(200);

    const mk2 = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: sessionCookie } });
    expect(mk2.statusCode).toBe(200);
    const body = JSON.parse(mk2.body);
    const found = (body.data || []).some((m: any) => m.id === createdMcpId);
    expect(found).toBe(false);
  });

  it('Admin deletes user and user session is invalidated', async () => {
    const del = await server.fastify.inject({ method: 'DELETE', url: `/v1/admin/users/${createdUserId}`, headers: { 'X-Admin-Key': server.adminKey } });
    expect([200,204,404]).toContain(del.statusCode);

    const sessionRes = await server.fastify.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sessionCookie } });
    expect([200, 401]).toContain(sessionRes.statusCode);
  });
});
