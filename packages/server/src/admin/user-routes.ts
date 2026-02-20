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
 * @see M21.7: Admin User CRUD Routes
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { users, compatUpdate } from '@mcpambassador/core';
import { eq, and } from 'drizzle-orm';
import { authenticateAdminOrSession } from './middleware.js';
import { createUser, getUserById, updateUserPassword } from '../auth/user-auth.js';
import {
  createUserSchema,
  updateUserSchema,
  userParamsSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
} from '../auth/schemas.js';
import { validatePassword } from '../auth/password-policy.js';
import { ZodError } from 'zod';

export interface AdminUserRoutesOptions {
  db: DatabaseClient;
}

/**
 * Register admin user routes on admin Fastify instance
 */
export async function registerAdminUserRoutes(
  fastify: FastifyInstance,
  opts: AdminUserRoutesOptions
): Promise<void> {
  // All routes protected by admin authentication (API key or session)
  const preHandlers = [authenticateAdminOrSession(opts.db)];

  /**
   * GET /v1/admin/users - List users with pagination
   */
  fastify.get(
    '/v1/admin/users',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const query = listUsersQuerySchema.parse(request.query);

        // Build where clause
        const conditions = [];
        if (query.status) {
          conditions.push(eq(users.status, query.status));
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        // Fetch users
        const userList = await opts.db.query.users.findMany({
          where: whereClause,
          limit: query.limit,
          offset: query.offset,
          orderBy: (users, { desc }) => [desc(users.created_at)],
        });

        // Count total (simplified - in production would optimize this)
        const totalUsers = await opts.db.query.users.findMany({
          where: whereClause,
        });

        return reply.status(200).send({
          users: userList.map((u) => ({
            user_id: u.user_id,
            username: u.username,
            display_name: u.display_name,
            email: u.email,
            is_admin: u.is_admin,
            status: u.status,
            auth_source: u.auth_source,
            created_at: u.created_at,
            last_login_at: u.last_login_at,
          })),
          pagination: {
            limit: query.limit,
            offset: query.offset,
            total: totalUsers.length,
          },
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid query parameters',
            details: err.errors,
          });
        }

        fastify.log.error({ err }, '[Admin] List users error');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list users',
        });
      }
    }
  );

  /**
   * POST /v1/admin/users - Create user
   */
  fastify.post(
    '/v1/admin/users',
    { preHandler: preHandlers, bodyLimit: 8192 },
    async (request, reply) => {
      try {
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

        // Check if username already exists
        const existing = await opts.db.query.users.findFirst({
          where: (users, { eq }) => eq(users.username, body.username),
        });

        if (existing) {
          return reply.status(409).send({
            error: 'Conflict',
            message: 'Username already exists',
          });
        }

        // Create user
        const user = await createUser(opts.db, {
          username: body.username,
          password: body.password,
          display_name: body.display_name,
          email: body.email,
          is_admin: body.is_admin,
        });

        return reply.status(201).send({
          user_id: user.user_id,
          username: user.username,
          display_name: user.display_name,
          email: user.email,
          is_admin: user.is_admin,
          status: user.status,
          auth_source: user.auth_source,
          created_at: user.created_at,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid request body',
            details: err.errors,
          });
        }

        fastify.log.error({ err }, '[Admin] Create user error');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to create user',
        });
      }
    }
  );

  /**
   * GET /v1/admin/users/:userId - Get user details
   */
  fastify.get(
    '/v1/admin/users/:userId',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const params = userParamsSchema.parse(request.params);
        const user = await getUserById(opts.db, params.userId);

        if (!user) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        return reply.status(200).send({
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
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid user ID',
            details: err.errors,
          });
        }

        fastify.log.error({ err }, '[Admin] Get user error');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to get user',
        });
      }
    }
  );

  /**
   * PATCH /v1/admin/users/:userId - Update user
   */
  fastify.patch(
    '/v1/admin/users/:userId',
    { preHandler: preHandlers, bodyLimit: 8192 },
    async (request, reply) => {
      try {
        const params = userParamsSchema.parse(request.params);
        const body = updateUserSchema.parse(request.body);

        // Check if user exists
        const user = await getUserById(opts.db, params.userId);
        if (!user) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Build update object
        const updates: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };

        if (body.display_name !== undefined) {
          updates['display_name'] = body.display_name;
        }
        if (body.email !== undefined) {
          updates['email'] = body.email;
        }
        if (body.status !== undefined) {
          updates['status'] = body.status;
        }
        if (body.is_admin !== undefined) {
          updates['is_admin'] = body.is_admin;
        }

        // Update user
        await compatUpdate(opts.db, users).set(updates).where(eq(users.user_id, params.userId));

        // Fetch updated user
        const updatedUser = await getUserById(opts.db, params.userId);

        return reply.status(200).send({
          user_id: updatedUser!.user_id,
          username: updatedUser!.username,
          display_name: updatedUser!.display_name,
          email: updatedUser!.email,
          is_admin: updatedUser!.is_admin,
          status: updatedUser!.status,
          auth_source: updatedUser!.auth_source,
          updated_at: updatedUser!.updated_at,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid request',
            details: err.errors,
          });
        }

        fastify.log.error({ err }, '[Admin] Update user error');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to update user',
        });
      }
    }
  );

  /**
   * DELETE /v1/admin/users/:userId - Deactivate user
   */
  fastify.delete(
    '/v1/admin/users/:userId',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const params = userParamsSchema.parse(request.params);

        // Check if user exists
        const user = await getUserById(opts.db, params.userId);
        if (!user) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Soft delete - set status to inactive
        await compatUpdate(opts.db, users)
          .set({
            status: 'deactivated',
            updated_at: new Date().toISOString(),
          })
          .where(eq(users.user_id, params.userId));

        return reply.status(200).send({
          message: 'User deactivated successfully',
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid user ID',
            details: err.errors,
          });
        }

        fastify.log.error({ err }, '[Admin] Deactivate user error');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to deactivate user',
        });
      }
    }
  );

  /**
   * POST /v1/admin/users/:userId/reset-password - Reset user password
   */
  fastify.post(
    '/v1/admin/users/:userId/reset-password',
    { preHandler: preHandlers, bodyLimit: 4096 },
    async (request, reply) => {
      try {
        const params = userParamsSchema.parse(request.params);
        const body = resetPasswordSchema.parse(request.body);

        // Check if user exists
        const user = await getUserById(opts.db, params.userId);
        if (!user) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'User not found',
          });
        }

        // Validate new password
        const validation = validatePassword(body.new_password);
        if (!validation.valid) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: validation.errors[0] ?? 'Invalid password',
            details: validation.errors,
          });
        }

        // Update password
        await updateUserPassword(opts.db, params.userId, body.new_password);

        return reply.status(200).send({
          message: 'Password reset successfully',
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid request',
            details: err.errors,
          });
        }

        fastify.log.error({ err }, '[Admin] Reset password error');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to reset password',
        });
      }
    }
  );
}
