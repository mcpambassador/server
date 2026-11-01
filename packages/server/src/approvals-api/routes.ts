/**
 * Approval queue API (ADR-023): list, summary, detail and decision, for admins
 * (`/v1/admin/approvals*`) and for owners (`/v1/users/me/approvals*`).
 *
 * Every route goes through the session-only guard (no admin key, no bearer; CSRF checked there).
 * Order for a decision: session -> CSRF -> visibility (404) -> approver role (403) -> step-up (428)
 * -> atomic transition (409 on a lost race). List/summary rows never carry the argument preview;
 * only the detail of an open request does.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getAgentGrant,
  getApprovalDisplayNames,
  getApprovalRequest,
  countPendingApprovals,
  listApprovalRequests,
  type ApprovalRequestRecord,
  type DatabaseClient,
} from '@mcpambassador/core';
import {
  ADMIN_APPROVALS_ROUTE,
  ADMIN_APPROVALS_SUMMARY_ROUTE,
  ADMIN_APPROVAL_DECISION_ROUTE,
  ADMIN_APPROVAL_ROUTE,
  APPROVAL_ID_PATTERN,
  APPROVAL_LIST_DEFAULT_LIMIT,
  APPROVAL_REAUTH_REQUIRED_CODE,
  APPROVAL_REAUTH_REQUIRED_STATUS,
  USER_APPROVALS_ROUTE,
  USER_APPROVALS_SUMMARY_ROUTE,
  USER_APPROVAL_DECISION_ROUTE,
  USER_APPROVAL_ROUTE,
  approvalDecisionRequestSchema,
  approvalListQuerySchema,
  type Approver,
  type ApprovalRequestDetail,
  type ApprovalRequestSummary,
} from '@mcpambassador/contracts';
import { ErrorCodes, wrapError, wrapSuccess } from '../admin/reply-envelope.js';
import type { ApprovalService } from '../services/approvals/service.js';
import type { ToolPinService } from '../services/tool-pins/pin-service.js';
import type { StepUpStore } from '../auth/step-up.js';
import { sessionOnlyGuard } from './session-guard.js';

export interface ApprovalApiOptions {
  db: DatabaseClient;
  getApprovals: () => ApprovalService | null;
  getPins: () => ToolPinService | null;
  stepUp: StepUpStore;
}

interface ScopeDef {
  kind: 'admin' | 'user';
  /** The approver class a viewer of this scope can act as. */
  role: Approver;
  list: string;
  summary: string;
  detail: string;
  decision: string;
}

const SCOPES: ScopeDef[] = [
  {
    kind: 'admin',
    role: 'admin',
    list: ADMIN_APPROVALS_ROUTE,
    summary: ADMIN_APPROVALS_SUMMARY_ROUTE,
    detail: ADMIN_APPROVAL_ROUTE,
    decision: ADMIN_APPROVAL_DECISION_ROUTE,
  },
  {
    kind: 'user',
    role: 'owner',
    list: USER_APPROVALS_ROUTE,
    summary: USER_APPROVALS_SUMMARY_ROUTE,
    detail: USER_APPROVAL_ROUTE,
    decision: USER_APPROVAL_DECISION_ROUTE,
  },
];

const encodeCursor = (r: ApprovalRequestRecord): string =>
  Buffer.from(JSON.stringify({ c: r.created_at, i: r.approval_id })).toString('base64url');

function decodeCursor(raw: string): { createdAt: string; approvalId: string } | null {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof v.c !== 'string' || typeof v.i !== 'string') return null;
    return { createdAt: v.c, approvalId: v.i };
  } catch {
    return null;
  }
}

function toSummary(
  r: ApprovalRequestRecord,
  names: { mcpNames: Map<string, string>; grantLabels: Map<string, string> }
): ApprovalRequestSummary {
  return {
    approval_id: r.approval_id,
    status: r.status,
    mcp_id: r.mcp_id,
    mcp_name: names.mcpNames.get(r.mcp_id) ?? '',
    tool_name: r.tool_name,
    grant_id: r.grant_id,
    grant_label: names.grantLabels.get(r.grant_id) ?? '',
    bound_client_id: r.bound_client_id,
    user_id: r.user_id,
    required_approver: r.required_approver,
    args_hash: r.args_hash,
    created_at: r.created_at,
    expires_at: r.expires_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
    approver_role: r.approver_role,
    self_approved: r.self_approved,
  };
}

