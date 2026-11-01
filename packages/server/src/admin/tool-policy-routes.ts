/**
 * Admin tool-policy routes (ADR-023): per-tool approval policy and the MCP-wide approval default.
 *
 * Admin authentication (X-Admin-Key or admin session) is applied by the parent plugin; changing a
 * policy is not a decision on a request, so the admin key is allowed here. The actor is audited.
 * `requires_approval: true` demands an explicit `approver` (enforced by the contract schema).
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import {
  getMcpApprovalDefault,
  getMcpEntryById,
  getToolPolicy,
  listToolPolicies,
} from '@mcpambassador/core';
import {
  ADMIN_MCP_APPROVAL_DEFAULT_ROUTE,
  ADMIN_MCP_TOOL_POLICIES_ROUTE,
  ADMIN_MCP_TOOL_POLICY_ROUTE,
  APPROVAL_TOOL_NAME_MAX_LENGTH,
  putToolPolicyRequestSchema,
  setApprovalDefaultRequestSchema,
} from '@mcpambassador/contracts';
import { adminKeyActor } from './middleware.js';
import { ErrorCodes, wrapError, wrapSuccess } from './reply-envelope.js';
import type { ApprovalService } from '../services/approvals/service.js';

export interface AdminToolPolicyRoutesConfig {
  db: DatabaseClient;
  /** null when approvals are not initialised (routes then answer 503). */
  getApprovals: () => ApprovalService | null;
}

export const registerAdminToolPolicyRoutes: FastifyPluginCallback<AdminToolPolicyRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminToolPolicyRoutesConfig,
  done
) => {
  const { db, getApprovals } = opts;

  const actorOf = (request: FastifyRequest): string =>
    adminKeyActor(request) ?? request.session?.userId ?? 'admin';

  // GET /v1/admin/mcps/:mcpId/tool-policies
  fastify.get(ADMIN_MCP_TOOL_POLICIES_ROUTE, async (request, reply) => {
    const { mcpId } = request.params as { mcpId: string };
    if (!(await getMcpEntryById(db, mcpId))) {
      return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'MCP not found'));
    }
    const def = await getMcpApprovalDefault(db, mcpId);
    return reply.send(
      wrapSuccess({
        policies: await listToolPolicies(db, mcpId),
        default_requires_approval: def?.default_requires_approval ?? false,
        default_approver: def?.default_approver ?? 'owner',
      })
    );
  });

  // PUT /v1/admin/mcps/:mcpId/tool-policies/:toolName
  fastify.put(ADMIN_MCP_TOOL_POLICY_ROUTE, async (request, reply) => {
    const svc = getApprovals();
    if (!svc) {
      return reply
        .status(503)
        .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Approvals are not initialised'));
    }
    const { mcpId, toolName } = request.params as { mcpId: string; toolName: string };
    if (toolName.length < 1 || toolName.length > APPROVAL_TOOL_NAME_MAX_LENGTH) {
      return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid tool name'));
    }
    const body = putToolPolicyRequestSchema.parse(request.body);
    if (!(await getMcpEntryById(db, mcpId))) {
      return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'MCP not found'));
    }
    await svc.setToolPolicy(mcpId, toolName, body, actorOf(request));
    return reply.send(wrapSuccess(await getToolPolicy(db, mcpId, toolName)));
  });

  // PATCH /v1/admin/mcps/:mcpId/approval-default
  fastify.patch(ADMIN_MCP_APPROVAL_DEFAULT_ROUTE, async (request, reply) => {
    const svc = getApprovals();
    if (!svc) {
      return reply
        .status(503)
        .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Approvals are not initialised'));
    }
    const { mcpId } = request.params as { mcpId: string };
    const body = setApprovalDefaultRequestSchema.parse(request.body);
    if (!(await svc.setMcpDefault(mcpId, body, actorOf(request)))) {
      return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'MCP not found'));
    }
    return reply.send(wrapSuccess(await getMcpApprovalDefault(db, mcpId)));
  });

  done();
};
