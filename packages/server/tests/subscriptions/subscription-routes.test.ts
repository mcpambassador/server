/**
 * Subscription Routes Integration Tests
 *
 * Tests for user self-service subscription management endpoints.
 *
 * @see M25.9: Integration Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import { createToolProfile, createGroup, addUserToGroup, createMcpEntry, grantGroupAccess } from '@mcpambassador/core';

describe('Subscription Routes', () => {
  let server: TestServerHandle;
  let testUserId: string;
  let testUserId2: string;
  let testProfileId: string;
  let testClientId: string;
  let testMcpId: string;
  let testMcpIdNoAccess: string;
  let testGroupId: string;
  let sessionCookie: string;
  let sessionCookie2: string;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test users
    const user1 = await createUser(server.db, {
      username: 'subuser1',
      password: 'pass1234',
      display_name: 'Sub User 1',
      email: 'sub1@example.com',
    });
    testUserId = user1.user_id;

    const user2 = await createUser(server.db, {
      username: 'subuser2',
      password: 'pass1234',
      display_name: 'Sub User 2',
      email: 'sub2@example.com',
    });
    testUserId2 = user2.user_id;

    // Create test profile
    const profile = await createToolProfile(server.db, {
      name: 'sub-test-profile',
      description: 'Test profile for subscriptions',
      allowed_tools: '[]',
      denied_tools: '[]',
    });
    testProfileId = profile.profile_id;

    // Create test group
    const group = await createGroup(server.db, {
      name: 'sub-test-group-' + Date.now(),
      description: 'Test group for subscriptions',
      status: 'active',
      created_by: 'system',
    });
    testGroupId = group.group_id;

    // Add user1 to group
    await addUserToGroup(server.db, {
      user_id: testUserId,
      group_id: testGroupId,
      assigned_by: 'system',
    });

    // Create test MCPs
    const mcp1 = await createMcpEntry(server.db, {
      name: 'sub-test-mcp-' + Date.now(),
      display_name: 'Sub Test MCP',
      description: 'Test MCP for subscriptions',
      transport_type: 'stdio',
      config: JSON.stringify({
        command: 'test',
        args: [],
        env: {},
      }),
      requires_user_credentials: false,
      tool_catalog: JSON.stringify([
        { name: 'tool1', description: 'Tool 1', inputSchema: {} },
        { name: 'tool2', description: 'Tool 2', inputSchema: {} },
      ]),
      status: 'published',
    });
    testMcpId = mcp1.mcp_id;

    const mcp2 = await createMcpEntry(server.db, {
      name: 'sub-test-mcp-no-access-' + Date.now(),
      display_name: 'Sub Test MCP No Access',
      description: 'Test MCP for access control',
      transport_type: 'stdio',
      config: JSON.stringify({
        command: 'test',
        args: [],
        env: {},
      }),
      requires_user_credentials: false,
      tool_catalog: JSON.stringify([]),
      status: 'published',
    });
    testMcpIdNoAccess = mcp2.mcp_id;

    // Grant group access to MCP1 only
    await grantGroupAccess(server.db, {
      group_id: testGroupId,
      mcp_id: testMcpId,
      assigned_by: 'system',
    });

    // Login as user1
    const loginResponse1 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username: 'subuser1',
        password: 'pass1234',
      },
    });

    const cookies1 = loginResponse1.headers['set-cookie'];
    if (Array.isArray(cookies1)) {
      sessionCookie = cookies1[0].split(';')[0];
    } else if (typeof cookies1 === 'string') {
      sessionCookie = cookies1.split(';')[0];
    }

    // Login as user2
    const loginResponse2 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username: 'subuser2',
        password: 'pass1234',
      },
    });

    const cookies2 = loginResponse2.headers['set-cookie'];
    if (Array.isArray(cookies2)) {
      sessionCookie2 = cookies2[0].split(';')[0];
    } else if (typeof cookies2 === 'string') {
      sessionCookie2 = cookies2.split(';')[0];
    }

    // Create test client for user1
    const clientResponse = await server.fastify.inject({
      method: 'POST',
      url: '/v1/users/me/clients',
      headers: {
        cookie: sessionCookie,
      },
      payload: {
        client_name: 'subscription-test-client',
        profile_id: testProfileId,
      },
    });

    const clientBody = JSON.parse(clientResponse.body);
    testClientId = clientBody.data.client.id;
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('POST /v1/users/me/clients/:clientId/subscriptions', () => {
    it('should subscribe to MCP with group access', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          mcp_id: testMcpId,
          selected_tools: ['tool1'],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.id).toBeDefined();
      expect(body.data.clientId).toBe(testClientId);
      expect(body.data.mcpId).toBe(testMcpId);
      expect(body.data.status).toBe('active');
    });

    it('should reject subscription without group access', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          mcp_id: testMcpIdNoAccess,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toContain('does not have access');
    });

    it('should reject duplicate subscription', async () => {
      // Try to subscribe again to the same MCP
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          mcp_id: testMcpId,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toContain('already subscribed');
    });

    it('should reject without session', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        payload: {
          mcp_id: testMcpId,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/users/me/clients/:clientId/subscriptions', () => {
    it('should list subscriptions for client', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      const sub = body.data[0];
      expect(sub.id).toBeDefined();
      expect(sub.mcpName).toBeDefined();
    });

    it('should reject for other user client', async () => {
      // User2 tries to list subscriptions for User1 client
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie2,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v1/users/me/clients/:clientId/subscriptions/:subscriptionId', () => {
    let testSubscriptionId: string;

    beforeAll(async () => {
      // Get subscription ID from list
      const listResponse = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
      });

      const listBody = JSON.parse(listResponse.body);
      testSubscriptionId = listBody.data[0].id;
    });

    it('should get subscription detail', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions/${testSubscriptionId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.id).toBe(testSubscriptionId);
      expect(body.data.mcpName).toBeDefined();
    });
  });

  describe('PATCH /v1/users/me/clients/:clientId/subscriptions/:subscriptionId', () => {
    let testSubscriptionId: string;

    beforeAll(async () => {
      // Get subscription ID from list
      const listResponse = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
      });

      const listBody = JSON.parse(listResponse.body);
      testSubscriptionId = listBody.data[0].id;
    });

    it('should update selected tools', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/users/me/clients/${testClientId}/subscriptions/${testSubscriptionId}`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          selected_tools: ['tool1', 'tool2'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.selectedTools).toEqual(['tool1', 'tool2']);
    });

    it('should pause subscription', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/users/me/clients/${testClientId}/subscriptions/${testSubscriptionId}`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          status: 'paused',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('paused');
    });

    it('should resume subscription', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/users/me/clients/${testClientId}/subscriptions/${testSubscriptionId}`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          status: 'active',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('active');
    });
  });

  describe('DELETE /v1/users/me/clients/:clientId/subscriptions/:subscriptionId', () => {
    let testSubscriptionId: string;

    beforeAll(async () => {
      // Get subscription ID from list
      const listResponse = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions`,
        headers: {
          cookie: sessionCookie,
        },
      });

      const listBody = JSON.parse(listResponse.body);
      testSubscriptionId = listBody.data[0].id;
    });

    it('should remove subscription', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/users/me/clients/${testClientId}/subscriptions/${testSubscriptionId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(204);

      // Verify subscription is hard deleted (should return 404)
      const getResponse = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}/subscriptions/${testSubscriptionId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(getResponse.statusCode).toBe(404);
    });
  });
});
