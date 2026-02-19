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
import type { SharedMcpManager } from '../downstream/index.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import type { KillSwitchManager } from './kill-switch-manager.js';
import { authenticateAdmin } from './middleware.js';
import { z } from 'zod';
import {
  createProfileSchema,
  updateProfileSchema,
  killSwitchSchema,
  listProfilesQuerySchema,
  listAuditEventsQuerySchema,
  getProfileParamsSchema,
  killSwitchParamsSchema,
  updateUserSchema,
  updateUserParamsSchema,
  listUsersQuerySchema,
  createClientSchema,
  updateClientSchema,
  updateClientParamsSchema,
  listClientKeysQuerySchema,
  listSessionsQuerySchema,
  deleteSessionParamsSchema,
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
import { eq, and, or, desc, asc } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  users,
  clients,
  user_sessions,
  session_connections,
  compatInsert,
  compatUpdate,
} from '@mcpambassador/core';
import { validatePassword, hashPassword } from '../auth/password-policy.js';
import { createUserSchema, resetPasswordSchema } from '../auth/schemas.js';
import { registerAdminGroupRoutes } from './group-routes.js';
import { registerAdminMcpRoutes } from './mcp-routes.js';

/**
 * Admin routes plugin configuration
 */
export interface AdminRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  mcpManager: SharedMcpManager;
  dataDir: string;
  killSwitchManager: KillSwitchManager; // CR-M10-001: Shared kill switch manager
  userPool: UserMcpPool | null; // M18: Per-user MCP pool for session termination
  rotateHmacSecret: () => Promise<number>; // M19.2a: HMAC secret rotation callback
}

/**
 * Admin routes plugin
 */
