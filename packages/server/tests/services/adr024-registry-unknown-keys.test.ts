/** ADR-024: sync provenance / unknown registry keys are neither persisted nor echoed. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getMcpEntryByName } from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { RegistryService, pickRegistryEntry } from '../../src/services/registry-service.js';
import { SecretStore } from '../../src/services/secret-store.js';

const PROVENANCE = {
  source: 'official-registry',
  official_name: 'io.github.acme/thing',
  namespace_verification: 'github',
  package_integrity: { npm: 'sha512-AAAA' },
  dependencies_pinned: false,
  pinning: 'none',
  flags: ['new-package', 'name-near-match'],
  synced_at: '2026-11-08T00:00:00Z',
  unknown_future_key: { x: 1 },
};

const doc = [
  'schema_version: "1.0"',
  'registry: { name: t, maintainer: t, updated_at: "2026-01-01" }',
  'mcps:',
  '  - name: synced-thing',
  '    display_name: Synced Thing',
  '    description: d',
  '    transport_type: stdio',
  '    config: { command: [npx, -y, "pkg@1.2.3"] }',
  '    auth_type: none',
  '    verified: false',
  ...Object.entries(PROVENANCE).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`),
  '    __proto__: { polluted: true }',
].join('\n');

describe('registry entries drop unknown / provenance keys (ADR-024)', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  afterEach(() => vi.restoreAllMocks());

  async function load(): Promise<RegistryService> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(doc, { status: 200 }));
    const s = new RegistryService(
      { url: 'https://registry.example/r.yaml', refreshIntervalHours: 24, enabled: true },
      server.db,
      new SecretStore()
    );
    await s.fetchRegistry();
    return s;
  }

  it('lists the entry without any provenance or unknown key', async () => {
    const s = await load();
    const entries = await s.getEntries();
    expect(entries.map(e => e.name)).toEqual(['synced-thing']);
    const e = entries[0] as unknown as Record<string, unknown>;
    for (const k of Object.keys(PROVENANCE)) expect(e).not.toHaveProperty(k);
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(e.verified).toBe(false);
    expect(e.config).toEqual({ command: ['npx', '-y', 'pkg@1.2.3'] });
  });

  it('installs exactly as before; nothing provenance-shaped reaches the catalog row', async () => {
    const s = await load();
    const r = await s.installEntry('synced-thing');
    expect(r.success).toBe(true);
    const row = (await getMcpEntryByName(server.db, 'synced-thing')) as unknown as Record<
      string,
      unknown
    >;
    expect(row.status).toBe('draft');
    expect(JSON.stringify(row)).not.toMatch(/official-registry|sha512-AAAA|name-near-match/);
    for (const k of Object.keys(PROVENANCE)) expect(row).not.toHaveProperty(k);
  });

  it('pickRegistryEntry keeps every known key and nothing else', () => {
    const known = {
      name: 'a',
      display_name: 'A',
      description: 'd',
      icon_url: 'https://x/i.png',
      transport_type: 'http' as const,
      config: { url: 'https://x/mcp' },
      auth_type: 'none' as const,
      isolation_mode: 'shared' as const,
      requires_user_credentials: false,
      credential_schema: {},
      tags: ['t'],
      category: 'c',
      repository_url: 'https://x/r',
      documentation_url: 'https://x/d',
      version: '1.0.0',
      maintainer: 'm',
      verified: true,
    };
    expect(pickRegistryEntry({ ...known, ...PROVENANCE } as never)).toEqual(known);
  });
});
