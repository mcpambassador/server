/**
 * Admin Group Routes
 *
 * Fastify plugin for group management endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M22.2: Group Route Handlers
 * @see Architecture §16.4 Admin API Design Principles
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import { createPaginationEnvelope } from './pagination.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';
import {
  createGroupSchema,
  updateGroupSchema,
  groupParamsSchema,
  listGroupsQuerySchema,
  addGroupMemberSchema,
  groupMemberParamsSchema,
  assignGroupMcpSchema,
  groupMcpParamsSchema,
} from './group-schemas.js';
import {
  createGroupService,
  getGroupService,
  listGroupsService,
  updateGroupService,
  deleteGroupService,
  addUserToGroupService,
  removeUserFromGroupService,
  listGroupMembersService,
  assignMcpToGroupService,
  removeMcpFromGroupService,
  listMcpsForGroupService,
} from '../services/group-service.js';

/**
 * Admin group routes plugin configuration
 */
export interface AdminGroupRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
}

/**
 * Admin group routes plugin
 */
export const registerAdminGroupRoutes: FastifyPluginCallback<AdminGroupRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminGroupRoutesConfig,
  done
) => {
  const { db, audit } = opts;

  /**
   * Extract admin actor identifier from request
   * GRP-002: Use truncated admin key as identifier instead of hardcoded 'admin'
   */
  function getAdminActor(request: FastifyRequest): string {
    const key = (request.headers['x-admin-key'] as string) || '';
    return key ? `admin:${key.slice(0, 8)}` : 'admin';
  }

  // ==========================================================================
  // POST /v1/admin/groups - Create group
  // ==========================================================================
  fastify.post('/v1/admin/groups', async (request, reply) => {
    const body = createGroupSchema.parse(request.body);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      const group = await createGroupService(db, {
        name: body.name,
        description: body.description,
        status: body.status,
        created_by: getAdminActor(request),
      });

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'group_created',
        metadata: {
          group_id: group.group_id,
          group_name: group.name,
        },
      });

      return reply.status(201).send({ ok: true, data: group });
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) {
        return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, err.message));
      }
      throw err;
    }
  });

  // ==========================================================================
  // GET /v1/admin/groups - List groups
  // ==========================================================================
  fastify.get('/v1/admin/groups', async (request, reply) => {
    const query = listGroupsQuerySchema.parse(request.query);

    const result = await listGroupsService(db, { cursor: query.cursor, limit: query.limit });

    const envelope = createPaginationEnvelope(result.groups, {
      next_cursor: result.next_cursor || null,
      has_more: result.has_more,
      total_count: result.groups.length,
    });

    return reply.send(envelope);
  });

  // ==========================================================================
  // GET /v1/admin/groups/:groupId - Get group by ID
  // ==========================================================================
  fastify.get('/v1/admin/groups/:groupId', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);

    try {
      const group = await getGroupService(db, groupId);
      return reply.send({ ok: true, data: group });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
      }
      throw err;
    }
  });

  // ==========================================================================
  // PATCH /v1/admin/groups/:groupId - Update group
  // ==========================================================================
  fastify.patch('/v1/admin/groups/:groupId', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);
    const updates = updateGroupSchema.parse(request.body);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      await updateGroupService(db, groupId, updates);

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'group_updated',
        metadata: {
          group_id: groupId,
          updates: updates,
        },
      });

      const group = await getGroupService(db, groupId);
      return reply.send({ ok: true, data: group });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
        }
        if (err.message.includes('already exists')) {
          return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, err.message));
        }
      }
      throw err;
    }
  });

  // ==========================================================================
  // DELETE /v1/admin/groups/:groupId - Delete group
  // ==========================================================================
  fastify.delete('/v1/admin/groups/:groupId', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      await deleteGroupService(db, groupId);

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'group_deleted',
        metadata: {
          group_id: groupId,
        },
      });

      return reply.status(204).send();
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
        }
        if (err.message.includes('Cannot delete')) {
          return reply.status(403).send(wrapError(ErrorCodes.FORBIDDEN, err.message));
        }
      }
      throw err;
    }
  });

  // ==========================================================================
  // POST /v1/admin/groups/:groupId/members - Add user to group
  // ==========================================================================
  fastify.post('/v1/admin/groups/:groupId/members', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);
    const body = addGroupMemberSchema.parse(request.body);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      await addUserToGroupService(db, {
        user_id: body.user_id,
        group_id: groupId,
        assigned_by: getAdminActor(request),
      });

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: body.user_id,
        source_ip: sourceIp,
        action: 'user_added_to_group',
        metadata: {
          group_id: groupId,
          user_id: body.user_id,
        },
      });

      return reply.status(201).send(wrapSuccess({ message: 'User added to group' }));
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
        }
        if (err.message.includes('already a member')) {
          return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, err.message));
        }
      }
      throw err;
    }
  });

  // ==========================================================================
  // DELETE /v1/admin/groups/:groupId/members/:userId - Remove user from group
  // ==========================================================================
  fastify.delete('/v1/admin/groups/:groupId/members/:userId', async (request, reply) => {
    const { groupId, userId } = groupMemberParamsSchema.parse(request.params);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      await removeUserFromGroupService(db, userId, groupId);

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: userId,
        source_ip: sourceIp,
        action: 'user_removed_from_group',
        metadata: {
          group_id: groupId,
          user_id: userId,
        },
      });

      return reply.status(204).send();
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
        }
        if (err.message.includes('Cannot remove')) {
          return reply.status(403).send(wrapError(ErrorCodes.FORBIDDEN, err.message));
        }
      }
      throw err;
    }
  });

  // ==========================================================================
  // GET /v1/admin/groups/:groupId/members - List group members
  // ==========================================================================
  fastify.get('/v1/admin/groups/:groupId/members', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);

    const members = await listGroupMembersService(db, groupId);

    return reply.send({ ok: true, data: members });
  });

  // ==========================================================================
  // POST /v1/admin/groups/:groupId/mcps - Assign MCP to group
  // ==========================================================================
  fastify.post('/v1/admin/groups/:groupId/mcps', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);
    const body = assignGroupMcpSchema.parse(request.body);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      await assignMcpToGroupService(db, {
        mcp_id: body.mcp_id,
        group_id: groupId,
        assigned_by: getAdminActor(request),
      });

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'mcp_assigned_to_group',
        metadata: {
          group_id: groupId,
          mcp_id: body.mcp_id,
        },
      });

      return reply.status(201).send(wrapSuccess({ message: 'MCP assigned to group' }));
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
        }
        if (err.message.includes('already assigned')) {
          return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, err.message));
        }
      }
      throw err;
    }
  });

  // ==========================================================================
  // DELETE /v1/admin/groups/:groupId/mcps/:mcpId - Remove MCP from group
  // ==========================================================================
  fastify.delete('/v1/admin/groups/:groupId/mcps/:mcpId', async (request, reply) => {
    const { groupId, mcpId } = groupMcpParamsSchema.parse(request.params);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    await removeMcpFromGroupService(db, mcpId, groupId);

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: undefined,
      source_ip: sourceIp,
      action: 'mcp_removed_from_group',
      metadata: {
        group_id: groupId,
        mcp_id: mcpId,
      },
    });

    return reply.status(204).send();
  });

  // ==========================================================================
  // GET /v1/admin/groups/:groupId/mcps - List MCPs for group
  // ==========================================================================
  fastify.get('/v1/admin/groups/:groupId/mcps', async (request, reply) => {
    const { groupId } = groupParamsSchema.parse(request.params);

    const mcps = await listMcpsForGroupService(db, groupId);

    return reply.send({ ok: true, data: mcps });
  });

  done();
};
