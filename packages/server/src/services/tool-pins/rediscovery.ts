/**
 * ADR-021 re-discovery: keeps pins honest for long-lived connections.
 *
 * - `notifications/tools/list_changed` from a shared stdio downstream: re-fetch that MCP's tools (debounced).
 * - Periodic (default 6h, TOOL_PIN_REDISCOVERY_HOURS): re-fetch every shared and per-user connection.
 * After each refresh the shared MCPs are observed immediately, so a changed definition lands in the review
 * queue (and the badge) without waiting for an agent to list tools. Serving is unaffected either way:
 * the agent only ever sees the approved pinned definition.
 */
import { getMcpEntryByName, logger, type DatabaseClient } from '@mcpambassador/core';
import { TOOL_PIN_REDISCOVERY_HOURS_DEFAULT } from '@mcpambassador/contracts';
import type { SharedMcpManager } from '../../downstream/manager.js';
import type { UserMcpPool } from '../../downstream/user-mcp-pool.js';
import type { ToolRouter } from '../../downstream/tool-router.js';

export interface RediscoveryOptions {
  db: DatabaseClient;
  mcpManager: SharedMcpManager;
  userPool: UserMcpPool | null;
  toolRouter: ToolRouter;
  /** 0 disables the periodic run (list_changed handling stays on). */
  intervalHours?: number;
  debounceMs?: number;
}

/** Parse TOOL_PIN_REDISCOVERY_HOURS; invalid or negative values fall back to the default. */
export function rediscoveryHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOOL_PIN_REDISCOVERY_HOURS;
  if (raw === undefined || raw === '') return TOOL_PIN_REDISCOVERY_HOURS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : TOOL_PIN_REDISCOVERY_HOURS_DEFAULT;
}

export class ToolPinRediscovery {
  private timer: NodeJS.Timeout | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(private readonly o: RediscoveryOptions) {}

  start(): void {
    this.o.mcpManager.onToolsListChanged = name => this.onListChanged(name);
    const hours = this.o.intervalHours ?? TOOL_PIN_REDISCOVERY_HOURS_DEFAULT;
    if (hours > 0) {
      this.timer = setInterval(() => void this.runAll(), hours * 3_600_000);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.o.mcpManager.onToolsListChanged = undefined;
  }

  /** Debounced single-MCP refresh (a downstream can send bursts of list_changed). */
  onListChanged(mcpName: string): void {
    if (this.pending.has(mcpName)) return;
    const t = setTimeout(() => {
      this.pending.delete(mcpName);
      void this.refreshOne(mcpName);
    }, this.o.debounceMs ?? 1000);
    t.unref();
    this.pending.set(mcpName, t);
  }

  async refreshOne(mcpName: string): Promise<void> {
    try {
      await this.o.mcpManager.refreshMcp(mcpName);
      await this.observeShared([mcpName]);
    } catch (err) {
      logger.warn({ err, mcp: mcpName }, '[tool-pins] list_changed refresh failed');
    }
  }

  /** The periodic run. Overlapping runs are skipped. */
  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.o.mcpManager.refreshAll();
      await this.o.userPool?.refreshAllTools();
      await this.observeShared(this.o.mcpManager.getConnectionNames());
    } catch (err) {
      logger.warn({ err }, '[tool-pins] periodic re-discovery failed');
    } finally {
      this.running = false;
    }
  }

  private async observeShared(names: string[]): Promise<void> {
    for (const name of names) {
      const entry = await getMcpEntryByName(this.o.db, name);
      if (entry && entry.isolation_mode === 'shared') {
        await this.o.toolRouter.observeSharedNow(this.o.db, entry);
      }
    }
  }
}
