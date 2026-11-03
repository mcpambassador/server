/**
 * TD-062: per-home cache cap + LRU purge. Policy is tested pure; liveness safety against the real allocator
 * (fake IO); the shell scripts are run for real, as the current user, against a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@mcpambassador/core';
import {
  CACHE_DIRS,
  ChildCacheGc,
  makeDefaultGcDeps,
  planPurges,
  resolveCacheGcConfig,
  verifyHome,
  type CacheGcConfig,
  type CacheGcDeps,
  type Measured,
} from '../../src/downstream/child-cache-gc.js';
import { ChildUidAllocator, type AllocatorDeps } from '../../src/downstream/child-uid-allocator.js';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const cfg = (o: Partial<CacheGcConfig> = {}): CacheGcConfig => ({
  mode: 'enforce',
  perHomeBytes: 100 * MIB,
  totalBytes: 0,
  intervalMs: 60_000,
  ...o,
});
const m = (uid: number, home: number, cache: number, o: Partial<Measured> = {}): Measured => ({
  key: `user:secret-user-${uid}:mcp`,
  uid,
  lastUsed: uid,
  live: false,
  homeBytes: home * MIB,
  cacheBytes: cache * MIB,
  ...o,
});

describe('resolveCacheGcConfig', () => {
  it('defaults: enforce, 1 GiB per home, 10 GiB total, 6 h', () => {
    expect(resolveCacheGcConfig({}, () => {})).toEqual({
      mode: 'enforce',
      perHomeBytes: 1024 * MIB,
      totalBytes: 10240 * MIB,
      intervalMs: 360 * 60_000,
    });
  });
  it('reads values; 0 disables a cap; dry-run/off modes', () => {
    expect(
      resolveCacheGcConfig(
        {
          MCP_AMBASSADOR_CHILD_HOME_MAX_MB: '0',
          MCP_AMBASSADOR_CHILD_HOMES_TOTAL_MAX_MB: '500',
          MCP_AMBASSADOR_CHILD_CACHE_GC: 'DRY-RUN',
          MCP_AMBASSADOR_CHILD_CACHE_GC_INTERVAL_MIN: '15',
        },
        () => {}
      )
    ).toEqual({ mode: 'dry-run', perHomeBytes: 0, totalBytes: 500 * MIB, intervalMs: 15 * 60_000 });
    expect(resolveCacheGcConfig({ MCP_AMBASSADOR_CHILD_CACHE_GC: 'off' }, () => {}).mode).toBe(
      'off'
    );
  });
  it('invalid values fall back to the safe defaults (never unlimited) and warn', () => {
    const warn = vi.fn();
    const c = resolveCacheGcConfig(
      {
        MCP_AMBASSADOR_CHILD_HOME_MAX_MB: '-5',
        MCP_AMBASSADOR_CHILD_HOMES_TOTAL_MAX_MB: 'lots',
        MCP_AMBASSADOR_CHILD_CACHE_GC: 'yes',
        MCP_AMBASSADOR_CHILD_CACHE_GC_INTERVAL_MIN: '0',
      },
      warn
    );
    expect(c.mode).toBe('dry-run'); // a mistyped mode must never delete
    expect(c.perHomeBytes).toBe(1024 * MIB);
    expect(c.totalBytes).toBe(10240 * MIB);
    expect(c.intervalMs).toBe(360 * 60_000);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe('planPurges', () => {
  it('under the cap: nothing', () => {
    expect(planPurges([m(1, 50, 40), m(2, 99, 90)], cfg()).purge).toEqual([]);
  });
  it('idle home over the per-home cap is purged; live one is only reported', () => {
    const plan = planPurges([m(1, 300, 250), m(2, 300, 250, { live: true })], cfg());
    expect(plan.purge.map(p => [p.m.uid, p.reason])).toEqual([[1, 'cap']]);
    expect(plan.liveOverCap.map(x => x.uid)).toEqual([2]);
  });
  it('total cap purges least recently used idle homes first, and stops once under', () => {
    const homes = [
      m(1, 80, 60, { lastUsed: 300 }),
      m(2, 80, 60, { lastUsed: 100 }),
      m(3, 80, 60, { lastUsed: 200 }),
      m(4, 80, 60, { lastUsed: 50, live: true }),
    ];
    const plan = planPurges(homes, cfg({ totalBytes: 250 * MIB })); // total 320 -> need to free 70
    expect(plan.purge.map(p => [p.m.uid, p.reason])).toEqual([
      [2, 'lru'],
      [3, 'lru'],
    ]);
  });
  it('never selects a live home for the total cap, even when that leaves the total over', () => {
    const plan = planPurges(
      [m(1, 80, 60, { live: true }), m(2, 80, 60, { live: true })],
      cfg({ totalBytes: 10 * MIB })
    );
    expect(plan.purge).toEqual([]);
  });
  it('both caps 0: nothing', () => {
    expect(planPurges([m(1, 5000, 4000)], cfg({ perHomeBytes: 0 })).purge).toEqual([]);
  });
});

// ---- allocator-backed safety tests (fake IO) ----

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'td062-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function rig(over: Partial<CacheGcConfig> = {}, gcDeps: Partial<CacheGcDeps> = {}) {
  let file: string | null = null;
  let t = 1000;
  const reaped: number[] = [];
  let nWrites = 0;
  const aDeps: AllocatorDeps = {
    readMap: () => file,
    writeMap: (_p, d) => {
      file = d;
      nWrites++;
    },
    wipeHome: () => Promise.resolve(),
    reapUid: uid => {
      reaped.push(uid);
      return Promise.resolve(0);
    },
    now: () => ++t,
  };
  const alloc = new ChildUidAllocator(
    { min: 20000, max: 20009, homesRoot: root, mapPath: '/data/child-uids.json' },
    aDeps
  );
  const purged: number[] = [];
  const usage: Record<number, { homeBytes: number; cacheBytes: number }> = {};
  const deps: CacheGcDeps = {
    measure: uid => Promise.resolve(usage[uid] ?? { homeBytes: 0, cacheBytes: 0 }),
    purge: uid => {
      purged.push(uid);
      return Promise.resolve();
    },
    now: () => ++t,
    ...gcDeps,
  };
  const gc = new ChildCacheGc(alloc, cfg(over), deps);
  const mkHome = (uid: number): void => mkdirSync(join(root, String(uid)), { recursive: true });
  return {
    alloc,
    gc,
    purged,
    usage,
    mkHome,
    reaped,
    readFile: () => file,
    writes: () => nWrites,
    setFile: (d: string) => {
      file = d;
    },
  };
}

describe('ChildCacheGc safety', () => {
  it('purges an idle over-cap home and logs a hash, never the user id', async () => {
    const r = rig();
    const lease = await r.alloc.lease('user:alice-private-id:github');
    lease.release();
    r.mkHome(lease.uid);
    r.usage[lease.uid] = { homeBytes: 300 * MIB, cacheBytes: 250 * MIB };
    const logs: string[] = [];
    for (const lvl of ['info', 'warn'] as const)
      vi.spyOn(logger, lvl).mockImplementation(((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      }) as never);
    await r.gc.sweep();
    expect(r.purged).toEqual([lease.uid]);
    expect(logs.some(l => l.includes('purged'))).toBe(true);
    expect(logs.join('\n')).not.toContain('alice-private-id');
    vi.restoreAllMocks();
  });

  it('a live lease: nothing is purged, only a warning', async () => {
    const r = rig();
    const lease = await r.alloc.lease('shared:fs');
    r.mkHome(lease.uid);
    r.usage[lease.uid] = { homeBytes: 900 * MIB, cacheBytes: 800 * MIB };
    await r.gc.sweep();
    expect(r.purged).toEqual([]);
    lease.release();
  });

  it('a lease taken between measure and purge aborts the purge', async () => {
    let alloc!: ChildUidAllocator;
    let late: Awaited<ReturnType<ChildUidAllocator['lease']>> | undefined;
    const r = rig(
      {},
      {
        measure: async uid => {
          // the instance starts again while its home is being measured
          late = await alloc.lease('shared:fs');
          expect(late.uid).toBe(uid);
          return { homeBytes: 500 * MIB, cacheBytes: 400 * MIB };
        },
      }
    );
    alloc = r.alloc;
    const first = await r.alloc.lease('shared:fs');
    first.release();
    r.mkHome(first.uid);
    await r.gc.sweep();
    expect(r.purged).toEqual([]);
    late?.release();
  });

  it('a lease requested during a purge waits for it, then succeeds', async () => {
    let unblock!: () => void;
    const order: string[] = [];
    const r = rig(
      {},
      {
        purge: async () => {
          order.push('purge-start');
          await new Promise<void>(res => (unblock = res));
          order.push('purge-end');
        },
      }
    );
    const first = await r.alloc.lease('shared:fs');
    first.release();
    r.mkHome(first.uid);
    r.usage[first.uid] = { homeBytes: 500 * MIB, cacheBytes: 400 * MIB };
    const sweep = r.gc.sweep();
    await vi.waitFor(() => expect(order).toEqual(['purge-start']));
    const waiting = r.alloc.lease('shared:fs').then(l => {
      order.push('lease');
      return l;
    });
    await new Promise(res => setTimeout(res, 20));
    expect(order).toEqual(['purge-start']); // the lease is held back while the purge runs
    unblock();
    const l = await waiting;
    await sweep;
    expect(order).toEqual(['purge-start', 'purge-end', 'lease']);
    expect(l.uid).toBe(first.uid);
    l.release();
  });

  it('measuring does not hold the allocator chain: another instance can be leased meanwhile', async () => {
    let unblock!: () => void;
    const r = rig(
      {},
      {
        measure: () =>
          new Promise(res => {
            unblock = () => res({ homeBytes: 1, cacheBytes: 0 });
          }),
      }
    );
    const a = await r.alloc.lease('shared:a');
    a.release();
    r.mkHome(a.uid);
    const sweep = r.gc.sweep();
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
    const b = await r.alloc.lease('shared:b'); // would hang if the sweep held the chain
    expect(b.uid).not.toBe(a.uid);
    b.release();
    unblock();
    await sweep;
  });

  it('LRU across homes under the total cap', async () => {
    const r = rig({ perHomeBytes: 0, totalBytes: 150 * MIB });
    const keys = ['shared:old', 'shared:mid', 'shared:new'];
    const uids: number[] = [];
    for (const k of keys) {
      const l = await r.alloc.lease(k);
      l.release();
      r.mkHome(l.uid);
      r.usage[l.uid] = { homeBytes: 80 * MIB, cacheBytes: 70 * MIB };
      uids.push(l.uid);
    }
    await r.gc.sweep(); // total 240 > 150 -> free 90+ => two oldest
    expect(r.purged).toEqual([uids[0], uids[1]]);
  });

  it('dry-run and off delete nothing', async () => {
    for (const mode of ['dry-run', 'off'] as const) {
      const r = rig({ mode });
      const l = await r.alloc.lease('shared:fs');
      l.release();
      r.mkHome(l.uid);
      r.usage[l.uid] = { homeBytes: 500 * MIB, cacheBytes: 400 * MIB };
      await r.gc.sweep();
      expect(r.purged).toEqual([]);
    }
  });

  it('measure and purge failures never throw out of the GC or the allocator chain', async () => {
    const r = rig({}, { measure: () => Promise.reject(new Error('du boom')) });
    const l = await r.alloc.lease('shared:fs');
    l.release();
    r.mkHome(l.uid);
    await expect(r.gc.sweep()).resolves.toBeDefined();
    const r2 = rig({}, { purge: () => Promise.reject(new Error('find boom')) });
    const l2 = await r2.alloc.lease('shared:fs');
    l2.release();
    r2.mkHome(l2.uid);
    r2.usage[l2.uid] = { homeBytes: 500 * MIB, cacheBytes: 400 * MIB };
    await expect(r2.gc.sweep()).resolves.toBeDefined();
    const again = await r2.alloc.lease('shared:fs'); // chain still healthy
    expect(again.uid).toBe(l2.uid);
    again.release();
  });

  it('refuses a home that is a symlink or outside <homesRoot>/<uid>', async () => {
    const r = rig();
    const l = await r.alloc.lease('shared:fs');
    l.release();
    const elsewhere = mkdtempSync(join(tmpdir(), 'td062-else-'));
    symlinkSync(elsewhere, join(root, String(l.uid))); // home is a symlink
    r.usage[l.uid] = { homeBytes: 500 * MIB, cacheBytes: 400 * MIB };
    await r.gc.sweep();
    expect(r.purged).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('idle listener fires after the last release and checks only that home', async () => {
    const r = rig();
    r.gc.start();
    const l = await r.alloc.lease('shared:fs');
    r.mkHome(l.uid);
    r.usage[l.uid] = { homeBytes: 500 * MIB, cacheBytes: 400 * MIB };
    l.release();
    await vi.waitFor(() => expect(r.purged).toEqual([l.uid]));
    r.gc.stop();
  });
});

describe('ChildUidAllocator.exclusiveIfIdle', () => {
  it('does not run for a live, unassigned or preparing uid; runs and blocks leases for an idle one', async () => {
    const r = rig();
    expect((await r.alloc.exclusiveIfIdle('nokey', 20005, async () => 1)).ran).toBe(false); // unassigned
    const l = await r.alloc.lease('shared:fs');
    expect((await r.alloc.exclusiveIfIdle('shared:fs', l.uid, async () => 1)).ran).toBe(false); // live
    l.release();
    const res = await r.alloc.exclusiveIfIdle('shared:fs', l.uid, async () => {
      expect(r.alloc.instances().find(i => i.uid === l.uid)?.live).toBe(true); // marked busy inside
      return 7;
    });
    expect(res).toEqual({ ran: true, value: 7 });
    expect(r.alloc.instances().find(i => i.uid === l.uid)?.live).toBe(false);
    await expect(
      r.alloc.exclusiveIfIdle('shared:fs', l.uid, () => Promise.reject(new Error('x')))
    ).rejects.toThrow('x');
    (await r.alloc.lease('shared:fs')).release(); // chain still works after a throwing fn
  });

  it('kills everything left running as the uid when fn throws (timeout), before releasing it', async () => {
    const r = rig();
    const l = await r.alloc.lease('shared:fs');
    l.release();
    r.reaped.length = 0;
    await expect(
      r.alloc.exclusiveIfIdle('shared:fs', l.uid, () => Promise.reject(new Error('timeout')))
    ).rejects.toThrow('timeout');
    expect(r.reaped).toEqual([l.uid]);
  });

  it('does not run when the key no longer owns the uid', async () => {
    const r = rig();
    const l = await r.alloc.lease('shared:fs');
    l.release();
    expect((await r.alloc.exclusiveIfIdle('shared:other', l.uid, async () => 1)).ran).toBe(false);
  });

  it('does not persist a stale map on release after the allocator reloaded its state', async () => {
    const r = rig();
    const l = await r.alloc.lease('shared:fs');
    const writes = r.writes();
    // another process/reload replaced the map on disk and in memory
    r.setFile(
      JSON.stringify({ version: 1, entries: { 'shared:other': { uid: 20003, lastUsed: 5 } } })
    );
    (r.alloc as unknown as { entries: unknown }).entries = null;
    r.alloc.instances(); // reload from the new file
    l.release();
    expect(r.writes()).toBe(writes); // release wrote nothing
    expect(r.readFile()).toContain('shared:other');
    expect(r.readFile()).not.toContain('shared:fs');
  });

  it('stamps lastUsed on the final release', async () => {
    const r = rig();
    const l = await r.alloc.lease('shared:fs');
    const before = r.alloc.instances().find(i => i.uid === l.uid)!.lastUsed;
    l.release();
    expect(r.alloc.instances().find(i => i.uid === l.uid)!.lastUsed).toBeGreaterThan(before);
  });
});

describe('verifyHome', () => {
  const range = () => ({ min: 20000, max: 20009, homesRoot: root });
  it('accepts a real <homesRoot>/<uid> directory', () => {
    mkdirSync(join(root, '20001'));
    expect(() => verifyHome(range(), 20001, join(root, '20001'))).not.toThrow();
  });
  it('rejects uid outside the range, wrong path, and symlinked home', () => {
    mkdirSync(join(root, '20001'));
    expect(() => verifyHome(range(), 5, join(root, '5'))).toThrow(/outside/);
    expect(() => verifyHome(range(), 20001, join(root, '20002'))).toThrow(/<homesRoot>/);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, '20003'));
    expect(() => verifyHome(range(), 20003, join(root, '20003'))).toThrow(/symlink/);
  });
});

// ---- the real shell scripts, run as the current user ----

describe('measure/purge scripts', () => {
  const run = async (_uid: number, script: string, args: string[]): Promise<string> =>
    (
      await execFileAsync('/bin/sh', ['-c', script, 'gc', ...args], {
        env: { PATH: '/usr/bin:/bin' },
      })
    ).stdout;
  const deps = makeDefaultGcDeps(run);
  const put = (p: string, size = 4096): void => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.alloc(size, 1));
  };

  it('purges only the allowlisted cache dirs; config and tokens survive', async () => {
    const home = join(root, '20001');
    for (const d of CACHE_DIRS) put(join(home, d, 'sub', 'blob'), 64 * 1024);
    put(join(home, '.config', 'token'), 10);
    put(join(home, 'state.json'), 10);
    const before = await deps.measure(20001, home);
    expect(before.cacheBytes).toBeGreaterThan(200 * 1024);
    expect(before.homeBytes).toBeGreaterThanOrEqual(before.cacheBytes);
    await deps.purge(20001, home);
    for (const d of CACHE_DIRS) {
      expect(existsSync(join(home, d))).toBe(true); // dir kept, contents gone
      expect(existsSync(join(home, d, 'sub'))).toBe(false);
    }
    expect(readFileSync(join(home, '.config', 'token'))).toHaveLength(10);
    expect(existsSync(join(home, 'state.json'))).toBe(true);
    const after = await deps.measure(20001, home);
    expect(after.cacheBytes).toBeLessThan(before.cacheBytes / 4);
  });

  it('empties a cache dir that has read-only subdirs', async () => {
    const home = join(root, '20002');
    put(join(home, '.npm-cache', 'ro', 'f'));
    chmodSync(join(home, '.npm-cache', 'ro'), 0o500);
    await deps.purge(20002, home);
    expect(existsSync(join(home, '.npm-cache', 'ro'))).toBe(false);
  });

  it('does not follow a symlinked cache dir or symlinks inside one', async () => {
    const home = join(root, '20003');
    const outside = join(root, 'outside');
    put(join(outside, 'precious'));
    mkdirSync(home, { recursive: true });
    symlinkSync(outside, join(home, '.cache')); // cache dir is a symlink: skipped
    put(join(home, 'tmp', 'x'));
    symlinkSync(outside, join(home, 'tmp', 'link')); // symlink inside a cache dir: removed, not followed
    await deps.purge(20003, home);
    expect(existsSync(join(outside, 'precious'))).toBe(true);
    expect(existsSync(join(home, 'tmp', 'link'))).toBe(false);
    const u = await deps.measure(20003, home);
    expect(u.cacheBytes).toBeLessThan(64 * 1024);
  });

  it('refuses a symlinked home', async () => {
    const real = join(root, 'real-home');
    put(join(real, '.cache', 'x'));
    symlinkSync(real, join(root, '20004'));
    await expect(deps.purge(20004, join(root, '20004'))).rejects.toThrow();
    expect(existsSync(join(real, '.cache', 'x'))).toBe(true);
    await expect(deps.measure(20004, join(root, '20004'))).rejects.toThrow();
  });
});
