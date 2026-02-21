/**
 * Admin User CRUD Routes
 *
 * Admin endpoints for user management (admin server):
 * - GET /v1/admin/users - List users with pagination
 * - POST /v1/admin/users - Create user
 * - GET /v1/admin/users/:userId - Get user details
 * - PATCH /v1/admin/users/:userId - Update user
 * - DELETE /v1/admin/users/:userId - Deactivate user
 * - POST /v1/admin/users/:userId/reset-password - Reset user password
 *
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M21.7: Admin User CRUD Routes
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { users, user_sessions, compatInsert, compatUpdate } from '@mcpambassador/core';
import { eq, and, or, desc, asc } from 'drizzle-orm';
import { validatePassword, hashPassword } from '../auth/password-policy.js';
import { createUserSchema, updateUserSchema, resetPasswordSchema } from '../auth/schemas.js';
import { updateUserParamsSchema, listUsersQuerySchema } from './schemas.js';
import { createPaginationEnvelope } from './pagination.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';
import { getUserGroupsService, getGroupService } from '../services/group-service.js';

/**
 * Admin user routes plugin configuration
 */
export interface AdminUserRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  userPool: UserMcpPool | null;
}

/**
 * Admin user routes plugin
 */
export const registerAdminUserRoutes: FastifyPluginCallback<AdminUserRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminUserRoutesConfig,
  done
) => {
  const { db, audit, userPool } = opts;

  // ==========================================================================
  // M21: POST /v1/admin/users - Create user with authentication
  // ==========================================================================
  fastify.post('/v1/admin/users', async (request, reply) => {
    const body = createUserSchema.parse(request.body);

    // Validate password
    const validation = validatePassword(body.password);
    if (!validation.valid) {
      return reply.status(400).send(
        wrapError(ErrorCodes.VALIDATION_ERROR, validation.errors[0] ?? 'Invalid password', validation.errors)
      );
    }

    // Hash password
    const passwordHash = await hashPassword(body.password);

    // Check for duplicate username
    const existingUser = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.username, body.username),
    });

    if (existingUser) {
      return reply.status(409).send(
        wrapError(ErrorCodes.CONFLICT, 'Username already exists')
      );
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

    return reply.status(201).send(wrapSuccess(createdUser));
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
  // M21: GET /v1/admin/users/:userId - Get user details
  // ==========================================================================
  fastify.get('/v1/admin/users/:userId', async (request, reply) => {
    try {
      const { userId } = updateUserParamsSchema.parse(request.params);

      const user = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.user_id, userId),
      });

      if (!user) {
        return reply.status(404).send(
          wrapError(ErrorCodes.NOT_FOUND, 'User not found')
        );
      }

      return reply.send(wrapSuccess({
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
      }));
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return reply.status(400).send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Invalid user ID format')
        );
      }
      throw err;
    }
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
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'User not found')
      );
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

    return reply.send(wrapSuccess(updatedUser));
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
        return reply.status(404).send(
          wrapError(ErrorCodes.NOT_FOUND, 'User not found')
        );
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

      return reply.send(wrapSuccess({
        message: 'User successfully deactivated',
        user_id: userId,
      }));
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return reply.status(400).send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Invalid user ID format')
        );
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
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'User not found')
      );
    }

    // Validate password
    const validation = validatePassword(new_password);
    if (!validation.valid) {
      return reply.status(400).send(
        wrapError(ErrorCodes.VALIDATION_ERROR, validation.errors[0] ?? 'Invalid password', validation.errors)
      );
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

    return reply.send(wrapSuccess({
      message: 'Password successfully reset',
      user_id: userId,
    }));
  });

  // ==========================================================================
  // GET /v1/admin/users/:userId/groups - Get groups for a user
  // ==========================================================================
  fastify.get('/v1/admin/users/:userId/groups', async (request, reply) => {
    try {
      const { userId } = updateUserParamsSchema.parse(request.params);
      
      // Verify user exists before fetching groups
      const user = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.user_id, userId),
      });
      if (!user) {
        return reply.status(404).send(
          wrapError(ErrorCodes.NOT_FOUND, 'User not found')
        );
      }

      const userGroups = await getUserGroupsService(db, userId);
      
      // Enrich with group details
      const enrichedGroups = await Promise.all(
        userGroups.map(async (ug) => {
          const group = await getGroupService(db, ug.group_id);
          return {
            group_id: ug.group_id,
            name: group.name,
            description: group.description,
            assigned_at: ug.assigned_at,
          };
        })
      );
      
      return reply.send(wrapSuccess(enrichedGroups));
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return reply.status(400).send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Invalid user ID format')
        );
      }
      throw err;
    }
  });

  done();
};
