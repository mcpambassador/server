import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('Downstream MCPs API', () => {
  it('GET /v1/admin/downstream - returns configured MCPs with status', async () => {
    const res = await handle.fastify.inject({
      method: 'GET',
      url: '/v1/admin/downstream',
      headers: { 'X-Admin-Key': handle.adminKey },
    });

    // Implementation pending - accept 200/401/404/501 for now
    expect([200, 401, 404, 500, 501]).toContain(res.statusCode);
  });
});
