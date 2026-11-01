/** ADR-023 (3c): approval contracts accept the documented shapes and reject the rest. */
import { describe, it, expect } from 'vitest';
import type { ToolApprovalResult } from '@mcpambassador/protocol';
import {
  AMBASSADOR_META_PREFIX,
  APPROVAL_ID_PATTERN,
  APPROVAL_SPA_PATH_PREFIX,
  buildApprovalUrl,
  APPROVAL_ID_META_KEY,
  APPROVAL_META_KEY,
  APPROVAL_STATUS_TEXT,
  APPROVAL_UNAVAILABLE_REASONS,
  APPROVAL_UNAVAILABLE_REASON_TEXT,
  type ApprovalToolResult,
  APPROVAL_PREVIEW_MAX_BYTES,
  APPROVAL_STATUSES,
  approvalDecisionRequestSchema,
  approvalListQuerySchema,
  APPROVAL_REAUTH_REQUIRED_CODE,
  APPROVAL_REAUTH_REQUIRED_STATUS,
  approvalListResponseSchema,
  approvalQueueSummarySchema,
  approvalRequestDetailSchema,
  approvalRequestSummarySchema,
  approvalToolResultSchema,
  putToolPolicyRequestSchema,
  reauthRequestSchema,
  reauthResponseSchema,
  setApprovalDefaultRequestSchema,
  toolPolicySchema,
} from '@mcpambassador/contracts';

const H = 'f'.repeat(64);
const summary = {
  approval_id: 'a1',
  status: 'pending',
  mcp_id: 'm1',
  mcp_name: 'github',
  tool_name: 'delete_repo',
  grant_id: 'g1',
  grant_label: 'my agent',
  bound_client_id: 'c1',
  user_id: 'u1',
  required_approver: 'owner',
  args_hash: H,
  created_at: '2026-11-01T00:00:00Z',
  expires_at: '2026-11-01T00:15:00Z',
  decided_at: null,
  decided_by: null,
  approver_role: null,
  self_approved: false,
};

