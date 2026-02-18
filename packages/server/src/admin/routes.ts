/**
 * Admin API Routes
 *
 * Fastify plugin that registers all admin endpoints.
 * All routes require admin authentication via X-Admin-Key header.
 *
 * @see Architecture §16.4 Admin API Design Principles
 * @see dev-plan.md M8: Admin API Implementation
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { DownstreamMcpManager } from '../downstream/index.js';
import type { KillSwitchManager } from './kill-switch-manager.js';
import { authenticateAdmin } from './middleware.js';
import {
  createProfileSchema,
  updateProfileSchema,
  killSwitchSchema,
  clientStatusSchema,
  listProfilesQuerySchema,
  listClientsQuerySchema,
  listAuditEventsQuerySchema,
  getProfileParamsSchema,
  updateClientStatusParamsSchema,
  killSwitchParamsSchema,
} from './schemas.js';
import { createPaginationEnvelope } from './pagination.js';
import { queryAuditEvents } from './audit-reader.js';
import {
  createToolProfile,
  getToolProfileById,
  listToolProfiles,
  updateToolProfile,
  deleteToolProfile,
  getEffectiveProfile as getToolProfileEffective,
} from '@mcpambassador/core';
import { listClients, updateClientStatus, getClientById } from '@mcpambassador/core';

/**
 * Admin routes plugin configuration
 */
export interface AdminRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  mcpManager: DownstreamMcpManager;
  dataDir: string;
  killSwitchManager: KillSwitchManager; // CR-M10-001: Shared kill switch manager
}

/**
 * Admin routes plugin
 */
