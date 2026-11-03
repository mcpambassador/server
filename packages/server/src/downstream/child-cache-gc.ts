/**
 * TD-062: size cap and LRU purge for the per-instance MCP caches (TD-059 homes under /tmp/mcp-homes/<uid>).
 *
 * What is purged: ONLY the four cache directories below, inside a home. Everything else an MCP wrote under its
 * HOME (config, tokens, state) is never deleted by this module; a home that stays over the cap because of such
 * data only gets a warning. The whole-home wipe on uid reassignment (child-uid-allocator) is unchanged.
 *
 * Safety rules:
 * - A uid with a live lease, or one being prepared, is never touched. The purge itself runs inside the
 *   allocator's serialized chain with the uid marked `preparing` (`exclusiveIfIdle`), so a lease for that
 *   instance waits for the purge instead of starting a child into a half-deleted cache. Measuring is read-only
 *   and runs outside the chain, so one slow `du` never holds up other instances.
 * - Every du/find runs as the child uid (setpriv, no capabilities), never as the server uid or root.
 * - Before acting the uid must be inside the allocator range and the home must be exactly
 *   <homesRoot>/<uid> with no symlink in its path (realpath); the shell script re-checks that the home and
 *   each cache directory are real directories, and find never follows symlinks or crosses devices.
 * - GC failures are logged and swallowed: they never block lease/start/stop and never throw out of the chain.
 * - Logs carry a hash of the instance key, never the user id.
 */
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { logger } from '@mcpambassador/core';
import { SETPRIV_PATH, resolveChildIsolationConfig } from './child-isolation.js';
import {
  getChildUidAllocator,
  keyHash,
  errText,
  type ChildUidAllocator,
} from './child-uid-allocator.js';

const execFileAsync = promisify(execFile);

/** The only directories (relative to a home) that GC may empty. Matches the env set in stdio-connection. */
export const CACHE_DIRS = ['.npm-cache', '.uv-cache', '.cache', 'tmp'] as const;

export type CacheGcMode = 'enforce' | 'dry-run' | 'off';

export interface CacheGcConfig {
  mode: CacheGcMode;
  /** 0 = no per-home cap */
  perHomeBytes: number;
  /** 0 = no total cap */
  totalBytes: number;
  intervalMs: number;
}

const MIB = 1024 * 1024;
export const DEFAULT_HOME_MAX_MB = 1024;
export const DEFAULT_TOTAL_MAX_MB = 10240;
export const DEFAULT_INTERVAL_MIN = 360;
const FIRST_SWEEP_DELAY_MS = 10 * 60_000;
/** Per-uid throttle for the "instance went idle" trigger. */
const IDLE_CHECK_MIN_GAP_MS = 10 * 60_000;
const GC_EXEC_TIMEOUT_MS = 120_000;
/** Each du/find/chmod kills itself (execFile's timeout only kills the sh), a little before execFile gives up. */
const TOOL_TIMEOUT_S = 100;
const TK = `timeout -s KILL ${TOOL_TIMEOUT_S}`;

function readInt(
  source: NodeJS.ProcessEnv,
  name: string,
  def: number,
  min: number,
  max: number,
  warn: (m: string) => void
): number {
  const raw = source[name]?.trim();
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    warn(`[child-cache-gc] ${name}="${raw}" is not an integer in ${min}-${max}; using ${def}`);
    return def;
  }
  return Number(raw);
}

/**
 * Reads MCP_AMBASSADOR_CHILD_HOME_MAX_MB, MCP_AMBASSADOR_CHILD_HOMES_TOTAL_MAX_MB, MCP_AMBASSADOR_CHILD_CACHE_GC
 * and MCP_AMBASSADOR_CHILD_CACHE_GC_INTERVAL_MIN. An invalid value falls back to the safe default (with a
 * warning), never to "unlimited"; only an explicit 0 disables a cap.
 */
export function resolveCacheGcConfig(
  source: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = m => logger.warn(m)
): CacheGcConfig {
  let mode: CacheGcMode = 'enforce';
  const rawMode = source['MCP_AMBASSADOR_CHILD_CACHE_GC']?.trim().toLowerCase();
  if (rawMode) {
    if (rawMode === 'enforce' || rawMode === 'dry-run' || rawMode === 'off') mode = rawMode;
    else {
      // a destructive feature fails safe: an unknown value never deletes anything
      mode = 'dry-run';
      warn(
        `[child-cache-gc] MCP_AMBASSADOR_CHILD_CACHE_GC="${rawMode}" is not enforce|dry-run|off; using dry-run (log only)`
      );
    }
  }
  const cap = 1024 * 1024; // MiB: 1 TiB, a sanity bound
  return {
    mode,
    perHomeBytes:
      readInt(source, 'MCP_AMBASSADOR_CHILD_HOME_MAX_MB', DEFAULT_HOME_MAX_MB, 0, cap, warn) * MIB,
    totalBytes:
      readInt(
        source,
        'MCP_AMBASSADOR_CHILD_HOMES_TOTAL_MAX_MB',
        DEFAULT_TOTAL_MAX_MB,
        0,
        cap,
        warn
      ) * MIB,
    intervalMs:
      readInt(
        source,
        'MCP_AMBASSADOR_CHILD_CACHE_GC_INTERVAL_MIN',
        DEFAULT_INTERVAL_MIN,
        1,
        7 * 24 * 60,
        warn
      ) * 60_000,
  };
}

