/**
 * TD-059: stable instance-key -> child uid mapping.
 *
 * Every downstream MCP instance (shared MCP, or user x MCP) runs under its OWN uid from a configured range,
 * so one child cannot read another's /proc/<pid>/environ or home. The mapping is persisted (server-owned
 * 0600 JSON in /data) so an instance keeps its uid, home and caches across restarts.
 *
 * Safety rules:
 * - A freshly assigned uid always has its home wiped first, as that uid (no root needed), so data left by an
 *   earlier owner of the uid (reclaim, or a lost map file) can never reach a different instance.
 * - A uid with a live lease is never reassigned. When the range is full, the least recently used key
 *   without a live lease is reclaimed; if none can be prepared the spawn is refused.
 * - Before a uid is (re)assigned, every process still running under it (a double-forked or setsid
 *   descendant of the previous owner outlives its direct child) is SIGKILLed; if any survives the
 *   assignment is refused for that uid (next candidate), so a new owner never shares a uid with leftovers.
 *   The same sweep runs when the last lease on a uid is released.
 * - A corrupt or unreadable map fails closed (children are not started); it is never silently recreated.
 * - Logs carry a hash of the key, never the user id.
 */
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { logger } from '@mcpambassador/core';
import { SETPRIV_PATH, resolveChildIsolationConfig } from './child-isolation.js';

/** Cleaning attempts per assignment (each may kill processes and wipe a home), so refusal stays fast. */
const MAX_PREPARE_ATTEMPTS = 8;
/** Total time one assignment may spend preparing uids; after that it is refused (restarts of others are not held up). */
const MAX_PREPARE_MS = 60_000;
const WIPE_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface UidRange {
  min: number;
  max: number;
  homesRoot: string;
  mapPath: string;
}

export interface AllocatorDeps {
  /** Returns file text, or null when the file does not exist. Throws on any other error. */
  readMap: (path: string) => string | null;
  /** Atomic replace (write temp + rename), mode 0600. */
  writeMap: (path: string, data: string) => void;
  /** Remove everything inside `home`, running as `uid`. Throws on failure. */
  wipeHome: (uid: number, home: string) => Promise<void>;
  /**
   * SIGKILL every process running under `uid`; returns how many (non-zombie) processes remain.
   * `shouldAbort` is checked before each round after the first: true means the uid has a new owner/lease and
   * must not be touched any more (returns 0).
   */
  reapUid: (uid: number, shouldAbort?: () => boolean) => Promise<number>;
  now: () => number;
}

/** IO behind the reap sweep (injectable for tests). Every function is synchronous so a round is atomic. */
export interface ReapIo {
  procs: (uid: number) => number[];
  kill: (pid: number) => void;
  /** Kill every process of `uid` from inside the uid (`kill -KILL -1` as that uid, no capabilities needed). */
  killAll: (uid: number) => void;
  sleep: (ms: number) => Promise<void>;
}

/** dash rejects `kill -s KILL -1` (reads -1 as an option), hence the `--`. kill(-1) skips the caller itself. */
export const KILL_ALL_SCRIPT = 'kill -s KILL -- -1';

const defaultReapIo: ReapIo = {
  procs: uid => procsOfUid(uid),
  kill: pid => process.kill(pid, 'SIGKILL'),
  killAll: uid => {
    spawnSync(
      SETPRIV_PATH,
      [
        `--reuid=${uid}`,
        `--regid=${uid}`,
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--',
        '/bin/sh',
        '-c',
        KILL_ALL_SCRIPT,
      ],
      { timeout: 5_000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } }
    );
  },
  sleep,
};

interface Entry {
  uid: number;
  lastUsed: number;
}

export interface UidLease {
  uid: number;
  gid: number;
  home: string;
  /** Idempotent. Call when the child process is gone. */
  release: () => void;
}

/**
 * Error text for server logs and the spawn failure (never sent to MCP clients).
 */
export function errText(err: unknown): string {
  // td036-allow: logs and the internal start() failure only; carries fs paths, never credentials
  return err instanceof Error ? err.message : 'unknown error';
}

export class ChildUidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildUidError';
  }
}

/** Short stable hash for logs (the key contains the user id). */
export function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Pids of non-zombie processes with any of real/effective/saved/fs uid == `uid` (reads /proc). */
export function procsOfUid(uid: number): number[] {
  const pids: number[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    throw new Error('cannot read /proc to check for leftover child processes');
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let status: string;
    try {
      status = readFileSync(`/proc/${n}/status`, 'utf8');
    } catch {
      continue; // exited meanwhile
    }
    if (/^State:\s+[ZX]/m.test(status)) continue;
    const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (m && [m[1], m[2], m[3], m[4]].some(v => Number(v) === uid)) pids.push(Number(n));
  }
  return pids;
}

