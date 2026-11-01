/**
 * Admin Tool Pin Routes (ADR-021)
 *
 * Review queue for tool definitions: list, detail, approve / reject, confirm-baseline, and the
 * per-MCP pin policy. All routes require admin authentication (applied by the parent plugin).
 * Audit metadata holds hashes only, never definition text.
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { AuditProvider, DatabaseClient, ToolPinRecord } from '@mcpambassador/core';
import { getMcpEntryById, getMcpPinPolicy, setMcpPinPolicy } from '@mcpambassador/core';
import {
  ADMIN_MCP_PIN_POLICY_ROUTE,
  ADMIN_TOOL_PINS_ROUTE,
  ADMIN_TOOL_PINS_SUMMARY_ROUTE,
  ADMIN_TOOL_PIN_APPROVE_ROUTE,
  ADMIN_TOOL_PIN_CONFIRM_BASELINE_ROUTE,
  ADMIN_TOOL_PIN_REJECT_ROUTE,
  ADMIN_TOOL_PIN_REVOKE_ROUTE,
  ADMIN_TOOL_PIN_ROUTE,
  SYSTEM_MIGRATION_ACTOR,
  setPinPolicyRequestSchema,
  toolPinConfirmBaselineRequestSchema,
  toolPinDecisionRequestSchema,
  toolPinListQuerySchema,
  toolPinRevokeRequestSchema,
  type ToolPinAuditAction,
} from '@mcpambassador/contracts';
import { adminKeyActor } from './middleware.js';
import { createPaginationEnvelope } from './pagination.js';
import { ErrorCodes, wrapError, wrapSuccess } from './reply-envelope.js';
import type { ToolPinService, DecisionResult } from '../services/tool-pins/pin-service.js';
import { sanitizeToolNameForLog } from '../services/tool-pins/canonical.js';

export interface AdminToolPinRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  /** null when pinning is not initialised (routes then answer 503). */
  getPins: () => ToolPinService | null;
  /** Called after any decision or policy change so cached catalog observations are re-evaluated. */
  onChanged?: () => void;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFlags(raw: string | null): { rules_version: number; codes: string[] } | null {
  const v = parseJson(raw) as { rules_version?: number; codes?: string[] } | null;
  return v && Array.isArray(v.codes)
    ? { rules_version: v.rules_version ?? 0, codes: v.codes }
    : null;
}

