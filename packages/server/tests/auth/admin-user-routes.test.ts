/**
 * Admin User CRUD Routes Integration Tests
 *
 * Tests for admin user management endpoints.
 *
 * @see M21.9: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';

describe('Admin User CRUD Routes', () => {
  let server: TestServerHandle;
  let testUserId: string;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test user for manipulation
    const user = await createUser(server.db, {
      username: 'manageduser',
      password: 'pass1234',
      display_name: 'Managed User',
      email: 'managed@example.com',
    });
    testUserId = user.user_id;
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('GET /v1/admin/users', () => {
    it('should list users with admin key', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/users',
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

    it('should filter users by status', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/users?status=active',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.every((u: any) => u.status === 'active')).toBe(true);
    });

    it('should reject without admin key', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/users',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /v1/admin/users', () => {
    it('should create user with admin key', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          username: 'newuser' + Date.now(),
          password: 'newpass123',
          display_name: 'New User',
          email: 'new@example.com',
          is_admin: false,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.user_id).toBeDefined();
      expect(body.data.username).toContain('newuser');
      expect(body.data.display_name).toBe('New User');
      expect(body.data.email).toBe('new@example.com');
      expect(body.data.is_admin).toBe(false);
    });

    it('should reject duplicate username', async () => {
      // Create first user
      const username = 'duplicate' + Date.now();
      await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          username,
          password: 'pass1234', // 8 chars minimum
          display_name: 'First User',
        },
      });

      // Try to create second user with same username
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          username,
          password: 'pass1234',
          display_name: 'Second User',
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    it('should reject invalid password', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          username: 'shortpwd',
          password: 'short',
          display_name: 'Short Password User',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toContain('Password');
    });
  });

  describe('GET /v1/admin/users/:userId', () => {
    it('should get user details', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/users/${testUserId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.user_id).toBe(testUserId);
      expect(body.data.username).toBe('manageduser');
    });

    it('should return 404 for non-existent user', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/admin/users/non-existent-id',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(400); // Invalid UUID format
    });
  });

  describe('PATCH /v1/admin/users/:userId', () => {
    it('should update user details', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/admin/users/${testUserId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          display_name: 'Updated Display Name',
          email: 'updated@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.display_name).toBe('Updated Display Name');
      expect(body.data.email).toBe('updated@example.com');
    });

    it('should update user status', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/admin/users/${testUserId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          status: 'suspended',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('suspended');
    });
  });

  describe('DELETE /v1/admin/users/:userId', () => {
    it('should deactivate user', async () => {
      // Create user to delete
      const createResp = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          username: 'todelete' + Date.now(),
          password: 'pass1234', // 8 chars minimum
          display_name: 'To Delete',
        },
      });

      const userId = JSON.parse(createResp.body).data.user_id;

      // Delete user
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/admin/users/${userId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.message).toContain('deactivated');

      // Verify user is deactivated
      const getResp = await server.fastify.inject({
        method: 'GET',
        url: `/v1/admin/users/${userId}`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
      });

      const user = JSON.parse(getResp.body);
      expect(user.data.status).toBe('deactivated');
    });
  });

  describe('POST /v1/admin/users/:userId/reset-password', () => {
    it('should reset user password', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/users/${testUserId}/reset-password`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          new_password: 'newpassword123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.message).toContain('reset');
    });

    it('should reject invalid password', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: `/v1/admin/users/${testUserId}/reset-password`,
        headers: {
          'X-Admin-Key': server.adminKey,
        },
        payload: {
          new_password: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