/**
 * SIGKILL every process of `uid` (needs CAP_KILL), repeating while new ones appear. Returns survivors.
 * Each round (scan, per-pid kill, in-uid `kill -1`) runs without yielding, and `shouldAbort` is checked before
 * every round after the first (round 0 runs synchronously in the caller), so a sweep that started when the last
 * lease was released can never kill a child that the next lease of the same uid has started since.
 */
export async function reapProcessesOfUid(
  uid: number,
  shouldAbort?: () => boolean,
  io: ReapIo = defaultReapIo
): Promise<number> {
  for (let round = 0; round < 20; round++) {
    if (round > 0 && shouldAbort?.()) return 0;
    const pids = io.procs(uid);
    if (pids.length === 0) return 0;
    for (const pid of pids) {
      try {
        io.kill(pid);
      } catch {
        // already gone, or not killable: the next scan decides
      }
    }
    try {
      io.killAll(uid);
    } catch {
      // best effort: catches forks the scan missed; the next scan decides
    }
    await io.sleep(25);
  }
  if (shouldAbort?.()) return 0;
  return io.procs(uid).length;
}

const defaultDeps: AllocatorDeps = {
  readMap: path => {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  writeMap: (path, data) => {
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    try {
      const dfd = openSync(dirname(path), 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // directory fsync is best effort (not every filesystem allows it)
    }
  },
  wipeHome: async (uid, home) => {
    // Runs as the child uid with no capabilities. A previous owner may have left 0500 subdirs or a 000 home
    // (find cannot enter those), so the owner first restores u+rwx, then deletes. find never follows symlinks.
    const script =
      'h="$1"; chmod 0700 "$h" && find "$h" -mindepth 1 -type d -exec chmod u+rwx {} + ; find "$h" -mindepth 1 -delete';
    try {
      await execFileAsync(
        SETPRIV_PATH,
        [
          `--reuid=${uid}`,
          `--regid=${uid}`,
          '--clear-groups',
          '--inh-caps=-all',
          '--ambient-caps=-all',
          '--',
          '/bin/sh',
          '-c',
          script,
          'wipe',
          home,
        ],
        { timeout: WIPE_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' } }
      );
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      throw new Error(`wipe of ${home} as uid ${uid} failed (${String(code)})`, { cause: err });
    }
  },
  reapUid: (uid, shouldAbort) => reapProcessesOfUid(uid, shouldAbort),
  now: () => Date.now(),
};

export class ChildUidAllocator {
  private entries: Map<string, Entry> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private live = new Map<number, number>(); // uid -> live lease count
  /** uids being cleaned for a (re)assignment right now; their entries must not be leased through the fast path */
  private preparing = new Set<number>();
  private readonly deps: AllocatorDeps;

  constructor(
    private readonly range: UidRange,
    deps: Partial<AllocatorDeps> = {}
  ) {
    this.deps = { ...defaultDeps, ...deps };
  }

  homeFor(uid: number): string {
    return `${this.range.homesRoot}/${uid}`;
  }

  /** Lease the uid for `key` (assigning one if needed). Throws ChildUidError; callers must not spawn. */
  lease(key: string): Promise<UidLease> {
    // Fast path (N1): a key that already has an assignment whose uid is not being reclaimed right now needs no
    // cleaning, so it must not queue behind another instance's slow prepare (a wipe can take a while).
    if (key && this.entries) {
      const known = this.entries.get(key);
      if (known && !this.preparing.has(known.uid)) {
        try {
          return Promise.resolve(this.takeLease(this.entries, known));
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(errText(err)));
        }
      }
    }
    // serialized: preparing a uid awaits (kill, wipe) and two callers must never pick the same one
    const run = this.chain.then(() => this.leaseInner(key));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async leaseInner(key: string): Promise<UidLease> {
    if (!key) throw new ChildUidError('child isolation needs a non-empty instance key');
    const entries = this.load();
    let entry = entries.get(key);
    const fresh = !entry;
    if (!entry) {
      const uid = await this.prepareFreshUid(entries, key);
      entry = { uid, lastUsed: this.deps.now() };
      entries.set(key, entry);
      try {
        this.persist(entries);
      } catch (err) {
        entries.delete(key);
        this.entries = null; // a reclaimed victim was dropped from memory only; reread the file
        throw new ChildUidError(`cannot persist ${this.range.mapPath}: ${errText(err)}`);
      }
      logger.info(`[child-uid] assigned uid ${uid} to instance ${keyHash(key)}`);
      const size = this.range.max - this.range.min + 1;
      if (entries.size * 5 >= size * 4) {
        logger.warn(
          `[child-uid] ${entries.size}/${size} uids of ${this.range.min}-${this.range.max} are assigned (80%+); widen MCP_AMBASSADOR_CHILD_UID_RANGE before idle instances start being reclaimed`
        );
      }
    }
    return this.takeLease(entries, entry, fresh);
  }

  /** Synchronous: mark the entry used and take a lease on its uid. */
  private takeLease(entries: Map<string, Entry>, entry: Entry, justPersisted = false): UidLease {
    entry.lastUsed = this.deps.now();
    if (!justPersisted) {
      try {
        this.persist(entries);
      } catch {
        // lastUsed is only an LRU hint; the mapping itself is already durable
      }
    }
    const uid = entry.uid;
    this.live.set(uid, (this.live.get(uid) ?? 0) + 1);
    let released = false;
    return {
      uid,
      gid: uid,
      home: this.homeFor(uid),
      release: () => {
        if (released) return;
        released = true;
        const n = (this.live.get(uid) ?? 1) - 1;
        if (n > 0) {
          this.live.set(uid, n);
          return;
        }
        this.live.delete(uid);
        // The direct child is gone; kill anything it detached. Round 0 runs right here; later rounds stop as
        // soon as the uid is leased again (a quick stop -> start of the same instance) or being reclaimed.
        const stale = (): boolean => (this.live.get(uid) ?? 0) > 0 || this.preparing.has(uid);
        void this.deps.reapUid(uid, stale).then(
          left => {
            if (left > 0)
              logger.warn(`[child-uid] ${left} process(es) of uid ${uid} survived SIGKILL`);
          },
          (err: unknown) =>
            logger.warn(`[child-uid] leftover sweep of uid ${uid} failed: ${errText(err)}`)
        );
      },
    };
  }

  /**
   * Choose a uid for a key without one and make it clean: no leftover processes, empty home. Candidates are the
   * free uids (lowest first), then idle keys' uids (least recently used first, reclaimed). A candidate that
   * cannot be cleaned is skipped, so one stuck uid never locks the range.
   */
  private async prepareFreshUid(entries: Map<string, Entry>, key: string): Promise<number> {
    const used = new Set<number>();
    for (const e of entries.values()) used.add(e.uid);
    const idle = [...entries.entries()]
      .filter(([, e]) => (this.live.get(e.uid) ?? 0) === 0)
      .sort((x, y) => x[1].lastUsed - y[1].lastUsed);
    const started = this.deps.now();
    let tried = 0;
    let lastWhy = '';
    const budgetLeft = (): boolean =>
      tried < MAX_PREPARE_ATTEMPTS && this.deps.now() - started < MAX_PREPARE_MS;
    const attempt = async (uid: number): Promise<boolean> => {
      tried++;
      // marked before the first await: the fast path must not lease this uid while it is being cleaned
      this.preparing.add(uid);
      try {
        const left = await this.deps.reapUid(uid);
        if (left > 0) throw new Error(`${left} process(es) still running under it`);
        await this.deps.wipeHome(uid, this.homeFor(uid));
        return true;
      } catch (err) {
        lastWhy = errText(err);
        logger.warn(`[child-uid] uid ${uid} not usable for ${keyHash(key)}: ${lastWhy}`);
        return false;
      } finally {
        this.preparing.delete(uid);
      }
    };
    for (let uid = this.range.min; uid <= this.range.max && budgetLeft(); uid++) {
      if (!used.has(uid) && (await attempt(uid))) return uid;
    }
    for (const [k, e] of idle) {
      if (!budgetLeft()) break;
      // an earlier attempt awaited: the key may have been leased (fast path), released or reassigned since
      if ((this.live.get(e.uid) ?? 0) > 0 || entries.get(k) !== e) continue;
      if (await attempt(e.uid)) {
        entries.delete(k);
        logger.warn(
          `[child-uid] range exhausted: reclaimed uid ${e.uid} from instance ${keyHash(k)} for ${keyHash(key)} (home wiped)`
        );
        return e.uid;
      }
    }
    logger.warn(
      tried === 0
        ? `[child-uid] range ${this.range.min}-${this.range.max} exhausted, no idle uid to reclaim (instance ${keyHash(key)} refused)`
        : `[child-uid] no usable uid in ${this.range.min}-${this.range.max} for instance ${keyHash(key)} (${tried} tried)`
    );
    throw new ChildUidError(
      tried === 0
        ? `child uid range ${this.range.min}-${this.range.max} is exhausted and every uid has a live process`
        : `no child uid could be prepared in ${this.range.min}-${this.range.max}${lastWhy ? ` (last: ${lastWhy})` : ''}`
    );
  }

  /**
   * Forget the uid assignment of keys (user deleted, MCP uninstalled) so the uid can be reused. Keys with a live
   * lease are kept. The home is wiped on the next assignment. Returns how many keys were freed.
   */
  releaseKeys(match: (key: string) => boolean): number {
    const entries = this.load();
    let n = 0;
    for (const [k, e] of [...entries]) {
      if (!match(k) || (this.live.get(e.uid) ?? 0) > 0) continue;
      entries.delete(k);
      n++;
    }
    if (n > 0) {
      try {
        this.persist(entries);
      } catch (err) {
        this.entries = null;
        throw new ChildUidError(`cannot persist ${this.range.mapPath}: ${errText(err)}`);
      }
    }
    return n;
  }

  private load(): Map<string, Entry> {
    if (this.entries) return this.entries;
    const { mapPath, min, max } = this.range;
    const recovery = `Move ${mapPath} aside to recover: every home is then wiped when its instance is assigned a uid again.`;
    let raw: string | null;
    try {
      raw = this.deps.readMap(mapPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'error';
      logger.error(`[child-uid] cannot read ${mapPath} (${code}). ${recovery}`);
      throw new ChildUidError(`cannot read ${mapPath} (${code}); child instances are not started`);
    }
    const entries = new Map<string, Entry>();
    if (raw !== null) {
      const bad = (why: string): never => {
        logger.error(`[child-uid] ${mapPath} is invalid (${why}). ${recovery}`);
        throw new ChildUidError(`${mapPath} is invalid (${why}); child instances are not started`);
      };
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        return bad('not JSON');
      }
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
        return bad('not an object');
      const d = doc as { version?: unknown; entries?: unknown };
      if (d.version !== 1) return bad('unsupported version');
      if (typeof d.entries !== 'object' || d.entries === null || Array.isArray(d.entries)) {
        return bad('entries is not an object');
      }
      const seen = new Set<number>();
      for (const [k, v] of Object.entries(d.entries as Record<string, unknown>)) {
        if (!k) return bad('empty key');
        const e = v as { uid?: unknown; lastUsed?: unknown } | null;
        if (
          typeof e !== 'object' ||
          e === null ||
          typeof e.uid !== 'number' ||
          !Number.isInteger(e.uid) ||
          typeof e.lastUsed !== 'number' ||
          !Number.isFinite(e.lastUsed)
        ) {
          return bad('malformed entry');
        }
        if (e.uid < min || e.uid > max) return bad('uid outside the configured range');
        if (seen.has(e.uid)) return bad('duplicate uid');
        seen.add(e.uid);
        entries.set(k, { uid: e.uid, lastUsed: e.lastUsed });
      }
    }
    this.entries = entries;
    return entries;
  }

  private persist(entries: Map<string, Entry>): void {
    const doc = { version: 1, entries: Object.fromEntries(entries) };
    this.deps.writeMap(this.range.mapPath, JSON.stringify(doc));
  }
}

let singleton: { sig: string; alloc: ChildUidAllocator } | null = null;

/** Process-wide allocator for the configured range (rebuilt if the configuration changes). */
export function getChildUidAllocator(range: UidRange): ChildUidAllocator {
  const sig = `${range.min}-${range.max}|${range.homesRoot}|${range.mapPath}`;
  if (!singleton || singleton.sig !== sig) {
    singleton = { sig, alloc: new ChildUidAllocator(range) };
  }
  return singleton.alloc;
}

/**
 * Free the uid assignments of keys that will not come back (user deactivated, MCP removed from the catalog).
 * No-op unless per-instance uids are configured; never throws (a failure only delays reuse of the uid).
 */
export function forgetChildUidKeys(match: (key: string) => boolean): void {
  try {
    const cfg = resolveChildIsolationConfig();
    if (cfg?.kind !== 'range') return;
    const n = getChildUidAllocator(cfg).releaseKeys(match);
    if (n > 0) logger.info(`[child-uid] released ${n} uid assignment(s)`);
  } catch (err) {
    logger.warn(`[child-uid] could not release uid assignments: ${errText(err)}`);
  }
}

/** Instance keys of one catalog MCP: its shared and discovery instances and every user's instance of it. */
export function catalogMcpKeyMatcher(name: string): (key: string) => boolean {
  return key =>
    key === `shared:${name}` ||
    key === `discovery:${name}` ||
    (key.startsWith('user:') && key.endsWith(`:${name}`));
}

/** Test hook. */
export function resetChildUidAllocatorForTests(): void {
  singleton = null;
}
