import { describe, it, expect } from 'vitest';
import { SharedMcpManager } from '../../src/downstream/manager';
import { makeMcpConfig, makeTool } from './helpers';

describe('SharedMcpManager mixed transports', () => {
  // These configs cannot connect (no such stdio binary, nothing listening); the manager must
  // isolate each failure instead of throwing, and expose an empty catalog.
  it('initializes mixed transport configs without throwing when none connect', async () => {
    const mgr = new SharedMcpManager();
    const configs = [
      makeMcpConfig({ name: 's1', transport: 'stdio' }),
      makeMcpConfig({ name: 'h1', transport: 'http', url: 'http://127.0.0.1:1' }),
    ];
    await expect(mgr.initialize(configs)).resolves.toBeUndefined();
    expect(mgr.getConnectionNames()).toEqual([]);
    await mgr.shutdown();
  });

  it('aggregates an empty tool catalog across transports', async () => {
    const mgr = new SharedMcpManager();
    await mgr.aggregateTools();
    expect(Array.isArray(mgr.getToolCatalog())).toBe(true);
    expect(mgr.getToolCatalog()).toHaveLength(0);
  });
});