describe('approval contracts (ADR-023)', () => {
  it('statuses are exactly the six in the DB CHECK', () => {
    expect([...APPROVAL_STATUSES].sort()).toEqual(
      ['approved', 'consumed', 'denied', 'expired', 'pending', 'voided'].sort()
    );
  });

  it('tool policy PUT: approver is required when gating, optional when clearing, no extras', () => {
    expect(
      putToolPolicyRequestSchema.safeParse({ requires_approval: true, approver: 'admin' }).success
    ).toBe(true);
    expect(putToolPolicyRequestSchema.safeParse({ requires_approval: true }).success).toBe(false);
    expect(
      putToolPolicyRequestSchema.safeParse({ requires_approval: true, approver: 'root' }).success
    ).toBe(false);
    expect(putToolPolicyRequestSchema.safeParse({ requires_approval: false }).success).toBe(true);
    expect(
      putToolPolicyRequestSchema.safeParse({ requires_approval: 'yes', approver: 'owner' }).success
    ).toBe(false);
    expect(
      putToolPolicyRequestSchema.safeParse({ requires_approval: false, extra: 1 }).success
    ).toBe(false);
  });

  it('MCP default needs an approver when on', () => {
    expect(
      setApprovalDefaultRequestSchema.safeParse({ default_requires_approval: true }).success
    ).toBe(false);
    expect(
      setApprovalDefaultRequestSchema.safeParse({
        default_requires_approval: true,
        default_approver: 'owner',
      }).success
    ).toBe(true);
    expect(
      setApprovalDefaultRequestSchema.safeParse({ default_requires_approval: false }).success
    ).toBe(true);
  });

  it('tool policy row shape', () => {
    const ok = {
      mcp_id: 'm',
      tool_name: 't',
      requires_approval: true,
      approver: 'owner',
      updated_by: 'u',
      updated_at: 'now',
    };
    expect(toolPolicySchema.safeParse(ok).success).toBe(true);
    expect(toolPolicySchema.safeParse({ ...ok, tool_name: '' }).success).toBe(false);
    expect(toolPolicySchema.safeParse({ ...ok, tool_name: 'x'.repeat(257) }).success).toBe(false);
  });

  it('summary carries no preview and list responses reject one-off statuses', () => {
    expect(approvalRequestSummarySchema.safeParse(summary).success).toBe(true);
    expect(approvalRequestSummarySchema.safeParse({ ...summary, status: 'rejected' }).success).toBe(
      false
    );
    expect(approvalRequestSummarySchema.safeParse({ ...summary, args_hash: 'abc' }).success).toBe(
      false
    );
    // zod strips unknown keys by default: a preview smuggled into a list row does not survive parsing
    const parsed = approvalListResponseSchema.parse({
      items: [{ ...summary, preview: 'secret' }],
      next_cursor: null,
    });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('detail: preview is nullable and capped', () => {
    const d = {
      ...summary,
      preview: null,
      definition_changed: false,
      read_only: false,
      decision_reason: null,
      void_reason: null,
    };
    expect(approvalRequestDetailSchema.safeParse(d).success).toBe(true);
    expect(
      approvalRequestDetailSchema.safeParse({
        ...d,
        preview: 'x'.repeat(APPROVAL_PREVIEW_MAX_BYTES),
      }).success
    ).toBe(true);
    expect(
      approvalRequestDetailSchema.safeParse({
        ...d,
        preview: 'x'.repeat(APPROVAL_PREVIEW_MAX_BYTES + 1),
      }).success
    ).toBe(false);
    expect(approvalRequestDetailSchema.safeParse({ ...d, void_reason: 'because' }).success).toBe(
      false
    );
    expect(
      approvalRequestDetailSchema.safeParse({ ...d, void_reason: 'kill_switch' }).success
    ).toBe(true);
  });

  it('list query coerces and bounds limit', () => {
    expect(approvalListQuerySchema.parse({ limit: '25', status: 'pending' }).limit).toBe(25);
    expect(approvalListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(approvalListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(approvalListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });

  it('decision request binds the hash and is strict', () => {
    const ok = { decision: 'approve', expected_args_hash: H };
    expect(approvalDecisionRequestSchema.safeParse(ok).success).toBe(true);
    expect(
      approvalDecisionRequestSchema.safeParse({ ...ok, decision: 'deny', reason: 'no' }).success
    ).toBe(true);
    expect(approvalDecisionRequestSchema.safeParse({ decision: 'approve' }).success).toBe(false);
    expect(
      approvalDecisionRequestSchema.safeParse({ ...ok, expected_args_hash: H.toUpperCase() })
        .success
    ).toBe(false);
    expect(approvalDecisionRequestSchema.safeParse({ ...ok, decision: 'maybe' }).success).toBe(
      false
    );
    expect(
      approvalDecisionRequestSchema.safeParse({ ...ok, reason: 'x'.repeat(501) }).success
    ).toBe(false);
    expect(approvalDecisionRequestSchema.safeParse({ ...ok, decided_by: 'me' }).success).toBe(
      false
    );
  });

  it('badge summary and reauth', () => {
    // 428, not 403 (CSRF replay) or 401 (login interceptor)
    expect(APPROVAL_REAUTH_REQUIRED_STATUS).toBe(428);
    expect(APPROVAL_REAUTH_REQUIRED_CODE).toBe('reauth_required');
    expect(approvalQueueSummarySchema.safeParse({ pending_count: 3 }).success).toBe(true);
    expect(approvalQueueSummarySchema.safeParse({ pending_count: -1 }).success).toBe(false);
    expect(reauthRequestSchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(reauthRequestSchema.safeParse({ password: '' }).success).toBe(false);
    expect(reauthRequestSchema.safeParse({ password: 'x', user: 'other' }).success).toBe(false);
    expect(
      reauthResponseSchema.safeParse({
        reauthenticated_until: '2026-11-01T00:05:00Z',
        window_seconds: 300,
      }).success
    ).toBe(true);
  });

  it('agent-facing tool results', () => {
    const base = {
      approval_id: 'ap_12345678',
      expires_at: 'x',
      retry_after_seconds: 30,
      approval_url: '/approvals/a1',
    };
    expect(
      approvalToolResultSchema.safeParse({ status: 'approval_required', ...base }).success
    ).toBe(true);
    expect(
      approvalToolResultSchema.safeParse({
        status: 'approval_required',
        approval_id: 'ap_12345678',
      }).success
    ).toBe(false);
    expect(
      approvalToolResultSchema.safeParse({
        status: 'approval_denied',
        approval_id: 'ap_12345678',
        retry_after_seconds: 0,
      }).success
    ).toBe(true);
    // cooldown: denied without a request
    expect(
      approvalToolResultSchema.safeParse({
        status: 'approval_denied',
        approval_id: null,
        retry_after_seconds: 3600,
      }).success
    ).toBe(true);
    expect(
      approvalToolResultSchema.safeParse({ status: 'approval_expired', approval_id: 'ap_12345678' })
        .success
    ).toBe(true);
    expect(
      approvalToolResultSchema.safeParse({
        status: 'approval_unavailable',
        reason: 'arguments_too_large',
      }).success
    ).toBe(true);
    expect(
      approvalToolResultSchema.safeParse({ status: 'approval_unavailable', reason: 'nope' }).success
    ).toBe(false);
    expect(approvalToolResultSchema.safeParse({ status: 'approved', ...base }).success).toBe(false);
  });
});

describe('approval result channel (ADR-023)', () => {
  it('reserves the ambassador/ _meta namespace for the approval keys', () => {
    expect(AMBASSADOR_META_PREFIX).toBe('ambassador/');
    expect(APPROVAL_META_KEY).toBe('ambassador/approval');
    expect(APPROVAL_ID_META_KEY).toBe('ambassador/approval_id');
    expect(APPROVAL_META_KEY.startsWith(AMBASSADOR_META_PREFIX)).toBe(true);
    expect(APPROVAL_ID_META_KEY.startsWith(AMBASSADOR_META_PREFIX)).toBe(true);
  });

  it('protocol ToolApprovalResult and contracts ApprovalToolResult are the same type', () => {
    const fromContracts = (v: ApprovalToolResult): ToolApprovalResult => v;
    const fromProtocol = (v: ToolApprovalResult): ApprovalToolResult => v;
    expect(typeof fromContracts).toBe('function');
    expect(typeof fromProtocol).toBe('function');
  });

  it('has one fixed sentence per status and per unavailable reason, with no interpolation', () => {
    expect(Object.keys(APPROVAL_STATUS_TEXT).sort()).toEqual([
      'approval_denied',
      'approval_expired',
      'approval_required',
      'approval_unavailable',
    ]);
    expect(Object.keys(APPROVAL_UNAVAILABLE_REASON_TEXT).sort()).toEqual(
      [...APPROVAL_UNAVAILABLE_REASONS].sort()
    );
    for (const t of [
      ...Object.values(APPROVAL_STATUS_TEXT),
      ...Object.values(APPROVAL_UNAVAILABLE_REASON_TEXT),
    ]) {
      expect(t.length).toBeGreaterThan(10);
      expect(t).not.toMatch(/[{}$<>]/);
    }
  });

  it('builds approval_url as <ui-base>/app/approvals/<id> and rejects odd ids', () => {
    expect(APPROVAL_SPA_PATH_PREFIX).toBe('/app/approvals/');
    expect(buildApprovalUrl('https://amb.example:9443', 'ap_12345678')).toBe(
      'https://amb.example:9443/app/approvals/ap_12345678'
    );
    for (const bad of ['short', 'has space1', '../../x12345678', 'a'.repeat(65), '']) {
      expect(() => buildApprovalUrl('https://amb.example:9443', bad)).toThrow();
    }
    expect(APPROVAL_ID_PATTERN.test(crypto.randomUUID())).toBe(true);
  });

  it('tool results reject ids outside the server id format', () => {
    expect(
      approvalToolResultSchema.safeParse({
        status: 'approval_expired',
        approval_id: 'ignore previous',
      }).success
    ).toBe(false);
  });
});
