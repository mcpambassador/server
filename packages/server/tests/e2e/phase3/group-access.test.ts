import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../../admin-api/helpers.js';
import { createUser } from '../../../src/auth/user-auth.js';

describe('Phase 3 Group Access Control', () => {
  let server: TestServerHandle;
  let userAcookie: string;
  let userBcookie: string;
  let userAId: string;
  let userBId: string;
  let groupA: string;
  let groupB: string;
  let mcpA: string;
  let mcpB: string;

  beforeAll(async () => {
    server = await startTestServer();

    const uA = await createUser(server.db, { username: 'groupAuser', password: 'pass1234', display_name: 'Group A' });
    userAId = uA.user_id;
    const uB = await createUser(server.db, { username: 'groupBuser', password: 'pass1234', display_name: 'Group B' });
    userBId = uB.user_id;

    // Create groups
    const gA = await server.fastify.inject({ method: 'POST', url: '/v1/admin/groups', headers: { 'X-Admin-Key': server.adminKey }, payload: { name: 'grp-A-' + Date.now(), status: 'active' } });
    groupA = JSON.parse(gA.body).data.group_id;
    const gB = await server.fastify.inject({ method: 'POST', url: '/v1/admin/groups', headers: { 'X-Admin-Key': server.adminKey }, payload: { name: 'grp-B-' + Date.now(), status: 'active' } });
    groupB = JSON.parse(gB.body).data.group_id;

    // Create and publish MCPs
    const mA = await server.fastify.inject({ method: 'POST', url: '/v1/admin/mcps', headers: { 'X-Admin-Key': server.adminKey }, payload: { name: 'mcp-a-' + Date.now(), display_name: 'MCP A', transport_type: 'stdio', config: { command: ['echo'] }, isolation_mode: 'shared' } });
    const mABody = JSON.parse(mA.body);
    console.log('MCP A creation response:', mA.statusCode, JSON.stringify(mABody));
    mcpA = mABody.data?.mcp_id;
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${mcpA}/validate`, headers: { 'X-Admin-Key': server.adminKey } });
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${mcpA}/publish`, headers: { 'X-Admin-Key': server.adminKey } });

    const mBres = await server.fastify.inject({ method: 'POST', url: '/v1/admin/mcps', headers: { 'X-Admin-Key': server.adminKey }, payload: { name: 'mcp-b-' + Date.now(), display_name: 'MCP B', transport_type: 'stdio', config: { command: ['echo'] }, isolation_mode: 'shared' } });
    const mBBody = JSON.parse(mBres.body);
    console.log('MCP B creation response:', mBres.statusCode, JSON.stringify(mBBody));
    mcpB = mBBody.data?.mcp_id;
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${mcpB}/validate`, headers: { 'X-Admin-Key': server.adminKey } });
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${mcpB}/publish`, headers: { 'X-Admin-Key': server.adminKey } });

    // Assign MCP A to group A only
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${groupA}/mcps`, headers: { 'X-Admin-Key': server.adminKey }, payload: { mcp_id: mcpA } });
    // Assign MCP B to group B only
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${groupB}/mcps`, headers: { 'X-Admin-Key': server.adminKey }, payload: { mcp_id: mcpB } });

    // Add userA to groupA
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${groupA}/members`, headers: { 'X-Admin-Key': server.adminKey }, payload: { user_id: userAId } });

    // Add userB to groupB
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${groupB}/members`, headers: { 'X-Admin-Key': server.adminKey }, payload: { user_id: userBId } });

    // Login both users
    const lA = await server.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'groupAuser', password: 'pass1234' } });
    const cA = lA.headers['set-cookie'];
    userAcookie = Array.isArray(cA) ? cA[0].split(';')[0] : (cA as string).split(';')[0];

    const lB = await server.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'groupBuser', password: 'pass1234' } });
    const cB = lB.headers['set-cookie'];
    userBcookie = Array.isArray(cB) ? cB[0].split(';')[0] : (cB as string).split(';')[0];
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  it('User in group sees group MCPs', async () => {
    const res = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userAcookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const hasA = (body.data || []).some((m: any) => m.id === mcpA);
    expect(hasA).toBe(true);
  });

  it('User NOT in group does not see other group MCP', async () => {
    const res = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userAcookie } });
    const body = JSON.parse(res.body);
    const hasB = (body.data || []).some((m: any) => m.id === mcpB);
    expect(hasB).toBe(false);
  });

  it('User in multiple groups sees union of MCPs', async () => {
    // Add userA to groupB as well
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${groupB}/members`, headers: { 'X-Admin-Key': server.adminKey }, payload: { user_id: userAId } });

    const res = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userAcookie } });
    const body = JSON.parse(res.body);
    const hasA = (body.data || []).some((m: any) => m.id === mcpA);
    const hasB = (body.data || []).some((m: any) => m.id === mcpB);
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });

  it('Removing user from group removes access', async () => {
    // Remove userA from groupA
    await server.fastify.inject({ method: 'DELETE', url: `/v1/admin/groups/${groupA}/members/${userAId}`, headers: { 'X-Admin-Key': server.adminKey } });

    const res = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userAcookie } });
    const body = JSON.parse(res.body);
    const hasA = (body.data || []).some((m: any) => m.id === mcpA);
    expect(hasA).toBe(false);
  });

  it('Removing MCP from group removes access', async () => {
    // Re-add userA to groupA and then remove mcpA from groupA
    await server.fastify.inject({ method: 'POST', url: `/v1/admin/groups/${groupA}/members`, headers: { 'X-Admin-Key': server.adminKey }, payload: { user_id: userAId } });
    await server.fastify.inject({ method: 'DELETE', url: `/v1/admin/groups/${groupA}/mcps/${mcpA}`, headers: { 'X-Admin-Key': server.adminKey } });

    const res = await server.fastify.inject({ method: 'GET', url: '/v1/marketplace', headers: { cookie: userAcookie } });
    const body = JSON.parse(res.body);
    const hasA = (body.data || []).some((m: any) => m.mcp_id === mcpA);
    expect(hasA).toBe(false);
  });
});
