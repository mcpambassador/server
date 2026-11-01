/**
 * ADR-021 D6/D6'': one-shot, FROZEN baseline for MCPs that exist when pinning is first enabled.
 *
 * At arming (once, ever) we record in server_settings:
 *   - `tool_pin_baseline_map`:    { mcp_id: { tool_name: projection hash } } from the publish-time snapshots
 *   - `tool_pin_baseline_scopes`: { mcp_id: [user_id, ...] } the per-user scopes that existed at that moment
 *     (the shared/NULL scope is always included)
 * and never read `mcp_catalog.tool_catalog` again for baselining (admin discover rewrites it). The first
 * observation of each recorded (mcp, scope) compares live tools with the frozen map: equal and clean =>
 * approved by `system:migration`; anything else => pending_review. Scopes created later (new users) take
 * the normal review path. A hash that was rejected/revoked anywhere is never baseline-approved
 * (enforced in the pin service).
 */
import { getServerSetting, logger, setServerSetting } from '@mcpambassador/core';
import {
  listMcpCredentialUsers,
  listMcpToolSnapshots,
  type DatabaseClient,
} from '@mcpambassador/core';
import { snapshotProjectionHash } from './canonical.js';
import type { PinAuditFn, ToolPinService } from './pin-service.js';

export const BASELINE_DONE_KEY = 'tool_pin_baseline_done';
export const BASELINE_MAP_KEY = 'tool_pin_baseline_map';
export const BASELINE_SCOPES_KEY = 'tool_pin_baseline_scopes';

type FrozenMap = Record<string, Record<string, string>>;
type FrozenScopes = Record<string, string[]>;

export class ToolPinBaseline {
  private map = new Map<string, Map<string, string>>();
  private scopes = new Map<string, Set<string>>();

  constructor(
    private readonly db: DatabaseClient,
    private readonly pins: ToolPinService,
    private readonly audit: PinAuditFn = () => {}
  ) {}

  /** Arm the baseline once, ever. Safe to call on every start. */
  async init(): Promise<void> {
    if (await getServerSetting(this.db, BASELINE_DONE_KEY)) {
      try {
        const map = JSON.parse(
          (await getServerSetting(this.db, BASELINE_MAP_KEY)) ?? 'null'
        ) as unknown;
        const scopes = JSON.parse(
          (await getServerSetting(this.db, BASELINE_SCOPES_KEY)) ?? 'null'
        ) as unknown;
        if (!isRecord(map) || !isRecord(scopes)) throw new Error('missing frozen baseline');
        for (const [mcp, tools] of Object.entries(map)) {
          if (!isRecord(tools)) continue;
          const m = new Map<string, string>();
          for (const [t, h] of Object.entries(tools)) if (typeof h === 'string') m.set(t, h);
          this.map.set(mcp, m);
        }
        for (const [mcp, ids] of Object.entries(scopes)) {
          if (Array.isArray(ids))
            this.scopes.set(mcp, new Set(ids.filter((x): x is string => typeof x === 'string')));
        }
      } catch {
        this.map.clear();
        this.scopes.clear();
        logger.error(
          '[tool-pins] frozen baseline unreadable or missing; baseline disabled (tools go to review)'
        );
      }
      return;
    }

    const map: FrozenMap = {};
    const scopes: FrozenScopes = {};
    for (const row of await listMcpToolSnapshots(this.db)) {
      const tools: Record<string, string> = {};
      try {
        const arr = JSON.parse(row.tool_catalog) as unknown;
        if (Array.isArray(arr)) {
          for (const t of arr) {
            const name = (t as { name?: unknown } | null)?.name;
            const h = snapshotProjectionHash(t);
            if (typeof name === 'string' && h) tools[name] = h;
          }
        }
      } catch {
        /* unreadable snapshot: empty map => every tool goes to review (safe) */
      }
      map[row.mcp_id] = tools;
      scopes[row.mcp_id] = [];
    }
    const addScope = (mcpId: string, userId: string | null) => {
      if (userId === null || !scopes[mcpId]) return;
      if (!scopes[mcpId]!.includes(userId)) scopes[mcpId]!.push(userId);
    };
    for (const c of await listMcpCredentialUsers(this.db)) addScope(c.mcp_id, c.user_id);
    for (const r of this.pins.allRecords()) addScope(r.mcp_id, r.scope_user_id);

    await setServerSetting(this.db, BASELINE_MAP_KEY, JSON.stringify(map), 'system');
    await setServerSetting(this.db, BASELINE_SCOPES_KEY, JSON.stringify(scopes), 'system');
    const mcpCount = Object.keys(map).length;
    await setServerSetting(
      this.db,
      BASELINE_DONE_KEY,
      JSON.stringify({ at: new Date().toISOString(), mcp_count: mcpCount }),
      'system'
    );
    for (const [mcp, tools] of Object.entries(map))
      this.map.set(mcp, new Map(Object.entries(tools)));
    for (const [mcp, ids] of Object.entries(scopes)) this.scopes.set(mcp, new Set(ids));
    this.audit('tool_pin_baseline_run', { mcp_count: mcpCount });
    logger.info({ mcp_count: mcpCount }, '[tool-pins] baseline armed and frozen');
  }

  /**
   * Frozen snapshot hashes for the first observation of (mcp, scope), or undefined when no baseline
   * applies (not recorded at arming, scope created after arming, or the scope was already observed).
   */
  baselineFor(mcpId: string, scopeUserId: string | null): Promise<Map<string, string> | undefined> {
    const frozen = this.map.get(mcpId);
    if (!frozen || this.pins.hasScopeRows(mcpId, scopeUserId)) return Promise.resolve(undefined);
    if (scopeUserId !== null && !this.scopes.get(mcpId)?.has(scopeUserId))
      return Promise.resolve(undefined);
    return Promise.resolve(new Map(frozen));
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
