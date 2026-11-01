/**
 * Kill Switch Manager
 *
 * Shared kill switch state used by the REST API and enforcement paths. State is held in memory for
 * synchronous lookups on the hot path and persisted to the `kill_switches` table (TD-022): loaded at
 * startup, written on every change, so a restart never silently clears an active switch.
 *
 * Key format: `type:target` (e.g. "client:cli_123", "mcp:github"). Active = present.
 *
 * @see CR-M10-001, TD-022
 */

import {
  listKillSwitches,
  upsertKillSwitch,
  deleteKillSwitch,
  type DatabaseClient,
} from '@mcpambassador/core';

export interface ActiveKillSwitch {
  target: string;
  type: 'client' | 'mcp';
  activated_at: string;
  activated_by: string;
}

export class KillSwitchManager {
  private state = new Map<string, ActiveKillSwitch>();

  constructor(private readonly db?: DatabaseClient) {}

  /** Replace in-memory state with the persisted switches (call once at startup, after migrations). */
  async load(): Promise<number> {
    if (!this.db) return 0;
    const rows = await listKillSwitches(this.db);
    this.state = new Map(rows.map(r => [r.target, r]));
    return rows.length;
  }

  /**
   * Activate / deactivate `target` ("client:<id>" | "mcp:<name>"). Fails closed: an activation takes
   * effect in memory first, then is persisted; if persistence throws the switch stays active for this
   * process and the caller learns it will not survive a restart.
   */
  async set(target: string, enabled: boolean, actor: string): Promise<void> {
    if (enabled) {
      if (!this.state.has(target)) {
        const rec: ActiveKillSwitch = {
          target,
          type: target.startsWith('client:') ? 'client' : 'mcp',
          activated_at: new Date().toISOString(),
          activated_by: actor,
        };
        this.state.set(target, rec);
        if (this.db) await upsertKillSwitch(this.db, rec);
      }
    } else {
      // Persist the removal first so a failed delete doesn't report a switch as cleared.
      if (this.db) await deleteKillSwitch(this.db, target);
      this.state.delete(target);
    }
  }

  isActive(type: string, target: string): boolean {
    return this.state.has(`${type}:${target}`);
  }

  /** Active switches, oldest first */
  list(): ActiveKillSwitch[] {
    return [...this.state.values()].sort((a, b) => a.activated_at.localeCompare(b.activated_at));
  }
}