export interface HomeUsage {
  /** Whole home (cache dirs included). */
  homeBytes: number;
  /** Sum of the allowlisted cache dirs that exist. */
  cacheBytes: number;
}

export interface Measured extends HomeUsage {
  key: string;
  uid: number;
  lastUsed: number;
  live: boolean;
}

export type PurgeReason = 'cap' | 'lru';

export interface PurgePlan {
  purge: Array<{ m: Measured; reason: PurgeReason }>;
  /** Over the per-home cap but live: never touched, only reported. */
  liveOverCap: Measured[];
  totalBytes: number;
}

/**
 * Pure policy. Idle homes over the per-home cap lose their caches; then, while the total is still over the
 * total cap, idle homes are purged least recently used first. Live homes are never selected.
 */
export function planPurges(measured: Measured[], cfg: CacheGcConfig): PurgePlan {
  const purge: PurgePlan['purge'] = [];
  const liveOverCap: Measured[] = [];
  const chosen = new Set<number>();
  let total = measured.reduce((s, m) => s + m.homeBytes, 0);
  const totalBefore = total;
  if (cfg.perHomeBytes > 0) {
    for (const m of measured) {
      if (m.homeBytes <= cfg.perHomeBytes) continue;
      if (m.live) liveOverCap.push(m);
      else if (m.cacheBytes > 0) {
        purge.push({ m, reason: 'cap' });
        chosen.add(m.uid);
        total -= m.cacheBytes;
      }
    }
  }
  if (cfg.totalBytes > 0 && total > cfg.totalBytes) {
    const lru = measured
      .filter(m => !m.live && m.cacheBytes > 0 && !chosen.has(m.uid))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const m of lru) {
      if (total <= cfg.totalBytes) break;
      purge.push({ m, reason: 'lru' });
      total -= m.cacheBytes;
    }
  }
  return { purge, liveOverCap, totalBytes: totalBefore };
}

/** What the GC needs from the allocator (narrow, so tests can fake it). */
export interface GcTarget {
  uidRange: { min: number; max: number; homesRoot: string };
  homeFor: (uid: number) => string;
  instances: () => Array<{ key: string; uid: number; lastUsed: number; live: boolean }>;
  exclusiveIfIdle: <T>(
    key: string,
    uid: number,
    fn: () => Promise<T>
  ) => Promise<{ ran: true; value: T } | { ran: false; reason?: 'unassigned' | 'busy' }>;
  setIdleListener: (fn: ((uid: number) => void) | undefined) => void;
}

export interface CacheGcDeps {
  measure: (uid: number, home: string) => Promise<HomeUsage>;
  purge: (uid: number, home: string) => Promise<void>;
  now: () => number;
}

/** Runs `script` with `args` as `uid`, no capabilities. Injectable so tests can run it as the current user. */
export type ScriptRunner = (uid: number, script: string, args: string[]) => Promise<string>;

const setprivRunner: ScriptRunner = async (uid, script, args) => {
  const { stdout } = await execFileAsync(
    SETPRIV_PATH,
    [
      `--reuid=${uid}`,
      `--regid=${uid}`,
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      '/bin/sh',
      '-c',
      script,
      'gc',
      ...args,
    ],
    { timeout: GC_EXEC_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1 << 20 }
  );
  return stdout;
};

/** du -x stays on one device; -P (default) never follows symlinks. Unreadable entries only shrink the figure. */
export const MEASURE_SCRIPT =
  'h="$1"; shift; [ -d "$h" ] && [ ! -L "$h" ] || exit 3; ' +
  `${TK} du -skx -- "$h" 2>/dev/null; ` +
  'for d in "$@"; do p="$h/$d"; if [ -d "$p" ] && [ ! -L "$p" ]; then ' +
  `${TK} du -skx -- "$p" 2>/dev/null; fi; done; exit 0`;

