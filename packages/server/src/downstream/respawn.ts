/**
 * TD-045: respawn of stdio MCP processes that exit unexpectedly (crash, OOM kill, ...).
 * Shared by SharedMcpManager and UserMcpPool. Exponential backoff that retries forever at the cap (a
 * permanently dead MCP is a worse outcome than a retry every 30 s), an audit callback, and a per-key
 * status that health checks surface.
 *
 * Races: every cancel() bumps the key's generation. A respawn whose start() is already in flight checks
 * the generation (and `isCurrent`) when start() resolves and stops the connection if it was superseded,
 * so a remove / update / restart / shutdown during a respawn never leaves an orphan process.
 */
import { logger } from '@mcpambassador/core';
import type { StdioMcpConnection } from './stdio-connection.js';

export type RespawnEventSink = (action: string, metadata: Record<string, unknown>) => void;
export interface RespawnStatus {
  /** `failing`: still retrying, but past the normal attempt budget (health reports unhealthy). */
  state: 'ok' | 'respawning' | 'failing';
  attempts: number;
}

export class RespawnController {
  static readonly FAILING_AFTER = 5;
  static readonly BASE_MS = 1000;
  static readonly CAP_MS = 30000;
  static readonly STABLE_MS = 60000;
  /** Past the failing threshold, at most one summary event per this interval until recovery. */
  static readonly SUMMARY_MS = 3600000;

  private attempts = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Set<string>();
  private generation = new Map<string, number>();
  private lastSummary = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly scope: 'shared' | 'user',
    private readonly sink?: RespawnEventSink
  ) {}

  private emit(action: string, key: string, extra: Record<string, unknown> = {}): void {
    try {
      this.sink?.(action, { scope: this.scope, key, ...extra });
    } catch (err) {
      logger.error({ err }, '[respawn] audit sink failed');
    }
  }

  private gen(key: string): number {
    return this.generation.get(key) ?? 0;
  }

  /**
   * Call on an unexpected exit. `isCurrent` must be false once the connection was removed or replaced;
   * `afterStart` runs after a successful restart (e.g. refresh the tool catalog).
   */
  schedule(
    key: string,
    connection: StdioMcpConnection,
    isCurrent: () => boolean,
    afterStart: () => Promise<void> | void,
    reason = 'process_exited'
  ): void {
    if (this.closed || this.timers.has(key) || this.inflight.has(key) || !isCurrent()) return;
    this.plan(key, connection, isCurrent, afterStart, reason);
  }

  private plan(
    key: string,
    connection: StdioMcpConnection,
    isCurrent: () => boolean,
    afterStart: () => Promise<void> | void,
    reason: string
  ): void {
    if (this.closed || !isCurrent()) return;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const delay = Math.min(
      RespawnController.BASE_MS * 2 ** (attempt - 1),
      RespawnController.CAP_MS
    );
    const gen = this.gen(key);
    logger.warn(`[respawn] ${this.scope}:${key} respawn ${attempt} in ${delay}ms`);
    // Audit volume: per-attempt events only within the normal budget; past it, `mcp_respawn_failing`
    // once, then an hourly summary, until `mcp_respawned`.
    if (attempt <= RespawnController.FAILING_AFTER) {
      this.emit('mcp_process_exited', key, { reason, attempt, delay_ms: delay });
    } else if (attempt === RespawnController.FAILING_AFTER + 1) {
      this.lastSummary.set(key, Date.now());
      this.emit('mcp_respawn_failing', key, { attempts: attempt - 1, will_keep_retrying: true });
    } else if (Date.now() - (this.lastSummary.get(key) ?? 0) >= RespawnController.SUMMARY_MS) {
      this.lastSummary.set(key, Date.now());
      this.emit('mcp_respawn_failing', key, { attempts: attempt - 1, summary: true });
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (this.closed || this.gen(key) !== gen || !isCurrent()) return;
      this.inflight.add(key);
      connection
        .start()
        .then(async () => {
          this.inflight.delete(key);
          if (this.closed || this.gen(key) !== gen || !isCurrent()) {
            // superseded while start() was running: do not leave the new process behind
            await connection.stop().catch(() => undefined);
            return;
          }
          await afterStart();
          this.lastSummary.delete(key);
          this.emit('mcp_respawned', key, { attempt });
          const t = setTimeout(() => {
            if (this.gen(key) === gen) this.attempts.delete(key);
          }, RespawnController.STABLE_MS);
          t.unref();
        })
        .catch(err => {
          this.inflight.delete(key);
          logger.error({ err }, `[respawn] ${this.scope}:${key} respawn failed`);
          if (attempt <= RespawnController.FAILING_AFTER)
            this.emit('mcp_respawn_failed', key, { attempt });
          if (this.gen(key) === gen)
            this.plan(key, connection, isCurrent, afterStart, 'respawn_failed');
        });
    }, delay);
    timer.unref();
    this.timers.set(key, timer);
  }

  /** Cancel a pending respawn and invalidate one whose start() is in flight. */
  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.attempts.delete(key);
    this.lastSummary.delete(key);
    this.generation.set(key, this.gen(key) + 1);
  }

  cancelPrefix(prefix: string): void {
    const keys = new Set([...this.timers.keys(), ...this.attempts.keys(), ...this.inflight]);
    for (const k of keys) if (k.startsWith(prefix)) this.cancel(k);
  }

  close(): void {
    this.closed = true;
    for (const k of new Set([...this.timers.keys(), ...this.inflight])) this.cancel(k);
  }

  status(key: string): RespawnStatus {
    const attempts = this.attempts.get(key) ?? 0;
    const active = this.timers.has(key) || this.inflight.has(key);
    if (!active) return { state: 'ok', attempts };
    return {
      state: attempts > RespawnController.FAILING_AFTER ? 'failing' : 'respawning',
      attempts,
    };
  }
}
