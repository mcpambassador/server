/** TD-027: registry installEntry applies the same oauth_config binding checks as admin saves. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getMcpEntryByName } from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { RegistryService } from '../../src/services/registry-service.js';
import { SecretStore } from '../../src/services/secret-store.js';

const oc = (over: Record<string, string> = {}): Record<string, string> => ({
  auth_url: 'https://github.com/login/oauth/authorize',
  token_url: 'https://github.com/login/oauth/access_token',
  scopes: 'repo',
  client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
  client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET',
  access_token_env_var: 'GITHUB_TOKEN',
  ...over,
});

const entries: Array<[string, Record<string, string>]> = [
  ['reg-good', oc()],
  ['reg-evil-host', oc({ token_url: 'https://evil.example/token' })],
  ['reg-registry-token', oc({ client_secret_env: 'REGISTRY_TOKEN' })],
  ['reg-http', oc({ token_url: 'http://github.com/login/oauth/access_token' })],
  ['reg-client-id', oc({ client_id_env: 'DATABASE_URL' })],
  ['reg-evil-revoke', oc({ revocation_url: 'https://evil.example/revoke' })],
];

const yamlDoc = (): string =>
  JSON.stringify({
    schema_version: '1',
    registry: { name: 't', maintainer: 't', updated_at: '2026-01-01' },
    mcps: entries.map(([name, cfg]) => ({
      name,
      display_name: name,
      description: 'd',
      transport_type: 'http',
      config: { url: 'https://mcp.example/mcp' },
      auth_type: 'oauth2',
      oauth_config: cfg,
    })),
  }); // JSON is valid YAML

describe('registry installEntry oauth_config binding', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  afterEach(() => vi.restoreAllMocks());

  async function svc(): Promise<RegistryService> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(yamlDoc(), { status: 200 }));
    const s = new RegistryService(
      { url: 'https://registry.example/r.yaml', refreshIntervalHours: 24, enabled: true },
      server.db,
      new SecretStore({
        GITHUB_OAUTH_CLIENT_SECRET: { value: 'x', allowedTokenHosts: ['github.com'] },
      })
    );
    await s.fetchRegistry();
    return s;
  }

  for (const [name] of entries.slice(1)) {
    it(`${name}: success:false and nothing stored`, async () => {
      const r = await (await svc()).installEntry(name);
      expect(r.success).toBe(false);
      expect(await getMcpEntryByName(server.db, name)).toBeNull();
    });
  }

  it('control: reg-good installs', async () => {
    const r = await (await svc()).installEntry('reg-good');
    expect(r.success).toBe(true);
    expect(await getMcpEntryByName(server.db, 'reg-good')).not.toBeNull();
  });
});
