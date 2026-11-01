/**
 * Approval gate persistence (ADR-023): tool policies, MCP approval defaults, approval requests.
 *
 * Every state transition is ONE conditional UPDATE ... RETURNING: when two actors race (approve vs
 * deny, approve vs expire, approve vs void, consume vs consume, approve vs approve) the database
 * lets exactly one UPDATE match; the loser gets no row back and must answer 409. Every transition
 * out of an open state sets `preview = NULL` in the same statement (the table CHECK requires it).
 * Raw arguments are never stored. Times are ISO-8601 UTC strings (lexicographic order == time order).
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { and, desc, eq, gt, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  agent_grants,
  approval_requests,
  clients,
  mcp_catalog,
  tool_policies,
  users,
} from '../../schema/index.js';
import { compatInsert, compatSelect, compatUpdate } from '../compat.js';

export type ApproverValue = 'owner' | 'admin';
export type ApprovalStatusValue =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'voided'
  | 'consumed';

export interface ToolPolicyRecord {
  mcp_id: string;
  tool_name: string;
  requires_approval: boolean;
  approver: ApproverValue;
  updated_by: string;
  updated_at: string;
}

export interface McpApprovalDefault {
  default_requires_approval: boolean;
  default_approver: ApproverValue;
}

export interface ApprovalRequestRecord {
  approval_id: string;
  grant_id: string;
  bound_client_id: string | null;
  user_id: string;
  mcp_id: string;
  tool_name: string;
  args_hash: string;
  pin_hash: string | null;
  required_approver: ApproverValue;
  status: ApprovalStatusValue;
  preview: string | null;
  via: string | null;
  disclosure_mode: 'full' | 'progressive';
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  approver_role: ApproverValue | null;
  self_approved: boolean;
  decision_reason: string | null;
  consumed_at: string | null;
  void_reason: string | null;
}

const OPEN: ApprovalStatusValue[] = ['pending', 'approved'];

function toRequest(r: any): ApprovalRequestRecord {
  return {
    approval_id: r.approval_id,
    grant_id: r.grant_id,
    bound_client_id: r.bound_client_id ?? null,
    user_id: r.user_id,
    mcp_id: r.mcp_id,
    tool_name: r.tool_name,
    args_hash: r.args_hash,
    pin_hash: r.pin_hash ?? null,
    required_approver: r.required_approver,
    status: r.status,
    preview: r.preview ?? null,
    via: r.via ?? null,
    disclosure_mode: r.disclosure_mode,
    created_at: r.created_at,
    expires_at: r.expires_at,
    decided_at: r.decided_at ?? null,
    decided_by: r.decided_by ?? null,
    approver_role: r.approver_role ?? null,
    self_approved: Boolean(r.self_approved),
    decision_reason: r.decision_reason ?? null,
    consumed_at: r.consumed_at ?? null,
    void_reason: r.void_reason ?? null,
  };
}

// ===== Policies =====

export async function getToolPolicy(
  db: DatabaseClient,
  mcpId: string,
  toolName: string
): Promise<ToolPolicyRecord | null> {
  const [r] = (await compatSelect(db)
    .from(tool_policies)
    .where(and(eq(tool_policies.mcp_id, mcpId), eq(tool_policies.tool_name, toolName)))) as any[];
  return r ? (r as ToolPolicyRecord) : null;
}

export async function listToolPolicies(
  db: DatabaseClient,
  mcpId: string
): Promise<ToolPolicyRecord[]> {
  return (await compatSelect(db)
    .from(tool_policies)
    .where(eq(tool_policies.mcp_id, mcpId))) as ToolPolicyRecord[];
}

export async function upsertToolPolicy(db: DatabaseClient, p: ToolPolicyRecord): Promise<void> {
  await compatInsert(db, tool_policies)
    .values(p)
    .onConflictDoUpdate({
      target: [tool_policies.mcp_id, tool_policies.tool_name],
      set: {
        requires_approval: p.requires_approval,
        approver: p.approver,
        updated_by: p.updated_by,
        updated_at: p.updated_at,
      },
    });
}

export async function getMcpApprovalDefault(
  db: DatabaseClient,
  mcpId: string
): Promise<McpApprovalDefault | null> {
  const [r] = (await compatSelect(db)
    .from(mcp_catalog)
    .where(eq(mcp_catalog.mcp_id, mcpId))) as any[];
  return r
    ? {
        default_requires_approval: Boolean(r.default_requires_approval),
        default_approver: r.default_approver,
      }
    : null;
}

/** Returns false when the MCP does not exist. */
export async function setMcpApprovalDefault(
  db: DatabaseClient,
  mcpId: string,
  d: McpApprovalDefault
): Promise<boolean> {
  const rows = (await compatUpdate(db, mcp_catalog)
    .set({
      default_requires_approval: d.default_requires_approval,
      default_approver: d.default_approver,
    })
    .where(eq(mcp_catalog.mcp_id, mcpId))
    .returning({ id: mcp_catalog.mcp_id })) as any[];
  return rows.length > 0;
}

