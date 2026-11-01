/**
 * ADR-021 Tool Definition Pinning — admin API contracts (9443, `{ ok, data }` envelope).
 *
 * GET  /v1/admin/tool-pins?status=&mcp_id=&scope_user_id=&baseline=&cursor=&limit=
 *        → paginated ToolPinSummary[]
 * GET  /v1/admin/tool-pins/:pinId           → ToolPinDetail (both definitions, for the diff view)
 * GET  /v1/admin/tool-pins/summary          → ToolPinQueueSummary (SPA badge)
 * POST /v1/admin/tool-pins/:pinId/approve   → body ToolPinDecisionRequest → ToolPinDetail
 * POST /v1/admin/tool-pins/:pinId/reject    → body ToolPinDecisionRequest → ToolPinDetail
 * POST /v1/admin/tool-pins/:pinId/confirm-baseline → ToolPinDetail (D6: human confirms a system:migration pin)
 * PATCH /v1/admin/mcps/:mcpId/pin-policy    → body { pin_policy } ; `auto` rejected (400) for registry/imported MCPs
 *
 * All routes are admin-only (adminRoutes, S4 actor). Canonicalisation: see TOOL_CANONICALIZATION and
 * fixtures/tool-definition-canonical-vectors.json.
 */
import { z } from 'zod';

// ===== Routes =====

export const ADMIN_TOOL_PINS_ROUTE = '/v1/admin/tool-pins';
export const ADMIN_TOOL_PINS_SUMMARY_ROUTE = '/v1/admin/tool-pins/summary';
export const ADMIN_TOOL_PIN_ROUTE = '/v1/admin/tool-pins/:pinId';
export const ADMIN_TOOL_PIN_APPROVE_ROUTE = '/v1/admin/tool-pins/:pinId/approve';
export const ADMIN_TOOL_PIN_REJECT_ROUTE = '/v1/admin/tool-pins/:pinId/reject';
export const ADMIN_TOOL_PIN_CONFIRM_BASELINE_ROUTE = '/v1/admin/tool-pins/:pinId/confirm-baseline';
export const ADMIN_MCP_PIN_POLICY_ROUTE = '/v1/admin/mcps/:mcpId/pin-policy';

// ===== Canonicalisation (D1) =====

export const TOOL_CANONICALIZATION = {
  algorithm: 'RFC8785-JCS',
  hash: 'sha256',
  /** Fields hashed AND served; everything else (incl. `_meta`) is stripped from the served definition. */
  hashedFields: [
    'name',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'annotations',
    'icons',
  ],
  /** Canonical UTF-8 size cap. Larger => pending_review + flag `canonical_too_large`, never auto-approved. */
  maxCanonicalBytes: 65536,
} as const;

/** Tool names in audit metadata and logs: control characters stripped, max length (D5). */
export const TOOL_NAME_LOG_MAX_LENGTH = 128;

// ===== Policy / status =====

export const PIN_POLICIES = ['review', 'auto'] as const;
export const pinPolicySchema = z.enum(PIN_POLICIES);
export type PinPolicy = z.infer<typeof pinPolicySchema>;

export const TOOL_PIN_STATUSES = ['approved', 'pending_review', 'rejected'] as const;
export const toolPinStatusSchema = z.enum(TOOL_PIN_STATUSES);
export type ToolPinStatus = z.infer<typeof toolPinStatusSchema>;

/** Reserved approver identity for the D6 one-shot baseline. */
export const SYSTEM_MIGRATION_ACTOR = 'system:migration';

/** Pending-queue flood cap, per (mcp_id, scope_user_id) (D4b). "Held" keeps serving approved defs (D4c). */
export const TOOL_PIN_MAX_PENDING_PER_SCOPE = 200;
/** Auto-hold an MCP after this many rejections within the window. */
export const TOOL_PIN_AUTO_HOLD_REJECTIONS = 5;
export const TOOL_PIN_AUTO_HOLD_WINDOW_HOURS = 24;
/** server_settings key marking the D6 baseline as done; never re-arms. */
export const TOOL_PIN_BASELINE_SETTING_KEY = 'tool_pin_baseline_done';
/** Default periodic re-discovery interval (hours), configurable. */
export const TOOL_PIN_REDISCOVERY_HOURS_DEFAULT = 6;

// ===== Heuristic flags (flag only, never decides) =====

