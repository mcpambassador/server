/**
 * Credential Routes Integration Tests
 *
 * Tests for user self-service credential management endpoints.
 *
 * @see M26.10: Integration Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { compatInsert, mcp_catalog } from '@mcpambassador/core';
import crypto from 'crypto';

// Helper to extract cookie from set-cookie header
function extractCookie(setCookieHeader?: string | string[] | undefined): string | undefined {
  const sc = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!sc) return undefined;
  const m = sc.match(/([^=]+)=([^;]+);?/);
  return m ? `${m[1]}=${m[2]}` : undefined;
}

describe('Credential Routes', () => {
  let server: TestServerHandle;
  let testUserId: string;
  let testMcpId: string;
  let noCrMcpId: string;
  let sessionCookie: string;

  beforeAll(async () => {
    server = await startTestServer();

    // Create test user via admin API (ensures proper password hashing)
    const createUserRes = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: {
        username: 'credtestuser',
        password: 'Test1234!',
        display_name: 'Credential Test User',
        email: 'credtest@example.com',
      },
    });

    expect(createUserRes.statusCode).toBe(201);
    const userData = JSON.parse(createUserRes.body);
    testUserId = userData.user_id;

    // Create test MCP entry that requires credentials
    testMcpId = crypto.randomUUID();
    await compatInsert(server.db, mcp_catalog).values({
      mcp_id: testMcpId,
      name: 'test-mcp-with-creds',
      display_name: 'Test MCP with Credentials',
      description: 'Test MCP that requires user credentials',
      transport_type: 'stdio',
      config: JSON.stringify({
        command: '/usr/bin/test',
        args: [],
      }),
      isolation_mode: 'per_user',
      requires_user_credentials: true,
      credential_schema: JSON.stringify({
        type: 'object',
        required: ['api_key', 'region'],
        properties: {
          api_key: { type: 'string' },
          region: { type: 'string' },
        },
      }),
      tool_catalog: '[]',
      tool_count: 0,
      status: 'published',
      validation_status: 'valid',
      validation_result: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Create a second MCP that does NOT require credentials
    noCrMcpId = crypto.randomUUID();
    await compatInsert(server.db, mcp_catalog).values({
      mcp_id: noCrMcpId,
      name: 'test-mcp-no-creds',
      display_name: 'Test MCP without Credentials',
      description: 'Test MCP that does not require credentials',
      transport_type: 'stdio',
      config: JSON.stringify({
        command: '/usr/bin/test',
        args: [],
      }),
      isolation_mode: 'shared',
      requires_user_credentials: false,
      credential_schema: '{}',
      tool_catalog: '[]',
      tool_count: 0,
      status: 'published',
      validation_status: 'valid',
      validation_result: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Login to get session cookie
    const loginRes = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username: 'credtestuser',
        password: 'Test1234!',
      },
    });

    expect(loginRes.statusCode).toBe(200);
    const cookie = extractCookie(loginRes.headers['set-cookie']);
    expect(cookie).toBeDefined();
    sessionCookie = cookie!;
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  describe('PUT /v1/users/me/credentials/:mcpId', () => {
    it('should set credentials for an MCP that requires credentials', async () => {
      const res = await server.fastify.inject({
        method: 'PUT',
        url: `/v1/users/me/credentials/${testMcpId}`,
        headers: { Cookie: sessionCookie },
        payload: {
          credentials: {
            api_key: 'test-key-12345',
            region: 'us-west-2',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.mcp_id).toBe(testMcpId);
      expect(data.has_credentials).toBe(true);
      expect(data.updated_at).toBeDefined();
    });

    it('should return 400 if MCP does not require credentials', async () => {
      const res = await server.fastify.inject({
        method: 'PUT',
        url: `/v1/users/me/credentials/${noCrMcpId}`,
        headers: { Cookie: sessionCookie },
        payload: {
          credentials: {
            api_key: 'test-key-12345',
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const data = res.json();
      expect(data.error).toBe('Bad request');
    });

    it('should return 404 if MCP does not exist', async () => {
      const fakeMcpId = crypto.randomUUID();

      const res = await server.fastify.inject({
        method: 'PUT',
        url: `/v1/users/me/credentials/${fakeMcpId}`,
        headers: { Cookie: sessionCookie },
        payload: {
          credentials: {
            api_key: 'test-key-12345',
          },
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 400 if required credential fields are missing', async () => {
      const res = await server.fastify.inject({
        method: 'PUT',
        url: `/v1/users/me/credentials/${testMcpId}`,
        headers: { Cookie: sessionCookie },
        payload: {
          credentials: {
            api_key: 'test-key-12345',
            // Missing 'region' field
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const data = res.json();
      expect(data.error).toBe('Validation failed');
    });

    it('should generate vault_salt if user does not have one', async () => {
      // Create a user via admin API
      const noSaltUserRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: { 'X-Admin-Key': server.adminKey },
        payload: {
          username: 'nosaltuser',
          password: 'NoSalt1234!',
          display_name: 'No Salt User',
          email: 'nosalt@example.com',
        },
      });

      expect(noSaltUserRes.statusCode).toBe(201);

      // Verify user has no vault_salt yet
      const userFromDb = await server.db.query.users.findFirst({
        where: (users, { eq }) => eq(users.username, 'nosaltuser'),
      });
      expect(userFromDb?.vault_salt).toBeNull();

      // Login as this user
      const noSaltLoginRes = await server.fastify.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          username: 'nosaltuser',
          password: 'NoSalt1234!',
        },
      });

      expect(noSaltLoginRes.statusCode).toBe(200);
      const noSaltCookie = extractCookie(noSaltLoginRes.headers['set-cookie']);
      expect(noSaltCookie).toBeDefined();

      // Set credentials - this should generate vault_salt
      const res = await server.fastify.inject({
        method: 'PUT',
        url: `/v1/users/me/credentials/${testMcpId}`,
        headers: { Cookie: noSaltCookie! },
        payload: {
          credentials: {
            api_key: 'test-key-nosalt',
            region: 'eu-west-1',
          },
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify vault_salt was generated
      const updatedUser = await server.db.query.users.findFirst({
        where: (users, { eq }) => eq(users.username, 'nosaltuser'),
      });
      expect(updatedUser?.vault_salt).toBeTruthy();
      expect(updatedUser?.vault_salt).toHaveLength(64); // 32 bytes hex-encoded
    });
  });

  describe('GET /v1/users/me/credentials', () => {
    it('should return credential status for all MCPs that require credentials', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me/credentials',
        headers: { Cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data)).toBe(true);

      // Find our test MCP
      const testMcpStatus = data.find((m: any) => m.mcp_id === testMcpId);
      expect(testMcpStatus).toBeDefined();
      expect(testMcpStatus.mcp_name).toBe('test-mcp-with-creds');
      expect(testMcpStatus.has_credentials).toBe(true); // We set credentials earlier
    });

    it('should never return actual credential values', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me/credentials',
        headers: { Cookie: sessionCookie },
      });

      const data = res.json();

      // Verify no credential values are returned
      for (const item of data) {
        expect(item).not.toHaveProperty('credentials');
        expect(item).not.toHaveProperty('encrypted_credentials');
        expect(item).not.toHaveProperty('api_key');
        expect(item.has_credentials).toBeTypeOf('boolean');
      }
    });
  });

  describe('DELETE /v1/users/me/credentials/:mcpId', () => {
    it('should delete credentials for an MCP', async () => {
      const res = await server.fastify.inject({
        method: 'DELETE',
        url: `/v1/users/me/credentials/${testMcpId}`,
        headers: { Cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(204);

      // Verify credentials are deleted
      const listRes = await server.fastify.inject({
        method: 'GET',
        url: '/v1/users/me/credentials',
        headers: { Cookie: sessionCookie },
      });

      const data = listRes.json();
      const testMcpStatus = data.find((m: any) => m.mcp_id === testMcpId);
      expect(testMcpStatus.has_credentials).toBe(false);
    });
  });
});
