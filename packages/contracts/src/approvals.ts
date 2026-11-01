/**
 * ADR-023 Human approval gates — contracts (admin/user API on 9443, `{ ok, data }` envelope; the
 * pending tool result on the agent path).
 *
 * Admin (adminRoutes, SPA session + CSRF, never X-Admin-Key for decisions):
 *   GET  /v1/admin/mcps/:mcpId/tool-policies                  → ToolPolicy[]
 *   PUT  /v1/admin/mcps/:mcpId/tool-policies/:toolName        → body PutToolPolicyRequest → ToolPolicy
 *   PATCH /v1/admin/mcps/:mcpId/approval-default              → body SetApprovalDefaultRequest
 *   GET  /v1/admin/approvals?status=&mcp_id=&cursor=&limit=   → ApprovalListResponse
 *   GET  /v1/admin/approvals/summary                          → ApprovalQueueSummary (SPA badge)
 *   GET  /v1/admin/approvals/:approvalId                      → ApprovalRequestDetail
 *   POST /v1/admin/approvals/:approvalId/decision             → body ApprovalDecisionRequest → ApprovalRequestDetail
 * User: the same list/summary/detail/decision under /v1/users/me/approvals, limited to the user's grants.
 * Step-up: POST /v1/auth/reauth → ReauthResponse (required within 5 min for admin-approver decisions).
 *
 * Agent path: a gated call returns a tool result with `isError: true` and `structuredContent` that
 * parses as ApprovalToolResult.
 *
 * Written to be valid on zod 3 and zod 4: two-argument z.record, no nested object defaults.
 */
import { z } from 'zod';

// ===== Routes =====

export const ADMIN_MCP_TOOL_POLICIES_ROUTE = '/v1/admin/mcps/:mcpId/tool-policies';
export const ADMIN_MCP_TOOL_POLICY_ROUTE = '/v1/admin/mcps/:mcpId/tool-policies/:toolName';
export const ADMIN_MCP_APPROVAL_DEFAULT_ROUTE = '/v1/admin/mcps/:mcpId/approval-default';
export const ADMIN_APPROVALS_ROUTE = '/v1/admin/approvals';
export const ADMIN_APPROVALS_SUMMARY_ROUTE = '/v1/admin/approvals/summary';
export const ADMIN_APPROVAL_ROUTE = '/v1/admin/approvals/:approvalId';
export const ADMIN_APPROVAL_DECISION_ROUTE = '/v1/admin/approvals/:approvalId/decision';
export const USER_APPROVALS_ROUTE = '/v1/users/me/approvals';
export const USER_APPROVALS_SUMMARY_ROUTE = '/v1/users/me/approvals/summary';
export const USER_APPROVAL_ROUTE = '/v1/users/me/approvals/:approvalId';
export const USER_APPROVAL_DECISION_ROUTE = '/v1/users/me/approvals/:approvalId/decision';
export const AUTH_REAUTH_ROUTE = '/v1/auth/reauth';

// ===== Limits (ADR-023 §3, §6, §9; config may override within the bounds noted there) =====

export const APPROVAL_PENDING_TTL_SECONDS = 900;
export const APPROVAL_PENDING_TTL_MIN_SECONDS = 60;
export const APPROVAL_PENDING_TTL_MAX_SECONDS = 86400;
/** An approved request must be consumed within this long, or it expires unused. */
export const APPROVAL_APPROVED_USE_TTL_SECONDS = 600;
/** Canonical-argument cap AND preview cap (one constant): larger arguments get no approval at all. */
export const APPROVAL_PREVIEW_MAX_BYTES = 8192;
export const APPROVAL_REAUTH_WINDOW_SECONDS = 300;
/**
 * A decision that needs a fresh step-up answers HTTP 428 with this error code (not 403, which the SPA's CSRF
 * replay would hit, and not 401, which triggers the login interceptor). The SPA then asks for the password,
 * calls AUTH_REAUTH_ROUTE and retries the decision once.
 */
