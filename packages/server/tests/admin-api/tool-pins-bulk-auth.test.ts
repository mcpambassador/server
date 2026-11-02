import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

let handle: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  handle = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(handle);
});

describe('bulk tool-pin approve requires admin auth (FB-033)', () => {
  const url = '/v1/admin/mcps/some-mcp/tool-pins/approve';
  const payload = { items: [{ pin_id: 'p', expected_hash: 'a'.repeat(64) }] };

  it('401 without an admin key', async () => {
    const res = await handle.fastify.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(401);
  });
  it('401 with an invalid admin key', async () => {
    const res = await handle.fastify.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'X-Admin-Key': 'invalid_key' },
    });
    expect(res.statusCode).toBe(401);
  });
  it('passes auth with the admin key (then 404 for unknown MCP or 503 without pins)', async () => {
    const res = await handle.fastify.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'X-Admin-Key': handle.adminKey },
    });
    expect([404, 503]).toContain(res.statusCode);
  });
});
