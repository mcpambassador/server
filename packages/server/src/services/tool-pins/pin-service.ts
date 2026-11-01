/**
 * ADR-021 Tool Definition Pinning: pin store + discovery comparison + serving lookup.
 *
 * - `observe()` runs at discovery/connect time (hashing happens here, never per request) and records
 *   new / changed definitions as pending_review (or auto-approves first-seen tools under pin_policy=auto).
 * - `resolveApproved()` is the O(1) in-memory lookup used by the catalog filter. It only ever returns
 *   a definition whose stored canonical JSON still hashes to the stored approved_hash.
 * - Admin decisions live in decisions added by the admin-endpoints commit; they call `refresh()`.
 */
import { randomUUID } from 'node:crypto';
import {
  TOOL_PIN_BLOCKING_FLAG_CODES,
  SYSTEM_MIGRATION_ACTOR,
  TOOL_PIN_FLAG_RULES_VERSION,
  TOOL_PIN_MAX_PENDING_PER_SCOPE,
  type PinPolicy,
  type ToolDefinition,
  type ToolPinAuditAction,
  type ToolPinFlagCode,
  type ToolPinFlags,
} from '@mcpambassador/contracts';
import {
  countPendingToolPins,
  insertToolPin,
  listAllToolPins,
  logger,
  updateToolPin,
  type DatabaseClient,
  type ToolPinRecord,
} from '@mcpambassador/core';
import {
  canonicalizeToolDefinition,
  hashCanonical,
  parseToolDefinition,
  sanitizeToolNameForLog,
} from './canonical.js';
import { hasReservedName, scanToolDefinition } from './flags.js';

export type PinAuditFn = (action: ToolPinAuditAction, metadata: Record<string, unknown>) => void;

export interface ApprovedTool {
  definition: ToolDefinition;
  hash: string;
  /** scope of the pin that was used (null = shared / all-users baseline) */
  pinScopeUserId: string | null;
}

export interface ObserveArgs {
  mcpId: string;
  /** null for a shared MCP; the user id for a per-user MCP instance */
  scopeUserId: string | null;
  /** Raw `tools/list` entries from the downstream, untrusted */
  liveTools: unknown[];
  policy: PinPolicy;
  /** D6 baseline: tool name -> hash of the publish-time snapshot. Present only for baseline MCPs. */
  baseline?: Map<string, string>;
}

export interface ObserveSummary {
  created: number;
  changed: number;
  autoApproved: number;
  unchanged: number;
  held: boolean;
}

const SYSTEM_AUTO = 'system:auto';

const key = (mcpId: string, scope: string | null, tool: string): string =>
  `${mcpId}\u0000${scope ?? ''}\u0000${tool}`;

const nowIso = (): string => new Date().toISOString();

interface Loaded {
  rec: ToolPinRecord;
  /** Present only if approved_definition re-hashes to approved_hash */
  approved?: ToolDefinition;
}

export class ToolPinService {
  private pins = new Map<string, Loaded>();
  private held = new Set<string>();
  private loaded = false;

  constructor(
    private readonly db: DatabaseClient,
    private readonly audit: PinAuditFn = () => {}
  ) {}

