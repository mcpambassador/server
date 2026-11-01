/**
 * ApprovalService (ADR-023): policy resolution and the approval-request state machine.
 *
 * No HTTP, no pipeline here. The gate (PR-3) calls `evaluate`/`createOrFind`/`consume`; the routes
 * (PR-2) call `decide`; lifecycle hooks call `voidScope`; the reaper calls `reap`. Every transition
 * is a single conditional UPDATE in the repository, so a race has exactly one winner.
 *
 * Audit metadata carries ids and hashes only: never arguments, never the preview.
 */

import crypto from 'node:crypto';
import type { DatabaseClient, ApprovalRequestRecord, VoidScope } from '@mcpambassador/core';
import {
  consumeApproval,
  countApprovalsCreatedSince,
  countOpenApprovals,
  decideApproval,
  expireDueApprovals,
  findOpenApproval,
  getApprovalRequest,
  getMcpApprovalDefault,
  getToolPolicy,
  insertApprovalRequest,
  recentDenialTimes,
  setMcpApprovalDefault,
  upsertToolPolicy,
  voidApproval,
  voidOpenApprovals,
} from '@mcpambassador/core';
import {
  APPROVAL_APPROVED_USE_TTL_SECONDS,
  APPROVAL_CREATE_RATE_PER_GRANT_PER_MINUTE,
  APPROVAL_DENIAL_COOLDOWN_SECONDS,
  APPROVAL_DENIAL_COOLDOWN_THRESHOLD,
  APPROVAL_DENIAL_COOLDOWN_WINDOW_SECONDS,
  APPROVAL_MAX_OPEN_PER_GRANT,
  APPROVAL_MAX_OPEN_PER_USER,
  APPROVAL_PENDING_TTL_SECONDS,
  APPROVAL_PREVIEW_MAX_BYTES,
  type Approver,
  type ApprovalRejectReason,
  type ApprovalUnavailableReason,
  type ApprovalVoidReason,
} from '@mcpambassador/contracts';

export type ApprovalAuditFn = (action: string, metadata: Record<string, unknown>) => void;

export interface ApprovalServiceOptions {
  /** Reject a decision where the deciding admin owns the request (ADR-023 A2). */
  requireDistinctAdmin?: boolean;
  pendingTtlSeconds?: number;
  approvedUseTtlSeconds?: number;
  clock?: () => Date;
}

export interface EffectivePolicy {
  requires_approval: boolean;
  approver: Approver;
  source: 'tool' | 'mcp_default' | 'none';
}

export interface CreateInput {
  grantId: string;
  /** NULL means the grant has no live bound client: the caller must not create a request. */
  boundClientId: string | null;
  userId: string;
  mcpId: string;
  toolName: string;
  argsHash: string;
  pinHash: string | null;
  required: Approver;
  /** Sanitized, redacted excerpt built by the gate; stored only while the request is open. */
  preview: string;
  via: string | null;
  disclosureMode: 'full' | 'progressive';
  /** Grant expiry (ISO): the pending request never outlives it. */
  grantExpiresAt: string;
}

export type CreateResult =
  | { kind: 'created' | 'existing'; request: ApprovalRequestRecord }
  | { kind: 'cooldown'; until: string }
  | { kind: 'unavailable'; reason: ApprovalUnavailableReason };

export type DecideResult =
  | { kind: 'ok'; request: ApprovalRequestRecord }
  | { kind: 'not_found' }
  /** Viewer may see the request but is not the required class (owner on admin-required, or reverse). */
  | { kind: 'forbidden_role' }
  | { kind: 'self_approval_forbidden' }
  /** Lost a race, expired, hash differs from what the approver saw, grant gone, or already decided. */
  | { kind: 'conflict' };

export type ConsumeResult =
  | { kind: 'consumed'; request: ApprovalRequestRecord }
  | { kind: 'rejected'; reason: ApprovalRejectReason };

/** `admin` is the stricter class. */
export function stricterApprover(a: Approver, b: Approver): Approver {
  return a === 'admin' || b === 'admin' ? 'admin' : 'owner';
}

const iso = (d: Date): string => d.toISOString();

export class ApprovalService {
  private readonly clock: () => Date;
  private readonly pendingTtl: number;
  private readonly approvedTtl: number;
  private readonly requireDistinctAdmin: boolean;

