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
  TOOL_PIN_AUTO_HOLD_REJECTIONS,
  TOOL_PIN_AUTO_HOLD_WINDOW_HOURS,
  TOOL_PIN_BLOCKING_FLAG_CODES,
  TOOL_PIN_INFORMATIONAL_FLAG_CODES,
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
  getToolPinByKey,
  insertToolPin,
  listAllToolPins,
  logger,
  updateToolPin,
  updateToolPinsAtomic,
  type DatabaseClient,
  type ToolPinRecord,
} from '@mcpambassador/core';
import {
  canonicalizeToolDefinition,
  hashCanonical,
  parseToolDefinition,
  sanitizeToolNameForLog,
  snapshotProjectionHash,
} from './canonical.js';
import { hasReservedName, scanToolDefinition } from './flags.js';

const MAX_TOOL_NAME_CHARS = 512;

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
  /** D6 baseline: tool name -> snapshotProjectionHash of the publish-time snapshot entry. Present only for baseline MCPs. */
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
        // B5: a corrupt row must never fail startup; the tool is simply hidden.
        try {
          const parsed = parseToolDefinition(JSON.parse(rec.approved_definition));
          if (parsed.ok) loaded.approved = parsed.definition;
        } catch {
          logger.error(
            { mcp_id: rec.mcp_id, tool: sanitizeToolNameForLog(rec.tool_name) },
            '[tool-pins] approved_definition is not valid JSON; tool hidden'
          );
        }
      }
    }
    this.pins.set(key(rec.mcp_id, rec.scope_user_id, rec.tool_name), loaded);
  }

  /** True if any pin row exists for this (mcp, scope): the scope has been observed before. */
  hasScopeRows(mcpId: string, scopeUserId: string | null): boolean {
    const prefix = key(mcpId, scopeUserId, '');
    for (const k of this.pins.keys()) if (k.startsWith(prefix)) return true;
    return false;
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

  // ===== Admin decisions (ADR-021 §3, D4a, D6) =====

  /** Pin by id from the in-memory map (admin lookups; not on the serving path). */
  getById(pinId: string): ToolPinRecord | undefined {
    for (const l of this.pins.values()) if (l.rec.pin_id === pinId) return l.rec;
    return undefined;
  }

  /** All pins, for admin listing (filtering happens in the route). */
  allRecords(): ToolPinRecord[] {
    return [...this.pins.values()].map(l => l.rec);
  }

  /** Rejections recorded for an MCP inside the auto-hold window (derived from rows: restart-safe, self-expiring). */
  recentRejections(mcpId: string): number {
    const cutoff = Date.now() - TOOL_PIN_AUTO_HOLD_WINDOW_HOURS * 3_600_000;
    let n = 0;
    for (const l of this.pins.values()) {
      const r = l.rec;
      if (
        r.mcp_id === mcpId &&
        r.rejected_hash &&
        r.status === 'rejected' &&
        Date.parse(r.updated_at) >= cutoff
      )
        n++;
    }
    return n;
  }

  isMcpAutoHeld(mcpId: string): boolean {
    return this.recentRejections(mcpId) >= TOOL_PIN_AUTO_HOLD_REJECTIONS;
  }

  /** Approve the pending definition. `expectedHash` must equal the pin's current pending_hash. */
  async approve(
    pinId: string,
    o: {
      expectedHash: string;
      applyTo?: 'this_scope' | 'all_users';
      actor: string;
      reason?: string;
    }
  ): Promise<DecisionResult> {
    const pin = this.getById(pinId);
    if (!pin) return { ok: false, code: 'not_found' };
    if (pin.status !== 'pending_review' || !pin.pending_hash || !pin.pending_definition) {
      return { ok: false, code: 'not_pending' };
    }
    if (pin.pending_hash !== o.expectedHash) return { ok: false, code: 'stale' };
    const flags = parseFlags(pin.flags);
    const blocking = flags.codes.filter(
      c =>
        c === 'canonical_too_large' ||
        (TOOL_PIN_BLOCKING_FLAG_CODES as readonly string[]).includes(c)
    );
    if (blocking.length > 0) return { ok: false, code: 'blocked', flags: blocking };
    if (hashCanonical(pin.pending_definition) !== pin.pending_hash)
      return { ok: false, code: 'corrupt' };

    if (o.applyTo === 'all_users' && pin.scope_user_id !== null) {
      // S3: never overwrite a different pending item on the all-users pin; refuse before changing anything.
      const base = this.pins.get(key(pin.mcp_id, null, pin.tool_name))?.rec;
      if (base && base.status === 'pending_review' && base.pending_hash !== pin.pending_hash) {
        this.audit('tool_pin_baseline_conflict', {
          pin_id: pin.pin_id,
          baseline_pin_id: base.pin_id,
          mcp_id: pin.mcp_id,
          tool: sanitizeToolNameForLog(pin.tool_name),
          attempted_hash: pin.pending_hash,
          pending_hash: base.pending_hash,
          actor: o.actor,
        });
        return { ok: false, code: 'baseline_conflict' };
      }
    }

    const ts = nowIso();
    const patch: Partial<ToolPinRecord> = {
      status: 'approved',
      approved_hash: pin.pending_hash,
      approved_definition: pin.pending_definition,
      pending_hash: null,
      pending_definition: null,
      rejected_hash: null,
      approved_at: ts,
      approved_by: o.actor,
      updated_at: ts,
    };
    await updateToolPin(this.db, pin.pin_id, patch);
    this.index({ ...pin, ...patch } as ToolPinRecord);

    let baselineWritten = false;
    if (o.applyTo === 'all_users' && pin.scope_user_id !== null) {
      baselineWritten = await this.writeBaselinePin(pin, o.actor, ts);
    }
    this.audit('tool_pin_approved', {
      pin_id: pin.pin_id,
      mcp_id: pin.mcp_id,
      scope_user_id: pin.scope_user_id,
      tool: sanitizeToolNameForLog(pin.tool_name),
      old_hash: pin.approved_hash,
      new_hash: pin.pending_hash,
      apply_to: o.applyTo ?? 'this_scope',
      baseline_written: baselineWritten,
      actor: o.actor,
      reason_given: Boolean(o.reason),
    });
    return { ok: true, pin: this.getById(pin.pin_id)! };
  }

  /** D4a: copy the approved definition to the NULL-scope pin so per-user instances need no review. */
  private async writeBaselinePin(src: ToolPinRecord, actor: string, ts: string): Promise<boolean> {
    const hash = src.pending_hash!;
    const def = src.pending_definition!;
    const existing = this.pins.get(key(src.mcp_id, null, src.tool_name))?.rec;
    if (existing) {
      if (existing.approved_hash === hash) return false;
      const patch: Partial<ToolPinRecord> = {
        status: 'approved',
        approved_hash: hash,
        approved_definition: def,
        pending_hash: null,
        pending_definition: null,
        rejected_hash: null,
        approved_at: ts,
        approved_by: actor,
        updated_at: ts,
      };
      await updateToolPin(this.db, existing.pin_id, patch);
      this.index({ ...existing, ...patch } as ToolPinRecord);
      return true;
    }
    const rec: ToolPinRecord = {
      pin_id: randomUUID(),
      mcp_id: src.mcp_id,
      scope_user_id: null,
      tool_name: src.tool_name,
      status: 'approved',
      approved_hash: hash,
      approved_definition: def,
      pending_hash: null,
      pending_definition: null,
      rejected_hash: null,
      revoked_hashes: null,
      flags: src.flags,
      absent: false,
      first_seen_at: ts,
      approved_at: ts,
      approved_by: actor,
      updated_at: ts,
    };
    await insertToolPin(this.db, rec);
    this.index(rec);
    return true;
  }

  /** Reject the pending definition. The previously approved one (if any) keeps serving. */
  async reject(
    pinId: string,
    o: { expectedHash: string; actor: string; reason?: string }
  ): Promise<DecisionResult> {
    const pin = this.getById(pinId);
    if (!pin) return { ok: false, code: 'not_found' };
    if (pin.status !== 'pending_review' || !pin.pending_hash)
      return { ok: false, code: 'not_pending' };
    if (pin.pending_hash !== o.expectedHash) return { ok: false, code: 'stale' };
    const ts = nowIso();
    const patch: Partial<ToolPinRecord> = {
      status: 'rejected',
      rejected_hash: pin.pending_hash,
      pending_hash: null,
      pending_definition: null,
      updated_at: ts,
    };
    await updateToolPin(this.db, pin.pin_id, patch);
    this.index({ ...pin, ...patch } as ToolPinRecord);
    this.audit('tool_pin_rejected', {
      pin_id: pin.pin_id,
      mcp_id: pin.mcp_id,
      scope_user_id: pin.scope_user_id,
      tool: sanitizeToolNameForLog(pin.tool_name),
      rejected_hash: pin.pending_hash,
      actor: o.actor,
      reason_given: Boolean(o.reason),
    });
    if (this.recentRejections(pin.mcp_id) === TOOL_PIN_AUTO_HOLD_REJECTIONS) {
      this.audit('mcp_auto_held', {
        mcp_id: pin.mcp_id,
        rejections: TOOL_PIN_AUTO_HOLD_REJECTIONS,
        window_hours: TOOL_PIN_AUTO_HOLD_WINDOW_HOURS,
      });
      logger.warn({ mcp_id: pin.mcp_id }, '[tool-pins] MCP auto-held after repeated rejections');
    }
    return { ok: true, pin: this.getById(pin.pin_id)! };
  }

  /**
   * D7: withdraw an APPROVED definition. The tool is hidden at once (also for per-user scopes that relied on
   * a NULL-scope pin); the old hash is recorded as rejected so it is not re-raised, and a new hash goes pending.
   */
  async revoke(
    pinId: string,
    o: { expectedHash: string; actor: string; reason?: string }
  ): Promise<DecisionResult> {
    const pin = this.getById(pinId);
    if (!pin) return { ok: false, code: 'not_found' };
    if (!pin.approved_hash) return { ok: false, code: 'not_approved' };
    if (pin.approved_hash !== o.expectedHash) return { ok: false, code: 'stale' };
    const ts = nowIso();
    // R2: the hash is withdrawn EVERYWHERE: every pin of this (mcp, tool) in any scope serving the same hash.
    const targets = [...this.pins.values()]
      .map(l => l.rec)
      .filter(
        r =>
          r.pin_id === pin.pin_id ||
          (r.mcp_id === pin.mcp_id &&
            r.tool_name === pin.tool_name &&
            r.approved_hash === pin.approved_hash)
      );
    const updates = targets.map(r => {
      const revoked = parseRevoked(r.revoked_hashes);
      if (!revoked.includes(pin.approved_hash!)) revoked.push(pin.approved_hash!);
      // A queued pending item is kept (status stays pending_review); otherwise the pin is rejected.
      // rejected_hash is left alone: the revoked hash goes to revoked_hashes.
      const patch: Partial<ToolPinRecord> = {
        status: r.pending_hash ? 'pending_review' : 'rejected',
        approved_hash: null,
        approved_definition: null,
        revoked_hashes: JSON.stringify(revoked),
        updated_at: ts,
      };
      return { rec: r, patch };
    });
    await updateToolPinsAtomic(
      this.db,
      updates.map(u => ({ pinId: u.rec.pin_id, patch: u.patch }))
    );
    for (const u of updates) this.index({ ...u.rec, ...u.patch } as ToolPinRecord);
    const pinIds = updates.map(u => u.rec.pin_id);
    this.audit('tool_pin_revoked', {
      pin_id: pin.pin_id,
      pin_ids: pinIds,
      count: pinIds.length,
      mcp_id: pin.mcp_id,
      scope_user_id: pin.scope_user_id,
      tool: sanitizeToolNameForLog(pin.tool_name),
      revoked_hash: pin.approved_hash,
      previously_approved_by: pin.approved_by,
      actor: o.actor,
      reason_given: Boolean(o.reason),
    });
    return { ok: true, pin: this.getById(pin.pin_id)!, revokedPinIds: pinIds };
  }

  /** (c) True if this exact definition was rejected or revoked for the same (mcp, tool) in ANY scope. */
  private rejectedAnywhere(mcpId: string, toolName: string, hash: string): boolean {
    for (const l of this.pins.values()) {
      if (l.rec.mcp_id !== mcpId || l.rec.tool_name !== toolName) continue;
      if (l.rec.rejected_hash === hash || parseRevoked(l.rec.revoked_hashes).includes(hash))
        return true;
    }
    return false;
  }

  /** D6: a human confirms a `system:migration` baseline pin. `expectedHash` must equal approved_hash. */
  async confirmBaseline(
    pinId: string,
    o: { expectedHash: string; actor: string }
  ): Promise<DecisionResult> {
    const pin = this.getById(pinId);
    if (!pin) return { ok: false, code: 'not_found' };
    if (pin.approved_by !== SYSTEM_MIGRATION_ACTOR || !pin.approved_hash) {
      return { ok: false, code: 'not_baseline' };
    }
    if (pin.approved_hash !== o.expectedHash) return { ok: false, code: 'stale' };
    const ts = nowIso();
    const patch: Partial<ToolPinRecord> = { approved_by: o.actor, approved_at: ts, updated_at: ts };
    await updateToolPin(this.db, pin.pin_id, patch);
    this.index({ ...pin, ...patch } as ToolPinRecord);
    this.audit('tool_pin_baseline_confirmed', {
      pin_id: pin.pin_id,
      mcp_id: pin.mcp_id,
      scope_user_id: pin.scope_user_id,
      tool: sanitizeToolNameForLog(pin.tool_name),
      hash: pin.approved_hash,
      actor: o.actor,
    });
    return { ok: true, pin: this.getById(pin.pin_id)! };
  }

  /** Queue counts for the SPA badge. */
  queueSummary(): {
    pending_count: number;
    baseline_unreviewed_count: number;
    held_mcps: Array<{ mcp_id: string; scope_user_id: string | null }>;
  } {
    let pending = 0;
    let baseline = 0;
    const heldMcps = new Set<string>();
    for (const l of this.pins.values()) {
      if (l.rec.status === 'pending_review') pending++;
      if (l.rec.approved_by === SYSTEM_MIGRATION_ACTOR && l.rec.approved_hash) baseline++;
      heldMcps.add(l.rec.mcp_id);
    }
    const held = this.heldScopes();
    for (const m of heldMcps) {
      if (this.isMcpAutoHeld(m) && !held.some(h => h.mcp_id === m && h.scope_user_id === null)) {
        held.push({ mcp_id: m, scope_user_id: null });
      }
    }
    return { pending_count: pending, baseline_unreviewed_count: baseline, held_mcps: held };
  }

  /** Per-(mcp, scope) promise chain: concurrent observes of one scope run strictly in order (B2). */
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Compare live definitions with the pins for one (mcp, scope). Never throws on bad downstream data.
   * Serialized per (mcp, scope) so two overlapping discoveries cannot race on the same rows.
   */
  observe(args: ObserveArgs): Promise<ObserveSummary> {
    const k = key(args.mcpId, args.scopeUserId, '');
    const prev = this.chains.get(k) ?? Promise.resolve();
    const run = prev.then(
      () => this.observeLocked(args),
      () => this.observeLocked(args)
    );
    const tail = run.catch(() => undefined);
    this.chains.set(k, tail);
    void tail.then(() => {
      if (this.chains.get(k) === tail) this.chains.delete(k);
    });
    return run;
  }

  private async observeLocked(args: ObserveArgs): Promise<ObserveSummary> {
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
    // duplicate_name: the same name twice in one list hides BOTH (the router skips them too).
    const nameCounts = new Map<string, number>();
    for (const raw of liveTools) {
      const n = (raw as { name?: unknown } | null)?.name;
      if (typeof n === 'string') nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
    }

    for (const raw of liveTools) {
      const name = (raw as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_CHARS)
        continue;
      if (seen.has(name)) continue; // second occurrence: only the first is recorded
      seen.add(name);
      const assessed = this.assess(raw, name, (nameCounts.get(name) ?? 0) > 1);
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
        // Clean = no flag other than the explicit informational (length-only) ones.
        const clean =
          !blocking &&
          !assessed.tooLarge &&
          assessed.flags.codes.every(c =>
            (TOOL_PIN_INFORMATIONAL_FLAG_CODES as readonly string[]).includes(c)
          );
        if (
          clean &&
          !this.rejectedAnywhere(mcpId, name, assessed.hash) &&
          args.baseline.get(name) === snapshotProjectionHash(raw)
        ) {
          approve = true;
          approvedBy = SYSTEM_MIGRATION_ACTOR;
        } else if (!assessed.flags.codes.includes('baseline_mismatch')) {
          assessed.flags.codes = [...assessed.flags.codes, 'baseline_mismatch' as const].sort();
        }
      } else if (
        policy === 'auto' &&
        !blocking &&
        !assessed.tooLarge &&
        !this.rejectedAnywhere(mcpId, name, assessed.hash)
      ) {
        approve = true;
        approvedBy = SYSTEM_AUTO;
      }

      if (!approve) {
        if (
          this.held.has(scopeKey) ||
          this.recentRejections(mcpId) >= TOOL_PIN_AUTO_HOLD_REJECTIONS
        ) {
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
        revoked_hashes: null,
        flags: assessed.flags.codes.length ? JSON.stringify(assessed.flags) : null,
        absent: false,
        first_seen_at: ts,
        approved_at: approve ? ts : null,
        approved_by: approvedBy,
        updated_at: ts,
      };
      await insertToolPin(this.db, rec);
      const stored = await getToolPinByKey(this.db, mcpId, scopeUserId, name);
      if (stored && stored.pin_id !== rec.pin_id) {
        // Lost a race with another writer: adopt its row, record nothing.
        this.index(stored);
        summary.unchanged++;
        continue;
      }
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
    } else if (
      a.hash === existing.pending_hash ||
      a.hash === existing.rejected_hash ||
      parseRevoked(existing.revoked_hashes).includes(a.hash)
    ) {
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
  private assess(raw: unknown, name: string, duplicate = false): Assessed {
    const parsed = parseToolDefinition(raw);
    const flagCodes = new Set<ToolPinFlagCode>();
    let canonical: string;
    let hash: string;
    let tooLarge: boolean;
    let heuristics: ToolPinFlags | null = null;

    if (parsed.ok) {
      const c = canonicalizeToolDefinition(parsed.definition);
      // B4: a valid but oversize definition is stored as a size marker (never the unbounded text),
      // keyed by the hash of the FULL canonical text. It is flagged canonical_too_large => not approvable.
      canonical = c.tooLarge ? JSON.stringify({ truncated: true, bytes: c.bytes }) : c.canonical;
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
    if (duplicate) flagCodes.add('duplicate_name');
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

export type DecisionResult =
  | { ok: true; pin: ToolPinRecord; revokedPinIds?: string[] }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'not_pending'
        | 'stale'
        | 'blocked'
        | 'corrupt'
        | 'not_baseline'
        | 'not_approved'
        | 'baseline_conflict';
      flags?: string[];
    };

/** Hashes withdrawn by revoke (JSON array column). */
function parseRevoked(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseFlags(raw: string | null): ToolPinFlags {
  if (!raw) return { rules_version: TOOL_PIN_FLAG_RULES_VERSION, codes: [] };
  try {
    const v = JSON.parse(raw) as ToolPinFlags;
    return Array.isArray(v.codes) ? v : { rules_version: TOOL_PIN_FLAG_RULES_VERSION, codes: [] };
  } catch {
    return { rules_version: TOOL_PIN_FLAG_RULES_VERSION, codes: [] };
  }
}