  /** Load all pins into memory (startup). */
  async load(): Promise<void> {
    this.pins.clear();
    for (const rec of await listAllToolPins(this.db)) this.index(rec);
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Re-index one record after a DB write (also used by admin decisions). */
  index(rec: ToolPinRecord): void {
    const loaded: Loaded = { rec };
    if (rec.approved_hash && rec.approved_definition) {
      if (hashCanonical(rec.approved_definition) !== rec.approved_hash) {
        // Tampered or corrupted row: fail closed (tool hidden), never serve it.
        logger.error(
          { mcp_id: rec.mcp_id, tool: sanitizeToolNameForLog(rec.tool_name) },
          '[tool-pins] approved_definition does not match approved_hash; tool hidden'
        );
      } else {
        const parsed = parseToolDefinition(JSON.parse(rec.approved_definition));
        if (parsed.ok) loaded.approved = parsed.definition;
      }
    }
    this.pins.set(key(rec.mcp_id, rec.scope_user_id, rec.tool_name), loaded);
  }

  getPin(mcpId: string, scopeUserId: string | null, toolName: string): ToolPinRecord | undefined {
    return this.pins.get(key(mcpId, scopeUserId, toolName))?.rec;
  }

  /** Scopes currently held by the flood cap (D4b/c). */
  heldScopes(): Array<{ mcp_id: string; scope_user_id: string | null }> {
    return [...this.held].map(k => {
      const [mcp_id, scope] = k.split('\u0000');
      return { mcp_id: mcp_id!, scope_user_id: scope ? scope : null };
    });
  }

  /**
   * The approved definition to serve for a tool, or undefined (hidden). For a per-user MCP pass the
   * user id: a user-scope pin wins; with no user-scope pin the shared (all-users) baseline applies.
   */
  resolveApproved(
    mcpId: string,
    scopeUserId: string | null,
    toolName: string
  ): ApprovedTool | undefined {
    const own = this.pins.get(key(mcpId, scopeUserId, toolName));
    if (own) {
      return own.approved && own.rec.approved_hash
        ? { definition: own.approved, hash: own.rec.approved_hash, pinScopeUserId: scopeUserId }
        : undefined;
    }
    if (scopeUserId !== null) {
      const base = this.pins.get(key(mcpId, null, toolName));
      if (base?.approved && base.rec.approved_hash) {
        return { definition: base.approved, hash: base.rec.approved_hash, pinScopeUserId: null };
      }
    }
    return undefined;
  }

  /** Compare live definitions with the pins for one (mcp, scope). Never throws on bad downstream data. */
  async observe(args: ObserveArgs): Promise<ObserveSummary> {
    const { mcpId, scopeUserId, liveTools, policy } = args;
    const summary: ObserveSummary = {
      created: 0,
      changed: 0,
      autoApproved: 0,
      unchanged: 0,
      held: false,
    };
    const seen = new Set<string>();
    const scopeKey = key(mcpId, scopeUserId, '');

    for (const raw of liveTools) {
      const name = (raw as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name.length === 0 || name.length > 512) continue;
      seen.add(name);
      const assessed = this.assess(raw, name);
      const existing = this.pins.get(key(mcpId, scopeUserId, name))?.rec;
      const logName = sanitizeToolNameForLog(name);

      if (existing) {
        await this.observeExisting(existing, assessed, mcpId, logName, summary);
        continue;
      }

      // Per-user instance whose definition equals the approved shared baseline: no row needed.
      if (scopeUserId !== null) {
        const base = this.pins.get(key(mcpId, null, name));
        if (base?.rec.approved_hash && base.rec.approved_hash === assessed.hash) {
          summary.unchanged++;
          continue;
        }
      }

      const blocking = assessed.flags.codes.some(c =>
        (TOOL_PIN_BLOCKING_FLAG_CODES as readonly string[]).includes(c)
      );
      let approve = false;
      let approvedBy: string | null = null;
      if (args.baseline !== undefined) {
        // D6: baseline MCPs are not governed by pin_policy on first observation. Equal to the
        // publish-time snapshot and clean => approved by the migration; anything else => pending.
        const clean = !blocking && !assessed.tooLarge && assessed.flags.codes.length === 0;
        if (clean && args.baseline.get(name) === assessed.hash) {
          approve = true;
          approvedBy = SYSTEM_MIGRATION_ACTOR;
        } else if (!assessed.flags.codes.includes('baseline_mismatch')) {
          assessed.flags.codes = [...assessed.flags.codes, 'baseline_mismatch' as const].sort();
        }
      } else if (policy === 'auto' && !blocking && !assessed.tooLarge) {
        approve = true;
        approvedBy = SYSTEM_AUTO;
      }

      if (!approve) {
        if (this.held.has(scopeKey)) {
          summary.held = true;
          continue; // D4c: held scopes record no new pending items
        }
        const pending = await countPendingToolPins(this.db, mcpId, scopeUserId);
        if (pending >= TOOL_PIN_MAX_PENDING_PER_SCOPE) {
          this.held.add(scopeKey);
          summary.held = true;
          this.audit('tool_pin_queue_capped', {
            mcp_id: mcpId,
            scope_user_id: scopeUserId,
            cap: TOOL_PIN_MAX_PENDING_PER_SCOPE,
          });
          logger.warn({ mcp_id: mcpId }, '[tool-pins] pending queue cap reached; scope held');
          continue;
        }
      }

      const ts = nowIso();
      const rec: ToolPinRecord = {
        pin_id: randomUUID(),
        mcp_id: mcpId,
        scope_user_id: scopeUserId,
        tool_name: name,
        status: approve ? 'approved' : 'pending_review',
        approved_hash: approve ? assessed.hash : null,
        approved_definition: approve ? assessed.canonical : null,
        pending_hash: approve ? null : assessed.hash,
        pending_definition: approve ? null : assessed.canonical,
        rejected_hash: null,
        flags: assessed.flags.codes.length ? JSON.stringify(assessed.flags) : null,
        absent: false,
        first_seen_at: ts,
        approved_at: approve ? ts : null,
        approved_by: approvedBy,
        updated_at: ts,
      };
      await insertToolPin(this.db, rec);
      this.index(rec);
      summary.created++;
      if (approve) summary.autoApproved++;
      this.audit(approve ? 'tool_pin_created' : 'tool_definition_changed', {
        mcp_id: mcpId,
        scope_user_id: scopeUserId,
        tool: logName,
        new_hash: assessed.hash,
        old_hash: null,
        approved_by: approvedBy,
        flags: assessed.flags.codes,
      });
      if (assessed.flags.codes.length) {
        this.audit('tool_pin_flagged', {
          mcp_id: mcpId,
          tool: logName,
          hash: assessed.hash,
          flags: assessed.flags.codes,
          rules_version: TOOL_PIN_FLAG_RULES_VERSION,
        });
      }
    }

    // Tools that disappeared from the downstream: keep the pin, mark absent.
    for (const [k, l] of this.pins) {
      if (l.rec.mcp_id !== mcpId || l.rec.scope_user_id !== scopeUserId) continue;
      if (seen.has(l.rec.tool_name) || l.rec.absent) continue;
      const ts = nowIso();
      await updateToolPin(this.db, l.rec.pin_id, { absent: true, updated_at: ts });
      this.pins.set(k, { ...l, rec: { ...l.rec, absent: true, updated_at: ts } });
    }

    if (this.held.has(scopeKey) && !summary.held) {
      // Queue drained below the cap: release the hold.
      if (
        (await countPendingToolPins(this.db, mcpId, scopeUserId)) < TOOL_PIN_MAX_PENDING_PER_SCOPE
      ) {
        this.held.delete(scopeKey);
      }
    }
    return summary;
  }

  private async observeExisting(
    existing: ToolPinRecord,
    a: Assessed,
    mcpId: string,
    logName: string,
    summary: ObserveSummary
  ): Promise<void> {
    const patch: Partial<ToolPinRecord> = {};
    if (existing.absent) patch.absent = false;

    if (a.hash === existing.approved_hash) {
      // Live definition is the approved one again: drop any stale pending item.
      if (existing.status !== 'approved' || existing.pending_hash) {
        Object.assign(patch, {
          status: 'approved',
          pending_hash: null,
          pending_definition: null,
        });
      }
    } else if (a.hash === existing.pending_hash || a.hash === existing.rejected_hash) {
      // Already queued, or already rejected: do not re-raise.
    } else {
      summary.changed++;
      Object.assign(patch, {
        status: 'pending_review',
        pending_hash: a.hash,
        pending_definition: a.canonical,
        flags: a.flags.codes.length ? JSON.stringify(a.flags) : null,
      });
      this.audit('tool_definition_changed', {
        mcp_id: mcpId,
        scope_user_id: existing.scope_user_id,
        tool: logName,
        old_hash: existing.approved_hash,
        new_hash: a.hash,
        flags: a.flags.codes,
      });
      if (a.flags.codes.length) {
        this.audit('tool_pin_flagged', {
          mcp_id: mcpId,
          tool: logName,
          hash: a.hash,
          flags: a.flags.codes,
          rules_version: TOOL_PIN_FLAG_RULES_VERSION,
        });
      }
    }

    if (Object.keys(patch).length === 0) {
      summary.unchanged++;
      return;
    }
    patch.updated_at = nowIso();
    await updateToolPin(this.db, existing.pin_id, patch);
    this.index({ ...existing, ...patch } as ToolPinRecord);
  }

  /** Canonical form + hash + flags for one raw downstream tool. Never throws. */
  private assess(raw: unknown, name: string): Assessed {
    const parsed = parseToolDefinition(raw);
    const flagCodes = new Set<ToolPinFlagCode>();
    let canonical: string;
    let hash: string;
    let tooLarge: boolean;
    let heuristics: ToolPinFlags | null = null;

    if (parsed.ok) {
      const c = canonicalizeToolDefinition(parsed.definition);
      canonical = c.canonical;
      hash = c.hash;
      tooLarge = c.tooLarge;
      heuristics = scanToolDefinition(parsed.definition);
    } else {
      // Not a valid definition: keep a canonical dump of the raw object so the admin can see it
      // and so repeats of the same garbage dedupe on hash. Never approvable.
      flagCodes.add('invalid_definition');
      const stripped = this.rawDump(raw);
      canonical = stripped.canonical;
      hash = stripped.hash;
      tooLarge = stripped.tooLarge;
    }
    for (const c of heuristics?.codes ?? []) flagCodes.add(c);
    if (tooLarge) flagCodes.add('canonical_too_large');
    if (hasReservedName(name)) flagCodes.add('reserved_name');
    return {
      canonical,
      hash,
      tooLarge,
      flags: { rules_version: TOOL_PIN_FLAG_RULES_VERSION, codes: [...flagCodes].sort() },
    };
  }

  private rawDump(raw: unknown): { canonical: string; hash: string; tooLarge: boolean } {
    try {
      // Reuse the canonicaliser on the loosely-typed object (it only needs JSON-serialisable data).
      const c = canonicalizeToolDefinition(raw as ToolDefinition);
      // Oversize raw dumps are replaced by a marker so we never persist unbounded downstream data.
      if (c.tooLarge) {
        const marker = JSON.stringify({ truncated: true, bytes: c.bytes });
        return { canonical: marker, hash: c.hash, tooLarge: true };
      }
      return { canonical: c.canonical, hash: c.hash, tooLarge: false };
    } catch {
      const marker = JSON.stringify({ unserialisable: true });
      return { canonical: marker, hash: hashCanonical(marker), tooLarge: false };
    }
  }
}

interface Assessed {
  canonical: string;
  hash: string;
  tooLarge: boolean;
  flags: ToolPinFlags;
}
