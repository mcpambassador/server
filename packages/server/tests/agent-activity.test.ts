/** ADR-020 S6: agent activity keeps per-user MCPs alive; the reaper stops quiet, session-less ones. */
import { describe, it, expect, vi } from 'vitest';
import { UserMcpPool } from '../src/downstream/index.js';
import { SessionLifecycleManager } from '../src/session/lifecycle-manager.js';

const mkPool = (): UserMcpPool => new UserMcpPool({ healthCheckIntervalMs: 0 } as any);

describe('UserMcpPool agent activity', () => {
  it('tracks recent activity within a window and clears it on terminate', async () => {
    const pool = mkPool();
    const t0 = 1_000_000;
    expect(pool.hasRecentActivity('u1', 300_000, t0)).toBe(false);
    pool.markActivity('u1', t0);
    expect(pool.hasRecentActivity('u1', 300_000, t0 + 299_000)).toBe(true);
    expect(pool.hasRecentActivity('u1', 300_000, t0 + 301_000)).toBe(false);
    pool.markActivity('u1', Date.now());
    await pool.terminateForUser('u1');
    expect(pool.hasRecentActivity('u1')).toBe(false);
    await pool.shutdown();
  });
});

describe('SessionLifecycleManager agent reaper', () => {
  const build = (liveSession: boolean, active: boolean) => {
    const terminate = vi.fn(() => Promise.resolve());
    const pool = {
      listActiveUserIds: () => ['u1'],
      hasRecentActivity: () => active,
      terminateForUser: terminate,
    };
    const db = {
      query: {
        user_sessions: {
          findFirst: () => Promise.resolve(liveSession ? { session_id: 's' } : undefined),
        },
      },
    };
    const mgr = new SessionLifecycleManager(
      db as any,
      { emit: () => Promise.resolve() } as any,
      { evaluationIntervalMs: 1, sweepIntervalMs: 1, ttlHardMaxSeconds: 1 },
      pool as any
    );
    return { mgr, terminate };
  };

  it('terminates quiet users with no live session', async () => {
    const { mgr, terminate } = build(false, false);
    await (mgr as any).reapIdleAgentUsers();
    expect(terminate).toHaveBeenCalledWith('u1');
  });
  it('keeps users with recent agent activity or a live stdio session', async () => {
    for (const [live, active] of [
      [false, true],
      [true, false],
    ] as const) {
      const { mgr, terminate } = build(live, active);
      await (mgr as any).reapIdleAgentUsers();
      expect(terminate).not.toHaveBeenCalled();
    }
  });
});
