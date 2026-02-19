/**
 * Client Routes Integration Tests
 *
 * Tests for user self-service client management endpoints.
 *
 * @see M25.9: Integration Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import { createToolProfile } from '@mcpambassador/core';

describe('Client Routes', () => {
  let server: TestServerHandle;
  let testUserId: string;
  let testProfileId: string;
  let sessionCookie: string;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test user
    const user = await createUser(server.db, {
      username: 'clientuser',
      password: 'pass1234',
      display_name: 'Client User',
      email: 'client@example.com',
    });
    testUserId = user.user_id;

    // Create test profile
    const profile = await createToolProfile(server.db, {
      name: 'test-profile',
      description: 'Test profile for clients',
      allowed_tools: '[]',
      denied_tools: '[]',
    });
    testProfileId = profile.profile_id;

    // Login to get session cookie
    const loginResponse = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username: 'clientuser',
        password: 'pass1234',
      },
    });

    const cookies = loginResponse.headers['set-cookie'];
    if (Array.isArray(cookies)) {
      sessionCookie = cookies[0].split(';')[0];
    } else if (typeof cookies === 'string') {
      sessionCookie = cookies.split(';')[0];
    }
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('POST /v1/users/me/clients', () => {
    it('should create a client with authenticated user', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'test-client-' + Date.now(),
          profile_id: testProfileId,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.client_id).toBeDefined();
      expect(body.data.plaintext_key).toBeDefined();
      expect(body.data.plaintext_key).toMatch(/^amb_pk_/);
      expect(body.data.user_id).toBe(testUserId);
      expect(body.data.profile_id).toBe(testProfileId);
      expect(body.data.status).toBe('active');
    });

    it('should reject without session', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        payload: {
          client_name: 'unauthorized-client',
          profile_id: testProfileId,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject with invalid profile', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'bad-profile-client',
          profile_id: '00000000-0000-0000-0000-000000000000',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject with extra fields (strict schema)', async () => {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'strict-test',
          profile_id: testProfileId,
          extra_field: 'should fail',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/users/me/clients', () => {
    let testClientId: string;

    beforeAll(async () => {
      // Create a test client
      const createResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'list-test-client',
          profile_id: testProfileId,
        },
      });

      const body = JSON.parse(createResponse.body);
      testClientId = body.data.client_id;
    });

    it('should list user clients', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      const client = body.data.find((c: any) => c.client_id === testClientId);
      expect(client).toBeDefined();
      expect(client.plaintext_key).toBeUndefined(); // Should NOT be returned in list
    });

    it('should reject without session', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me/clients',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/users/me/clients/:clientId', () => {
    let testClientId: string;

    beforeAll(async () => {
      // Create a test client
      const createResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'get-test-client',
          profile_id: testProfileId,
        },
      });

      const body = JSON.parse(createResponse.body);
      testClientId = body.data.client_id;
    });

    it('should get client detail', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.client_id).toBe(testClientId);
      expect(body.data.plaintext_key).toBeUndefined(); // Should NOT be returned
    });

    it('should reject for non-existent client', async () => {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me/clients/00000000-0000-0000-0000-000000000000',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /v1/users/me/clients/:clientId', () => {
    let testClientId: string;

    beforeAll(async () => {
      // Create a test client
      const createResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'update-test-client',
          profile_id: testProfileId,
        },
      });

      const body = JSON.parse(createResponse.body);
      testClientId = body.data.client_id;
    });

    it('should update client name', async () => {
      const newName = 'updated-client-name-' + Date.now();

      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/users/me/clients/${testClientId}`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: newName,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.client_name).toBe(newName);
    });

    it('should suspend client', async () => {
      const response = await server.fastify.inject({
        method: 'PATCH',
        url: `/v1/users/me/clients/${testClientId}`,
        headers: {
          cookie: sessionCookie,
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

  describe('DELETE /v1/users/me/clients/:clientId', () => {
    let testClientId: string;

    beforeAll(async () => {
      // Create a test client
      const createResponse = await server.fastify.inject({
        method: 'POST',
        url: '/v1/users/me/clients',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          client_name: 'delete-test-client',
          profile_id: testProfileId,
        },
      });

      const body = JSON.parse(createResponse.body);
      testClientId = body.data.client_id;
    });

    it('should revoke client', async () => {
      const response = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/users/me/clients/${testClientId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(204);

      // Verify client is revoked
      const getResponse = await server.fastify.inject({
        method: 'GET',
        url: `/v1/users/me/clients/${testClientId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      const body = JSON.parse(getResponse.body);
      expect(body.data.status).toBe('revoked');
    });
  });
});