/** The owner first restores u+rwx on cache subdirs (a 0500 dir cannot be emptied), then deletes contents only. */
export const PURGE_SCRIPT =
  'h="$1"; shift; [ -d "$h" ] && [ ! -L "$h" ] || exit 3; ' +
  'for d in "$@"; do p="$h/$d"; [ -d "$p" ] && [ ! -L "$p" ] || continue; ' +
  `${TK} find -P "$p" -xdev -type d -exec chmod u+rwx {} + 2>/dev/null; ` +
  `${TK} find -P "$p" -xdev -mindepth 1 -delete || exit 4; done`;

export function makeDefaultGcDeps(run: ScriptRunner = setprivRunner): CacheGcDeps {
  return {
    measure: async (uid, home) => {
      const out = await run(uid, MEASURE_SCRIPT, [home, ...CACHE_DIRS]);
      let homeBytes: number | undefined;
      let cacheBytes = 0;
      for (const line of out.split('\n')) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (!m) continue;
        const bytes = Number(m[1]) * 1024;
        if (m[2] === home) homeBytes = bytes;
        else if (CACHE_DIRS.some(d => m[2] === `${home}/${d}`)) cacheBytes += bytes;
      }
      if (homeBytes === undefined) throw new Error('home size could not be measured');
      return { homeBytes, cacheBytes: Math.min(cacheBytes, homeBytes) };
    },
    purge: async (uid, home) => {
      await run(uid, PURGE_SCRIPT, [home, ...CACHE_DIRS]);
    },
    now: () => Date.now(),
  };
}

/**
 * Throws unless `uid` is inside the allocator range and `home` is exactly <homesRoot>/<uid> as a real
 * directory (no symlink anywhere in its path).
 */
export function verifyHome(
  range: { min: number; max: number; homesRoot: string },
  uid: number,
  home: string
): void {
  if (!Number.isInteger(uid) || uid < range.min || uid > range.max)
    throw new Error(`uid ${uid} is outside the child uid range`);
  if (home !== `${range.homesRoot}/${uid}`) throw new Error('home path is not <homesRoot>/<uid>');
  if (realpathSync(home) !== `${realpathSync(range.homesRoot)}/${uid}`)
    throw new Error('home path resolves through a symlink');
  if (!lstatSync(home).isDirectory()) throw new Error('home is not a directory');
}

const mib = (b: number): string => `${(b / MIB).toFixed(1)}MiB`;

export class ChildCacheGc {
  private gate: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private lastIdleCheck = new Map<number, number>();

  constructor(
    private readonly target: GcTarget,
    private readonly cfg: CacheGcConfig,
    private readonly deps: CacheGcDeps = makeDefaultGcDeps()
  ) {}

