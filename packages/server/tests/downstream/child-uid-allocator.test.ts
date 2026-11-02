import { describe, it, expect, vi } from 'vitest';
import {
  ChildUidAllocator,
  ChildUidError,
  catalogMcpKeyMatcher,
  KILL_ALL_SCRIPT,
  keyHash,
  reapProcessesOfUid,
  type ReapIo,
  type AllocatorDeps,
} from '../../src/downstream/child-uid-allocator.js';
import {
  resolveChildIsolationConfig,
  checkIsolationAvailable,
  wrapCommandForIsolation,
  resolveChildNproc,
  effectiveChildNproc,
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
    wipeHome: (uid: number, home: string): Promise<void> => {
      wiped.push([uid, home]);
      events.push(`wipe:${uid}`);
      return Promise.resolve();
    },
    reapUid: (uid: number, _abort?: () => boolean): Promise<number> => {
      events.push(`reap:${uid}`);
      return Promise.resolve(0);
    },
  };
  const deps: AllocatorDeps = {
    readMap: () => hooks.readMap(),
    writeMap: (p, d) => hooks.writeMap(p, d),
    wipeHome: (u, h) => hooks.wipeHome(u, h),
    reapUid: (u, abort) => hooks.reapUid(u, abort),
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
  it('rejects a range below 10000 (system/login uids)', async () => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: '9000-9010' }, 1000, 1000)
    ).toThrow(/10000/);
  });

  it('parses a range with defaults', async () => {
    expect(resolveChildIsolationConfig(ok, SERVER.uid, SERVER.gid)).toEqual({
      kind: 'range',
      min: 20000,
      max: 20999,
      homesRoot: '/tmp/mcp-homes',
      mapPath: '/data/child-uids.json',
    });
  });
  it('keeps the legacy single uid when the range is unset, and null when nothing is set', async () => {
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
  it('rejects a range containing the server uid', async () => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: '20000-20010' }, 20005, 1000)
    ).toThrow(/server uid/);
  });
  it('rejects a range containing the server gid', async () => {
    expect(() =>
      resolveChildIsolationConfig({ MCP_AMBASSADOR_CHILD_UID_RANGE: '20000-20010' }, 1000, 20005)
    ).toThrow(/server gid/);
  });
  it('rejects setting both the range and the legacy uid', async () => {
    expect(() =>
      resolveChildIsolationConfig({ ...ok, MCP_AMBASSADOR_CHILD_UID: '1001' }, 1000, 1000)
    ).toThrow(/both set/);
  });
  it('rejects unsafe homes roots and relative map paths', async () => {
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
  it('gives each key its own uid, gid = uid, and a home under the root', async () => {
    const h = harness();
    const a = h.make();
    const l1 = await a.lease('user:u1:alpaca');
    const l2 = await a.lease('user:u2:alpaca');
    const l3 = await a.lease('shared:fetch');
    expect([l1.uid, l2.uid, l3.uid]).toEqual([20000, 20001, 20002]);
    expect(l1.gid).toBe(l1.uid);
    expect(l1.home).toBe('/tmp/mcp-homes/20000');
  });

  it('is stable: same key, same uid, across leases and across a restart (reload from the file)', async () => {
    const h = harness();
    const l1 = await h.make().lease('user:u1:a');
    await h.make().lease('user:u2:a');
    const again = h.make(); // new process, same map file
    expect((await again.lease('user:u1:a')).uid).toBe(l1.uid);
    expect((await again.lease('user:u2:a')).uid).toBe(20001);
  });

  it('wipes the home as the uid on first assignment only', async () => {
    const h = harness();
    const a = h.make();
    await a.lease('k1');
    await a.lease('k1');
    expect(h.wiped).toEqual([[20000, '/tmp/mcp-homes/20000']]);
    await h.make().lease('k1'); // restart: no wipe, caches survive
    expect(h.wiped).toHaveLength(1);
  });

  it('never hands one uid to two keys, even when one is concurrently leased', async () => {
    const h = harness(20000, 20009);
    const a = h.make();
    const uids = new Set<number>();
    for (let i = 0; i < 10; i++) uids.add((await a.lease(`user:u${i}:m`)).uid);
    expect(uids.size).toBe(10);
  });

  it('fails closed when the range is full and every uid is live (warn logged, hashed key)', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    await a.lease('user:alice:m');
    await a.lease('user:bob:m');
    const warn = vi.spyOn(logger, 'warn');
    await expect(a.lease('user:carol:m')).rejects.toThrow(ChildUidError);
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/exhausted/);
    expect(logged).toContain(keyHash('user:carol:m'));
    expect(logged).not.toContain('carol');
    warn.mockRestore();
  });

  it('reclaims the least recently used idle key when full, wipes, and logs hashes only', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const l1 = await a.lease('user:alice:m');
    const l2 = await a.lease('user:bob:m');
    l1.release();
    l2.release();
    (await a.lease('user:bob:m')).release(); // bob is more recent than alice
    h.wiped.length = 0;
    const warn = vi.spyOn(logger, 'warn');
    const l3 = await a.lease('user:carol:m');
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

  it('does not reclaim a uid that has a live process, only idle ones', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const live = await a.lease('live'); // stays leased
    const idle = await a.lease('idle');
    idle.release();
    const l = await a.lease('new');
    expect(l.uid).toBe(idle.uid);
    expect(l.uid).not.toBe(live.uid);
  });

  it('kills leftover processes of a uid BEFORE wiping it, on a fresh assignment', async () => {
    const h = harness(20000, 20000);
    const a = h.make();
    (await a.lease('user:alice:m')).release();
    h.events.length = 0;
    await a.lease('user:bob:m'); // reclaim: alice's detached descendants must be dead first
    expect(h.events).toEqual(['reap:20000', 'wipe:20000']);
  });

  it('refuses a uid whose leftover process survives SIGKILL, and tries the next candidate', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const stuck = new Set([20000]);
    h.hooks.reapUid = (uid: number) => Promise.resolve(stuck.has(uid) ? 1 : 0);
    const l = await a.lease('user:bob:m');
    expect(l.uid).toBe(20001); // 20000 skipped, never wiped or handed out
    expect(h.wiped.map(w => w[0])).toEqual([20001]);
  });

  it('a stuck reclaim victim does not lock the range: the next idle key is used', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    const l1 = await a.lease('user:alice:m');
    const l2 = await a.lease('user:bob:m');
    l1.release();
    l2.release();
    h.hooks.reapUid = (uid: number) => Promise.resolve(uid === l1.uid ? 1 : 0); // alice (LRU) cannot be cleaned
    const l3 = await a.lease('user:carol:m');
    expect(l3.uid).toBe(l2.uid);
    const map = JSON.parse(h.file()!) as { entries: Record<string, { uid: number }> };
    expect(Object.keys(map.entries).sort()).toEqual(['user:alice:m', 'user:carol:m']);
  });

  it('refuses the spawn when every candidate is stuck, and keeps the map intact', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    h.hooks.reapUid = () => Promise.resolve(2);
    await expect(a.lease('k')).rejects.toThrow(/no child uid could be prepared/);
    expect(h.file()).toBeNull();
  });

  it('a failing wipe is skipped the same way (0500 dirs that cannot be cleaned)', async () => {
    const h = harness(20000, 20001);
    const a = h.make();
    h.hooks.wipeHome = (uid: number) => {
      if (uid === 20000) return Promise.reject(new Error('wipe failed'));
      return Promise.resolve();
    };
    expect((await a.lease('k')).uid).toBe(20001);
  });

  it('sweeps leftovers when the last lease on a uid is released, not before', async () => {
    const h = harness();
    const a = h.make();
    const l1 = await a.lease('k');
    const l2 = await a.lease('k');
    h.events.length = 0;
    l1.release();
    expect(h.events).toEqual([]); // restart overlap: l2 still holds the uid
    l2.release();
    l2.release();
    await new Promise(r => setImmediate(r)); // the sweep is async
    expect(h.events).toEqual([`reap:${l1.uid}`]);
  });

  describe('release sweep vs a quick restart (S1)', () => {
    function fakeIo(pids: number[]) {
      const log = { kills: [] as number[], killAlls: 0, rounds: 0, visible: true };
      const io: ReapIo = {
        procs: () => {
          log.rounds++;
          return log.visible ? pids : [];
        },
        kill: pid => {
          log.kills.push(pid);
        },
        killAll: () => {
          log.killAlls++;
        },
        sleep: () => new Promise(r => setImmediate(r)),
      };
      return { io, log };
    }

    it('reap rounds scan, kill each pid and kill -1, and repeat until the uid is empty', async () => {
      const state = { left: [11, 12], rounds: 0 };
      const log = { kills: [] as number[], killAlls: 0 };
      const io: ReapIo = {
        procs: () => (state.rounds++ < 2 ? state.left : []),
        kill: pid => {
          log.kills.push(pid);
        },
        killAll: () => {
          log.killAlls++;
        },
        sleep: () => Promise.resolve(),
      };
      expect(await reapProcessesOfUid(20000, undefined, io)).toBe(0);
      expect(log.kills).toEqual([11, 12, 11, 12]);
      expect(log.killAlls).toBe(2);
    });

    it('the in-uid kill-all uses the form dash accepts', () => {
      expect(KILL_ALL_SCRIPT).toBe('kill -s KILL -- -1');
    });

    it('round 0 runs synchronously; later rounds stop once the abort predicate turns true', async () => {
      const { io, log } = fakeIo([99]);
      let abort = false;
      const p = reapProcessesOfUid(20000, () => abort, io);
      expect(log.kills).toEqual([99]); // synchronous, before any await
      abort = true;
      expect(await p).toBe(0);
      expect(log.kills).toEqual([99]); // nothing killed after the abort
      expect(log.killAlls).toBe(1);
    });

    it('stop -> start of the same key: the new child is never killed by the old release sweep', async () => {
      const h = harness(20000, 20002);
      const { io, log } = fakeIo([4242]);
      log.visible = false; // clean uid for the first assignment
      h.hooks.reapUid = (_uid, abort) => reapProcessesOfUid(_uid, abort, io);
      const a = h.make();
      const old = await a.lease('user:alice:m');
      log.visible = true; // a detached descendant of the old child is still running
      old.release(); // sweep round 0 kills 4242 synchronously
      expect(log.kills).toEqual([4242]);
      const next = await a.lease('user:alice:m'); // the restart, before the sweep's next round
      expect(next.uid).toBe(old.uid);
      await new Promise(r => setTimeout(r, 30));
      expect(log.kills).toEqual([4242]); // later rounds aborted: the new child's uid was left alone
      expect(log.killAlls).toBe(1);
    });

    it('the sweep also stands down while its uid is being reclaimed', async () => {
      const h = harness(20000, 20000);
      let abortFn: (() => boolean) | undefined;
      h.hooks.reapUid = (_uid, abort) => {
        abortFn ??= abort;
        return Promise.resolve(0);
      };
      const a = h.make();
      const l = await a.lease('user:alice:m');
      l.release();
      expect(abortFn?.()).toBe(false); // idle, nothing else going on
      let unblock!: () => void;
      h.hooks.wipeHome = () => new Promise<void>(r => (unblock = r));
      const bob = a.lease('user:bob:m'); // reclaims 20000
      await new Promise(r => setImmediate(r));
      expect(abortFn?.()).toBe(true); // being prepared for someone else
      unblock();
      await bob;
    });
  });

  describe('fast path and prepare budget (N1)', () => {
    it('an existing key leases without waiting behind another instance slow wipe', async () => {
      const h = harness(20000, 20005);
      const a = h.make();
      const known = await a.lease('shared:known');
      known.release();
      let unblock!: () => void;
      h.hooks.wipeHome = () => new Promise<void>(r => (unblock = r));
      const slow = a.lease('user:new:m'); // sits in the wipe
      await new Promise(r => setImmediate(r));
      const again = await a.lease('shared:known'); // must not wait for `slow`
      expect(again.uid).toBe(known.uid);
      unblock();
      expect((await slow).uid).not.toBe(known.uid);
    });

    it('a key whose uid is being reclaimed right now waits and gets a clean uid of its own', async () => {
      const h = harness(20000, 20001);
      const a = h.make();
      const la = await a.lease('user:a:m');
      const lb = await a.lease('user:b:m');
      la.release();
      lb.release();
      let unblock!: () => void;
      h.hooks.wipeHome = (uid: number) => {
        h.events.push(`wipe:${uid}`);
        return new Promise<void>(r => (unblock = r));
      };
      const c = a.lease('user:c:m'); // reclaims a (oldest idle): uid 20000
      await new Promise(r => setImmediate(r));
      let aDone = false;
      const a2 = a.lease('user:a:m').then(l => ((aDone = true), l));
      await new Promise(r => setImmediate(r));
      expect(aDone).toBe(false); // not handed the uid that is being wiped for c
      unblock();
      expect((await c).uid).toBe(la.uid);
      await new Promise(r => setImmediate(r));
      unblock(); // a's fresh assignment wipes the next idle uid (b's)
      const l = await a2;
      expect(l.uid).toBe(lb.uid);
      expect(l.uid).not.toBe(la.uid);
    });

    it('an idle candidate leased meanwhile is skipped, never reclaimed', async () => {
      const h = harness(20000, 20002);
      const a = h.make();
      const x = await a.lease('user:x:m');
      const y = await a.lease('user:y:m');
      const z = await a.lease('user:z:m');
      x.release();
      y.release();
      z.release();
      // first candidate's wipe fails slowly; meanwhile y (the next idle candidate) is leased again
      let fail!: () => void;
      let first = true;
      h.hooks.wipeHome = () => {
        if (first) {
          first = false;
          return new Promise<void>((_r, rej) => (fail = () => rej(new Error('stuck'))));
        }
        return Promise.resolve();
      };
      const w = a.lease('user:w:m');
      await new Promise(r => setImmediate(r));
      const y2 = await a.lease('user:y:m'); // fast path
      fail();
      const lw = await w;
      expect(lw.uid).toBe(z.uid); // not y's uid
      expect(y2.uid).toBe(y.uid);
    });

    it('stops trying after the prepare time budget and refuses', async () => {
      const h = harness(20000, 20005);
      let t = 0;
      const a = new ChildUidAllocator(
        { min: 20000, max: 20005, homesRoot: '/tmp/mcp-homes', mapPath: MAP },
        { ...h.deps, now: () => t }
      );
      h.hooks.wipeHome = (uid: number) => {
        h.events.push(`wipe:${uid}`);
        t += 61_000; // the attempt used up the whole budget
        return Promise.reject(new Error('stuck'));
      };
      await expect(a.lease('user:q:m')).rejects.toBeInstanceOf(ChildUidError);
      expect(h.events.filter(e => e.startsWith('wipe:'))).toHaveLength(1);
    });
  });

  it('catalog removal matches shared, discovery and every user instance of that MCP only', () => {
    const m = catalogMcpKeyMatcher('github');
    expect(m('shared:github')).toBe(true);
    expect(m('discovery:github')).toBe(true);
    expect(m('user:u-1:github')).toBe(true);
    expect(m('user:u-1:github2')).toBe(false);
    expect(m('shared:github2')).toBe(false);
    expect(m('user:github:other')).toBe(false);
  });

  it('serializes concurrent leases: no two keys ever get the same uid while a wipe is awaited', async () => {
    const h = harness(20000, 20009);
    const a = h.make();
    h.hooks.wipeHome = () => new Promise<void>(r => setTimeout(r, 5));
    const leases = await Promise.all(Array.from({ length: 6 }, (_, i) => a.lease(`user:u${i}:m`)));
    expect(new Set(leases.map(l => l.uid)).size).toBe(6);
  });

  it('warns (no user id) when 80% of the range is assigned', async () => {
    const h = harness(20000, 20004);
    const a = h.make();
    const warn = vi.spyOn(logger, 'warn');
    for (let i = 0; i < 4; i++) await a.lease(`user:secret${i}:m`);
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/4\/5 uids.*80%/);
    expect(logged).not.toMatch(/secret/);
    warn.mockRestore();
  });

  it('releaseKeys frees idle matching keys only and persists', async () => {
    const h = harness();
    const a = h.make();
    const live = await a.lease('user:u1:a');
    (await a.lease('user:u1:b')).release();
    (await a.lease('user:u2:a')).release();
    expect(a.releaseKeys(k => k.startsWith('user:u1:'))).toBe(1); // u1:a is live
    const map = JSON.parse(h.file()!) as { entries: Record<string, unknown> };
    expect(Object.keys(map.entries).sort()).toEqual(['user:u1:a', 'user:u2:a']);
    live.release();
  });

  it('release is idempotent and a second lease on the same key keeps the uid live', async () => {
    const h = harness(20000, 20000);
    const a = h.make();
    const l1 = await a.lease('k');
    const l2 = await a.lease('k');
    l1.release();
    l1.release();
    await expect(a.lease('other')).rejects.toThrow(/exhausted/); // l2 still live
    l2.release();
    expect((await a.lease('other')).uid).toBe(20000);
  });

  it('refuses a new instance if its home cannot be wiped (and keeps a reclaimed victim)', async () => {
    const h = harness(20000, 20000);
    const a = h.make();
    (await a.lease('old')).release();
    h.hooks.wipeHome = () => Promise.reject(new Error('boom'));
    await expect(a.lease('new')).rejects.toThrow(/no child uid could be prepared/);
    expect(JSON.parse(h.file()!).entries.old.uid).toBe(20000);
    expect((await a.lease('old')).uid).toBe(20000);
  });

  it('refuses the spawn if the map cannot be persisted', async () => {
    const h = harness();
    h.hooks.writeMap = () => {
      throw new Error('disk full');
    };
    await expect(h.make().lease('k')).rejects.toThrow(/cannot persist/);
  });

  it('rejects an empty key', async () => {
    await expect(harness().make().lease('')).rejects.toThrow(/instance key/);
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
    it.each(cases)('%s', async (_n, body) => {
      const h = harness(20000, 20002, body);
      const err = vi.spyOn(logger, 'error');
      await expect(h.make().lease('k')).rejects.toThrow(ChildUidError);
      const logged = err.mock.calls.map(c => String(c[0])).join('\n');
      expect(logged).toContain(MAP);
      expect(logged).toMatch(/Move .* aside/);
      expect(h.writes).toHaveLength(0); // never silently recreated
      expect(h.wiped).toHaveLength(0);
      err.mockRestore();
    });
    it('an unreadable (non-ENOENT) map fails closed', async () => {
      const h = harness();
      h.hooks.readMap = () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' });
      };
      await expect(h.make().lease('k')).rejects.toThrow(/cannot read/);
    });
    it('a valid map loads', async () => {
      const h = harness(20000, 20002, '{"version":1,"entries":{"k":{"uid":20001,"lastUsed":5}}}');
      expect((await h.make().lease('k')).uid).toBe(20001);
    });
  });
});

