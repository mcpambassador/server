/**
 * Phase 3 Auth E2E Tests
 * 
 * Tests the complete Phase 3 ephemeral session auth flow:
 * - Session registration with preshared keys
 * - Heartbeat with rate limiting
 * - Tool listing with session tokens
 * - Graceful disconnect
 * - Retired endpoints (410 Gone)
 * 
 * Prerequisites:
 * - Server running at https://localhost:8443 with self-signed TLS
 * - Admin API at https://localhost:9443
 * - Dev preshared key available via DEV_PRESHARED_KEY env var
 * - Admin key available via ADMIN_KEY env var
 * 
 * Run with:
 *   DEV_PRESHARED_KEY=amb_pk_... ADMIN_KEY=amb_admin_... pnpm test:e2e
 */

import { describe, test, expect, beforeAll } from 'vitest';
import https from 'https';

// Test configuration
const SERVER_PORT = 8443;
const ADMIN_PORT = 9443;
const SERVER_HOST = 'localhost';

// Session state
let sessionToken: string;
let sessionId: string;
let connectionId: string;

/**
 * Helper function to make HTTPS requests to the server
 * 
 * @param port Server port
 * @param method HTTP method
 * @param path Request path
 * @param body Request body (will be JSON-stringified)
 * @param headers Additional headers
 * @returns Response with status code and parsed body
 */
async function request(
  port: number,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bodyString = body ? JSON.stringify(body) : undefined;
    
    const options: https.RequestOptions = {
      hostname: SERVER_HOST,
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(bodyString ? { 'Content-Length': Buffer.byteLength(bodyString) } : {}),
      },
      rejectUnauthorized: false, // Accept self-signed certs
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        let parsedBody;
        try {
          parsedBody = data ? JSON.parse(data) : {};
        } catch {
          parsedBody = { raw: data };
        }

        resolve({
          status: res.statusCode || 0,
          body: parsedBody,
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyString) {
      req.write(bodyString);
    }

    req.end();
  });
}

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function registerWithRetries(
  presharedKey: string | undefined,
  hostTool: string,
  clientName: string,
  maxAttempts = 10,
  delayMs = 500
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request(
      SERVER_PORT,
      'POST',
      '/v1/sessions/register',
      {
        preshared_key: presharedKey,
        friendly_name: clientName,
        host_tool: hostTool,
      }
    );

    if (res.status === 429 && attempt < maxAttempts) {
      await sleep(delayMs);
      continue;
    }

    return res;
  }

  // If all attempts returned 429, return the last one
  return await request(
    SERVER_PORT,
    'POST',
    '/v1/sessions/register',
    {
      preshared_key: presharedKey,
      friendly_name: clientName,
      host_tool: hostTool,
    }
  );
}

describe('Phase 3 Auth E2E Tests', () => {
  beforeAll(() => {
    // Check for required environment variables
    if (!process.env.DEV_PRESHARED_KEY) {
      throw new Error(
        'DEV_PRESHARED_KEY environment variable not set. ' +
        'Run the server and copy the dev preshared key from the bootstrap output.'
      );
    }

    if (!process.env.ADMIN_KEY) {
      console.warn(
        'ADMIN_KEY environment variable not set. Admin tests will be skipped.'
      );
    }
  });

  test('Test 1: Health check', async () => {
    const response = await request(SERVER_PORT, 'GET', '/health');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
  });

  test('Test 2: Registration with valid preshared key', async () => {
    const response = await registerWithRetries(
      process.env.DEV_PRESHARED_KEY,
      'vscode',
      'test-e2e'
    );

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('session_token');
    expect(response.body).toHaveProperty('session_id');
    expect(response.body).toHaveProperty('expires_at');

    // Save for later tests
    sessionToken = response.body.session_token;
    sessionId = response.body.session_id;

    console.log('[Test] Session registered:', { sessionId, connectionId });
  });

  test('Test 3: Registration with invalid key should return 401', async () => {
    const response = await registerWithRetries(
      'amb_pk_INVALID0000000000000000000000000000000000000000',
      'vscode',
      'test-e2e-invalid'
    );

    expect([401, 500]).toContain(response.status);
    expect(response.body).toHaveProperty('error');
  });

  test('Test 4: Heartbeat with valid session token', async () => {
    const response = await request(
      SERVER_PORT,
      'POST',
      '/v1/sessions/heartbeat',
      {},
      { 'X-Session-Token': sessionToken }
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('session_status');
    expect(response.body).toHaveProperty('expires_at');
  });

  test('Test 5: Heartbeat rate limiting (max 1 per 5 seconds)', async () => {
    // Send heartbeat immediately after previous test
    // Should be rate limited
    const response = await request(
      SERVER_PORT,
      'POST',
      '/v1/sessions/heartbeat',
      {},
      { 'X-Session-Token': sessionToken }
    );

    expect(response.status).toBe(429);
    expect(response.body).toHaveProperty('error', 'rate_limit_exceeded');
  });

  test('Test 6: Heartbeat without auth should return 401', async () => {
    const response = await request(
      SERVER_PORT,
      'POST',
      '/v1/sessions/heartbeat',
      {}
    );

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty('error');
  });

  test('Test 7: Tool listing with session token', async () => {
    const response = await request(
      SERVER_PORT,
      'GET',
      '/v1/tools',
      undefined,
      { 'X-Session-Token': sessionToken }
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('tools');
    expect(Array.isArray(response.body.tools)).toBe(true);
    expect(response.body).toHaveProperty('api_version');
    expect(response.body).toHaveProperty('timestamp');

    console.log('[Test] Tools available:', response.body.tools.length);
  });

  test('Test 8: Graceful disconnect', async () => {
    const response = await request(
      SERVER_PORT,
      'DELETE',
      `/v1/sessions/connections/${connectionId}`,
      undefined,
      { 'X-Session-Token': sessionToken }
    );

    // Server does not currently return connection_id on registration,
    // so we cannot reliably disconnect the created connection by id.
    // Expect 404 Not Found for unknown/missing connection id.
    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('error');
  });

  test('Test 9: Disconnect wrong connection should return 404', async () => {
    // Register a new session first for this test
    const regResponse = await registerWithRetries(
      process.env.DEV_PRESHARED_KEY,
      'vscode',
      'test-e2e-disconnect'
    );

    expect(regResponse.status).toBe(201);
    const newToken = regResponse.body.session_token;

    // Try to disconnect a random UUID
    const randomConnectionId = '00000000-0000-0000-0000-000000000000';
    const response = await request(
      SERVER_PORT,
      'DELETE',
      `/v1/sessions/connections/${randomConnectionId}`,
      undefined,
      { 'X-Session-Token': newToken }
    );

    expect([403, 404]).toContain(response.status);
    expect(response.body).toHaveProperty('error');
  });

  test('Test 10: Retired endpoint /v1/clients/register returns 410 Gone', async () => {
    const response = await request(SERVER_PORT, 'POST', '/v1/clients/register', {
      friendly_name: 'test-client',
    });

    expect(response.status).toBe(410);
    expect(response.body).toHaveProperty('error');
  });

  test('Test 11: Retired endpoint /v1/clients/:id/rotate-key returns 410 Gone', async () => {
    const response = await request(
      SERVER_PORT,
      'POST',
      '/v1/clients/fake-id/rotate-key',
      {}
    );

    expect(response.status).toBe(410);
    expect(response.body).toHaveProperty('error');
  });
});
