import { describe, it, expect, vi } from 'vitest';
import {
  ChildUidAllocator,
  ChildUidError,
  keyHash,
  type AllocatorDeps,
} from '../../src/downstream/child-uid-allocator.js';
import {
  resolveChildIsolationConfig,
  checkIsolationAvailable,
  wrapCommandForIsolation,
} from '../../src/downstream/child-isolation.js';
import { logger } from '@mcpambassador/core';

// every id is injected: nothing here depends on the runner's uid/gid
const SERVER = { uid: 1000, gid: 1000 };
const MAP = '/data/child-uids.json';

function harness(min = 20000, max = 20002, initial: string | null = null) {
  let file: string | null = initial;
  let t = 1000;
  const wiped: Array<[number, string]> = [];
  const writes: string[] = [];
  const events: string[] = [];
  // mutable hooks: a test can swap one after the allocator was built
  const hooks = {
    readMap: (): string | null => file,
    writeMap: (_p: string, d: string): void => {
      file = d;
      writes.push(d);
    },
    wipeHome: (uid: number, home: string): void => {
      wiped.push([uid, home]);
      events.push(`wipe:${uid}`);
    },
    reapUid: (uid: number): number => {
      events.push(`reap:${uid}`);
      return 0;
    },
  };
  const deps: AllocatorDeps = {
    readMap: () => hooks.readMap(),
    writeMap: (p, d) => hooks.writeMap(p, d),
    wipeHome: (u, h) => hooks.wipeHome(u, h),
    reapUid: u => hooks.reapUid(u),
    now: () => ++t,
  };
  const make = () =>
    new ChildUidAllocator({ min, max, homesRoot: '/tmp/mcp-homes', mapPath: MAP }, deps);
  return {
    make,
    deps,
    hooks,
    wiped,
    events,
    writes,
    file: () => file,
    setFile: (f: string | null) => (file = f),
  };
}

describe('resolveChildIsolationConfig (range)', () => {
  const ok = { MCP_AMBASSADOR_CHILD_UID_RANGE: '20000-20999' };
  it('rejects a range below 10000 (system/login uids)', () => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: '9000-9010' }, 1000, 1000)
    ).toThrow(/10000/);
  });

  it('parses a range with defaults', () => {
    expect(resolveChildIsolationConfig(ok, SERVER.uid, SERVER.gid)).toEqual({
      kind: 'range',
      min: 20000,
      max: 20999,
      homesRoot: '/tmp/mcp-homes',
      mapPath: '/data/child-uids.json',
    });
  });
  it('keeps the legacy single uid when the range is unset, and null when nothing is set', () => {
    expect(
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID: '1001' }, 1000, 1000)?.kind
    ).toBe('legacy');
    expect(resolveChildIsolationConfig({}, 1000, 1000)).toBeNull();
  });
  it.each([
    ['abc', /must look like/],
    ['20000', /must look like/],
    ['20999-20000', /min <= max/],
    ['10000-20000', /at most 10000/],
    ['0-5', /non-zero/],
  ])('rejects %s', (range, re) => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: range }, 1000, 1000)
    ).toThrow(re);
  });
  it('rejects a range containing the server uid', () => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: '20000-20010' }, 20005, 1000)
    ).toThrow(/server uid/);
  });
  it('rejects a range containing the server gid', () => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: '20000-20010' }, 1000, 20005)
    ).toThrow(/server gid/);
  });
  it('rejects setting both the range and the legacy uid', () => {
    expect(() =>
      resolveChildIsolationConfig({ ...ok, MCP_AMBASSADOR_CHILD_UID: '1001' }, 1000, 1000)
    ).toThrow(/both set/);
  });
  it('rejects unsafe homes roots and relative map paths', () => {
    for (const r of ['/tmp/a/b', '/etc', '/tmp/..', '/tmp/a b']) {
      expect(() =>
        resolveChildIsolationConfig({ ...ok, MCP_AMBASSADOR_CHILD_HOMES_ROOT: r }, 1000, 1000)
      ).toThrow(/HOMES_ROOT/);
    }
    expect(() =>
      resolveChildIsolationConfig({ ...ok, MCP_AMBASSADOR_CHILD_UID_MAP: 'x.json' }, 1000, 1000)
    ).toThrow(/absolute/);
  });
});

