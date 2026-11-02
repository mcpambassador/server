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
 * - A uid with a live process is never reassigned. When the range is full, the least recently used key
 *   without a live process is reclaimed; if none exists the spawn is refused.
 * - A corrupt or unreadable map fails closed (children are not started); it is never silently recreated.
 * - Logs carry a hash of the key, never the user id.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { logger } from '@mcpambassador/core';
import { SETPRIV_PATH } from './child-isolation.js';

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
  wipeHome: (uid: number, home: string) => void;
  now: () => number;
}

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
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  },
  wipeHome: (uid, home) => {
    // find -delete never follows symlinks. Runs as the child uid with no capabilities.
    const r = spawnSync(
      SETPRIV_PATH,
      [
        `--reuid=${uid}`,
        `--regid=${uid}`,
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--',
        '/usr/bin/find',
        home,
        '-mindepth',
        '1',
        '-delete',
      ],
      { timeout: 60_000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } }
    );
    if (r.status !== 0) {
      throw new Error(`wipe of ${home} as uid ${uid} failed (status ${String(r.status)})`);
    }
  },
  now: () => Date.now(),
};

export class ChildUidAllocator {
  private entries: Map<string, Entry> | null = null;
  private live = new Map<number, number>(); // uid -> live lease count
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
  lease(key: string): UidLease {
    if (!key) throw new ChildUidError('child isolation needs a non-empty instance key');
    const entries = this.load();
    let entry = entries.get(key);
    if (!entry) {
      const uid = this.pickUid(entries, key);
      try {
        this.deps.wipeHome(uid, this.homeFor(uid));
      } catch (err) {
        this.entries = null; // a reclaimed victim was dropped from memory only; reread the file
        throw new ChildUidError(
          `cannot prepare home for a new instance (uid ${uid}): ${errText(err)}`
        );
      }
      entry = { uid, lastUsed: this.deps.now() };
      entries.set(key, entry);
      try {
        this.persist(entries);
      } catch (err) {
        entries.delete(key);
        throw new ChildUidError(`cannot persist ${this.range.mapPath}: ${errText(err)}`);
      }
      logger.info(`[child-uid] assigned uid ${uid} to instance ${keyHash(key)}`);
    } else {
      entry.lastUsed = this.deps.now();
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
        if (n <= 0) this.live.delete(uid);
        else this.live.set(uid, n);
      },
    };
  }

  private pickUid(entries: Map<string, Entry>, key: string): number {
    const used = new Set<number>();
    for (const e of entries.values()) used.add(e.uid);
    for (let uid = this.range.min; uid <= this.range.max; uid++) {
      if (!used.has(uid)) return uid;
    }
    // Range full: reclaim the least recently used key whose uid has no live process.
    let victim: [string, Entry] | null = null;
    for (const [k, e] of entries) {
      if ((this.live.get(e.uid) ?? 0) > 0) continue;
      if (!victim || e.lastUsed < victim[1].lastUsed) victim = [k, e];
    }
    if (!victim) {
      logger.warn(
        `[child-uid] range ${this.range.min}-${this.range.max} exhausted, no idle uid to reclaim (instance ${keyHash(key)} refused)`
      );
      throw new ChildUidError(
        `child uid range ${this.range.min}-${this.range.max} is exhausted and every uid has a live process`
      );
    }
    entries.delete(victim[0]);
    logger.warn(
      `[child-uid] range exhausted: reclaiming uid ${victim[1].uid} from instance ${keyHash(victim[0])} for ${keyHash(key)} (home will be wiped)`
    );
    return victim[1].uid;
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

/** Test hook. */
export function resetChildUidAllocatorForTests(): void {
  singleton = null;
}