  constructor(
    private readonly db: DatabaseClient,
    private readonly audit: ApprovalAuditFn = () => {},
    opts: ApprovalServiceOptions = {}
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.pendingTtl = opts.pendingTtlSeconds ?? APPROVAL_PENDING_TTL_SECONDS;
    this.approvedTtl = opts.approvedUseTtlSeconds ?? APPROVAL_APPROVED_USE_TTL_SECONDS;
    this.requireDistinctAdmin = opts.requireDistinctAdmin ?? false;
  }

  // ===== Policy =====

  /**
   * Evaluated at call time: an explicit tool row wins (including an explicit "no"); otherwise the MCP
   * default applies, so tools first seen after the default is set, and tools already discovered,
   * are gated without any rediscovery.
   */
  async evaluate(mcpId: string, toolName: string): Promise<EffectivePolicy> {
    const row = await getToolPolicy(this.db, mcpId, toolName);
    if (row) {
      return {
        requires_approval: row.requires_approval,
        approver: row.approver,
        source: 'tool',
      };
    }
    const def = await getMcpApprovalDefault(this.db, mcpId);
    if (def?.default_requires_approval) {
      return { requires_approval: true, approver: def.default_approver, source: 'mcp_default' };
    }
    return { requires_approval: false, approver: 'owner', source: 'none' };
  }

  /**
   * Set or clear a tool policy. Turning the gate off voids that tool's open requests
   * (`policy_removed`); a changed approver class is enforced at decide time (stricter wins).
   */
  async setToolPolicy(
    mcpId: string,
    toolName: string,
    p: { requires_approval: boolean; approver?: Approver },
    actor: string
  ): Promise<void> {
    const approver: Approver = p.approver ?? 'owner';
    if (p.requires_approval && !p.approver) {
      throw new Error('approver required when requires_approval is true');
    }
    await upsertToolPolicy(this.db, {
      mcp_id: mcpId,
      tool_name: toolName,
      requires_approval: p.requires_approval,
      approver,
      updated_by: actor,
      updated_at: iso(this.clock()),
    });
    this.audit('tool_policy_changed', {
      mcp_id: mcpId,
      tool_name: toolName,
      requires_approval: p.requires_approval,
      approver,
      actor,
    });
    if (!p.requires_approval) await this.voidScope({ mcpId, toolName }, 'policy_removed');
  }

  /** Returns false when the MCP does not exist. */
  async setMcpDefault(
    mcpId: string,
    d: { default_requires_approval: boolean; default_approver?: Approver },
    actor: string
  ): Promise<boolean> {
    if (d.default_requires_approval && !d.default_approver) {
      throw new Error('default_approver required when default_requires_approval is true');
    }
    const prev = await getMcpApprovalDefault(this.db, mcpId);
    const ok = await setMcpApprovalDefault(this.db, mcpId, {
      default_requires_approval: d.default_requires_approval,
      default_approver: d.default_approver ?? prev?.default_approver ?? 'owner',
    });
    if (ok) {
      this.audit('tool_policy_changed', {
        mcp_id: mcpId,
        scope: 'mcp_default',
        requires_approval: d.default_requires_approval,
        approver: d.default_approver ?? null,
        actor,
      });
    }
    return ok;
  }

  // ===== Create =====

