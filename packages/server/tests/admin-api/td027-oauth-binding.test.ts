import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer } from './helpers';

// TD-027: through the REAL admin routes (real error handler), not a bare Fastify.
let handle: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  handle = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(handle);
});

const body = (over: Record<string, unknown>) => ({
  name: 'gh',
  display_name: 'GH',
  transport_type: 'http',
  config: { url: 'https://example.com/mcp' },
  auth_type: 'oauth2',
  oauth_config: {
    auth_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    scopes: 'repo',
    client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
    client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET',
    access_token_env_var: 'GITHUB_TOKEN',
    ...over,
  },
});

const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  handle.fastify.inject({
    method,
    url,
    headers: { 'X-Admin-Key': handle.adminKey, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload),
  });

describe('admin MCP oauth_config validation (TD-027)', () => {
  it.each([
    ['wrong host', { token_url: 'https://evil.example/t' }],
    ['REGISTRY_TOKEN as secret', { client_secret_env: 'REGISTRY_TOKEN' }],
    ['http token_url (S1)', { token_url: 'http://github.com/t' }],
    ['foreign revocation_url (B3)', { revocation_url: 'https://evil.example/r' }],
    ['client_id_env DATABASE_URL (S2)', { client_id_env: 'DATABASE_URL' }],
  ])('POST %s -> 400 VALIDATION_ERROR', async (_n, over) => {
    const res = await send('POST', '/v1/admin/mcps', body(over));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH wrong host / http / bad client id -> 400', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    for (const over of [
      { token_url: 'https://evil.example/t' },
      { token_url: 'http://github.com/t' },
      { client_id_env: 'DATABASE_URL' },
    ]) {
      const res = await send('PATCH', `/v1/admin/mcps/${id}`, body(over));
      expect(res.statusCode).toBe(400);
    }
  });

  it('schema errors report paths and messages, not received values', async () => {
    const res = await send('POST', '/v1/admin/mcps', body({ client_id_env: 'DATABASE_URL' }));
    const text = JSON.stringify(res.json());
    expect(text).toContain('oauth_config.client_id_env');
    expect(text).not.toContain('postgres');
  });

  it('other admin routes now return 400 (not 500) for invalid bodies', async () => {
    const res = await send('POST', '/v1/admin/mcps', { name: 5 });
    expect(res.statusCode).toBe(400);
  });
});