export const adminRoutes: FastifyPluginCallback<AdminRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminRoutesConfig,
  done
) => {
  const { db, audit, mcpManager, dataDir, killSwitchManager } = opts;

  // ==========================================================================
  // ADMIN AUTHENTICATION HOOK (all routes)
  // ==========================================================================
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  fastify.addHook('preHandler', authenticateAdmin(db));

  // ==========================================================================
  // SEC-M8-01: Security headers on all admin routes
  // ==========================================================================
  fastify.addHook('onSend', (_request, reply, _payload, done) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.header('X-Content-Type-Options', 'nosniff');
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.header('Cache-Control', 'no-store');
    done();
  });

  // ==========================================================================
  // SEC-M8-02: Global error handler for admin routes
  // ==========================================================================
  fastify.setErrorHandler(async (error, _request, reply) => {
    // Log full error server-side
    console.error('[admin-api] Error:', error);

    // Return sanitized error to client
    const statusCode = reply.statusCode >= 400 ? reply.statusCode : 500;

    if (statusCode === 401) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing admin key',
      });
    }

    if (statusCode === 403) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Access denied',
      });
    }

    if (statusCode === 404) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found',
      });
    }

    if (statusCode === 409) {
      return reply.status(409).send({
        error: 'Conflict',
        message: error.message || 'Resource conflict',
      });
    }

    if (statusCode === 400) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message || 'Invalid request',
      });
    }

    // Generic 500 response (no stack traces, SQL errors, or file paths)
    return reply.status(500).send({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  });

  // ==========================================================================
  // M8.3: GET /v1/admin/profiles (list)
  // ==========================================================================
  fastify.get('/v1/admin/profiles', async (request, reply) => {
    const query = listProfilesQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    const { profiles, has_more, next_cursor } = await listToolProfiles(db, {
      limit,
      cursor: query.cursor,
    });

    // Apply name filter if provided (LIKE %name%)
    let filteredProfiles = profiles;
    if (query.name) {
      const nameLower = query.name.toLowerCase();
      filteredProfiles = profiles.filter(p => p.name.toLowerCase().includes(nameLower));
    }

    // Apply sorting
    if (query.sort === 'created_at:asc') {
      filteredProfiles.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (query.sort === 'created_at:desc') {
      filteredProfiles.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else if (query.sort === 'name:desc') {
      filteredProfiles.sort((a, b) => b.name.localeCompare(a.name));
    }
    // Default is name:asc (already handled by repository)

    return reply.send(
      createPaginationEnvelope(filteredProfiles, {
        has_more,
        next_cursor: next_cursor || null,
        total_count: filteredProfiles.length,
      })
    );
  });

  // ==========================================================================
  // M8.4: GET /v1/admin/profiles/:profileId
  // ==========================================================================
  fastify.get('/v1/admin/profiles/:profileId', async (request, reply) => {
    const { profileId } = getProfileParamsSchema.parse(request.params);

    const profile = await getToolProfileById(db, profileId);
    if (!profile) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Profile not found',
      });
    }

    // Resolve inheritance chain
    const effectiveProfile = await getToolProfileEffective(db, profileId);

    return reply.send({
      ...profile,
      effective: {
        allowed_tools: effectiveProfile.allowed_tools,
        denied_tools: effectiveProfile.denied_tools,
        rate_limits: effectiveProfile.rate_limits,
        inheritance_chain: effectiveProfile.inheritance_chain,
      },
    });
  });

  // ==========================================================================
  // M8.5: POST /v1/admin/profiles
  // ==========================================================================
  fastify.post('/v1/admin/profiles', async (request, reply) => {
    const body = createProfileSchema.parse(request.body);

    try {
      const profile = await createToolProfile(db, {
        name: body.name,
        description: body.description || '',
        allowed_tools: JSON.stringify(body.allowed_tools || []),
        denied_tools: JSON.stringify(body.denied_tools || []),
        inherited_from: body.parent_profile_id || null,
      });

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: '127.0.0.1',
        action: 'profile_create',
        metadata: {
          profile_id: profile.profile_id,
          profile_name: profile.name,
        },
      });

      return reply.status(201).send(profile);
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message.includes('cycle') ||
          error.message.includes('depth') ||
          error.message.includes('Parent profile not found')
        ) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: error.message,
          });
        }
      }
      throw error;
    }
  });

  // ==========================================================================
  // M8.6: PATCH /v1/admin/profiles/:profileId
  // ==========================================================================
  fastify.patch('/v1/admin/profiles/:profileId', async (request, reply) => {
    const { profileId } = getProfileParamsSchema.parse(request.params);
    const body = updateProfileSchema.parse(request.body);

    const profile = await getToolProfileById(db, profileId);
    if (!profile) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Profile not found',
      });
    }

    try {
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.allowed_tools !== undefined)
        updates.allowed_tools = JSON.stringify(body.allowed_tools);
      if (body.denied_tools !== undefined) updates.denied_tools = JSON.stringify(body.denied_tools);
      if (body.parent_profile_id !== undefined) updates.inherited_from = body.parent_profile_id;

      await updateToolProfile(db, profileId, updates);

      const updatedProfile = await getToolProfileById(db, profileId);

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: '127.0.0.1',
        action: 'profile_update',
        metadata: {
          profile_id: profileId,
          changes: Object.keys(updates),
        },
      });

      return reply.send(updatedProfile);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('cycle') || error.message.includes('depth')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: error.message,
          });
        }
      }
      throw error;
    }
  });

  // ==========================================================================
  // M8.7: DELETE /v1/admin/profiles/:profileId
  // ==========================================================================
  fastify.delete('/v1/admin/profiles/:profileId', async (request, reply) => {
    const { profileId } = getProfileParamsSchema.parse(request.params);

    const profile = await getToolProfileById(db, profileId);
    if (!profile) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Profile not found',
      });
    }

    // Check if any clients reference this profile
    const { clients: referencingClients } = await listClients(
      db,
      { profile_id: profileId },
      { limit: 1 }
    );

    if (referencingClients.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Cannot delete profile: clients are still using it',
      });
    }

    await deleteToolProfile(db, profileId);

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: undefined,
      source_ip: '127.0.0.1',
      action: 'profile_delete',
      metadata: {
        profile_id: profileId,
        profile_name: profile.name,
      },
    });

    return reply.status(204).send();
  });

  // ==========================================================================
  // M8.8: POST /v1/admin/kill-switch/:target
  // CR-M10-001: Use shared kill switch manager
  // ==========================================================================
  fastify.post('/v1/admin/kill-switch/:target', async (request, reply) => {
    const { target } = killSwitchParamsSchema.parse(request.params);
    const body = killSwitchSchema.parse(request.body);

    // Store kill switch state using shared manager
    killSwitchManager.set(target, body.enabled);

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: 'admin_action',
      severity: 'warn',
      client_id: undefined,
      user_id: undefined,
      source_ip: '127.0.0.1',
      action: body.enabled ? 'kill_switch_activate' : 'kill_switch_deactivate',
      metadata: {
        target,
        enabled: body.enabled,
      },
    });

    return reply.send({
      target,
      enabled: body.enabled,
      timestamp: new Date().toISOString(),
    });
  });

  // ==========================================================================
  // M8.9: PATCH /v1/clients/:clientId/status
  // ==========================================================================
  fastify.patch('/v1/clients/:clientId/status', async (request, reply) => {
    const { clientId } = updateClientStatusParamsSchema.parse(request.params);
    const body = clientStatusSchema.parse(request.body);

    const client = await getClientById(db, clientId);
    if (!client) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Client not found',
      });
    }

    await updateClientStatus(db, clientId, body.status);

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: 'admin_action',
      severity: 'info',
      client_id: clientId,
      user_id: undefined,
      source_ip: '127.0.0.1',
      action: 'client_status_change',
      metadata: {
        old_status: client.status,
        new_status: body.status,
      },
    });

    const updatedClient = await getClientById(db, clientId);
    return reply.send(updatedClient);
  });

  // ==========================================================================
  // M8.10: GET /v1/audit/events
  // ==========================================================================
  fastify.get('/v1/audit/events', async (request, reply) => {
    const query = listAuditEventsQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    const { events, has_more, next_cursor } = await queryAuditEvents(dataDir, {
      start_time: query.start_time,
      end_time: query.end_time,
      client_id: query.client_id,
      event_type: query.event_type,
      limit,
      cursor: query.cursor,
    });

    return reply.send(
      createPaginationEnvelope(events, {
        has_more,
        next_cursor,
        total_count: events.length,
      })
    );
  });

  // ==========================================================================
  // M8.11: GET /v1/admin/clients
  // ==========================================================================
  fastify.get('/v1/admin/clients', async (request, reply) => {
    const query = listClientsQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    const { clients, has_more, next_cursor } = await listClients(
      db,
      {
        status: query.status,
        host_tool: query.host_tool,
      },
      {
        limit,
        cursor: query.cursor,
      }
    );

    return reply.send(
      createPaginationEnvelope(clients, {
        has_more,
        next_cursor: next_cursor || null,
        total_count: clients.length,
      })
    );
  });

  // ==========================================================================
  // M8.12: GET /v1/admin/downstream
  // ==========================================================================
  fastify.get('/v1/admin/downstream', async (_request, reply) => {
    const status = mcpManager.getStatus();

    return reply.send({
      total_connections: status.total_connections,
      healthy_connections: status.healthy_connections,
      total_tools: status.total_tools,
      connections: status.connections,
    });
  });

  done();
};
