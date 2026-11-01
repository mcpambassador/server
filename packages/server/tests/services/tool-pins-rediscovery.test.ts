import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ToolPinRediscovery,
  rediscoveryHoursFromEnv,
} from '../../src/services/tool-pins/rediscovery.js';

describe('rediscoveryHoursFromEnv', () => {
  it('defaults to 6, accepts 0 (off) and valid numbers, rejects junk', () => {
    expect(rediscoveryHoursFromEnv({})).toBe(6);
    expect(rediscoveryHoursFromEnv({ TOOL_PIN_REDISCOVERY_HOURS: '0' })).toBe(0);
    expect(rediscoveryHoursFromEnv({ TOOL_PIN_REDISCOVERY_HOURS: '12' })).toBe(12);
    expect(rediscoveryHoursFromEnv({ TOOL_PIN_REDISCOVERY_HOURS: 'x' })).toBe(6);
    expect(rediscoveryHoursFromEnv({ TOOL_PIN_REDISCOVERY_HOURS: '-1' })).toBe(6);
  });
});

describe('ToolPinRediscovery', () => {
  afterEach(() => vi.useRealTimers());

  const mk = () => {
    const mgr: any = {
      refreshMcp: vi.fn(async () => {}),
      refreshAll: vi.fn(async () => {}),
      getConnectionNames: () => [],
      onToolsListChanged: undefined,
    };
    const pool: any = { refreshAllTools: vi.fn(async () => {}) };
    const rd = new ToolPinRediscovery({
      db: {} as never,
      mcpManager: mgr,
      userPool: pool,
      toolRouter: {} as never,
      intervalHours: 6,
      debounceMs: 1000,
    });
    return { mgr, pool, rd };
  };

  it('debounces list_changed bursts into one refresh of that MCP', async () => {
    vi.useFakeTimers();
    const { mgr, rd } = mk();
    rd.start();
    mgr.onToolsListChanged('a');
    mgr.onToolsListChanged('a');
    mgr.onToolsListChanged('b');
    await vi.advanceTimersByTimeAsync(1100);
    expect(mgr.refreshMcp).toHaveBeenCalledTimes(2);
    expect(mgr.refreshMcp).toHaveBeenCalledWith('a');
    rd.stop();
    expect(mgr.onToolsListChanged).toBeUndefined();
  });

  it('refreshes shared and per-user connections every interval, skipping overlap', async () => {
    vi.useFakeTimers();
    const { mgr, pool, rd } = mk();
    rd.start();
    await vi.advanceTimersByTimeAsync(6 * 3_600_000 + 10);
    expect(mgr.refreshAll).toHaveBeenCalledTimes(1);
    expect(pool.refreshAllTools).toHaveBeenCalledTimes(1);
    rd.stop();
    await vi.advanceTimersByTimeAsync(12 * 3_600_000);
    expect(mgr.refreshAll).toHaveBeenCalledTimes(1);
  });
});
