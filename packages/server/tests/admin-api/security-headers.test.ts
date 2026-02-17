import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

let handle: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('SEC-M8-01 / Security headers and sanitization', () => {
  it('includes X-Content-Type-Options and Cache-Control on /health', async () => {
    const res = await handle.fastify.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('error responses do not expose stack traces or file paths', async () => {
    // Trigger an internal error by calling an unimplemented admin endpoint without auth
    const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles' });
    // Response may be 401 or 501 during initial implementation; check body for sensitive data
    const body = res.body || '';
    expect(body).not.toMatch(/\b(stack|Error:|TypeError|ReferenceError)\b/);
    expect(body).not.toMatch(/\/home\//);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