describe('ChildUidAllocator', () => {
  it('gives each key its own uid, gid = uid, and a home under the root', () => {
    const h = harness();
    const a = h.make();
    const l1 = a.lease('user:u1:alpaca');
    const l2 = a.lease('user:u2:alpaca');
    const l3 = a.lease('shared:fetch');
    expect([l1.uid, l2.uid, l3.uid]).toEqual([20000, 20001, 20002]);
    expect(l1.gid).toBe(l1.uid);
    expect(l1.home).toBe('/tmp/mcp-homes/20000');
  });

  it('is stable: same key, same uid, across leases and across a restart (reload from the file)', () => {
    const h = harness();
    const l1 = h.make().lease('user:u1:a');
    h.make().lease('user:u2:a');
    const again = h.make(); // new process, same map file
    expect(again.lease('user:u1:a').uid).toBe(l1.uid);
    expect(again.lease('user:u2:a').uid).toBe(20001);
  });

  it('wipes the home as the uid on first assignment only', () => {
    const h = harness();
    const a = h.make();
    a.lease('k1');
    a.lease('k1');
    expect(h.wiped).toEqual([[20000, '/tmp/mcp-homes/20000']]);
    h.make().lease('k1'); // restart: no wipe, caches survive
    expect(h.wiped).toHaveLength(1);
  });

  it('never hands one uid to two keys, even when one is concurrently leased', () => {
    const h = harness(20000, 20009);
    const a = h.make();
    const uids = new Set<number>();
    for (let i = 0; i < 10; i++) uids.add(a.lease(`user:u${i}:m`).uid);
    expect(uids.size).toBe(10);
  });

  it('fails closed when the range is full and every uid is live (warn logged, hashed key)', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    a.lease('user:alice:m');
    a.lease('user:bob:m');
    const warn = vi.spyOn(logger, 'warn');
    expect(() => a.lease('user:carol:m')).toThrow(ChildUidError);
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/exhausted/);
    expect(logged).toContain(keyHash('user:carol:m'));
    expect(logged).not.toContain('carol');
    warn.mockRestore();
  });

  it('reclaims the least recently used idle key when full, wipes, and logs hashes only', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const l1 = a.lease('user:alice:m');
    const l2 = a.lease('user:bob:m');
    l1.release();
    l2.release();
    a.lease('user:bob:m').release(); // bob is more recent than alice
    h.wiped.length = 0;
    const warn = vi.spyOn(logger, 'warn');
    const l3 = a.lease('user:carol:m');
    expect(l3.uid).toBe(l1.uid); // alice's uid
    expect(h.wiped).toEqual([[l1.uid, l1.home]]);
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/reclaimed uid/);
    expect(logged).toContain(keyHash('user:alice:m'));
    expect(logged).not.toMatch(/alice|bob|carol/);
    warn.mockRestore();
    // alice is gone from the persisted map; coming back she gets a (wiped) uid again
    const map = JSON.parse(h.file()!) as { entries: Record<string, { uid: number }> };
    expect(Object.keys(map.entries).sort()).toEqual(['user:bob:m', 'user:carol:m']);
  });

  it('does not reclaim a uid that has a live process, only idle ones', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const live = a.lease('live'); // stays leased
    const idle = a.lease('idle');
    idle.release();
    const l = a.lease('new');
    expect(l.uid).toBe(idle.uid);
    expect(l.uid).not.toBe(live.uid);
  });

  it('kills leftover processes of a uid BEFORE wiping it, on a fresh assignment', () => {
    const h = harness(20000, 20000);
    const a = h.make();
    a.lease('user:alice:m').release();
    h.events.length = 0;
    a.lease('user:bob:m'); // reclaim: alice's detached descendants must be dead first
    expect(h.events).toEqual(['reap:20000', 'wipe:20000']);
  });

  it('refuses a uid whose leftover process survives SIGKILL, and tries the next candidate', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const stuck = new Set([20000]);
    h.hooks.reapUid = (uid: number) => (stuck.has(uid) ? 1 : 0);
    const l = a.lease('user:bob:m');
    expect(l.uid).toBe(20001); // 20000 skipped, never wiped or handed out
    expect(h.wiped.map(w => w[0])).toEqual([20001]);
  });

  it('a stuck reclaim victim does not lock the range: the next idle key is used', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const l1 = a.lease('user:alice:m');
    const l2 = a.lease('user:bob:m');
    l1.release();
    l2.release();
    h.hooks.reapUid = (uid: number) => (uid === l1.uid ? 1 : 0); // alice (LRU) cannot be cleaned
    const l3 = a.lease('user:carol:m');
    expect(l3.uid).toBe(l2.uid);
    const map = JSON.parse(h.file()!) as { entries: Record<string, { uid: number }> };
    expect(Object.keys(map.entries).sort()).toEqual(['user:alice:m', 'user:carol:m']);
  });

  it('refuses the spawn when every candidate is stuck, and keeps the map intact', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    h.hooks.reapUid = () => 2;
    expect(() => a.lease('k')).toThrow(/no child uid could be prepared/);
    expect(h.file()).toBeNull();
  });

  it('a failing wipe is skipped the same way (0500 dirs that cannot be cleaned)', () => {
    const h = harness(20000, 20001);
    const a = h.make();
    h.hooks.wipeHome = (uid: number) => {
      if (uid === 20000) throw new Error('wipe failed');
    };
    expect(a.lease('k').uid).toBe(20001);
  });

  it('sweeps leftovers when the last lease on a uid is released, not before', () => {
    const h = harness();
    const a = h.make();
    const l1 = a.lease('k');
    const l2 = a.lease('k');
    h.events.length = 0;
    l1.release();
    expect(h.events).toEqual([]); // restart overlap: l2 still holds the uid
    l2.release();
    l2.release();
    expect(h.events).toEqual([`reap:${l1.uid}`]);
  });

  it('releaseKeys frees idle matching keys only and persists', () => {
    const h = harness();
    const a = h.make();
    const live = a.lease('user:u1:a');
    a.lease('user:u1:b').release();
    a.lease('user:u2:a').release();
    expect(a.releaseKeys(k => k.startsWith('user:u1:'))).toBe(1); // u1:a is live
    const map = JSON.parse(h.file()!) as { entries: Record<string, unknown> };
    expect(Object.keys(map.entries).sort()).toEqual(['user:u1:a', 'user:u2:a']);
    live.release();
  });

  it('release is idempotent and a second lease on the same key keeps the uid live', () => {
    const h = harness(20000, 20000);
    const a = h.make();
    const l1 = a.lease('k');
    const l2 = a.lease('k');
    l1.release();
    l1.release();
    expect(() => a.lease('other')).toThrow(/exhausted/); // l2 still live
    l2.release();
    expect(a.lease('other').uid).toBe(20000);
  });

  it('refuses a new instance if its home cannot be wiped (and keeps a reclaimed victim)', () => {
    const h = harness(20000, 20000);
    const a = h.make();
    a.lease('old').release();
    h.hooks.wipeHome = () => {
      throw new Error('boom');
    };
    expect(() => a.lease('new')).toThrow(/no child uid could be prepared/);
    expect(JSON.parse(h.file()!).entries.old.uid).toBe(20000);
    expect(a.lease('old').uid).toBe(20000);
  });

  it('refuses the spawn if the map cannot be persisted', () => {
    const h = harness();
    h.hooks.writeMap = () => {
      throw new Error('disk full');
    };
    expect(() => h.make().lease('k')).toThrow(/cannot persist/);
  });

  it('rejects an empty key', () => {
    expect(() => harness().make().lease('')).toThrow(/instance key/);
  });

  describe('corrupt map fails closed', () => {
    const cases: Array<[string, string]> = [
      ['not JSON', '{nope'],
      ['array', '[]'],
      ['wrong version', '{"version":2,"entries":{}}'],
      ['entries not object', '{"version":1,"entries":[]}'],
      ['non-numeric uid', '{"version":1,"entries":{"k":{"uid":"20000","lastUsed":1}}}'],
      ['fractional uid', '{"version":1,"entries":{"k":{"uid":20000.5,"lastUsed":1}}}'],
      ['missing lastUsed', '{"version":1,"entries":{"k":{"uid":20000}}}'],
      ['uid below range', '{"version":1,"entries":{"k":{"uid":19999,"lastUsed":1}}}'],
      ['uid above range', '{"version":1,"entries":{"k":{"uid":20003,"lastUsed":1}}}'],
      [
        'duplicate uid',
        '{"version":1,"entries":{"a":{"uid":20000,"lastUsed":1},"b":{"uid":20000,"lastUsed":2}}}',
      ],
      ['empty key', '{"version":1,"entries":{"":{"uid":20000,"lastUsed":1}}}'],
    ];
    it.each(cases)('%s', (_n, body) => {
      const h = harness(20000, 20002, body);
      const err = vi.spyOn(logger, 'error');
      expect(() => h.make().lease('k')).toThrow(ChildUidError);
      const logged = err.mock.calls.map(c => String(c[0])).join('\n');
      expect(logged).toContain(MAP);
      expect(logged).toMatch(/Move .* aside/);
      expect(h.writes).toHaveLength(0); // never silently recreated
      expect(h.wiped).toHaveLength(0);
      err.mockRestore();
    });
    it('an unreadable (non-ENOENT) map fails closed', () => {
      const h = harness();
      h.hooks.readMap = () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' });
      };
      expect(() => h.make().lease('k')).toThrow(/cannot read/);
    });
    it('a valid map loads', () => {
      const h = harness(20000, 20002, '{"version":1,"entries":{"k":{"uid":20001,"lastUsed":5}}}');
      expect(h.make().lease('k').uid).toBe(20001);
    });
  });
});