export const TOOL_PIN_FLAG_RULES_VERSION = 1;
export const TOOL_PIN_FLAG_CODES = [
  'instruction_phrase',
  'references_other_tool_or_file',
  'hidden_unicode',
  'bidi_unicode',
  'long_description',
  'base64_blob',
  'markup',
  'canonical_too_large',
  'baseline_mismatch',
] as const;
export const toolPinFlagCodeSchema = z.enum(TOOL_PIN_FLAG_CODES);
export type ToolPinFlagCode = z.infer<typeof toolPinFlagCodeSchema>;

export const toolPinFlagsSchema = z.object({
  rules_version: z.number().int(),
  codes: z.array(toolPinFlagCodeSchema),
});
export type ToolPinFlags = z.infer<typeof toolPinFlagsSchema>;

// ===== Definition =====

/** The served/hashed tool object. Unknown fields and `_meta` are stripped, so this is strict about nothing else. */
export const toolDefinitionSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
    annotations: z.record(z.unknown()).optional(),
    icons: z.array(z.record(z.unknown())).optional(),
  })
  .strip();
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

// ===== Responses =====

export const toolPinSummarySchema = z.object({
  pin_id: z.string(),
  mcp_id: z.string(),
  mcp_name: z.string(),
  /** null = shared MCP / baseline for all users */
  scope_user_id: z.string().nullable(),
  tool_name: z.string(),
  status: toolPinStatusSchema,
  approved_hash: z.string().nullable(),
  pending_hash: z.string().nullable(),
  flags: toolPinFlagsSchema.nullable(),
  /** tool no longer reported by the downstream */
  absent: z.boolean(),
  /** approved_by === system:migration and not yet confirmed by a human (D6) */
  baseline_unreviewed: z.boolean(),
  first_seen_at: z.string(),
  approved_at: z.string().nullable(),
  approved_by: z.string().nullable(),
  updated_at: z.string(),
});
export type ToolPinSummary = z.infer<typeof toolPinSummarySchema>;

export const toolPinDetailSchema = toolPinSummarySchema.extend({
  approved_definition: toolDefinitionSchema.nullable(),
  pending_definition: toolDefinitionSchema.nullable(),
});
export type ToolPinDetail = z.infer<typeof toolPinDetailSchema>;

export const toolPinQueueSummarySchema = z.object({
  pending_count: z.number().int(),
  baseline_unreviewed_count: z.number().int(),
  held_mcps: z.array(z.object({ mcp_id: z.string(), scope_user_id: z.string().nullable() })),
});
export type ToolPinQueueSummary = z.infer<typeof toolPinQueueSummarySchema>;

// ===== Requests =====

export const toolPinListQuerySchema = z.object({
  status: toolPinStatusSchema.optional(),
  mcp_id: z.string().optional(),
  scope_user_id: z.string().optional(),
  baseline: z.enum(['unreviewed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ToolPinListQuery = z.infer<typeof toolPinListQuerySchema>;

export const toolPinDecisionRequestSchema = z.object({
  /** Must equal the pin's current pending_hash; guards against approving a definition that changed again. */
  expected_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * approve only (D4a): `all_users` writes the NULL-scope baseline pin for this MCP+tool, so per-user
   * instances with the same hash need no review. Default `this_scope`.
   */
  apply_to: z.enum(['this_scope', 'all_users']).optional(),
  reason: z.string().max(500).optional(),
});
export type ToolPinDecisionRequest = z.infer<typeof toolPinDecisionRequestSchema>;

export const setPinPolicyRequestSchema = z.object({ pin_policy: pinPolicySchema });
export type SetPinPolicyRequest = z.infer<typeof setPinPolicyRequestSchema>;

// ===== Audit =====

/** Hashes only in metadata, never definition text (ADR-021 §8). */
export const TOOL_PIN_AUDIT_ACTIONS = [
  'tool_pin_created',
  'tool_definition_changed',
  'tool_pin_approved',
  'tool_pin_rejected',
  'tool_pin_flagged',
  'tool_pin_queue_capped',
  'tool_pin_baseline_run',
  'tool_pin_baseline_confirmed',
  'mcp_pin_policy_changed',
  'mcp_auto_held',
] as const;
export type ToolPinAuditAction = (typeof TOOL_PIN_AUDIT_ACTIONS)[number];
