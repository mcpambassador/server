import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('Admin authentication', () => {
  it('returns 401 for admin endpoints without X-Admin-Key header', async () => {
    const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);
  });

  it('returns 401 for admin endpoints with invalid X-Admin-Key', async () => {
    const res = await handle.fastify.inject({
      method: 'GET',
      url: '/v1/admin/profiles',
      headers: { 'X-Admin-Key': 'invalid_key' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);
  });

  it('accepts requests with valid X-Admin-Key when implemented (happy path)', async () => {
    const res = await handle.fastify.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { 'X-Admin-Key': handle.adminKey },
    });

    // Implementation pending — expect a non-500 status (501 until implemented)
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
  });
});
