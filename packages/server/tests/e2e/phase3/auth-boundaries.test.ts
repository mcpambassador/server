import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../../admin-api/helpers.js';
import { createUser } from '../../../src/auth/user-auth.js';

describe('Phase 3 Auth Boundaries', () => {
  let server: TestServerHandle;
  let userCookie: string;
  let userId: string;

  beforeAll(async () => {
    server = await startTestServer();
    const u = await createUser(server.db, { username: 'authbounduser', password: 'pass1234', display_name: 'AuthBound', email: 'authbound@example.com' });
    userId = u.user_id;

    const login = await server.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'authbounduser', password: 'pass1234' } });
    const cookies = login.headers['set-cookie'];
    userCookie = Array.isArray(cookies) ? cookies[0].split(';')[0] : (cookies as string).split(';')[0];
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  it('Non-admin cannot access admin endpoints', async () => {
    const res = await server.fastify.inject({ method: 'GET', url: '/v1/admin/users', headers: { cookie: userCookie } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);
  });

  it('Unauthenticated users get 401 on protected endpoints', async () => {
    const res = await server.fastify.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
  });

  it('User cannot access another user\'s clients', async () => {
    // Create a second user and client
    const { createToolProfile } = await import('@mcpambassador/core');
    const u2 = await createUser(server.db, { username: 'authbound2', password: 'pass1234', display_name: 'AuthBound2' });
    const profile = await createToolProfile(server.db, { name: 'ab-profile', description: 'p', allowed_tools: '[]', denied_tools: '[]' });

    // Login as u2 and create client
    const login2 = await server.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'authbound2', password: 'pass1234' } });
    const cookie2 = login2.headers['set-cookie'];
    const session2 = Array.isArray(cookie2) ? cookie2[0].split(';')[0] : (cookie2 as string).split(';')[0];

    const createClient = await server.fastify.inject({ method: 'POST', url: '/v1/users/me/clients', headers: { cookie: session2 }, payload: { client_name: 'ab-client', profile_id: profile.profile_id } });
    expect(createClient.statusCode).toBe(201);
    const clientId = JSON.parse(createClient.body).data.client.id;

    // Original user tries to GET that client
    const res = await server.fastify.inject({ method: 'GET', url: `/v1/users/me/clients/${clientId}`, headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('User only sees MCPs from their groups', async () => {
    // Create group and MCP, assign to group but not to default all-users
    const createGroup = await server.fastify.inject({ method: 'POST', url: '/v1/admin/groups', headers: { 'X-Admin-Key': server.adminKey }, payload: { name: 'authbound-group-' + Date.now(), status: 'active' } });
    const gid = JSON.parse(createGroup.body).data.group_id;

    const createMcp = await server.fastify.inject({ method: 'POST', url: '/v1/admin/mcps', headers: { 'X-Admin-Key': server.adminKey }, payload: { name: 'authbound-mcp-' + Date.now(), display_name: 'AB MCP', transport_type: 'stdio', config: { command: ['echo'] }, isolation_mode: 'shared' } });
    const mid = JSON.parse(createMcp.body).data.mcp_id;

    await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${mid}/validate`, headers: { 'X-Admin-Key': server.adminKey } });
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${mid}/publish`, headers: { 'X-Admin-Key': server.adminKey } });
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${gid}/mcps`, headers: { 'X-Admin-Key': server.adminKey }, payload: { mcp_id: mid } });

    // user is NOT in that group -> should not see it
    const mk = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userCookie } });
    expect(mk.statusCode).toBe(200);
    const body = JSON.parse(mk.body);
    const found = (body.data || []).some((m: any) => m.id === mid);
    expect(found).toBe(false);
  });

  it('Suspended user cannot log in', async () => {
    // Suspend user
    const patch = await server.fastify.inject({ method: 'PATCH', url: `/v1/admin/users/${userId}`, headers: { 'X-Admin-Key': server.adminKey }, payload: { status: 'suspended' } });
    expect(patch.statusCode).toBe(200);

    const login = await server.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'authbounduser', password: 'pass1234' } });
    expect(login.statusCode).toBe(401);
  });
});
