/** TD-031: registry import validates every entry like the admin create path and skips bad ones. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { RegistryService } from '../../src/services/registry-service.js';
import { SecretStore } from '../../src/services/secret-store.js';

const base = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  display_name: name,
  description: 'd',
  transport_type: 'http',
  config: { url: 'https://mcp.example/mcp' },
  tags: ['x'],
  category: 'misc',
  ...over,
});

const oauth = (over: Record<string, string> = {}): Record<string, unknown> => ({
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

const mcps = [
  base('good-plain'),
  base('good-oauth', oauth()),
  base('good-partial-oauth', {
    auth_type: 'oauth2',
    oauth_config: { token_url: 'https://github.com/login/oauth/access_token' },
  }),
  // Real supabase shape from registry.yaml: empty scopes, no env names
  base('supabase-shape', {
    auth_type: 'oauth2',
    oauth_config: {
      auth_url: 'https://mcp.supabase.com/oauth/authorize',
      token_url: 'https://mcp.supabase.com/oauth/token',
      scopes: '',
    },
  }),
  base('Bad_Name'),
  base('bad-transport', { transport_type: 'ftp' }),
  base('bad-config', { config: 'not-an-object' }),
  base('bad-http-oauth', oauth({ token_url: 'http://github.com/login/oauth/access_token' })),
  base('bad-client-id', oauth({ client_id_env: 'DATABASE_URL' })),
  base('bad-host', oauth({ token_url: 'https://evil.example/token' })),
  base('bad-secret', oauth({ client_secret_env: 'REGISTRY_TOKEN' })),
  'not-an-object',
];

const doc = JSON.stringify({
  schema_version: '1',
  registry: { name: 't', maintainer: 't', updated_at: '2026-01-01' },
  mcps,
});

describe('registry import validation (TD-031)', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  afterEach(() => vi.restoreAllMocks());

  async function loaded(): Promise<RegistryService> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(doc, { status: 200 }));
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

  it('keeps conforming entries (and not-yet-installable ones) and drops the rest', async () => {
    const s = await loaded();
    const names = (await s.getEntries()).map(e => e.name).sort();
    expect(names).toEqual([
      'bad-secret',
      'good-oauth',
      'good-partial-oauth',
      'good-plain',
      'supabase-shape',
    ]);
  });

  it('records skipped entries with name and reason only', async () => {
    const skipped = (await loaded()).getSkippedEntries();
    expect(skipped.map(x => x.name).sort()).toEqual([
      '(unnamed)',
      'Bad_Name',
      'bad-client-id',
      'bad-config',
      'bad-host',
      'bad-http-oauth',
      'bad-transport',
    ]);
    for (const x of skipped) {
      expect(Object.keys(x).sort()).toEqual(['name', 'reason']);
      expect(x.reason.length).toBeGreaterThan(0);
      expect(x.reason.length).toBeLessThanOrEqual(200);
    }
  });

  it('supabase-shaped entry (scopes empty) loads and installs without scopes', async () => {
    const s = await loaded();
    expect(s.getSkippedEntries().map(x => x.name)).not.toContain('supabase-shape');
    const r = await s.installEntry('supabase-shape');
    expect(r.success).toBe(true);
  });

  it('a dropped entry cannot be installed', async () => {
    const r = await (await loaded()).installEntry('bad-host');
    expect(r.success).toBe(false);
  });

  it('reasons never echo received values or env var names', async () => {
    const skipped = (await loaded()).getSkippedEntries();
    const byName = Object.fromEntries(skipped.map(x => [x.name, x.reason]));
    expect(byName['bad-transport']).toBe('transport_type: Invalid value');
    expect(byName['bad-transport']).not.toContain('ftp');
    expect(byName['bad-host']).toBe('oauth_config: secret binding rejected');
    const all = JSON.stringify(skipped);
    for (const leak of ['REGISTRY_TOKEN', 'GITHUB_OAUTH_CLIENT_SECRET', 'evil.example']) {
      expect(all).not.toContain(leak);
    }
  });

  it('control characters in names are neutralised in the skip record', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          schema_version: '1',
          registry: { name: 't', maintainer: 't', updated_at: '2026-01-01' },
          mcps: [base('evil\nname‮', { transport_type: 'x' })],
        }),
        { status: 200 }
      )
    );
    const s = new RegistryService(
      { url: 'https://registry.example/r.yaml', refreshIntervalHours: 24, enabled: true },
      server.db
    );
    await s.fetchRegistry();
    expect(s.getSkippedEntries()[0]?.name).toBe('evil?name?');
  });
});