  start(): void {
    if (this.cfg.mode === 'off' || !this.stopped) return;
    this.stopped = false;
    this.target.setIdleListener(uid => {
      void this.onIdle(uid);
    });
    this.schedule(FIRST_SWEEP_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.target.setIdleListener(undefined);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sweep().finally(() => this.schedule(this.cfg.intervalMs));
    }, ms);
    this.timer.unref();
  }

  /** One GC operation at a time (each du/find is cheap on its own; this only avoids piling them up). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn);
    this.gate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** The last lease on `uid` was released: check just that home against the per-home cap. */
  async onIdle(uid: number): Promise<void> {
    if (this.cfg.mode === 'off' || this.cfg.perHomeBytes <= 0) return;
    const now = this.deps.now();
    const last = this.lastIdleCheck.get(uid);
    if (last !== undefined && now - last < IDLE_CHECK_MIN_GAP_MS) return;
    this.lastIdleCheck.set(uid, now);
    try {
      await this.serial(async () => {
        const inst = this.target.instances().find(i => i.uid === uid);
        if (!inst || inst.live) return;
        const usage = await this.deps.measure(uid, this.target.homeFor(uid));
        const m: Measured = { ...inst, ...usage };
        const plan = planPurges([m], { ...this.cfg, totalBytes: 0 });
        for (const p of plan.purge) await this.purgeOne(p.m, p.reason);
        this.warnOver(m);
      });
    } catch (err) {
      logger.warn(`[child-cache-gc] idle check of uid ${uid} failed: ${errText(err)}`);
    }
  }

  /** Measure every assigned home, then purge per the plan. Never throws. */
  async sweep(): Promise<PurgePlan | undefined> {
    if (this.cfg.mode === 'off') return undefined;
    try {
      return await this.serial(async () => {
        const measured: Measured[] = [];
        for (const inst of this.target.instances()) {
          try {
            const usage = await this.deps.measure(inst.uid, this.target.homeFor(inst.uid));
            // liveness is read after the (slow) measurement; purgeOne re-checks it under the allocator
            const live = this.target.instances().find(i => i.uid === inst.uid)?.live ?? inst.live;
            measured.push({ ...inst, live, ...usage });
          } catch (err) {
            logger.warn(
              `[child-cache-gc] cannot measure instance ${keyHash(inst.key)} (uid ${inst.uid}): ${errText(err)}`
            );
          }
        }
        const plan = planPurges(measured, this.cfg);
        for (const m of plan.liveOverCap) this.warnOver(m);
        let done = 0;
        for (const p of plan.purge) if (await this.purgeOne(p.m, p.reason)) done++;
        logger.info(
          `[child-cache-gc] sweep: ${measured.length} homes, ${mib(plan.totalBytes)} total, ${done} ${this.cfg.mode === 'dry-run' ? 'would be purged' : 'purged'}`
        );
        return plan;
      });
    } catch (err) {
      logger.warn(`[child-cache-gc] sweep failed: ${errText(err)}`);
      return undefined;
    }
  }

  private warnOver(m: Measured): void {
    if (this.cfg.perHomeBytes <= 0 || m.homeBytes <= this.cfg.perHomeBytes) return;
    if (m.live) {
      logger.warn(
        `[child-cache-gc] instance ${keyHash(m.key)} (uid ${m.uid}) is ${mib(m.homeBytes)}, over the ${mib(this.cfg.perHomeBytes)} cap; running, so its caches are not touched`
      );
    } else if (m.homeBytes - m.cacheBytes > this.cfg.perHomeBytes) {
      logger.warn(
        `[child-cache-gc] instance ${keyHash(m.key)} (uid ${m.uid}) stays over the cap after cache purge: ${mib(m.homeBytes - m.cacheBytes)} of non-cache data (never auto-deleted)`
      );
    }
  }

  /** True when the home was purged (or, in dry-run, would have been). */
  private async purgeOne(m: Measured, reason: PurgeReason): Promise<boolean> {
    const home = this.target.homeFor(m.uid);
    const tag = `instance ${keyHash(m.key)} (uid ${m.uid})`;
    try {
      const r = await this.target.exclusiveIfIdle(m.key, m.uid, async () => {
        verifyHome(this.target.uidRange, m.uid, home);
        if (this.cfg.mode === 'dry-run') return false;
        await this.deps.purge(m.uid, home);
        return true;
      });
      if (!r.ran) {
        logger.info(
          r.reason === 'unassigned'
            ? `[child-cache-gc] ${tag} no longer owns this uid (released or reassigned); purge skipped`
            : `[child-cache-gc] ${tag} became busy; purge skipped`
        );
        return false;
      }
      logger.info(
        r.value
          ? `[child-cache-gc] purged ${tag}: ${CACHE_DIRS.join(',')} freed ~${mib(m.cacheBytes)} (home ${mib(m.homeBytes)}, reason ${reason})`
          : `[child-cache-gc] dry-run: would purge ${tag}: ~${mib(m.cacheBytes)} (home ${mib(m.homeBytes)}, reason ${reason})`
      );
      if (
        r.value &&
        m.homeBytes - m.cacheBytes > this.cfg.perHomeBytes &&
        this.cfg.perHomeBytes > 0
      )
        this.warnOver(m);
      return true;
    } catch (err) {
      logger.warn(`[child-cache-gc] purge of ${tag} failed: ${errText(err)}`);
      return false;
    }
  }
}

let current: ChildCacheGc | undefined;

/** Start the GC for the configured uid range (no-op without per-instance uids or with GC off). Never throws. */
export function startChildCacheGc(): void {
  try {
    stopChildCacheGc();
    const iso = resolveChildIsolationConfig();
    if (iso?.kind !== 'range') return;
    const cfg = resolveCacheGcConfig();
    if (cfg.mode === 'off') {
      logger.info('[child-cache-gc] disabled (MCP_AMBASSADOR_CHILD_CACHE_GC=off)');
      return;
    }
    const alloc: ChildUidAllocator = getChildUidAllocator(iso);
    current = new ChildCacheGc(alloc, cfg);
    current.start();
    logger.info(
      `[child-cache-gc] ${cfg.mode}: per-home cap ${cfg.perHomeBytes ? mib(cfg.perHomeBytes) : 'none'}, total cap ${cfg.totalBytes ? mib(cfg.totalBytes) : 'none'}, sweep every ${cfg.intervalMs / 60_000} min`
    );
  } catch (err) {
    logger.warn(`[child-cache-gc] not started: ${errText(err)}`);
  }
}

export function stopChildCacheGc(): void {
  current?.stop();
  current = undefined;
}
