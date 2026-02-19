/**
 * Self-Service Routes Integration Tests
 *
 * Tests for user self-service endpoints.
 *
 * @see M21.9: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';

describe('Self-Service Routes', () => {
  let server: TestServerHandle;
  let userId: string;
  let cookies: string | string[];

  beforeAll(async () => {
    server = await startTestServer();

    // Create and login test user
    const user = await createUser(server.db, {
      username: 'selfserviceuser',
      password: 'password123',
      display_name: 'Self Service User',
      email: 'selfservice@example.com',
    });
    userId = user.user_id;

    // Login to get session cookie
    const loginResponse = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username: 'selfserviceuser',
        password: 'password123',
      },
    });

    cookies = loginResponse.headers['set-cookie'] as string | string[];
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('GET /v1/users/me', () => {
    it('should return current user profile', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user_id).toBe(userId);
      expect(body.username).toBe('selfserviceuser');
      expect(body.display_name).toBe('Self Service User');
      expect(body.email).toBe('selfservice@example.com');
    });

    it('should reject unauthenticated request', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('PATCH /v1/users/me/password', () => {
    it('should change password with correct current password', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: '/v1/users/me/password',
        headers: {
          cookie: cookies,
        },
        payload: {
          current_password: 'password123',
          new_password: 'newpassword456',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('changed');
    });

    it('should reject incorrect current password', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: '/v1/users/me/password',
        headers: {
          cookie: cookies,
        },
        payload: {
          current_password: 'wrongpassword',
          new_password: 'newpassword789',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('incorrect');
    });

    it('should reject invalid new password', async () => {
      // Need to login again with new password first
      const loginResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'selfserviceuser',
          password: 'newpassword456',
        },
      });

      const newCookies = loginResponse.headers['set-cookie'] as string | string[];

      const response = await server.fastify.inject({
        method: 'PATCH',
        url: '/v1/users/me/password',
        headers: {
          cookie: newCookies,
        },
        payload: {
          current_password: 'newpassword456',
          new_password: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('Password');
    });

    it('should reject unauthenticated request', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: '/v1/users/me/password',
        payload: {
          current_password: 'password123',
          new_password: 'newpassword123',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject missing fields', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: '/v1/users/me/password',
        headers: {
          cookie: cookies,
        },
        payload: {
          current_password: 'password123',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