describe('range-mode preflight and wrapper', () => {
  const iso = { uid: 20007, gid: 20007, home: '/tmp/mcp-homes/20007', parent: '/tmp/mcp-homes' };
  const base = { capEff: 0xe0n, setprivOk: true, homeOk: true };
  it('passes with a root-owned parent', () => {
    expect(checkIsolationAvailable(iso, { ...base, parentOk: true })).toBeNull();
  });
  it('fails closed when the parent is not root-owned/closed', () => {
    expect(checkIsolationAvailable(iso, { ...base, parentOk: false })).toMatch(/owned by root/);
  });
  it('fails closed when the home is wrong', () => {
    expect(checkIsolationAvailable(iso, { ...base, parentOk: true, homeOk: false })).toMatch(
      /child home/
    );
  });
  it('real parent check rejects a missing path', () => {
    expect(
      checkIsolationAvailable(
        { ...iso, parent: '/nonexistent-td059' },
        { capEff: 0xe0n, setprivOk: true, homeOk: true }
      )
    ).toMatch(/owned by root/);
  });
  it('wrapper uses the instance uid/gid and repairs the home mode after the switch', () => {
    const w = wrapCommandForIsolation('npx', ['x'], iso);
    expect(w.args).toContain('--reuid=20007');
    expect(w.args).toContain('--regid=20007');
    expect(w.args.join(' ')).toContain('chmod 0700 "$HOME"');
    expect(w.args).toContain('/tmp/mcp-homes/20007');
  });
});