// ===== Requests: create / read =====

/**
 * Insert a pending request. The unique open-call index makes concurrent identical calls collapse:
 * `created: false` returns the already-open row for the same (grant, mcp, tool, args_hash).
 */
export async function insertApprovalRequest(
  db: DatabaseClient,
  row: ApprovalRequestRecord
): Promise<{ created: boolean; row: ApprovalRequestRecord }> {
  const ins = (await compatInsert(db, approval_requests)
    .values(row)
    .onConflictDoNothing()
    .returning()) as any[];
  if (ins.length > 0) return { created: true, row: toRequest(ins[0]) };
  const existing = await findOpenApproval(
    db,
    row.grant_id,
    row.mcp_id,
    row.tool_name,
    row.args_hash
  );
  if (!existing) throw new Error('approval insert conflicted but no open request found');
  return { created: false, row: existing };
}

export async function getApprovalRequest(
  db: DatabaseClient,
  approvalId: string
): Promise<ApprovalRequestRecord | null> {
  const [r] = (await compatSelect(db)
    .from(approval_requests)
    .where(eq(approval_requests.approval_id, approvalId))) as any[];
  return r ? toRequest(r) : null;
}

export async function findOpenApproval(
  db: DatabaseClient,
  grantId: string,
  mcpId: string,
  toolName: string,
  argsHash: string
): Promise<ApprovalRequestRecord | null> {
  const [r] = (await compatSelect(db)
    .from(approval_requests)
    .where(
      and(
        eq(approval_requests.grant_id, grantId),
        eq(approval_requests.mcp_id, mcpId),
        eq(approval_requests.tool_name, toolName),
        eq(approval_requests.args_hash, argsHash),
        inArray(approval_requests.status, OPEN)
      )
    )) as any[];
  return r ? toRequest(r) : null;
}

// ===== Requests: transitions (each exactly one winner) =====

export interface DecideInput {
  approvalId: string;
  decision: 'approve' | 'deny';
  /** The hash the approver was shown; a mismatch matches nothing. */
  expectedArgsHash: string;
  actor: string;
  actorRole: ApproverValue;
  selfApproved: boolean;
  reason?: string | null;
  now: string;
  /** New `expires_at` on approve: min(now + approved-use TTL, grant expiry), computed by the caller. */
  approvedExpiresAt?: string;
}

/**
 * pending -> approved | denied. Matches only while the request is still pending, unexpired, the hash
 * is the one the approver saw, and the grant, the requesting user and the bound client are all still
 * live (not revoked/expired/disabled/suspended) in the same statement. Returns the updated row, or null when another transition won (answer 409).
 */