  /**
   * Create (or return the already-open) request for a gated call. Order: dedup, cooldown, size, rate,
   * per-grant cap, per-user cap, insert. Dedup comes first so a poller retrying an identical call
   * never trips the caps; concurrent identical creates collapse on the unique open-call index.
   */
  async createOrFind(i: CreateInput): Promise<CreateResult> {
    const now = this.clock();
    const nowIso = iso(now);

    const open = await findOpenApproval(this.db, i.grantId, i.mcpId, i.toolName, i.argsHash);
    if (open) return { kind: 'existing', request: open };

    // cooldown: N denials of this (grant, mcp, tool) inside the window pause new requests
    const denials = await recentDenialTimes(
      this.db,
      i.grantId,
      i.mcpId,
      i.toolName,
      iso(new Date(now.getTime() - APPROVAL_DENIAL_COOLDOWN_WINDOW_SECONDS * 1000))
    );
    if (denials.length >= APPROVAL_DENIAL_COOLDOWN_THRESHOLD) {
      const until = new Date(
        new Date(denials[0]!).getTime() + APPROVAL_DENIAL_COOLDOWN_SECONDS * 1000
      );
      if (until.getTime() > now.getTime()) {
        this.audit('approval_cooldown_applied', {
          grant_id: i.grantId,
          mcp_id: i.mcpId,
          tool_name: i.toolName,
          until: iso(until),
        });
        return { kind: 'cooldown', until: iso(until) };
      }
    }

    if (Buffer.byteLength(i.preview, 'utf8') > APPROVAL_PREVIEW_MAX_BYTES) {
      return { kind: 'unavailable', reason: 'arguments_too_large' };
    }

    const created = await countApprovalsCreatedSince(
      this.db,
      i.grantId,
      iso(new Date(now.getTime() - 60_000))
    );
    if (created >= APPROVAL_CREATE_RATE_PER_GRANT_PER_MINUTE) {
      this.audit('approval_flood_blocked', { grant_id: i.grantId, cap: 'rate' });
      return { kind: 'unavailable', reason: 'rate_limited' };
    }
    if (
      (await countOpenApprovals(this.db, { grantId: i.grantId })) >= APPROVAL_MAX_OPEN_PER_GRANT
    ) {
      this.audit('approval_flood_blocked', { grant_id: i.grantId, cap: 'grant' });
      return { kind: 'unavailable', reason: 'too_many_pending' };
    }
    if ((await countOpenApprovals(this.db, { userId: i.userId })) >= APPROVAL_MAX_OPEN_PER_USER) {
      this.audit('approval_flood_blocked', { grant_id: i.grantId, cap: 'user' });
      return { kind: 'unavailable', reason: 'too_many_pending' };
    }

    const pendingExpiry = new Date(now.getTime() + this.pendingTtl * 1000);
    const grantExpiry = new Date(i.grantExpiresAt);
    const expires = Number.isNaN(grantExpiry.getTime())
      ? pendingExpiry
      : new Date(Math.min(pendingExpiry.getTime(), grantExpiry.getTime()));

    const res = await insertApprovalRequest(this.db, {
      approval_id: crypto.randomUUID(),
      grant_id: i.grantId,
      bound_client_id: i.boundClientId,
      user_id: i.userId,
      mcp_id: i.mcpId,
      tool_name: i.toolName,
      args_hash: i.argsHash,
      pin_hash: i.pinHash,
      required_approver: i.required,
      status: 'pending',
      preview: i.preview,
      via: i.via,
      disclosure_mode: i.disclosureMode,
      created_at: nowIso,
      expires_at: iso(expires),
      decided_at: null,
      decided_by: null,
      approver_role: null,
      self_approved: false,
      decision_reason: null,
      consumed_at: null,
      void_reason: null,
    });
    if (res.created) {
      this.audit('approval_requested', {
        approval_id: res.row.approval_id,
        grant_id: i.grantId,
        user_id: i.userId,
        mcp_id: i.mcpId,
        tool_name: i.toolName,
        args_hash: i.argsHash,
        required_approver: i.required,
      });
    }
    return { kind: res.created ? 'created' : 'existing', request: res.row };
  }

  // ===== Decide =====

  /**
   * Approve or deny. The caller has already established the credential (SPA session + CSRF), the
   * visibility of the request and, for admin-required requests, step-up. This enforces the required
   * class (stricter of the stored value and the current policy), self-approval, and the atomic
   * transition. Approve sets `expires_at = min(now + approved-use TTL, grant expiry)`.
   */
  async decide(i: {
    approvalId: string;
    decision: 'approve' | 'deny';
    expectedArgsHash: string;
    actorUserId: string;
    actorRole: Approver;
    reason?: string | null;
    grantExpiresAt: string;
  }): Promise<DecideResult> {
    const cur = await getApprovalRequest(this.db, i.approvalId);
    if (!cur) return { kind: 'not_found' };

    const policy = await this.evaluate(cur.mcp_id, cur.tool_name);
    const effective = policy.requires_approval
      ? stricterApprover(cur.required_approver, policy.approver)
      : cur.required_approver;
    if (i.actorRole !== effective) return { kind: 'forbidden_role' };

    const selfApproved = i.actorRole === 'admin' && i.actorUserId === cur.user_id;
    if (selfApproved && this.requireDistinctAdmin && i.decision === 'approve') {
      return { kind: 'self_approval_forbidden' };
    }

    const now = this.clock();
    const grantExpiry = new Date(i.grantExpiresAt).getTime();
    const useExpiry = now.getTime() + this.approvedTtl * 1000;
    const approvedExpiresAt = iso(
      new Date(Number.isNaN(grantExpiry) ? useExpiry : Math.min(useExpiry, grantExpiry))
    );

    const row = await decideApproval(this.db, {
      approvalId: i.approvalId,
      decision: i.decision,
      expectedArgsHash: i.expectedArgsHash,
      actor: i.actorUserId,
      actorRole: i.actorRole,
      selfApproved,
      reason: i.reason ?? null,
      now: iso(now),
      approvedExpiresAt,
    });
    if (!row) return { kind: 'conflict' };

    this.audit(i.decision === 'approve' ? 'approval_approved' : 'approval_denied', {
      approval_id: row.approval_id,
      grant_id: row.grant_id,
      mcp_id: row.mcp_id,
      tool_name: row.tool_name,
      args_hash: row.args_hash,
      decided_by: i.actorUserId,
      approver_role: i.actorRole,
      self_approved: row.self_approved,
    });
    return { kind: 'ok', request: row };
  }

