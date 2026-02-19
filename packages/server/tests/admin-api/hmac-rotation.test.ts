/**
 * HMAC Secret Rotation Tests (M19.2a)
 *
 * Tests the POST /v1/admin/rotate-hmac-secret endpoint for emergency secret rotation.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers.js';
import crypto from 'crypto';
import argon2 from 'argon2';
import { compatInsert, preshared_keys } from '@mcpambassador/core';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('HMAC Secret Rotation', () => {
  it('POST /v1/admin/rotate-hmac-secret - rotates secret successfully', async () => {
    // Count active sessions before rotation (should be 0 on fresh server)
    const db = handle.db;
    const sessionsBeforeCount = await db.query.user_sessions.findMany({
      where: (s: any, { eq }: any) => eq(s.status, 'active'),
    });

    // Call rotation endpoint
    const response = await handle.fastify.inject({
      method: 'POST',
      url: '/v1/admin/rotate-hmac-secret',
      headers: {
        'X-Admin-Key': handle.adminKey,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.success).toBe(true);
    expect(body.sessionsInvalidated).toBe(sessionsBeforeCount.length);
    expect(body.message).toBe('HMAC secret rotated. All sessions invalidated.');
  });

  it('POST /v1/admin/rotate-hmac-secret - requires admin authentication', async () => {
    const response = await handle.fastify.inject({
      method: 'POST',
      url: '/v1/admin/rotate-hmac-secret',
      // No X-Admin-Key header
    });

    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/admin/rotate-hmac-secret - is idempotent', async () => {
    // Call once
    const response1 = await handle.fastify.inject({
      method: 'POST',
      url: '/v1/admin/rotate-hmac-secret',
      headers: {
        'X-Admin-Key': handle.adminKey,
      },
    });

    expect(response1.statusCode).toBe(200);
    const body1 = JSON.parse(response1.body);
    expect(body1.success).toBe(true);

    // Call again immediately (should succeed with 0 sessions invalidated since all already expired)
    const response2 = await handle.fastify.inject({
      method: 'POST',
      url: '/v1/admin/rotate-hmac-secret',
      headers: {
        'X-Admin-Key': handle.adminKey,
      },
    });

    expect(response2.statusCode).toBe(200);
    const body2 = JSON.parse(response2.body);
    expect(body2.success).toBe(true);
    expect(body2.sessionsInvalidated).toBe(0); // No active sessions to invalidate
  });
});