export const APPROVAL_REAUTH_REQUIRED_STATUS = 428;
export const APPROVAL_REAUTH_REQUIRED_CODE = 'reauth_required';
export const APPROVAL_MAX_OPEN_PER_GRANT = 5;
export const APPROVAL_MAX_OPEN_PER_USER = 20;
export const APPROVAL_CREATE_RATE_PER_GRANT_PER_MINUTE = 10;
/** Denial cooldown keyed on (grant, mcp, tool). */
export const APPROVAL_DENIAL_COOLDOWN_THRESHOLD = 3;
export const APPROVAL_DENIAL_COOLDOWN_WINDOW_SECONDS = 3600;
export const APPROVAL_DENIAL_COOLDOWN_SECONDS = 3600;
export const APPROVAL_DECISION_REASON_MAX_LENGTH = 500;
export const APPROVAL_TOOL_NAME_MAX_LENGTH = 256;
export const APPROVAL_LIST_MAX_LIMIT = 100;
export const APPROVAL_LIST_DEFAULT_LIMIT = 50;
/** `_meta` key on direct tools/call, to poll one request's status. */
export const APPROVAL_META_KEY = 'ambassador/approval_id';

// ===== Enums =====

export const APPROVERS = ['owner', 'admin'] as const;
export const approverSchema = z.enum(APPROVERS);
export type Approver = z.infer<typeof approverSchema>;

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'voided',
  'consumed',
] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Terminal states: the preview is nulled and the row is never reopened. */
export const APPROVAL_TERMINAL_STATUSES = ['denied', 'expired', 'voided', 'consumed'] as const;

export const APPROVAL_DECISIONS = ['approve', 'deny'] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Why an open request was voided (audit `approval_voided` reason). */
export const APPROVAL_VOID_REASONS = [
  'grant_revoked',
  'pin_revoked',
  'definition_changed',
  'kill_switch',
  'client_suspended',
  'user_disabled',
  'policy_removed',
] as const;
export const approvalVoidReasonSchema = z.enum(APPROVAL_VOID_REASONS);
export type ApprovalVoidReason = z.infer<typeof approvalVoidReasonSchema>;

/** Why a retry did not consume an approval (audit `approval_rejected` reason). */
export const APPROVAL_REJECT_REASONS = [
  'args_mismatch',
  'consumed',
  'expired',
  'definition_changed',
  'wrong_grant',
] as const;
export const approvalRejectReasonSchema = z.enum(APPROVAL_REJECT_REASONS);
export type ApprovalRejectReason = z.infer<typeof approvalRejectReasonSchema>;

/** Why no request could be created for a gated call. */
export const APPROVAL_UNAVAILABLE_REASONS = [
  'arguments_too_large',
  'too_many_pending',
  'rate_limited',
] as const;
export const approvalUnavailableReasonSchema = z.enum(APPROVAL_UNAVAILABLE_REASONS);
export type ApprovalUnavailableReason = z.infer<typeof approvalUnavailableReasonSchema>;

// ===== Shared field schemas =====

const toolNameSchema = z.string().min(1).max(APPROVAL_TOOL_NAME_MAX_LENGTH);
/** Lower-case hex SHA-256. */
export const approvalArgsHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().min(1).max(64);

// ===== Tool policy =====

export const toolPolicySchema = z.object({
  mcp_id: z.string().min(1),
  tool_name: toolNameSchema,
  requires_approval: z.boolean(),
  approver: approverSchema,
  updated_by: z.string().min(1),
  updated_at: isoTimestampSchema,
});
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

/** Setting `requires_approval: true` demands an explicit approver: no default, so "admin only" is never implied away. */
export const putToolPolicyRequestSchema = z
  .object({
    requires_approval: z.boolean(),
    approver: approverSchema.optional(),
  })
  .strict()
  .refine(v => !v.requires_approval || v.approver !== undefined, {
    message: 'approver is required when requires_approval is true',
    path: ['approver'],
  });
export type PutToolPolicyRequest = z.infer<typeof putToolPolicyRequestSchema>;

export const toolPolicyListResponseSchema = z.object({ policies: z.array(toolPolicySchema) });
export type ToolPolicyListResponse = z.infer<typeof toolPolicyListResponseSchema>;

/** MCP-wide default for tools first seen after it is set. */
export const setApprovalDefaultRequestSchema = z
  .object({
    default_requires_approval: z.boolean(),
    default_approver: approverSchema.optional(),
  })
  .strict()
  .refine(v => !v.default_requires_approval || v.default_approver !== undefined, {
    message: 'default_approver is required when default_requires_approval is true',
    path: ['default_approver'],
  });
export type SetApprovalDefaultRequest = z.infer<typeof setApprovalDefaultRequestSchema>;

// ===== Approval requests =====

