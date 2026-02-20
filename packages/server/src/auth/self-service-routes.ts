/**
 * User Self-Service Routes
 *
 * Authenticated user endpoints for self-management:
 * - GET /v1/users/me - Get own profile
 * - PATCH /v1/users/me/password - Change own password
 *
 * @see M21.8: User Self-Service Routes
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { requireUserSession } from './user-session.js';
import { getUserById, authenticateUser, updateUserPassword } from './user-auth.js';
import { changePasswordSchema } from './schemas.js';
import { validatePassword } from './password-policy.js';
import { ZodError } from 'zod';
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';

export interface SelfServiceRoutesOptions {
  db: DatabaseClient;
}

/**
 * Register self-service routes on Fastify instance
 */
export async function registerSelfServiceRoutes(
  fastify: FastifyInstance,
  opts: SelfServiceRoutesOptions
): Promise<void> {
  /**
   * GET /v1/users/me - Get current user profile
   */
  fastify.get(
    '/v1/users/me',
    { preHandler: requireUserSession },
    async (request, reply) => {
      const userId = request.session.userId!;

      const user = await getUserById(opts.db, userId);

      if (!user) {
        return reply.status(404).send(
          wrapError(ErrorCodes.NOT_FOUND, 'User not found')
        );
      }

      return reply.status(200).send(wrapSuccess({
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
        email: user.email,
        status: user.status,
        is_admin: user.is_admin,
        auth_source: user.auth_source,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      }));
    }
  );

  /**
   * PATCH /v1/users/me/password - Change own password
   */
  fastify.patch(
    '/v1/users/me/password',
    { preHandler: requireUserSession, bodyLimit: 4096 },
    async (request, reply) => {
      const userId = request.session.userId!;

      try {
        // Validate request body
        const body = changePasswordSchema.parse(request.body);

        // Get current user
        const user = await getUserById(opts.db, userId);
        if (!user) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, 'User not found')
          );
        }

        // Verify current password
        const validUser = await authenticateUser(opts.db, user.username, body.current_password);
        if (!validUser) {
          return reply.status(401).send(
            wrapError(ErrorCodes.UNAUTHORIZED, 'Current password is incorrect')
          );
        }

        // Validate new password
        const validation = validatePassword(body.new_password);
        if (!validation.valid) {
          return reply.status(400).send(
            wrapError(ErrorCodes.VALIDATION_ERROR, validation.errors[0] ?? 'Invalid password', validation.errors)
          );
        }

        // Update password
        await updateUserPassword(opts.db, userId, body.new_password);

        return reply.status(200).send(wrapSuccess({
          message: 'Password changed successfully',
        }));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(
            wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', err.errors)
          );
        }

        fastify.log.error({ err }, '[Auth] Password change error');
        return reply.status(500).send(
          wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to change password')
        );
      }
    }
  );
}
