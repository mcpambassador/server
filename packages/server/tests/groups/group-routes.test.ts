/**
 * Admin Group Routes Integration Tests
 *
 * Tests for admin group management endpoints.
 *
 * @see M22.5: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';

describe('Admin Group Routes', () => {
  let server: TestServerHandle;
  let testUserId: string;
  let testGroupId: string;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test user
    const user = await createUser(server.db, {
      username: 'groupuser',
      password: 'pass1234',
      display_name: 'Group User',
      email: 'group@example.com',
    });
    testUserId = user.user_id;
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('POST /v1/admin/groups', () => {
    it('should create a group with admin key', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'test-group-' + Date.now(),
          description: 'Test group',
          status: 'active',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.group_id).toBeDefined();
      expect(body.data.name).toContain('test-group-');
      expect(body.data.description).toBe('Test group');
      expect(body.data.status).toBe('active');

      // Save for later tests
      testGroupId = body.data.group_id;
    });

    it('should reject duplicate group names', async () => {
      const groupName = 'duplicate-group-' + Date.now();

      // Create first group
      await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: groupName,
        },
      });

      // Try to create duplicate
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: groupName,
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    it('should reject without admin key', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/groups',
        payload: {
          name: 'unauthorized-group',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/admin/groups', () => {
    it('should list groups with admin key', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.has_more).toBeDefined();
    });

    it('should support cursor pagination', async () => {
      const response1 = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/groups?limit=2',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response1.statusCode).toBe(200);
      const body1 = JSON.parse(response1.body);

      if (body1.pagination.next_cursor) {
        const response2 = await server.fastify.inject({
          method: 'GET',
          url: `/v1/admin/groups?cursor=${body1.pagination.next_cursor}&limit=2`,
          headers: {
            'X-Admin-Key': server.adminKey,
          },
        });

        expect(response2.statusCode).toBe(200);
        const body2 = JSON.parse(response2.body);
        expect(body2.data).toBeDefined();
      }
    });

    it('should reject without admin key', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/groups',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/admin/groups/:groupId', () => {
    it('should get group by ID', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/groups/${testGroupId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.group_id).toBe(testGroupId);
    });

    it('should return 404 for non-existent group', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/groups/00000000-0000-0000-0000-000000000000',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /v1/admin/groups/:groupId', () => {
    it('should update group', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/admin/groups/${testGroupId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          description: 'Updated description',
          status: 'suspended',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.description).toBe('Updated description');
      expect(body.data.status).toBe('suspended');
    });

    it('should return 404 for non-existent group', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: '/v1/admin/groups/00000000-0000-0000-0000-000000000000',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          description: 'Updated',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /v1/admin/groups/:groupId/members', () => {
    it('should add user to group', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/groups/${testGroupId}/members`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          user_id: testUserId,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.message).toBe('User added to group');
    });

    it('should reject duplicate membership', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/groups/${testGroupId}/members`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          user_id: testUserId,
        },
      });

      expect(response.statusCode).toBe(409);
    });

    it('should return 404 for non-existent user', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/groups/${testGroupId}/members`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          user_id: '00000000-0000-0000-0000-000000000000',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v1/admin/groups/:groupId/members', () => {
    it('should list group members', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/groups/${testGroupId}/members`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.some((m: any) => m.user_id === testUserId)).toBe(true);
    });
  });

  describe('DELETE /v1/admin/groups/:groupId/members/:userId', () => {
    it('should remove user from group', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/groups/${testGroupId}/members/${testUserId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should not fail when removing non-member', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/groups/${testGroupId}/members/${testUserId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      // Should succeed (idempotent)
      expect(response.statusCode).toBe(204);
    });
  });

  describe('DELETE /v1/admin/groups/:groupId', () => {
    it('should delete a group', async () => {
      // Create a temporary group to delete
      const createResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          name: 'delete-test-' + Date.now(),
        },
      });

      const groupId = JSON.parse(createResponse.body).data.group_id;

      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/groups/${groupId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(204);

      // Verify it's deleted
      const getResponse = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/groups/${groupId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(getResponse.statusCode).toBe(404);
    });

    it('should prevent deletion of "all-users" group', async () => {
      // Find "all-users" group
      const listResponse = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      const groups = JSON.parse(listResponse.body).data;
      const allUsersGroup = groups.find((g: any) => g.name === 'all-users');

      if (allUsersGroup) {
        const response = await server.fastify.inject({
          method: 'DELETE',
          url: `/v1/admin/groups/${allUsersGroup.group_id}`,
          headers: {
            'X-Admin-Key': server.adminKey,
          },
        });

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.error.code).toBe('FORBIDDEN');
      }
    });

    it('should return 404 for non-existent group', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: '/v1/admin/groups/00000000-0000-0000-0000-000000000000',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('M22.4: Auto-assign to all-users group', () => {
    it('should auto-assign new users to "all-users" group', async () => {
      // Create a new user
      const newUser = await createUser(server.db, {
        username: 'autoassigntest-' + Date.now(),
        password: 'pass1234',
        display_name: 'Auto Assign Test',
        email: 'autoassign@example.com',
      });

      // Find "all-users" group
      const listResponse = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/groups',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      const groups = JSON.parse(listResponse.body).data;
      const allUsersGroup = groups.find((g: any) => g.name === 'all-users');

      if (allUsersGroup) {
        // Check if user is a member
        const membersResponse = await server.fastify.inject({
          method: 'GET',
          url: `/v1/admin/groups/${allUsersGroup.group_id}/members`,
          headers: {
            'X-Admin-Key': server.adminKey,
          },
        });

        const members = JSON.parse(membersResponse.body).data;
        expect(members.some((m: any) => m.user_id === newUser.user_id)).toBe(true);
      }
    });
  });

  describe('MCP access management', () => {
    let mcpId: string;

    beforeAll(async () => {
      // Create a test MCP entry
      const mcp = await server.db.query.mcp_catalog.findFirst({
        where: (mcp_catalog, { eq }) => eq(mcp_catalog.transport_type, 'stdio'),
      });

      if (mcp) {
        mcpId = mcp.mcp_id;
      } else {
        // If no MCP exists, skip these tests
        mcpId = '00000000-0000-0000-0000-000000000000';
      }
    });

    it('should assign MCP to group', async () => {
      if (mcpId === '00000000-0000-0000-0000-000000000000') {
        return; // Skip if no MCP available
      }

      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/groups/${testGroupId}/mcps`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          mcp_id: mcpId,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('MCP assigned to group');
    });

    it('should list MCPs for group', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/groups/${testGroupId}/mcps`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should remove MCP from group', async () => {
      if (mcpId === '00000000-0000-0000-0000-000000000000') {
        return; // Skip if no MCP available
      }

      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/groups/${testGroupId}/mcps/${mcpId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(204);
    });
  });
});
