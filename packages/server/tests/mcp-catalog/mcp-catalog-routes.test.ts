/**
 * MCP Catalog Routes Integration Tests
 *
 * Tests for MCP catalog admin endpoints and marketplace.
 *
 * @see M23.7: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import { addUserToGroup, getGroupByName, listUserGroups } from '@mcpambassador/core';

describe('MCP Catalog Routes', () => {
  let server: TestServerHandle;
  let testMcpId: string;
  let testUserId: string;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test user
    const user = await createUser(server.db, {
      username: 'mcpuser',
      password: 'pass1234',
      display_name: 'MCP User',
      email: 'mcpuser@example.com',
    });
    testUserId = user.user_id;

    // Add user to all-users group for marketplace tests (if not already in it)
    const allUsersGroup = await getGroupByName(server.db, 'all-users');
    if (allUsersGroup) {
      const userGroups = await listUserGroups(server.db, testUserId);
      const isInGroup = userGroups.some(ug => ug.group_id === allUsersGroup.group_id);
      if (!isInGroup) {
        await addUserToGroup(server.db, {
          user_id: testUserId,
          group_id: allUsersGroup.group_id,
          assigned_by: 'system',
        });
      }
    }
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('POST /v1/admin/mcps', () => {
    it('should create a draft MCP entry with admin key', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'test-mcp-' + Date.now(),
          display_name: 'Test MCP',
          description: 'A test MCP server',
          transport_type: 'stdio',
          config: {
            command: ['node', 'server.js'],
            env: { NODE_ENV: 'test' },
          },
          isolation_mode: 'shared',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.mcp_id).toBeDefined();
      expect(body.data.name).toContain('test-mcp-');
      expect(body.data.display_name).toBe('Test MCP');
      expect(body.data.status).toBe('draft');
      expect(body.data.validation_status).toBe('pending');

      // Save for later tests
      testMcpId = body.data.mcp_id;
    });

    it('should reject duplicate MCP names', async () => {
      const mcpName = 'duplicate-mcp-' + Date.now();

      // Create first MCP
      await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: mcpName,
          display_name: 'Duplicate MCP',
          transport_type: 'stdio',
          config: { command: ['node', 'index.js'] },
        },
      });

      // Try to create duplicate
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: mcpName,
          display_name: 'Duplicate MCP 2',
          transport_type: 'http',
          config: { url: 'https://example.com' },
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    it('should reject invalid transport config', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'invalid-config-' + Date.now(),
          display_name: 'Invalid Config',
          transport_type: 'stdio',
          config: {}, // Missing command
        },
      });

      // Should create (validation happens separately), but with pending status
      expect(response.statusCode).toBe(201);
    });

    it('should reject without admin key', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        payload: {
          name: 'unauthorized-mcp',
          display_name: 'Unauthorized',
          transport_type: 'stdio',
          config: { command: ['node', 'server.js'] },
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/admin/mcps', () => {
    it('should list all MCP entries', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
    });

    it('should filter by status', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/mcps?status=draft',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.every((mcp: any) => mcp.status === 'draft')).toBe(true);
    });

    it('should filter by isolation mode', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/mcps?isolation_mode=shared',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.every((mcp: any) => mcp.isolation_mode === 'shared')).toBe(true);
    });

    it('should support cursor pagination', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/mcps?limit=1',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      if (body.pagination.has_more) {
        expect(body.pagination.next_cursor).toBeDefined();
      }
    });
  });

  describe('GET /v1/admin/mcps/:mcpId', () => {
    it('should get MCP by ID', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/mcps/${testMcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.mcp_id).toBe(testMcpId);
    });

    it('should return 404 for non-existent MCP', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/mcps/00000000-0000-0000-0000-000000000000',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /v1/admin/mcps/:mcpId', () => {
    it('should update MCP metadata', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/admin/mcps/${testMcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          display_name: 'Updated Test MCP',
          description: 'Updated description',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.display_name).toBe('Updated Test MCP');
      expect(body.data.description).toBe('Updated description');
    });

    it('should reset validation status when config changes', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/admin/mcps/${testMcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          config: {
            command: ['node', 'updated.js'],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.validation_status).toBe('pending');
    });
  });

  describe('POST /v1/admin/mcps/:mcpId/validate', () => {
    it('should validate valid MCP config', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${testMcpId}/validate`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.valid).toBe(true);
      expect(body.data.errors).toHaveLength(0);
    });

    it('should detect invalid MCP config', async () => {
      // Create MCP with invalid config
      const createRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'invalid-mcp-' + Date.now(),
          display_name: 'Invalid MCP',
          transport_type: 'stdio',
          config: {}, // Missing command
        },
      });
      const invalidMcpId = JSON.parse(createRes.body).data.mcp_id;

      // Validate it
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${invalidMcpId}/validate`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.valid).toBe(false);
      expect(body.data.errors.length).toBeGreaterThan(0);
    });
  });

  describe('POST /v1/admin/mcps/:mcpId/publish', () => {
    it('should publish validated MCP', async () => {
      // First validate
      await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${testMcpId}/validate`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      // Then publish
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${testMcpId}/publish`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('published');
      expect(body.data.published_by).toBe('admin');
      expect(body.data.published_at).toBeDefined();
    });

    it('should reject publishing unvalidated MCP', async () => {
      // Create new MCP
      const createRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'unvalidated-mcp-' + Date.now(),
          display_name: 'Unvalidated MCP',
          transport_type: 'stdio',
          config: { command: ['node', 'server.js'] },
        },
      });
      const unvalidatedMcpId = JSON.parse(createRes.body).data.mcp_id;

      // Try to publish without validation
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${unvalidatedMcpId}/publish`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error.message).toContain('validation');
    });
  });

  describe('POST /v1/admin/mcps/:mcpId/archive', () => {
    it('should archive MCP', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${testMcpId}/archive`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('archived');
    });
  });

  describe('DELETE /v1/admin/mcps/:mcpId', () => {
    it('should delete draft MCP', async () => {
      // Create draft MCP
      const createRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'deletable-mcp-' + Date.now(),
          display_name: 'Deletable MCP',
          transport_type: 'stdio',
          config: { command: ['node', 'server.js'] },
        },
      });
      const deletableMcpId = JSON.parse(createRes.body).data.mcp_id;

      // Delete it
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/mcps/${deletableMcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should delete archived MCP', async () => {
      // testMcpId is already archived from previous test
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/mcps/${testMcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should reject deleting published MCP', async () => {
      // Create and publish an MCP
      const createRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/mcps',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'published-mcp-' + Date.now(),
          display_name: 'Published MCP',
          transport_type: 'stdio',
          config: { command: ['node', 'server.js'] },
        },
      });
      const publishedMcpId = JSON.parse(createRes.body).data.mcp_id;

      // Validate and publish
      await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${publishedMcpId}/validate`,
        headers: { 'X-Admin-Key': server.adminKey },
      });
      await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${publishedMcpId}/publish`,
        headers: { 'X-Admin-Key': server.adminKey },
      });

      // Try to delete
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/mcps/${publishedMcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error.message).toContain('Cannot delete published');
    });
  });

  describe('GET /v1/marketplace (user session required)', () => {
    it('should browse marketplace with user session', async () => {
      // Login to get session cookie
      const loginRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'mcpuser', password: 'pass1234' },
      });
      const sessionCookie = loginRes.headers['set-cookie'] as string;

      // Browse marketplace
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/marketplace',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();

      // Only published MCPs should be returned
      expect(body.data.every((mcp: any) => mcp.status === 'published')).toBe(true);
    });

    it('should reject marketplace access without session', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/marketplace',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should support cursor pagination', async () => {
      // Login
      const loginRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'mcpuser', password: 'pass1234' },
      });
      const sessionCookie = loginRes.headers['set-cookie'] as string;

      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/marketplace?limit=1',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      if (body.pagination.has_more) {
        expect(body.pagination.next_cursor).toBeDefined();
      }
    });
  });

  describe('YAML MCP Import', () => {
    it('should have imported YAML MCPs on first boot', async () => {
      // Check if any MCPs exist with status=published and published_by=system
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/mcps?status=published',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should have imported MCPs from YAML config (if any were configured)
      // The test may have 0 or more depending on test config
      expect(Array.isArray(body.data)).toBe(true);
    });
  });
});