export const adminRoutes: FastifyPluginCallback<AdminRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminRoutesConfig,
  done
) => {
  const { db, audit, mcpManager, dataDir, killSwitchManager, userPool, rotateHmacSecret } = opts;

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
        message: error instanceof Error ? error.message : 'Resource conflict',
      });
    }

    if (statusCode === 400) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error instanceof Error ? error.message : 'Invalid request',
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
      // SEC-M19-012: Sanitize validation error messages
      if (error instanceof Error) {
        if (error.message.includes('cycle')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Profile inheritance cycle detected',
          });
        }
        if (error.message.includes('depth')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Profile inheritance depth limit exceeded',
          });
        }
        if (error.message.includes('Parent profile not found')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Parent profile not found',
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
      // SEC-M19-012: Sanitize validation error messages
      if (error instanceof Error) {
        if (error.message.includes('cycle')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Profile inheritance cycle detected',
          });
        }
        if (error.message.includes('depth')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Profile inheritance depth limit exceeded',
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
    const referencingClients = await db.query.clients.findMany({
      where: (c, { eq: eqOp }) => eqOp(c.profile_id, profileId),
      limit: 1,
    });

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

  // ==========================================================================
  // M21: POST /v1/admin/users - Create user with authentication
  // ==========================================================================
  fastify.post('/v1/admin/users', async (request, reply) => {
    const body = createUserSchema.parse(request.body);

    // Validate password
    const validation = validatePassword(body.password);
    if (!validation.valid) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: validation.errors[0] ?? 'Invalid password',
        details: validation.errors,
      });
    }

    // Hash password
    const passwordHash = await hashPassword(body.password);

    // Check for duplicate username
    const existingUser = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.username, body.username),
    });

    if (existingUser) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Username already exists',
      });
    }

    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await compatInsert(db, users).values({
      user_id: userId,
      username: body.username,
      password_hash: passwordHash,
      display_name: body.display_name,
      email: body.email || null,
      is_admin: body.is_admin || false,
      status: 'active',
      auth_source: 'local',
      created_at: nowIso,
      updated_at: nowIso,
      metadata: '{}',
    });

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: userId,
      source_ip: request.ip || '127.0.0.1',
      action: 'user_create',
      metadata: {
        username: body.username,
        display_name: body.display_name,
        email: body.email,
        is_admin: body.is_admin || false,
      },
    });

    const createdUser = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.user_id, userId),
      columns: {
        user_id: true,
        username: true,
        display_name: true,
        email: true,
        is_admin: true,
        status: true,
        auth_source: true,
        created_at: true,
        updated_at: true,
      },
    });

    return reply.status(201).send(createdUser);
  });

  // ==========================================================================
  // M18.2: GET /v1/admin/users
  // ==========================================================================
  fastify.get('/v1/admin/users', async (request, reply) => {
    const query = listUsersQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    // Build where conditions
    const conditions: any[] = [];
    if (query.status) {
      conditions.push(eq(users.status, query.status));
    }

    // Query with filters
    let userList = await db.query.users.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit: limit + 1, // Fetch one extra to detect has_more
      orderBy: query.sort.includes('created_at')
        ? query.sort === 'created_at:desc'
          ? [desc(users.created_at)]
          : [asc(users.created_at)]
        : query.sort === 'display_name:desc'
          ? [desc(users.display_name)]
          : [asc(users.display_name)],
    });

    // Apply cursor filtering if provided
    if (query.cursor) {
      const cursorIndex = userList.findIndex(
        u => u.user_id === query.cursor || u.created_at === query.cursor
      );
      if (cursorIndex >= 0) {
        userList = userList.slice(cursorIndex + 1);
      }
    }

    // Pagination
    const hasMore = userList.length > limit;
    const data = hasMore ? userList.slice(0, limit) : userList;
    const nextCursor =
      hasMore && data.length > 0
        ? query.sort.includes('created_at')
          ? data[data.length - 1]!.created_at
          : data[data.length - 1]!.user_id
        : null;

    return reply.send(
      createPaginationEnvelope(data, {
        has_more: hasMore,
        next_cursor: nextCursor,
        total_count: data.length,
      })
    );
  });

  // ==========================================================================
  // M18.3: PATCH /v1/admin/users/:userId
  // ==========================================================================
  fastify.patch('/v1/admin/users/:userId', async (request, reply) => {
    const { userId } = updateUserParamsSchema.parse(request.params);
    const body = updateUserSchema.parse(request.body);

    // Check if user exists
    const user = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.user_id, userId),
    });

    if (!user) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'User not found',
      });
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      updated_at: nowIso,
    };

    if (body.display_name !== undefined) updates.display_name = body.display_name;
    if (body.email !== undefined) updates.email = body.email;

    const oldStatus = user.status;
    const statusChanged = body.status !== undefined && body.status !== oldStatus;

    if (body.status !== undefined) {
      updates.status = body.status;
    }

    // If status changes to suspended or deactivated, expire all active sessions
    if (statusChanged && (body.status === 'suspended' || body.status === 'deactivated')) {
      // Update user
      await compatUpdate(db, users)
        .set(updates)
        .where(eq(users.user_id, userId));

      // Expire all active sessions for this user
      await compatUpdate(db, user_sessions)
        .set({ status: 'expired' })
        .where(
          and(
            eq(user_sessions.user_id, userId),
            or(
              eq(user_sessions.status, 'active'),
              eq(user_sessions.status, 'idle'),
              eq(user_sessions.status, 'spinning_down')
            )
          )
        );

      // Terminate MCP instances (outside transaction)
      if (userPool) {
        await userPool.terminateForUser(userId);
      }
    } else {
      // Normal update (no cascading)
      await compatUpdate(db, users)
        .set(updates)
        .where(eq(users.user_id, userId));
    }

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: userId,
      source_ip: request.ip || '127.0.0.1',
      action: 'user_update',
      metadata: {
        changes: Object.keys(updates).filter(k => k !== 'updated_at'),
        old_status: oldStatus,
        new_status: body.status,
      },
    });

    const updatedUser = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.user_id, userId),
    });

    return reply.send(updatedUser);
  });

  // ==========================================================================
  // M21: GET /v1/admin/users/:userId - Get user details
  // ==========================================================================
  fastify.get('/v1/admin/users/:userId', async (request, reply) => {
    try {
      const { userId } = updateUserParamsSchema.parse(request.params);
      
      const user = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.user_id, userId),
      });

      if (!user) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User not found',
        });
      }

      return reply.send({
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
        email: user.email,
        is_admin: user.is_admin,
        status: user.status,
        auth_source: user.auth_source,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
      });
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid user ID format',
        });
      }
      throw err;
    }
  });

  // ==========================================================================
  // M21: DELETE /v1/admin/users/:userId - Deactivate user
  // ==========================================================================
  fastify.delete('/v1/admin/users/:userId', async (request, reply) => {
    try {
      const { userId } = updateUserParamsSchema.parse(request.params);
      
      const user = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.user_id, userId),
      });

      if (!user) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User not found',
        });
      }

      const nowIso = new Date().toISOString();

      // Deactivate user
      await compatUpdate(db, users)
        .set({ status: 'deactivated', updated_at: nowIso })
        .where(eq(users.user_id, userId));

      // Expire all active sessions
      await compatUpdate(db, user_sessions)
        .set({ status: 'expired' })
        .where(
          and(
            eq(user_sessions.user_id, userId),
            or(
              eq(user_sessions.status, 'active'),
              eq(user_sessions.status, 'idle'),
              eq(user_sessions.status, 'spinning_down')
            )
          )
        );

      // Terminate MCP instances
      if (userPool) {
        await userPool.terminateForUser(userId);
      }

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: userId,
        source_ip: request.ip || '127.0.0.1',
        action: 'user_deactivated',
        metadata: {},
      });

      return reply.send({
        message: 'User successfully deactivated',
        user_id: userId,
      });
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid user ID format',
        });
      }
      throw err;
    }
  });

  // ==========================================================================
  // M21: POST /v1/admin/users/:userId/reset-password - Reset password
  // ==========================================================================
  fastify.post('/v1/admin/users/:userId/reset-password', async (request, reply) => {
    const { userId } = updateUserParamsSchema.parse(request.params);
    const { new_password } = resetPasswordSchema.parse(request.body);
    
    const user = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.user_id, userId),
    });

    if (!user) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'User not found',
      });
    }

    // Validate password
    const validation = validatePassword(new_password);
    if (!validation.valid) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: validation.errors[0] ?? 'Invalid password',
        details: validation.errors,
      });
    }

    // Hash and update password
    const passwordHash = await hashPassword(new_password);
    const nowIso = new Date().toISOString();

    await compatUpdate(db, users)
      .set({ password_hash: passwordHash, updated_at: nowIso })
      .where(eq(users.user_id, userId));

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: userId,
      source_ip: request.ip || '127.0.0.1',
      action: 'password_reset',
      metadata: {},
    });

    return reply.send({
      message: 'Password successfully reset',
      user_id: userId,
    });
  });

  // ==========================================================================
  // M18.4: POST /v1/admin/clients
  // ==========================================================================
  fastify.post('/v1/admin/clients', async (request, reply) => {
    const body = createClientSchema.parse(request.body);

    // Verify user exists and is active
    const userRecord = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.user_id, body.user_id),
    });

    if (!userRecord) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'User not found',
      });
    }

    if (userRecord.status !== 'active') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'User is not active',
      });
    }

    // Verify profile exists
    const profile = await db.query.tool_profiles.findFirst({
      where: (p, { eq }) => eq(p.profile_id, body.profile_id),
    });

    if (!profile) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Profile not found',
      });
    }

    // Generate preshared key: amb_pk_ + 48 chars of base64url
    const randomBytes = crypto.randomBytes(36); // 36 bytes → 48 base64 chars
    const base64url = randomBytes
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const clientKey = `amb_pk_${base64url}`;

    // Extract prefix: first 8 chars after amb_pk_
    const keyPrefix = base64url.substring(0, 8);

    // Hash with Argon2id
    const keyHash = await argon2.hash(clientKey, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const clientId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await compatInsert(db, clients).values({
      client_id: clientId,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      client_name: body.client_name,
      user_id: body.user_id,
      profile_id: body.profile_id,
      status: 'active',
      created_by: 'admin', // TODO: Get actual admin user_id from auth context
      created_at: nowIso,
      expires_at: body.expires_at || null,
      metadata: '{}',
    });

    // Emit audit event (NEVER log the plaintext key!)
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: body.user_id,
      source_ip: request.ip || '127.0.0.1',
      action: 'client_create',
      metadata: {
        client_id: clientId,
        client_name: body.client_name,
        user_id: body.user_id,
        profile_id: body.profile_id,
      },
    });

    const createdKey = await db.query.clients.findFirst({
      where: (k, { eq }) => eq(k.client_id, clientId),
    });

    // Return key info WITH plaintext key (only time it's ever returned)
    return reply.status(201).send({
      client_id: createdKey!.client_id,
      key_prefix: createdKey!.key_prefix,
      client_name: createdKey!.client_name,
      user_id: createdKey!.user_id,
      profile_id: createdKey!.profile_id,
      status: createdKey!.status,
      created_at: createdKey!.created_at,
      expires_at: createdKey!.expires_at,
      plaintext_key: clientKey, // ONLY returned here, never stored
    });
  });

  // ==========================================================================
  // M18.5: GET /v1/admin/clients
  // ==========================================================================
  fastify.get('/v1/admin/clients', async (request, reply) => {
    const query = listClientKeysQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    // Build where conditions
    const conditions: any[] = [];
    if (query.user_id) {
      conditions.push(eq(clients.user_id, query.user_id));
    }
    if (query.status) {
      conditions.push(eq(clients.status, query.status));
    }

    // Query with filters
    let keyList = await db.query.clients.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit: limit + 1,
      orderBy: query.sort.includes('created_at')
        ? query.sort === 'created_at:desc'
          ? [desc(clients.created_at)]
          : [asc(clients.created_at)]
        : query.sort === 'client_name:desc'
          ? [desc(clients.client_name)]
          : [asc(clients.client_name)],
    });

    // Apply cursor filtering if provided
    if (query.cursor) {
      const cursorIndex = keyList.findIndex(
        k => k.client_id === query.cursor || k.created_at === query.cursor
      );
      if (cursorIndex >= 0) {
        keyList = keyList.slice(cursorIndex + 1);
      }
    }

    // Pagination
    const hasMore = keyList.length > limit;
    const data = hasMore ? keyList.slice(0, limit) : keyList;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.client_id : null;

    // Strip key_hash from response (never expose hashes)
    const sanitizedData = data.map(k => {
      const { key_hash, ...rest } = k;
      return rest;
    });

    return reply.send(
      createPaginationEnvelope(sanitizedData, {
        has_more: hasMore,
        next_cursor: nextCursor,
        total_count: sanitizedData.length,
      })
    );
  });

  // ==========================================================================
  // M18.6: PATCH /v1/admin/clients/:clientId
  // ==========================================================================
  fastify.patch('/v1/admin/clients/:clientId', async (request, reply) => {
    const { clientId } = updateClientParamsSchema.parse(request.params);
    const body = updateClientSchema.parse(request.body);

    // Check if key exists
    const key = await db.query.clients.findFirst({
      where: (k, { eq }) => eq(k.client_id, clientId),
    });

    if (!key) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Client key not found',
      });
    }

    // If profile_id is being changed, verify it exists
    if (body.profile_id !== undefined) {
      const profile = await db.query.tool_profiles.findFirst({
        where: (p, { eq }) => eq(p.profile_id, body.profile_id!),
      });

      if (!profile) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Profile not found',
        });
      }
    }

    const oldStatus = key.status;
    const statusChanged = body.status !== undefined && body.status !== oldStatus;

    const updates: Record<string, unknown> = {};
    if (body.status !== undefined) updates.status = body.status;
    if (body.profile_id !== undefined) updates.profile_id = body.profile_id;

    // If status changes to revoked, expire all sessions for this key's user
    if (statusChanged && body.status === 'revoked') {
      // Update key
      await compatUpdate(db, clients)
        .set(updates)
        .where(eq(clients.client_id, clientId));

      // Expire all active sessions for this key's user
      await compatUpdate(db, user_sessions)
        .set({ status: 'expired' })
        .where(
          and(
            eq(user_sessions.user_id, key.user_id),
            or(
              eq(user_sessions.status, 'active'),
              eq(user_sessions.status, 'idle'),
              eq(user_sessions.status, 'spinning_down')
            )
          )
        );

      // Terminate MCP instances (outside transaction)
      if (userPool) {
        await userPool.terminateForUser(key.user_id);
      }
    } else {
      // Normal update
      await compatUpdate(db, clients)
        .set(updates)
        .where(eq(clients.client_id, clientId));
    }

    const nowIso = new Date().toISOString();

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: key.user_id,
      source_ip: request.ip || '127.0.0.1',
      action: 'client_update',
      metadata: {
        client_id: clientId,
        changes: Object.keys(updates),
        old_status: oldStatus,
        new_status: body.status,
      },
    });

    const updatedKey = await db.query.clients.findFirst({
      where: (k, { eq }) => eq(k.client_id, clientId),
    });

    // Strip key_hash from response
    const { key_hash, ...keyInfo } = updatedKey!;

    return reply.send(keyInfo);
  });

  // ==========================================================================
  // M18.7: GET /v1/admin/sessions
  // ==========================================================================
  fastify.get('/v1/admin/sessions', async (request, reply) => {
    const query = listSessionsQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    // Build where conditions
    const conditions: any[] = [];
    if (query.user_id) {
      conditions.push(eq(user_sessions.user_id, query.user_id));
    }
    if (query.status) {
      conditions.push(eq(user_sessions.status, query.status));
    }

    // Query with filters
    let sessionList = await db.query.user_sessions.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit: limit + 1,
      orderBy: query.sort.includes('last_activity_at')
        ? query.sort === 'last_activity_at:desc'
          ? [desc(user_sessions.last_activity_at)]
          : [asc(user_sessions.last_activity_at)]
        : query.sort === 'created_at:desc'
          ? [desc(user_sessions.created_at)]
          : [asc(user_sessions.created_at)],
    });

    // Apply cursor filtering if provided
    if (query.cursor) {
      const cursorIndex = sessionList.findIndex(
        s => s.session_id === query.cursor || s.last_activity_at === query.cursor
      );
      if (cursorIndex >= 0) {
        sessionList = sessionList.slice(cursorIndex + 1);
      }
    }

    // Pagination
    const hasMore = sessionList.length > limit;
    const data = hasMore ? sessionList.slice(0, limit) : sessionList;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.session_id : null;

    // For each session, count connected connections
    const sessionsWithConnections = await Promise.all(
      data.map(async session => {
        const connections = await db.query.session_connections.findMany({
          where: (c, { eq, and }) =>
            and(eq(c.session_id, session.session_id), eq(c.status, 'connected')),
        });

        // Strip sensitive fields
        const { session_token_hash, token_nonce, ...sessionInfo } = session;

        return {
          ...sessionInfo,
          connection_count: connections.length,
        };
      })
    );

    return reply.send(
      createPaginationEnvelope(sessionsWithConnections, {
        has_more: hasMore,
        next_cursor: nextCursor,
        total_count: sessionsWithConnections.length,
      })
    );
  });

  // ==========================================================================
  // M18.8: DELETE /v1/admin/sessions/:sessionId
  // ==========================================================================
  fastify.delete('/v1/admin/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = deleteSessionParamsSchema.parse(request.params);

    // Check if session exists
    const session = await db.query.user_sessions.findFirst({
      where: (s, { eq }) => eq(s.session_id, sessionId),
    });

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Session not found',
      });
    }

    const nowIso = new Date().toISOString();

    // If already expired, return current state (idempotent)
    if (session.status === 'expired') {
      return reply.send({
        session_id: sessionId,
        status: 'expired',
        terminated_at: nowIso,
      });
    }

    // Expire the session and disconnect all connections
    // Set session to expired
    await compatUpdate(db, user_sessions)
      .set({ status: 'expired' })
      .where(eq(user_sessions.session_id, sessionId));

    // Disconnect all connections
    await compatUpdate(db, session_connections)
      .set({ status: 'disconnected', disconnected_at: nowIso })
      .where(eq(session_connections.session_id, sessionId));

    // Terminate MCP instances for this user
    if (userPool) {
      await userPool.terminateForUser(session.user_id);
    }

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: session.user_id,
      source_ip: request.ip || '127.0.0.1',
      action: 'session_terminate',
      metadata: {
        session_id: sessionId,
        old_status: session.status,
      },
    });

    return reply.send({
      session_id: sessionId,
      status: 'expired',
      terminated_at: nowIso,
    });
  });

  // ==========================================================================
  // M19.2a: POST /v1/admin/rotate-hmac-secret
  // ==========================================================================
  fastify.post('/v1/admin/rotate-hmac-secret', async (request, reply) => {
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      // Call the rotation method (returns count of invalidated sessions)
      const sessionsInvalidated = await rotateHmacSecret();

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'critical',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'hmac_secret_rotated',
        metadata: {
          sessions_invalidated: sessionsInvalidated,
          actor: 'admin',
        },
      });

      return reply.send({
        success: true,
        sessionsInvalidated,
        message: 'HMAC secret rotated. All sessions invalidated.',
      });
    } catch (err) {
      // Emit audit event for failure
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'error',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'hmac_secret_rotation_failed',
        metadata: {
          error: err instanceof Error ? err.message : 'Unknown error',
          actor: 'admin',
        },
      });

      // Log the real error for debugging (do not expose internal details to clients)
      // eslint-disable-next-line no-console
      console.error('[Admin] HMAC rotation failed:', err instanceof Error ? err.message : err);

      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to rotate HMAC secret',
      });
    }
  });

  // ==========================================================================
  // M22: Register group management routes
  // ==========================================================================
  fastify.register(registerAdminGroupRoutes, { db, audit });

  // ==========================================================================
  // M23: Register MCP catalog management routes
  // ==========================================================================
  fastify.register(registerAdminMcpRoutes, { db, audit });

  // ==========================================================================
  // M26.7: POST /v1/admin/rotate-credential-key - Rotate credential vault master key
  // ==========================================================================
  fastify.post('/v1/admin/rotate-credential-key', async (request, reply) => {
    const bodySchema = z
      .object({
        new_key: z.string().length(64).regex(/^[0-9a-fA-F]+$/),
      })
      .strict();

    const bodyResult = bodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: 'Invalid request',
        details: bodyResult.error.issues,
      });
    }

    const { new_key } = bodyResult.data;
    const newMasterKey = Buffer.from(new_key, 'hex');
    let currentMasterKey: Buffer | null = null;
    let tmpKeyPath: string | null = null;

    try {
      // Import vault and key manager
      const { CredentialVault } = await import('../services/credential-vault.js');
      const { MasterKeyManager } = await import('../services/master-key-manager.js');

      // Load current master key
      const keyManager = new MasterKeyManager(dataDir);
      currentMasterKey = await keyManager.loadMasterKey();
      const currentVault = new CredentialVault(currentMasterKey);

      // Get all credentials from database
      const {
        updateCredential,
        user_mcp_credentials,
        compatSelect,
        compatTransaction,
      } = await import('@mcpambassador/core');

      const allCredentials = await compatSelect(db).from(user_mcp_credentials);

      console.log(`[Admin] Starting credential re-encryption for ${allCredentials.length} credentials...`);

      // SEC-M2: Write key file FIRST (to temp), then DB transaction, then rename
      const keyPath = require('path').join(dataDir, 'credential_master_key');
      tmpKeyPath = keyPath + '.tmp';
      require('fs').mkdirSync(dataDir, { recursive: true });
      require('fs').writeFileSync(tmpKeyPath, newMasterKey.toString('hex'), { mode: 0o600 });

      // Re-encrypt all credentials in a transaction
      await compatTransaction(db, async () => {
        for (const cred of allCredentials) {
          // Get user's vault_salt
          const user = await db.query.users.findFirst({
            where: (users: any, { eq }: any) => eq(users.user_id, cred.user_id),
          });

          if (!user || !user.vault_salt) {
            console.warn(`[Admin] User ${cred.user_id} has no vault_salt, skipping credential ${cred.credential_id}`);
            continue;
          }

          // Re-encrypt with new key
          const { encryptedCredentials, iv } = currentVault.reEncrypt(
            user.vault_salt,
            cred.encrypted_credentials,
            cred.encryption_iv,
            newMasterKey
          );

          // Update in database
          await updateCredential(db, cred.credential_id, {
            encrypted_credentials: encryptedCredentials,
            encryption_iv: iv,
          });
        }
      });

      // Atomic rename: tmpKeyPath -> keyPath
      require('fs').renameSync(tmpKeyPath, keyPath);
      tmpKeyPath = null; // Mark as committed

      // SEC-H1: Update the live vault instance with new master key
      const serverInstance = request.server as any;
      if (serverInstance.credentialVault) {
        serverInstance.credentialVault.updateMasterKey(newMasterKey);
      }

      const completedAt = new Date().toISOString();

      console.log(`[Admin] Credential master key rotation complete: ${allCredentials.length} credentials re-encrypted`);

      return reply.status(200).send({
        rotated_count: allCredentials.length,
        completed_at: completedAt,
      });
    } catch (err) {
      console.error('[Admin] Credential key rotation failed:', err);
      // If transaction failed and temp file exists, delete it
      if (tmpKeyPath) {
        try {
          require('fs').unlinkSync(tmpKeyPath);
        } catch (unlinkErr) {
          // Ignore cleanup errors
        }
      }
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to rotate credential master key',
      });
    } finally {
      // SEC-H2: Zero master key buffers from heap
      if (currentMasterKey) {
        currentMasterKey.fill(0);
      }
      newMasterKey.fill(0);
    }
  });

  done();
};
