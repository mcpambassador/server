/**
 * Approval gate (ADR-023): sits in the invocation router AFTER kill switches, scope/authz and pin
 * schema checks, and immediately before the downstream call. Pure decision logic: it never talks to
 * the downstream MCP and never returns downstream-controlled text.
 *
 * Outcomes:
 *  - `proceed`: not gated, or a human-approved identical call was consumed (single use).
 *  - `blocked`: carries the agent-facing `ToolApprovalResult`. The caller turns it into a result.
 *
 * Fail closed: a gated call on a connection that cannot be approved (stdio client session, no grant)
 * is refused with `not_supported_for_client`; no request is created.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  getAgentGrant,
  getMcpEntryByName,
  redactSecretsInString,
  type DatabaseClient,
} from '@mcpambassador/core';
import {
  APPROVAL_ID_PATTERN,
  APPROVAL_PREVIEW_MAX_BYTES,
  buildApprovalUrl,
  type ApprovalToolResult,
} from '@mcpambassador/contracts';
import type { ApprovalService } from './service.js';

const canonicalizeJcs = createRequire(import.meta.url)('canonicalize') as (
  input: unknown
) => string | undefined;

/** How soon an agent should poll/retry a pending request. */
export const APPROVAL_RETRY_AFTER_SECONDS = 10;

/** Who is calling, from a validated agent session (never from request data). */
export interface GateGrantContext {
  grantId: string;
  userId: string;
  /** NULL when the grant has no live bound client: no request is created. */
  boundClientId: string | null;
  disclosureMode: 'full' | 'progressive';
  via: string | null;
  /** `_meta["ambassador/approval_id"]` supplied by the agent for status polling; validated here. */
  approvalId?: string;
}

export interface GateDeps {
  db: DatabaseClient;
  approvals: ApprovalService;
  /** Absolute base of the approval UI, from config (never the request Host). */
  uiBaseUrl: string;
}

export type GateOutcome = { proceed: true } | { proceed: false; approval: ApprovalToolResult };

const SENSITIVE_KEY =
  /token|password|passwd|secret|api_?key|credential|passphrase|bearer|authorization/i;

/** Deep copy for display with credential-looking keys and values replaced by visible markers. */
function redactForPreview(value: unknown, depth = 0): unknown {
  if (depth > 64) return '[REDACTED]';
  if (typeof value === 'string') return redactSecretsInString(value);
  if (Array.isArray(value)) return value.map(v => redactForPreview(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactForPreview(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** SHA-256 over the RFC 8785 canonical form of the exact object that will be routed. */
export function hashRoutedArguments(args: Record<string, unknown>): {
  argsHash: string;
  canonical: string;
} | null {
  const canonical = canonicalizeJcs(args);
  if (canonical === undefined) return null;
  return { argsHash: createHash('sha256').update(canonical, 'utf8').digest('hex'), canonical };
}

export async function runApprovalGate(
  deps: GateDeps,
  input: {
    /** NULL = a connection with no grant (stdio client session). */
    ctx: GateGrantContext | null;
    tool: { name: string; source_mcp: string; pinned_hash?: string | null };
    /** The exact arguments object that will be routed, after every transform. */
    args: Record<string, unknown>;
  }
): Promise<GateOutcome> {
  const { approvals } = deps;
  const mcp = await getMcpEntryByName(deps.db, input.tool.source_mcp);
  // Policies are keyed by catalog mcp_id; an MCP without a catalog row has none.
  if (!mcp) return { proceed: true };

  const policy = await approvals.evaluate(mcp.mcp_id, input.tool.name);
  if (!policy.requires_approval) return { proceed: true };

  const { ctx } = input;
  if (!ctx || !ctx.boundClientId) {
    return {
      proceed: false,
      approval: { status: 'approval_unavailable', reason: 'not_supported_for_client' },
    };
  }

  const hashed = hashRoutedArguments(input.args);
  if (!hashed || Buffer.byteLength(hashed.canonical, 'utf8') > APPROVAL_PREVIEW_MAX_BYTES) {
    return {
      proceed: false,
      approval: { status: 'approval_unavailable', reason: 'arguments_too_large' },
    };
  }
  const { argsHash } = hashed;
  // The pending request never outlives its grant; a revoked/missing grant cannot be approved against.
  const grant = await getAgentGrant(deps.db, ctx.grantId);
  if (!grant || grant.revoked_at) {
    return {
      proceed: false,
      approval: { status: 'approval_unavailable', reason: 'not_supported_for_client' },
    };
  }
  const pinHash = input.tool.pinned_hash ?? null;

  const required = (r: { approval_id: string; expires_at: string }): GateOutcome => ({
    proceed: false,
    approval: {
      status: 'approval_required',
      approval_id: r.approval_id,
      expires_at: r.expires_at,
      retry_after_seconds: APPROVAL_RETRY_AFTER_SECONDS,
      approval_url: buildApprovalUrl(deps.uiBaseUrl, r.approval_id),
    },
  });

  // Status polling by the id the agent was given: only this grant's own request, same call.
  if (ctx.approvalId && APPROVAL_ID_PATTERN.test(ctx.approvalId)) {
    const polled = await approvals.findForGrant(ctx.approvalId, ctx.grantId);
    if (
      polled &&
      polled.mcp_id === mcp.mcp_id &&
      polled.tool_name === input.tool.name &&
      polled.args_hash === argsHash
    ) {
      if (polled.status === 'denied') {
        return {
          proceed: false,
          approval: {
            status: 'approval_denied',
            approval_id: polled.approval_id,
            retry_after_seconds: 0,
          },
        };
      }
      if (polled.status === 'expired') {
        return {
          proceed: false,
          approval: { status: 'approval_expired', approval_id: polled.approval_id },
        };
      }
      if (polled.status === 'pending') return required(polled);
      // approved / consumed / voided: fall through to consume or a fresh request
    }
  }

  // A human-approved identical call: consume once, then route. Any rejection is audit-only for the
  // agent; it then gets a fresh request (or the cooldown / caps) like any other gated call.
  const consumed = await approvals.consume({
    grantId: ctx.grantId,
    mcpId: mcp.mcp_id,
    toolName: input.tool.name,
    argsHash,
    currentPinHash: pinHash,
    callerBoundClientId: ctx.boundClientId,
  });
  if (consumed.kind === 'consumed') return { proceed: true };

  const preview = canonicalizeJcs(redactForPreview(input.args)) ?? '{}';
  const created = await approvals.createOrFind({
    grantId: ctx.grantId,
    boundClientId: ctx.boundClientId,
    userId: ctx.userId,
    mcpId: mcp.mcp_id,
    toolName: input.tool.name,
    argsHash,
    pinHash,
    required: policy.approver,
    preview,
    via: ctx.via,
    disclosureMode: ctx.disclosureMode,
    grantExpiresAt: grant.expires_at,
  });
  switch (created.kind) {
    case 'created':
    case 'existing':
      return required(created.request);
    case 'cooldown':
      return {
        proceed: false,
        approval: {
          status: 'approval_denied',
          approval_id: null,
          retry_after_seconds: Math.max(
            0,
            Math.ceil((new Date(created.until).getTime() - approvals.now().getTime()) / 1000)
          ),
        },
      };
    case 'unavailable':
      return {
        proceed: false,
        approval: { status: 'approval_unavailable', reason: created.reason },
      };
  }
}
