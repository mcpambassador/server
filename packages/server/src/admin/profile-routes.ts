/**
 * Admin Profile Routes
 *
 * Fastify plugin for tool profile CRUD endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M8: Tool Profile Management
 * @see Architecture §16.4 Admin API Design Principles
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import { createPaginationEnvelope } from './pagination.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';
import {
  createProfileSchema,
  updateProfileSchema,
  listProfilesQuerySchema,
  getProfileParamsSchema,
} from './schemas.js';
import {
  createToolProfile,
  getToolProfileById,
  listToolProfiles,
  updateToolProfile,
  deleteToolProfile,
  getEffectiveProfile as getToolProfileEffective,
} from '@mcpambassador/core';

/**
 * Admin profile routes plugin configuration
 */
export interface AdminProfileRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
}

/**
 * Admin profile routes plugin
 */
export const registerAdminProfileRoutes: FastifyPluginCallback<AdminProfileRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminProfileRoutesConfig,
  done
) => {
  const { db, audit } = opts;

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
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'Profile not found')
      );
    }

    // Resolve inheritance chain
    const effectiveProfile = await getToolProfileEffective(db, profileId);

    return reply.send(wrapSuccess({
      ...profile,
      effective: {
        allowed_tools: effectiveProfile.allowed_tools,
        denied_tools: effectiveProfile.denied_tools,
        rate_limits: effectiveProfile.rate_limits,
        inheritance_chain: effectiveProfile.inheritance_chain,
      },
    }));
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

      return reply.status(201).send(wrapSuccess(profile));
    } catch (error) {
      // SEC-M19-012: Sanitize validation error messages
      if (error instanceof Error) {
        if (error.message.includes('cycle')) {
          return reply.status(400).send(
            wrapError(ErrorCodes.BAD_REQUEST, 'Profile inheritance cycle detected')
          );
        }
        if (error.message.includes('depth')) {
          return reply.status(400).send(
            wrapError(ErrorCodes.BAD_REQUEST, 'Profile inheritance depth limit exceeded')
          );
        }
        if (error.message.includes('Parent profile not found')) {
          return reply.status(400).send(
            wrapError(ErrorCodes.BAD_REQUEST, 'Parent profile not found')
          );
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
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'Profile not found')
      );
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

      return reply.send(wrapSuccess(updatedProfile));
    } catch (error) {
      // SEC-M19-012: Sanitize validation error messages
      if (error instanceof Error) {
        if (error.message.includes('cycle')) {
          return reply.status(400).send(
            wrapError(ErrorCodes.BAD_REQUEST, 'Profile inheritance cycle detected')
          );
        }
        if (error.message.includes('depth')) {
          return reply.status(400).send(
            wrapError(ErrorCodes.BAD_REQUEST, 'Profile inheritance depth limit exceeded')
          );
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
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'Profile not found')
      );
    }

    // Check if any clients reference this profile
    const referencingClients = await db.query.clients.findMany({
      where: (c, { eq: eqOp }) => eqOp(c.profile_id, profileId),
      limit: 1,
    });

    if (referencingClients.length > 0) {
      return reply.status(409).send(
        wrapError(ErrorCodes.CONFLICT, 'Cannot delete profile: clients are still using it')
      );
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

  done();
};