export async function decideApproval(
  db: DatabaseClient,
  i: DecideInput
): Promise<ApprovalRequestRecord | null> {
  const approve = i.decision === 'approve';
  if (approve && !i.approvedExpiresAt) throw new Error('approvedExpiresAt required on approve');
  const set: Record<string, unknown> = {
    status: approve ? 'approved' : 'denied',
    decided_at: i.now,
    decided_by: i.actor,
    approver_role: i.actorRole,
    self_approved: approve ? i.selfApproved : false,
    decision_reason: i.reason ?? null,
  };
  if (approve) set.expires_at = i.approvedExpiresAt;
  else set.preview = null;
  const grantLive: SQL = sql`EXISTS (SELECT 1 FROM ${agent_grants} WHERE ${agent_grants.grant_id} = ${approval_requests.grant_id} AND ${agent_grants.revoked_at} IS NULL AND ${agent_grants.expires_at} > ${i.now})`;
  // B2c: the principals the request is bound to must all still be active in this same statement:
  // the requesting user, and the bound client (a NULL bound client never matches, so it cannot be
  // approved).
  const userActive: SQL = sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.user_id} = ${approval_requests.user_id} AND ${users.status} = 'active')`;
  const clientActive: SQL = sql`EXISTS (SELECT 1 FROM ${clients} WHERE ${clients.client_id} = ${approval_requests.bound_client_id} AND ${clients.status} = 'active')`;
  const rows = (await compatUpdate(db, approval_requests)
    .set(set)
    .where(
      and(
        eq(approval_requests.approval_id, i.approvalId),
        eq(approval_requests.status, 'pending'),
        eq(approval_requests.args_hash, i.expectedArgsHash),
        gt(approval_requests.expires_at, i.now),
        // an owner can only decide requests stored as owner-approvable; the caller enforces the
        // effective (stricter of stored and current policy) class before calling
        i.actorRole === 'owner' ? eq(approval_requests.required_approver, 'owner') : sql`1 = 1`,
        grantLive,
        userActive,
        clientActive
      )
    )
    .returning()) as any[];
  return rows.length ? toRequest(rows[0]) : null;
}

/**
 * approved -> consumed, once. Matches only an approved, unexpired row. Returns false for the loser of
 * a consume/consume race (or any row already voided/expired).
 */
export async function consumeApproval(
  db: DatabaseClient,
  approvalId: string,
  now: string
): Promise<boolean> {
  const rows = (await compatUpdate(db, approval_requests)
    .set({ status: 'consumed', consumed_at: now, preview: null })
    .where(
      and(
        eq(approval_requests.approval_id, approvalId),
        eq(approval_requests.status, 'approved'),
        gt(approval_requests.expires_at, now)
      )
    )
    .returning({ id: approval_requests.approval_id })) as any[];
  return rows.length > 0;
}

/** Void ONE open request. Returns the row, or null when it was no longer open. */
export async function voidApproval(
  db: DatabaseClient,
  approvalId: string,
  reason: string
): Promise<ApprovalRequestRecord | null> {
  const rows = (await compatUpdate(db, approval_requests)
    .set({ status: 'voided', void_reason: reason, preview: null })
    .where(
      and(eq(approval_requests.approval_id, approvalId), inArray(approval_requests.status, OPEN))
    )
    .returning()) as any[];
  return rows.length ? toRequest(rows[0]) : null;
}

export type VoidScope =
  | { grantId: string }
  | { grantIds: string[] }
  | { boundClientId: string }
  | { userId: string }
  | { mcpId: string }
  | { mcpId: string; toolName: string };

/**
 * Void every open request in a scope (grant revoked, client suspended/deleted, user deleted or
 * disabled, MCP deleted, policy removed, kill switch). Returns the voided rows so the caller audits
 * each one (`approval_voided`); nothing disappears unaudited.
 */
export async function voidOpenApprovals(
  db: DatabaseClient,
  scope: VoidScope,
  reason: string
): Promise<ApprovalRequestRecord[]> {
  const cond: SQL[] = [inArray(approval_requests.status, OPEN)];
  if ('grantId' in scope) cond.push(eq(approval_requests.grant_id, scope.grantId));
  if ('grantIds' in scope) cond.push(inArray(approval_requests.grant_id, scope.grantIds));
  if ('boundClientId' in scope)
    cond.push(eq(approval_requests.bound_client_id, scope.boundClientId));
  if ('userId' in scope) cond.push(eq(approval_requests.user_id, scope.userId));
  if ('mcpId' in scope) cond.push(eq(approval_requests.mcp_id, scope.mcpId));
  if ('toolName' in scope) cond.push(eq(approval_requests.tool_name, scope.toolName));
  const rows = (await compatUpdate(db, approval_requests)
    .set({ status: 'voided', void_reason: reason, preview: null })
    .where(and(...cond))
    .returning()) as any[];
  return rows.map(toRequest);
}

/**
 * Expire open requests whose deadline passed (pending TTL or approved-use TTL). Returns the rows
 * for auditing. Preview is nulled in the same statement.
 */
export async function expireDueApprovals(
  db: DatabaseClient,
  now: string
): Promise<ApprovalRequestRecord[]> {
  const rows = (await compatUpdate(db, approval_requests)
    .set({ status: 'expired', preview: null })
    .where(and(inArray(approval_requests.status, OPEN), lte(approval_requests.expires_at, now)))
    .returning()) as any[];
  return rows.map(toRequest);
}

/** Receives rows voided by lifecycle hooks in core (grant revoke, MCP delete, ...) so the server can audit them. */
export type ApprovalVoidObserver = (rows: ApprovalRequestRecord[], reason: string) => void;
let voidObserver: ApprovalVoidObserver | null = null;
export function setApprovalVoidObserver(fn: ApprovalVoidObserver | null): void {
  voidObserver = fn;
}

/**
 * Lifecycle hook: void open requests in a scope and report them to the observer. Never throws into
 * the caller's revoke/delete path beyond DB errors (a failed void must not be silent: it throws).
 */
export async function voidApprovalsForLifecycle(
  db: DatabaseClient,
  scope: VoidScope,
  reason: string
): Promise<number> {
  if ('grantIds' in scope && scope.grantIds.length === 0) return 0;
  const rows = await voidOpenApprovals(db, scope, reason);
  if (rows.length > 0) voidObserver?.(rows, reason);
  return rows.length;
}

// ===== Requests: caps, rate and cooldown inputs =====

export async function countOpenApprovals(
  db: DatabaseClient,
  by: { grantId: string } | { userId: string }
): Promise<number> {
  const cond =
    'grantId' in by
      ? eq(approval_requests.grant_id, by.grantId)
      : eq(approval_requests.user_id, by.userId);
  const [r] = (await compatSelect(db, { n: sql<number>`count(*)` })
    .from(approval_requests)
    .where(and(cond, inArray(approval_requests.status, OPEN)))) as any[];
  return Number(r?.n ?? 0);
}

/** Requests created by a grant since `since` (per-grant creation rate limit). */
export async function countApprovalsCreatedSince(
  db: DatabaseClient,
  grantId: string,
  since: string
): Promise<number> {
  const [r] = (await compatSelect(db, { n: sql<number>`count(*)` })
    .from(approval_requests)
    .where(
      and(eq(approval_requests.grant_id, grantId), gt(approval_requests.created_at, since))
    )) as any[];
  return Number(r?.n ?? 0);
}

/**
 * Denials of one (grant, mcp, tool) since `since`, newest first (cooldown input): the caller applies
 * the threshold and computes the cooldown end from the newest `decided_at`.
 */
export async function recentDenialTimes(
  db: DatabaseClient,
  grantId: string,
  mcpId: string,
  toolName: string,
  since: string
): Promise<string[]> {
  const rows = (await compatSelect(db, { t: approval_requests.decided_at })
    .from(approval_requests)
    .where(
      and(
        eq(approval_requests.grant_id, grantId),
        eq(approval_requests.mcp_id, mcpId),
        eq(approval_requests.tool_name, toolName),
        eq(approval_requests.status, 'denied'),
        gt(approval_requests.decided_at, since)
      )
    )) as any[];
  return rows
    .map(r => r.t as string)
    .filter(Boolean)
    .sort()
    .reverse();
}

// ===== Queue reads (admin/user approvals API) =====

export interface ApprovalListFilter {
  /** Restrict to one user's requests (the user API); omitted for the admin API. */
  userId?: string;
  status?: ApprovalStatusValue;
  mcpId?: string;
  /** Keyset cursor: rows strictly after this (created_at, approval_id) in newest-first order. */
  after?: { createdAt: string; approvalId: string } | null;
  limit: number;
}

/** Newest first. Never selects more than `limit` rows; callers ask for limit+1 to detect a next page. */
export async function listApprovalRequests(
  db: DatabaseClient,
  f: ApprovalListFilter
): Promise<ApprovalRequestRecord[]> {
  const cond: SQL[] = [];
  if (f.userId) cond.push(eq(approval_requests.user_id, f.userId));
  if (f.status) cond.push(eq(approval_requests.status, f.status));
  if (f.mcpId) cond.push(eq(approval_requests.mcp_id, f.mcpId));
  if (f.after) {
    const c = or(
      lt(approval_requests.created_at, f.after.createdAt),
      and(
        eq(approval_requests.created_at, f.after.createdAt),
        lt(approval_requests.approval_id, f.after.approvalId)
      )
    );
    if (c) cond.push(c);
  }
  const q = compatSelect(db).from(approval_requests);
  const rows = (await (cond.length ? q.where(and(...cond)) : q)
    .orderBy(desc(approval_requests.created_at), desc(approval_requests.approval_id))
    .limit(f.limit)) as any[];
  return rows.map(toRequest);
}

/** Pending requests that can still be decided (not yet past their deadline). Drives the SPA badge. */
export async function countPendingApprovals(
  db: DatabaseClient,
  now: string,
  userId?: string
): Promise<number> {
  const cond: SQL[] = [
    eq(approval_requests.status, 'pending'),
    gt(approval_requests.expires_at, now),
  ];
  if (userId) cond.push(eq(approval_requests.user_id, userId));
  const [r] = (await compatSelect(db, { n: sql<number>`count(*)` })
    .from(approval_requests)
    .where(and(...cond))) as any[];
  return Number(r?.n ?? 0);
}

/** Display names for list rows: MCP name and grant label by id (missing ids map to ''). */
export async function getApprovalDisplayNames(
  db: DatabaseClient,
  rows: ApprovalRequestRecord[]
): Promise<{ mcpNames: Map<string, string>; grantLabels: Map<string, string> }> {
  const mcpIds = [...new Set(rows.map(r => r.mcp_id))];
  const grantIds = [...new Set(rows.map(r => r.grant_id))];
  const mcpNames = new Map<string, string>();
  const grantLabels = new Map<string, string>();
  if (mcpIds.length) {
    const m = (await compatSelect(db, {
      id: mcp_catalog.mcp_id,
      name: mcp_catalog.name,
    })
      .from(mcp_catalog)
      .where(inArray(mcp_catalog.mcp_id, mcpIds))) as Array<{ id: string; name: string }>;
    for (const x of m) mcpNames.set(x.id, x.name);
  }
  if (grantIds.length) {
    const g = (await compatSelect(db, {
      id: agent_grants.grant_id,
      label: agent_grants.label,
    })
      .from(agent_grants)
      .where(inArray(agent_grants.grant_id, grantIds))) as Array<{ id: string; label: string }>;
    for (const x of g) grantLabels.set(x.id, x.label);
  }
  return { mcpNames, grantLabels };
}