describe('range-mode preflight and wrapper', () => {
  const iso = { uid: 20007, gid: 20007, home: '/tmp/mcp-homes/20007', parent: '/tmp/mcp-homes' };
  const base = { capEff: 0xe0n, setprivOk: true, homeOk: true };
  it('passes with a root-owned parent', async () => {
    expect(checkIsolationAvailable(iso, { ...base, parentOk: true })).toBeNull();
  });
  it('fails closed when the parent is not root-owned/closed', async () => {
    expect(checkIsolationAvailable(iso, { ...base, parentOk: false })).toMatch(/owned by root/);
  });
  it('fails closed when the home is wrong', async () => {
    expect(checkIsolationAvailable(iso, { ...base, parentOk: true, homeOk: false })).toMatch(
      /child home/
    );
  });
  it('real parent check rejects a missing path', async () => {
    expect(
      checkIsolationAvailable(
        { ...iso, parent: '/nonexistent-td059' },
        { capEff: 0xe0n, setprivOk: true, homeOk: true }
      )
    ).toMatch(/owned by root/);
  });
  it('wrapper uses the instance uid/gid and repairs the home mode after the switch', async () => {
    const w = wrapCommandForIsolation('npx', ['x'], iso);
    expect(w.args).toContain('--reuid=20007');
    expect(w.args).toContain('--regid=20007');
    expect(w.args.join(' ')).toContain('chmod 0700 "$HOME"');
    expect(w.args).toContain('/tmp/mcp-homes/20007');
  });
  it('wrapper caps processes per instance (default 256, configurable, 0 disables)', async () => {
    const has = (n?: number) => wrapCommandForIsolation('npx', [], iso, undefined, n).args;
    const d = wrapCommandForIsolation('npx', [], iso).args;
    expect(d.slice(5, 9)).toEqual(['--', '/usr/bin/prlimit', '--nproc=256', '--']);
    expect(has(64).slice(5, 9)).toEqual(['--', '/usr/bin/prlimit', '--nproc=64', '--']);
    expect(has(64).slice(9, 11)).toEqual(['/bin/sh', '-c']);
    expect(has(0)).not.toContain('/usr/bin/prlimit');
  });
  it('never asks for more than the stricter hard limit the server already runs under', async () => {
    expect(effectiveChildNproc(256, 100)).toBe(100);
    expect(effectiveChildNproc(256, 4096)).toBe(256);
    expect(effectiveChildNproc(256, null)).toBe(256);
    expect(effectiveChildNproc(0, 100)).toBe(0);
  });
  it('preflight fails closed when prlimit is missing (unless the cap is disabled)', async () => {
    const base = { capEff: 0xe0n, setprivOk: true, homeOk: true, parentOk: true };
    expect(checkIsolationAvailable(iso, { ...base, prlimitOk: false })).toMatch(/prlimit/);
    expect(checkIsolationAvailable(iso, { ...base, prlimitOk: true })).toBeNull();
  });
  it('MCP_AMBASSADOR_CHILD_NPROC is validated', async () => {
    expect(resolveChildNproc({})).toBe(256);
    expect(resolveChildNproc({ MCP_AMBASSADOR_CHILD_NPROC: '512' })).toBe(512);
    expect(resolveChildNproc({ MCP_AMBASSADOR_CHILD_NPROC: '0' })).toBe(0);
    for (const bad of ['-1', 'abc', '1.5', '99999999'])
      expect(() => resolveChildNproc({ MCP_AMBASSADOR_CHILD_NPROC: bad })).toThrow(/NPROC/);
    expect(() =>
      resolveChildIsolationConfig(
        { MCP_AMBASSADOR_CHILD_UID_RANGE: '20000-20999', MCP_AMBASSADOR_CHILD_NPROC: 'x' },
        1000,
        1000
      )
    ).toThrow(/NPROC/);
  });
});
