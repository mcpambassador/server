import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerAdminMcpRoutes } from '../../src/admin/mcp-routes.js';
import { SecretStore } from '../../src/services/secret-store.js';

// TD-027: binding is checked at create/update time, before any DB access.
const store = new SecretStore({
  GITHUB_OAUTH_CLIENT_SECRET: { value: 'v', allowedTokenHosts: ['github.com'] },
});

const body = (over: Record<string, string>) => ({
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

async function app() {
  const f = Fastify();
  await f.register(registerAdminMcpRoutes, {
    db: {} as never,
    audit: {} as never,
    secretStore: store,
  });
  return f;
}

describe('admin MCP oauth_config secret binding (TD-027)', () => {
  it.each([
    ['create http token_url (S1)', 'POST', '/v1/admin/mcps', { token_url: 'http://github.com/t' }],
    [
      'create foreign revocation_url (B3)',
      'POST',
      '/v1/admin/mcps',
      { revocation_url: 'https://evil.example/r' },
    ],
    ['create wrong host', 'POST', '/v1/admin/mcps', { token_url: 'https://evil.example/t' }],
    ['create REGISTRY_TOKEN', 'POST', '/v1/admin/mcps', { client_secret_env: 'REGISTRY_TOKEN' }],
    [
      'create client_id_env DATABASE_URL',
      'POST',
      '/v1/admin/mcps',
      { client_id_env: 'DATABASE_URL' },
    ],
    [
      'update wrong host',
      'PATCH',
      '/v1/admin/mcps/11111111-1111-4111-8111-111111111111',
      { token_url: 'https://evil.example/t' },
    ],
  ])('%s -> 400 VALIDATION_ERROR', async (_n, method, url, over) => {
    const f = await app();
    const res = await f.inject({ method: method as 'POST', url, payload: body(over) });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('VALIDATION_ERROR');
    await f.close();
  });
});