export async function registerApprovalApiRoutes(
  fastify: FastifyInstance,
  opts: ApprovalApiOptions
): Promise<void> {
  const { db, getApprovals, getPins, stepUp } = opts;
  const emit = (action: string, meta: Record<string, unknown>): void =>
    getApprovals()?.emit(action, meta);

  const unavailable = (reply: FastifyReply): FastifyReply =>
    reply.status(503).send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Approvals are not initialised'));
  const notFound = (reply: FastifyReply): FastifyReply =>
    reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Approval request not found'));

  async function detailOf(
    svc: ApprovalService,
    r: ApprovalRequestRecord,
    role: Approver
  ): Promise<ApprovalRequestDetail> {
    const names = await getApprovalDisplayNames(db, [r]);
    const open = r.status === 'pending' || r.status === 'approved';
    let definitionChanged = false;
    if (open && r.pin_hash !== null) {
      const pins = getPins();
      // A per-user MCP serves the user's own pin and falls back to the shared baseline; resolveApproved
      // implements exactly that. A hidden/revoked tool counts as changed.
      const cur = pins?.resolveApproved(r.mcp_id, r.user_id, r.tool_name);
      definitionChanged = pins !== null && cur?.hash !== r.pin_hash;
    }
    const effective = await svc.effectiveApprover(r);
    return {
      ...toSummary(r, names),
      // The preview is stored only while open; terminal rows already have it NULL.
      preview: open ? r.preview : null,
      definition_changed: definitionChanged,
      read_only: !open || effective !== role,
      decision_reason: r.decision_reason,
      void_reason: (r.void_reason as ApprovalRequestDetail['void_reason']) ?? null,
    };
  }

  for (const scope of SCOPES) {
    const guard = sessionOnlyGuard(fastify, {
      db,
      emit,
      requireAdmin: scope.kind === 'admin',
    });
    const principalOf = (req: FastifyRequest): { userId: string; sessionId: string } =>
      req.approvalPrincipal!;
    const visibleTo = (userId: string): { userId?: string } =>
      scope.kind === 'user' ? { userId } : {};

    async function loadVisible(
      req: FastifyRequest,
      id: string
    ): Promise<ApprovalRequestRecord | null> {
      if (!APPROVAL_ID_PATTERN.test(id)) return null;
      const r = await getApprovalRequest(db, id);
      if (!r) return null;
      if (scope.kind === 'user' && r.user_id !== principalOf(req).userId) return null;
      return r;
    }

    // GET list
    fastify.get(scope.list, { preHandler: guard }, async (request, reply) => {
      const svc = getApprovals();
      if (!svc) return unavailable(reply);
      const parsed = approvalListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid query'));
      }
      const q = parsed.data;
      const after = q.cursor ? decodeCursor(q.cursor) : null;
      if (q.cursor && !after) {
        return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid cursor'));
      }
      const limit = q.limit ?? APPROVAL_LIST_DEFAULT_LIMIT;
      const rows = await listApprovalRequests(db, {
        ...visibleTo(principalOf(request).userId),
        status: q.status,
        mcpId: q.mcp_id,
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const names = await getApprovalDisplayNames(db, page);
      return reply.send(
        wrapSuccess({
          items: page.map(r => toSummary(r, names)),
          next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
        })
      );
    });

    // GET summary (badge)
    fastify.get(scope.summary, { preHandler: guard }, async (request, reply) => {
      const svc = getApprovals();
      if (!svc) return unavailable(reply);
      const n = await countPendingApprovals(
        db,
        svc.now().toISOString(),
        visibleTo(principalOf(request).userId).userId
      );
      return reply.send(wrapSuccess({ pending_count: n }));
    });

    // GET detail
    fastify.get(scope.detail, { preHandler: guard }, async (request, reply) => {
      const svc = getApprovals();
      if (!svc) return unavailable(reply);
      const { approvalId } = request.params as { approvalId: string };
      const r = await loadVisible(request, approvalId);
      if (!r) return notFound(reply);
      return reply.send(wrapSuccess(await detailOf(svc, r, scope.role)));
    });

    // POST decision
    fastify.post(scope.decision, { preHandler: guard, bodyLimit: 4096 }, async (request, reply) => {
      const svc = getApprovals();
      if (!svc) return unavailable(reply);
      const body = approvalDecisionRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid decision'));
      }
      const { approvalId } = request.params as { approvalId: string };
      const principal = principalOf(request);

      // visibility -> 404
      const r = await loadVisible(request, approvalId);
      if (!r) return notFound(reply);

      // approver role -> 403
      const effective = await svc.effectiveApprover(r);
      if (effective !== scope.role) {
        return reply
          .status(403)
          .send(
            wrapError(
              ErrorCodes.FORBIDDEN,
              effective === 'admin'
                ? 'This request must be decided by an administrator'
                : 'This request must be decided by its owner'
            )
          );
      }

      // step-up -> 428 (admin-class decisions only; fail-closed)
      if (scope.role === 'admin' && !stepUp.isFresh(principal.sessionId)) {
        return reply
          .status(APPROVAL_REAUTH_REQUIRED_STATUS)
          .send(wrapError(APPROVAL_REAUTH_REQUIRED_CODE, 'Reauthentication required'));
      }

      const grant = await getAgentGrant(db, r.grant_id);
      if (!grant) {
        return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, 'Approval is no longer open'));
      }

      const res = await svc.decide({
        approvalId,
        decision: body.data.decision,
        expectedArgsHash: body.data.expected_args_hash,
        actorUserId: principal.userId,
        actorRole: scope.role,
        reason: body.data.reason ?? null,
        grantExpiresAt: grant.expires_at,
      });
      switch (res.kind) {
        case 'ok':
          return reply.send(wrapSuccess(await detailOf(svc, res.request, scope.role)));
        case 'not_found':
          return notFound(reply);
        case 'forbidden_role':
          return reply
            .status(403)
            .send(wrapError(ErrorCodes.FORBIDDEN, 'Not permitted to decide this request'));
        case 'self_approval_forbidden':
          return reply
            .status(403)
            .send(
              wrapError(ErrorCodes.FORBIDDEN, 'Another administrator must approve your own request')
            );
        case 'conflict':
          return reply
            .status(409)
            .send(wrapError(ErrorCodes.CONFLICT, 'Approval is no longer open'));
      }
    });
  }
}
