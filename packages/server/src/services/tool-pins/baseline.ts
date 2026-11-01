/**
 * ADR-021 D6: one-shot baseline for MCPs that exist when pinning is first enabled.
 * Recorded in server_settings (`tool_pin_baseline_done`) and never re-armed. For each recorded MCP, the
 * first observation of each (mcp, scope) compares live tools with the publish-time `tool_catalog`
 * snapshot: equal and clean => approved by `system:migration`; anything else => pending_review.
 */
import { getMcpEntryById, getServerSetting, logger, setServerSetting } from '@mcpambassador/core';
import { listMcpToolSnapshots, type DatabaseClient } from '@mcpambassador/core';
import { snapshotProjectionHash } from './canonical.js';
import type { PinAuditFn, ToolPinService } from './pin-service.js';

export const BASELINE_DONE_KEY = 'tool_pin_baseline_done';
export const BASELINE_MCPS_KEY = 'tool_pin_baseline_mcps';

export class ToolPinBaseline {
  private mcps = new Set<string>();

  constructor(
    private readonly db: DatabaseClient,
    private readonly pins: ToolPinService,
    private readonly audit: PinAuditFn = () => {}
  ) {}

  /** Arm the baseline once, ever. Safe to call on every start. */
  async init(): Promise<void> {
    if (await getServerSetting(this.db, BASELINE_DONE_KEY)) {
      try {
        const ids = JSON.parse(
          (await getServerSetting(this.db, BASELINE_MCPS_KEY)) ?? '[]'
        ) as unknown;
        if (Array.isArray(ids))
          this.mcps = new Set(ids.filter((x): x is string => typeof x === 'string'));
      } catch {
        logger.error(
          '[tool-pins] baseline MCP list unreadable; baseline disabled (tools go to review)'
        );
      }
      return;
    }
    const ids = (await listMcpToolSnapshots(this.db)).map(r => r.mcp_id);
    await setServerSetting(this.db, BASELINE_MCPS_KEY, JSON.stringify(ids), 'system');
    await setServerSetting(
      this.db,
      BASELINE_DONE_KEY,
      JSON.stringify({ at: new Date().toISOString(), mcp_count: ids.length }),
      'system'
    );
    this.mcps = new Set(ids);
    this.audit('tool_pin_baseline_run', { mcp_count: ids.length });
    logger.info({ mcp_count: ids.length }, '[tool-pins] baseline armed');
  }

  /** Snapshot hashes for the first observation of (mcp, scope), or undefined when no baseline applies. */
  async baselineFor(
    mcpId: string,
    scopeUserId: string | null
  ): Promise<Map<string, string> | undefined> {
    if (!this.mcps.has(mcpId) || this.pins.hasScopeRows(mcpId, scopeUserId)) return undefined;
    const map = new Map<string, string>();
    try {
      const entry = await getMcpEntryById(this.db, mcpId);
      const arr = JSON.parse(entry?.tool_catalog ?? '[]') as unknown;
      if (Array.isArray(arr)) {
        for (const t of arr) {
          const name = (t as { name?: unknown } | null)?.name;
          const h = snapshotProjectionHash(t);
          if (typeof name === 'string' && h) map.set(name, h);
        }
      }
    } catch {
      /* unreadable snapshot: empty map => every tool goes to review (safe) */
    }
    return map;
  }
}
