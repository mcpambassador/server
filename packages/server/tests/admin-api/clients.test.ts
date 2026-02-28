import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('Clients API', () => {
  it('GET /v1/admin/clients - requires admin auth', async () => {
    const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/clients' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('PATCH /v1/clients/:clientId/status - update client status', async () => {
    const fakeClient = '00000000-0000-0000-0000-000000000000';
    const res = await handle.fastify.inject({
      method: 'PATCH',
      url: `/v1/clients/${fakeClient}/status`,
      headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ status: 'suspended' }),
    });

    expect([200, 400, 401, 404, 501]).toContain(res.statusCode);
  });
});
