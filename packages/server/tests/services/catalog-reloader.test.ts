import { describe, it, expect, beforeEach, vi } from 'vitest';

import { computeConfigFingerprint } from '../../src/downstream/manager.js';
import { CatalogReloader, CatalogReloadConflictError } from '../../src/services/catalog-reloader.js';

// Mock the catalog service so tests control DB catalog output
vi.mock('../../src/services/mcp-catalog-service.js', () => ({
  listMcpCatalogEntries: vi.fn(),
}));

import { listMcpCatalogEntries } from '../../src/services/mcp-catalog-service.js';

function makeEntry(name: string, transport = 'stdio', configObj = { command: ['true'] }, isolation_mode = 'shared') {
  return {
    name,
    transport_type: transport,
    config: JSON.stringify(configObj),
    isolation_mode,
  } as any;
}

describe('CatalogReloader (unit)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('computeConfigFingerprint parity', () => {
    const cfg = JSON.stringify({ command: ['a'] });
    const a = computeConfigFingerprint('stdio', cfg, 'shared');
    const b = computeConfigFingerprint('stdio', cfg, 'shared');
    expect(a).toBe(b);
  });

  it('diff algorithm - add', async () => {
    const shared = [makeEntry('new-mcp')];
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: shared, has_more: false });
    // per-user call
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [], has_more: false });

    const mcpManager = { getRunningFingerprints: () => new Map() } as any;
    const userPool = {
      getMcpConfigNames: () => [],
      getMcpConfigFingerprints: () => new Map(),
    } as any;

    const reloader = new CatalogReloader({} as any, mcpManager, userPool);
    const preview = await reloader.previewChanges();
    expect(preview.shared.to_add.some((x: any) => x.name === 'new-mcp')).toBeTruthy();
  });

  it('diff algorithm - remove', async () => {
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [], has_more: false });
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [], has_more: false });

    const mfp = new Map<string, string>();
    mfp.set('stale-mcp', 'fp-old');
    const mcpManager = { getRunningFingerprints: () => mfp } as any;
    const userPool = { getMcpConfigNames: () => [], getMcpConfigFingerprints: () => new Map() } as any;

    const reloader = new CatalogReloader({} as any, mcpManager, userPool);
    const preview = await reloader.previewChanges();
    expect(preview.shared.to_remove.some((x: any) => x.name === 'stale-mcp')).toBeTruthy();
  });

  it('diff algorithm - update', async () => {
    const entry = makeEntry('mcp1', 'stdio', { command: ['a'] });
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [entry], has_more: false });
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [], has_more: false });

    const desiredFp = computeConfigFingerprint(entry.transport_type, entry.config, entry.isolation_mode);
    const running = new Map<string, string>();
    running.set('mcp1', 'different-fp');

    const mcpManager = { getRunningFingerprints: () => running } as any;
    const userPool = { getMcpConfigNames: () => [], getMcpConfigFingerprints: () => new Map() } as any;

    const reloader = new CatalogReloader({} as any, mcpManager, userPool);
    const preview = await reloader.previewChanges();
    expect(preview.shared.to_update.some((x: any) => x.name === 'mcp1')).toBeTruthy();
  });

  it('diff algorithm - no-op', async () => {
    const entry = makeEntry('mcp-noop');
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [entry], has_more: false });
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [], has_more: false });

    const fp = computeConfigFingerprint(entry.transport_type, entry.config, entry.isolation_mode);
    const running = new Map<string, string>();
    running.set('mcp-noop', fp);

    const mcpManager = { getRunningFingerprints: () => running } as any;
    const userPool = { getMcpConfigNames: () => [], getMcpConfigFingerprints: () => new Map() } as any;

    const reloader = new CatalogReloader({} as any, mcpManager, userPool);
    const preview = await reloader.previewChanges();
    expect(preview.shared.unchanged.includes('mcp-noop')).toBeTruthy();
  });

  it('partial failure handling', async () => {
    const a = makeEntry('a');
    const b = makeEntry('b');
    const bad = makeEntry('bad');
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [a, b, bad], has_more: false });
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: [], has_more: false });

    const running = new Map<string, string>();
    const addedOrder: string[] = [];

    const mcpManager = {
      getRunningFingerprints: () => running,
      addMcp: async (config: any, fp?: string) => {
        if (config.name === 'bad') throw new Error('boom');
        // simulate async work
        await Promise.resolve();
        addedOrder.push(config.name);
      },
      updateMcp: async () => {},
      removeMcp: async () => {},
      aggregateTools: async () => {},
    } as any;

    const userPool = {
      getMcpConfigNames: () => [],
      getMcpConfigFingerprints: () => new Map(),
      updateMcpConfigs: () => ({ added: [], removed: [], updated: [] }),
      getStatus: () => ({ userCount: 0 }),
    } as any;

    const reloader = new CatalogReloader({} as any, mcpManager, userPool);
    const res = await reloader.applyChanges();
    expect(res.shared.added.sort()).toEqual(['a', 'b'].sort());
    expect(res.shared.errors.some(e => e.name === 'bad' && e.action === 'add')).toBeTruthy();
  });

  it('concurrent reload conflict', async () => {
    const e = makeEntry('x');
    (listMcpCatalogEntries as any).mockResolvedValue({ entries: [e], has_more: false });

    const mcpManager = {
      getRunningFingerprints: () => new Map<string, string>(),
      addMcp: async () => new Promise(r => setTimeout(r, 100)),
      updateMcp: async () => {},
      removeMcp: async () => {},
      aggregateTools: async () => {},
    } as any;

    const userPool = {
      getMcpConfigNames: () => [],
      getMcpConfigFingerprints: () => new Map(),
      updateMcpConfigs: () => ({ added: [], removed: [], updated: [] }),
      getStatus: () => ({ userCount: 0 }),
    } as any;

    const reloader = new CatalogReloader({} as any, mcpManager, userPool);

    const p1 = reloader.applyChanges();
    await new Promise(r => setTimeout(r, 10));
    await expect(reloader.applyChanges()).rejects.toBeInstanceOf(CatalogReloadConflictError);
    await p1; // allow first to finish
  });

  it('per-user diff detection', async () => {
    const shared = [] as any[];
    const perUser = [makeEntry('u-b', 'stdio', { command: ['1'] }, 'per_user'), makeEntry('u-c', 'stdio', { command: ['2'] }, 'per_user')];
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: shared, has_more: false });
    (listMcpCatalogEntries as any).mockResolvedValueOnce({ entries: perUser, has_more: false });

    const userPool = {
      getMcpConfigNames: () => ['u-a', 'u-b'],
      getMcpConfigFingerprints: () => new Map([['u-a', 'fp-a'], ['u-b', 'fp-old']]),
    } as any;

    const mcpManager = { getRunningFingerprints: () => new Map() } as any;
    const reloader = new CatalogReloader({} as any, mcpManager, userPool);
    const preview = await reloader.previewChanges();
    // u-c should be to_add, u-a to_remove, u-b to_update (fingerprint differs)
    expect(preview.per_user.to_add.some((x: any) => x.name === 'u-c')).toBeTruthy();
    expect(preview.per_user.to_remove.some((x: any) => x.name === 'u-a')).toBeTruthy();
    expect(preview.per_user.to_update.some((x: any) => x.name === 'u-b')).toBeTruthy();
  });
});
