/** TD-035: entries whose only problem is a missing server-side OAuth secret are listed, not hidden. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getMcpEntryByName } from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import {
  RegistryService,
  REGISTRY_UNAVAILABLE_REASON,
} from '../../src/services/registry-service.js';
import { SecretStore } from '../../src/services/secret-store.js';

const entry = (name: string, oauth?: Record<string, string>): Record<string, unknown> => ({
  name,
  display_name: name,
  description: 'd',
  transport_type: 'http',
  config: { url: 'https://mcp.example/mcp' },
  ...(oauth ? { auth_type: 'oauth2', oauth_config: oauth } : {}),
});
const gh = (over: Record<string, string> = {}): Record<string, string> => ({
  auth_url: 'https://github.com/login/oauth/authorize',
  token_url: 'https://github.com/login/oauth/access_token',
  scopes: 'repo',
  client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
  client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET',
  access_token_env_var: 'GITHUB_TOKEN',
  ...over,
});

const doc = JSON.stringify({
  schema_version: '1',
  registry: { name: 't', maintainer: 't', updated_at: '2026-01-01' },
  mcps: [
    entry('plain'),
    entry('github-like', gh()),
    entry('wrong-host', gh({ token_url: 'https://evil.example/token' })),
    entry('http-url', gh({ token_url: 'http://github.com/login/oauth/access_token' })),
  ],
});

describe('registry unavailable vs invalid (TD-035)', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  afterEach(() => vi.restoreAllMocks());

  async function load(store: SecretStore): Promise<RegistryService> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(doc, { status: 200 }));
    const s = new RegistryService(
      { url: 'https://registry.example/r.yaml', refreshIntervalHours: 24, enabled: true },
      server.db,
      store
    );
    await s.fetchRegistry();
    return s;
  }

  it('without the secret: listed as not installable with a generic reason', async () => {
    const s = await load(new SecretStore());
    const byName = Object.fromEntries((await s.getEntries()).map(e => [e.name, e]));
    expect(byName['plain']?.installable).toBe(true);
    expect(byName['plain']?.unavailable_reason).toBeUndefined();
    expect(byName['github-like']?.installable).toBe(false);
    expect(byName['github-like']?.unavailable_reason).toBe(REGISTRY_UNAVAILABLE_REASON);
    expect(REGISTRY_UNAVAILABLE_REASON).not.toMatch(/[A-Z]{3,}_|github\.com/);
    // wrong host / http URL are still INVALID, not unavailable
    expect(byName['http-url']).toBeUndefined();
    expect(s.getSkippedEntries().map(x => x.name)).toContain('http-url');
    expect(
      s
        .getUnavailableEntries()
        .map(x => x.name)
        .sort()
    ).toEqual(['github-like', 'wrong-host']);
    expect(JSON.stringify(s.getUnavailableEntries())).not.toContain('GITHUB_OAUTH');
    expect((await s.getEntry('github-like'))?.installable).toBe(false);
  });

  it('install is refused without leaking env names, and nothing is stored', async () => {
    const s = await load(new SecretStore());
    const r = await s.installEntry('github-like');
    expect(r.success).toBe(false);
    expect(r.message).toContain(REGISTRY_UNAVAILABLE_REASON);
    expect(r.message).not.toContain('GITHUB_OAUTH_CLIENT_SECRET');
    expect(await getMcpEntryByName(server.db, 'github-like')).toBeNull();
  });

  it('with the secret bound to the host: installable; wrong host is invalid', async () => {
    const s = await load(
      new SecretStore({
        GITHUB_OAUTH_CLIENT_SECRET: { value: 'x', allowedTokenHosts: ['github.com'] },
      })
    );
    const byName = Object.fromEntries((await s.getEntries()).map(e => [e.name, e]));
    expect(byName['github-like']?.installable).toBe(true);
    expect(byName['wrong-host']).toBeUndefined();
    expect(s.getSkippedEntries().map(x => x.name)).toContain('wrong-host');
    expect(s.getUnavailableEntries()).toEqual([]);
  });
});