/** List/summary row. No preview, ever: list endpoints must not carry argument text. */
export const approvalRequestSummarySchema = z.object({
  approval_id: z.string().min(1),
  status: approvalStatusSchema,
  mcp_id: z.string().min(1),
  mcp_name: z.string(),
  tool_name: toolNameSchema,
  grant_id: z.string().min(1),
  grant_label: z.string(),
  bound_client_id: z.string().nullable(),
  user_id: z.string().min(1),
  /** The approver class this request needs (snapshot of the policy at creation). */
  required_approver: approverSchema,
  args_hash: approvalArgsHashSchema,
  created_at: isoTimestampSchema,
  expires_at: isoTimestampSchema,
  decided_at: isoTimestampSchema.nullable(),
  decided_by: z.string().nullable(),
  approver_role: approverSchema.nullable(),
  self_approved: z.boolean(),
});
export type ApprovalRequestSummary = z.infer<typeof approvalRequestSummarySchema>;

export const approvalRequestDetailSchema = approvalRequestSummarySchema.extend({
  /** Sanitized, redacted argument preview; null once the request is terminal. */
  // NB: zod max() counts UTF-16 code units, which is never more than the UTF-8 byte count; the DB CHECK on
  // length(CAST(preview AS BLOB)) is the authoritative byte cap, so this is a coarse guard only.
  preview: z.string().max(APPROVAL_PREVIEW_MAX_BYTES).nullable(),
  /** The serving pin hash changed since the request was made: approving is pointless, the call will fail closed. */
  definition_changed: z.boolean(),
  /** The viewer may see this request but cannot decide it (admin-required request viewed by its owner). */
  read_only: z.boolean(),
  decision_reason: z.string().nullable(),
  void_reason: approvalVoidReasonSchema.nullable(),
});
export type ApprovalRequestDetail = z.infer<typeof approvalRequestDetailSchema>;

export const approvalListQuerySchema = z.object({
  status: approvalStatusSchema.optional(),
  mcp_id: z.string().min(1).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(APPROVAL_LIST_MAX_LIMIT).optional(),
});
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

export const approvalListResponseSchema = z.object({
  items: z.array(approvalRequestSummarySchema),
  next_cursor: z.string().nullable(),
});
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;

/** SPA nav badge. */
export const approvalQueueSummarySchema = z.object({
  pending_count: z.number().int().min(0),
});
export type ApprovalQueueSummary = z.infer<typeof approvalQueueSummarySchema>;

/** The approver approves exactly what they were shown: the hash comes from the detail they loaded. */
export const approvalDecisionRequestSchema = z
  .object({
    decision: approvalDecisionSchema,
    expected_args_hash: approvalArgsHashSchema,
    reason: z.string().max(APPROVAL_DECISION_REASON_MAX_LENGTH).optional(),
  })
  .strict();
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

// ===== Step-up reauthentication =====

export const reauthRequestSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
export type ReauthRequest = z.infer<typeof reauthRequestSchema>;

export const reauthResponseSchema = z.object({
  reauthenticated_until: isoTimestampSchema,
  window_seconds: z.number().int().positive(),
});
export type ReauthResponse = z.infer<typeof reauthResponseSchema>;

// ===== Agent-facing tool result (structuredContent of an `isError: true` result) =====

export const approvalRequiredResultSchema = z.object({
  status: z.literal('approval_required'),
  approval_id: z.string().min(1),
  expires_at: isoTimestampSchema,
  retry_after_seconds: z.number().int().min(0),
  approval_url: z.string().min(1),
});
export type ApprovalRequiredResult = z.infer<typeof approvalRequiredResultSchema>;

export const approvalDeniedResultSchema = z.object({
  status: z.literal('approval_denied'),
  /** Null under the denial cooldown, where no request was created. */
  approval_id: z.string().min(1).nullable(),
  retry_after_seconds: z.number().int().min(0),
});
export type ApprovalDeniedResult = z.infer<typeof approvalDeniedResultSchema>;

export const approvalExpiredResultSchema = z.object({
  status: z.literal('approval_expired'),
  approval_id: z.string().min(1),
});
export type ApprovalExpiredResult = z.infer<typeof approvalExpiredResultSchema>;

export const approvalUnavailableResultSchema = z.object({
  status: z.literal('approval_unavailable'),
  reason: approvalUnavailableReasonSchema,
});
export type ApprovalUnavailableResult = z.infer<typeof approvalUnavailableResultSchema>;

export const approvalToolResultSchema = z.discriminatedUnion('status', [
  approvalRequiredResultSchema,
  approvalDeniedResultSchema,
  approvalExpiredResultSchema,
  approvalUnavailableResultSchema,
]);
export type ApprovalToolResult = z.infer<typeof approvalToolResultSchema>;