  // ===== Consume (the retry) =====

  /**
   * Consume the approved request for an identical retry, once. The caller (gate) has re-checked the
   * pin (`currentPinHash` = `resolveApproved` result), kill switches and bound client; this
   * enforces binding (grant + exact args hash), the pin, a live bound client, and the single-use
   * transition. Any mismatch is audited as `approval_rejected` with a fixed reason.
   */
  async consume(i: {
    grantId: string;
    mcpId: string;
    toolName: string;
    argsHash: string;
    currentPinHash: string | null;
    /** The client the retry arrives through; NULL never matches. */
    callerBoundClientId: string | null;
  }): Promise<ConsumeResult> {
    const nowIso = iso(this.clock());
    const row = await findOpenApproval(this.db, i.grantId, i.mcpId, i.toolName, i.argsHash);
    if (!row || row.status !== 'approved') {
      return { kind: 'rejected', reason: 'args_mismatch' };
    }
    const reject = async (
      reason: ApprovalRejectReason,
      void_?: ApprovalVoidReason
    ): Promise<ConsumeResult> => {
      if (void_) {
        const v = await voidApproval(this.db, row.approval_id, void_);
        if (v) this.auditVoid(v, void_);
      }
      this.audit('approval_rejected', {
        approval_id: row.approval_id,
        grant_id: i.grantId,
        reason,
      });
      return { kind: 'rejected', reason };
    };

    if (row.expires_at <= nowIso) return reject('expired');
    if (
      !row.bound_client_id ||
      !i.callerBoundClientId ||
      row.bound_client_id !== i.callerBoundClientId
    ) {
      return reject('wrong_grant', 'client_suspended');
    }
    if (row.pin_hash !== i.currentPinHash)
      return reject('definition_changed', 'definition_changed');

    if (!(await consumeApproval(this.db, row.approval_id, nowIso))) {
      return { kind: 'rejected', reason: 'consumed' };
    }
    this.audit('approval_consumed', {
      approval_id: row.approval_id,
      grant_id: row.grant_id,
      mcp_id: row.mcp_id,
      tool_name: row.tool_name,
      args_hash: row.args_hash,
    });
    return { kind: 'consumed', request: { ...row, status: 'consumed', preview: null } };
  }

  // ===== Void / reap =====

  /** Void open requests in a scope and audit each; returns how many. */
  async voidScope(scope: VoidScope, reason: ApprovalVoidReason): Promise<number> {
    const rows = await voidOpenApprovals(this.db, scope, reason);
    for (const r of rows) this.auditVoid(r, reason);
    return rows.length;
  }

  /** Expire due pending/approved requests (periodic job); preview is nulled by the transition. */
  async reap(): Promise<number> {
    const rows = await expireDueApprovals(this.db, iso(this.clock()));
    for (const r of rows) {
      this.audit('approval_expired', {
        approval_id: r.approval_id,
        grant_id: r.grant_id,
        mcp_id: r.mcp_id,
        tool_name: r.tool_name,
        args_hash: r.args_hash,
      });
    }
    return rows.length;
  }

  /** Audit rows voided by core lifecycle hooks (grant revoke, user disable, MCP delete). */
  auditVoidedRows(rows: ApprovalRequestRecord[], reason: string): void {
    for (const r of rows) this.auditVoid(r, reason as ApprovalVoidReason);
  }

  private auditVoid(r: ApprovalRequestRecord, reason: ApprovalVoidReason): void {
    this.audit('approval_voided', {
      approval_id: r.approval_id,
      grant_id: r.grant_id,
      mcp_id: r.mcp_id,
      tool_name: r.tool_name,
      args_hash: r.args_hash,
      reason,
    });
  }
}
