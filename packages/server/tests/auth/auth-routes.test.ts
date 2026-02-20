/**
 * Auth Routes Integration Tests
 *
 * Tests for login, logout, and session endpoints.
 *
 * @see M21.9: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';

// Helper to extract cookie from set-cookie header
function extractCookie(setCookieHeader?: string | string[] | undefined): string | undefined {
  const sc = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!sc) return undefined;
  const m = sc.match(/([^=]+)=([^;]+);?/);
  return m ? `${m[1]}=${m[2]}` : undefined;
}

describe('Auth Routes', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test user
    await createUser(server.db, {
      username: 'testuser',
      password: 'test1234',
      display_name: 'Test User',
      email: 'test@example.com',
      is_admin: false,
    });

    // Create admin user
    await createUser(server.db, {
      username: 'adminuser',
      password: 'admin1234',
      display_name: 'Admin User',
      is_admin: true,
    });
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('POST /v1/auth/login', () => {
    it('should login with valid credentials', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'testuser',
          password: 'test1234',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.username).toBe('testuser');
      expect(body.user.displayName).toBe('Test User');
      expect(body.user.isAdmin).toBe(false);
      expect(body.user.createdAt).toBeDefined();
      expect(body.user.lastLoginAt).toBeDefined();

      // Should set session cookie
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie).toBeTruthy();
    });

    it('should reject missing credentials', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'testuser',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Bad Request');
    });
  });

  describe('GET /v1/auth/session', () => {
    it('should return session info when authenticated', async () => {
      // Login first
      const loginResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'adminuser',
          password: 'admin1234',
        },
      });

      expect(loginResponse.statusCode).toBe(200);
      const cookies = extractCookie(loginResponse.headers['set-cookie']);
      expect(cookies).toBeDefined();

      // Get session info
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.username).toBe('adminuser');
      expect(body.user.isAdmin).toBe(true);
    });

    it('should return 401 when not authenticated', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/auth/session',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('should logout authenticated user', async () => {
      // Login first
      const loginResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'testuser',
          password: 'test1234',
        },
      });

      expect(loginResponse.statusCode).toBe(200);
      const cookies = extractCookie(loginResponse.headers['set-cookie']);
      expect(cookies).toBeDefined();

      // Logout
      const logoutResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          cookie: cookies,
        },
      });

      expect(logoutResponse.statusCode).toBe(200);
      const body = JSON.parse(logoutResponse.body);
      expect(body.message).toBe('Logged out successfully');

      // Session should be invalid now
      const sessionResponse = await server.fastify.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: {
          cookie: cookies,
        },
      });

      expect(sessionResponse.statusCode).toBe(401);
    });

    it('should handle logout when not authenticated', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/logout',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // Run error cases and rate limiting last to avoid contaminating other tests
  describe('POST /v1/auth/login - error cases', () => {
    it('should reject invalid username', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'nonexistent',
          password: 'test1234',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid credentials');
    });

    it('should reject invalid password', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'testuser',
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('should rate limit after multiple failures', async () => {
      // Attempt login 5 times with wrong password
      for (let i = 0; i < 5; i++) {
        await server.fastify.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            username: 'testuser',
            password: 'wrongpass',
          },
        });
      }

      // 6th attempt should be rate limited
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'testuser',
          password: 'wrongpass',
        },
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Too Many Requests');
      expect(body.retry_after).toBeDefined();
    });
  });
});
