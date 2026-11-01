/**
 * TD-045: respawn of stdio MCP processes that exit unexpectedly (crash, OOM kill, output flood).
 * Shared by SharedMcpManager and UserMcpPool. Exponential backoff, bounded attempts, audit callback,
 * and a per-key status that health checks surface.
 */
import { logger } from '@mcpambassador/core';
import type { StdioMcpConnection } from './stdio-connection.js';

export type RespawnEventSink = (action: string, metadata: Record<string, unknown>) => void;
export interface RespawnStatus {
  state: 'ok' | 'respawning' | 'gave_up';
  attempts: number;
}

export class RespawnController {
  static readonly MAX_ATTEMPTS = 5;
  static readonly BASE_MS = 1000;
  static readonly CAP_MS = 30000;
  static readonly STABLE_MS = 60000;

  private attempts = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private gaveUp = new Set<string>();
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
    if (this.closed || this.timers.has(key) || !isCurrent()) return;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    if (attempt > RespawnController.MAX_ATTEMPTS) {
      this.gaveUp.add(key);
      logger.error(`[respawn] ${this.scope}:${key} giving up after ${attempt - 1} attempts`);
      this.emit('mcp_respawn_gave_up', key, { attempts: attempt - 1 });
      return;
    }
    this.attempts.set(key, attempt);
    const delay = Math.min(
      RespawnController.BASE_MS * 2 ** (attempt - 1),
      RespawnController.CAP_MS
    );
    logger.warn(`[respawn] ${this.scope}:${key} respawn ${attempt} in ${delay}ms`);
    this.emit('mcp_process_exited', key, { reason, attempt, delay_ms: delay });
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (this.closed || !isCurrent()) return;
      connection
        .start()
        .then(async () => {
          await afterStart();
          this.emit('mcp_respawned', key, { attempt });
          const t = setTimeout(() => {
            this.attempts.delete(key);
            this.gaveUp.delete(key);
          }, RespawnController.STABLE_MS);
          t.unref();
        })
        .catch(err => {
          logger.error({ err }, `[respawn] ${this.scope}:${key} respawn failed`);
          this.emit('mcp_respawn_failed', key, { attempt });
          this.schedule(key, connection, isCurrent, afterStart, 'respawn_failed');
        });
    }, delay);
    timer.unref();
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.attempts.delete(key);
    this.gaveUp.delete(key);
  }

  cancelPrefix(prefix: string): void {
    for (const k of [...this.timers.keys(), ...this.attempts.keys()]) {
      if (k.startsWith(prefix)) this.cancel(k);
    }
  }

  close(): void {
    this.closed = true;
    for (const k of [...this.timers.keys()]) this.cancel(k);
  }

  status(key: string): RespawnStatus {
    if (this.gaveUp.has(key)) return { state: 'gave_up', attempts: this.attempts.get(key) ?? 0 };
    if (this.timers.has(key)) return { state: 'respawning', attempts: this.attempts.get(key) ?? 0 };
    return { state: 'ok', attempts: this.attempts.get(key) ?? 0 };
  }
}
