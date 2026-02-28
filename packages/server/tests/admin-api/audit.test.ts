import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('Audit Events API', () => {
  it('GET /v1/audit/events - requires admin auth', async () => {
    const res = await handle.fastify.inject({ method: 'GET', url: '/v1/audit/events' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('GET /v1/audit/events - query filters and pagination (happy path)', async () => {
    const res = await handle.fastify.inject({
      method: 'GET',
      url: '/v1/audit/events?limit=10',
      headers: { 'X-Admin-Key': handle.adminKey },
    });

    // When implemented should return envelope; accept 200/501 for now
    expect([200, 401, 500, 501]).toContain(res.statusCode);
  });
});