export const registerAdminToolPinRoutes: FastifyPluginCallback<AdminToolPinRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminToolPinRoutesConfig,
  done
) => {
  const { db, audit, getPins, onChanged } = opts;

  const actorOf = (request: FastifyRequest): string =>
    adminKeyActor(request) ?? request.session?.userId ?? 'admin';

  const nameCache = new Map<string, string>();
  async function mcpName(mcpId: string): Promise<string> {
    const hit = nameCache.get(mcpId);
    if (hit) return hit;
    const e = await getMcpEntryById(db, mcpId);
    const name = e?.name ?? mcpId;
    if (e) nameCache.set(mcpId, name);
    return name;
  }

  async function summaryOf(r: ToolPinRecord) {
    return {
      pin_id: r.pin_id,
      mcp_id: r.mcp_id,
      mcp_name: await mcpName(r.mcp_id),
      scope_user_id: r.scope_user_id,
      tool_name: r.tool_name,
      status: r.status,
      approved_hash: r.approved_hash,
      pending_hash: r.pending_hash,
      flags: parseFlags(r.flags),
      absent: r.absent,
      baseline_unreviewed: r.approved_by === SYSTEM_MIGRATION_ACTOR && r.approved_hash !== null,
      first_seen_at: r.first_seen_at,
      approved_at: r.approved_at,
      approved_by: r.approved_by,
      updated_at: r.updated_at,
    };
  }

  async function detailOf(r: ToolPinRecord) {
    return {
      ...(await summaryOf(r)),
      approved_definition: parseJson(r.approved_definition),
      pending_definition: parseJson(r.pending_definition),
    };
  }

  async function emit(
    request: FastifyRequest,
    action: ToolPinAuditAction,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: undefined,
      source_ip: request.ip || '127.0.0.1',
      action,
      metadata,
    });
  }

  const unavailable = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(503).send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Tool pinning is not initialised'));

  function sendDecisionError(
    reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    r: Extract<DecisionResult, { ok: false }>
  ) {
    switch (r.code) {
      case 'not_found':
        return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Tool pin not found'));
      case 'not_pending':
        return reply
          .status(409)
          .send(wrapError(ErrorCodes.CONFLICT, 'Tool pin has no pending definition'));
      case 'stale':
        return reply
          .status(409)
          .send(
            wrapError(
              ErrorCodes.CONFLICT,
              'Definition changed since it was loaded; reload and review again'
            )
          );
      case 'blocked':
        return reply
          .status(409)
          .send(
            wrapError(ErrorCodes.CONFLICT, 'This definition cannot be approved', [
              { flags: r.flags ?? [] },
            ])
          );
      case 'corrupt':
        return reply
          .status(409)
          .send(wrapError(ErrorCodes.CONFLICT, 'Stored definition failed its integrity check'));
      case 'not_approved':
        return reply
          .status(409)
          .send(wrapError(ErrorCodes.CONFLICT, 'Tool pin has no approved definition to revoke'));
      case 'baseline_conflict':
        return reply
          .status(409)
          .send(
            wrapError(
              ErrorCodes.CONFLICT,
              'The all-users pin for this tool has a different pending definition; resolve that first'
            )
          );
      case 'not_baseline':
        return reply
          .status(409)
          .send(wrapError(ErrorCodes.CONFLICT, 'Tool pin is not an unconfirmed baseline pin'));
    }
  }

  // GET /v1/admin/tool-pins/summary (registered before /:pinId so it is never captured by it)
  fastify.get(ADMIN_TOOL_PINS_SUMMARY_ROUTE, async (_request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    return reply.send(wrapSuccess(pins.queueSummary()));
  });

  // GET /v1/admin/tool-pins
  fastify.get(ADMIN_TOOL_PINS_ROUTE, async (request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    const q = toolPinListQuerySchema.parse(request.query);
    const limit = q.limit ?? 50;
    const offset = q.cursor && /^\d{1,9}$/.test(q.cursor) ? Number(q.cursor) : 0;

    const rows = pins
      .allRecords()
      .filter(r => (q.status ? r.status === q.status : true))
      .filter(r => (q.mcp_id ? r.mcp_id === q.mcp_id : true))
      .filter(r =>
        q.scope === 'shared'
          ? r.scope_user_id === null
          : q.scope === 'user'
            ? r.scope_user_id !== null
            : true
      )
      .filter(r => (q.scope_user_id ? r.scope_user_id === q.scope_user_id : true))
      .filter(r =>
        q.baseline === 'unreviewed'
          ? r.approved_by === SYSTEM_MIGRATION_ACTOR && r.approved_hash !== null
          : true
      )
      // pending first, then newest activity
      .sort((a, b) =>
        a.status === b.status
          ? b.updated_at.localeCompare(a.updated_at)
          : a.status === 'pending_review'
            ? -1
            : b.status === 'pending_review'
              ? 1
              : 0
      );
    const page = rows.slice(offset, offset + limit);
    const hasMore = offset + limit < rows.length;
    return reply.send(
      createPaginationEnvelope(await Promise.all(page.map(summaryOf)), {
        has_more: hasMore,
        total_count: rows.length,
        next_cursor: hasMore ? String(offset + limit) : null,
      })
    );
  });

  // GET /v1/admin/tool-pins/:pinId
  fastify.get(ADMIN_TOOL_PIN_ROUTE, async (request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    const { pinId } = request.params as { pinId: string };
    const rec = pins.getById(pinId);
    if (!rec) return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Tool pin not found'));
    return reply.send(wrapSuccess(await detailOf(rec)));
  });

  // POST /v1/admin/tool-pins/:pinId/approve
  fastify.post(ADMIN_TOOL_PIN_APPROVE_ROUTE, async (request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    const { pinId } = request.params as { pinId: string };
    const body = toolPinDecisionRequestSchema.parse(request.body);
    const r = await pins.approve(pinId, {
      expectedHash: body.expected_hash,
      applyTo: body.apply_to,
      reason: body.reason,
      actor: actorOf(request),
    });
    if (!r.ok) return sendDecisionError(reply, r);
    onChanged?.();
    return reply.send(wrapSuccess(await detailOf(r.pin)));
  });

  // POST /v1/admin/tool-pins/:pinId/reject
  fastify.post(ADMIN_TOOL_PIN_REJECT_ROUTE, async (request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    const { pinId } = request.params as { pinId: string };
    const body = toolPinDecisionRequestSchema.parse(request.body);
    const r = await pins.reject(pinId, {
      expectedHash: body.expected_hash,
      reason: body.reason,
      actor: actorOf(request),
    });
    if (!r.ok) return sendDecisionError(reply, r);
    onChanged?.();
    return reply.send(wrapSuccess(await detailOf(r.pin)));
  });

  // POST /v1/admin/tool-pins/:pinId/revoke
  fastify.post(ADMIN_TOOL_PIN_REVOKE_ROUTE, async (request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    const { pinId } = request.params as { pinId: string };
    const body = toolPinRevokeRequestSchema.parse(request.body);
    const r = await pins.revoke(pinId, {
      expectedHash: body.expected_hash,
      reason: body.reason,
      actor: actorOf(request),
    });
    if (!r.ok) return sendDecisionError(reply, r);
    onChanged?.();
    return reply.send(wrapSuccess(await detailOf(r.pin)));
  });

  // POST /v1/admin/tool-pins/:pinId/confirm-baseline
  fastify.post(ADMIN_TOOL_PIN_CONFIRM_BASELINE_ROUTE, async (request, reply) => {
    const pins = getPins();
    if (!pins) return unavailable(reply);
    const { pinId } = request.params as { pinId: string };
    const body = toolPinConfirmBaselineRequestSchema.parse(request.body);
    const r = await pins.confirmBaseline(pinId, {
      expectedHash: body.expected_hash,
      actor: actorOf(request),
    });
    if (!r.ok) return sendDecisionError(reply, r);
    return reply.send(wrapSuccess(await detailOf(r.pin)));
  });

  // PATCH /v1/admin/mcps/:mcpId/pin-policy
  fastify.patch(ADMIN_MCP_PIN_POLICY_ROUTE, async (request, reply) => {
    const { mcpId } = request.params as { mcpId: string };
    const body = setPinPolicyRequestSchema.parse(request.body);
    const entry = await getMcpEntryById(db, mcpId);
    if (!entry) return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'MCP not found'));
    if (body.pin_policy === 'auto' && entry.origin !== 'custom') {
      return reply
        .status(400)
        .send(
          wrapError(
            ErrorCodes.BAD_REQUEST,
            "pin_policy 'auto' is only allowed for MCPs created by an admin; registry and imported MCPs always require review"
          )
        );
    }
    const previous = (await getMcpPinPolicy(db, mcpId)) ?? 'review';
    await setMcpPinPolicy(db, mcpId, body.pin_policy);
    onChanged?.();
    await emit(request, 'mcp_pin_policy_changed', {
      mcp_id: mcpId,
      mcp_name: sanitizeToolNameForLog(entry.name),
      previous,
      pin_policy: body.pin_policy,
      actor: actorOf(request),
    });
    return reply.send(wrapSuccess({ mcp_id: mcpId, pin_policy: body.pin_policy, previous }));
  });

  done();
};
