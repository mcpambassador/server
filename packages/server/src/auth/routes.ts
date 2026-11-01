/**
 * Auth Route Handlers
 *
 * User authentication endpoints on the main server:
 * - POST /v1/auth/login - Authenticate with username/password
 * - GET /v1/auth/session - Get current session info
 * - POST /v1/auth/logout - Destroy session
 *
 * @see M21.6: Auth Route Handlers
 */

import { establishAuthenticatedSession } from './establish-session.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { authenticateUser, getUserById } from './user-auth.js';
import { loginSchema } from './schemas.js';
import { LoginRateLimiter } from '../admin/session.js';
import { ZodError } from 'zod';
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';

export interface AuthRoutesOptions {
  db: DatabaseClient;
  /** ADR-023: forgotten on logout so a step-up window never outlives its session. */
  stepUp?: { clear(sessionId: string): void };
}

/**
 * Register auth routes on Fastify instance
 */
export async function registerAuthRoutes(
  fastify: FastifyInstance,
  opts: AuthRoutesOptions
): Promise<void> {
  const rateLimiter = new LoginRateLimiter();

  /**
   * POST /v1/auth/login - Authenticate user
   *
   * Rate limited: 5 attempts per 15 minutes per IP
   * Returns session info on success, 401 on failure
   */
  fastify.post('/v1/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const sourceIp = request.ip ?? '0.0.0.0';

    // Check rate limit
    if (rateLimiter.isRateLimited(sourceIp)) {
      const retryAfter = rateLimiter.getRetryAfter(sourceIp);
      return reply
        .status(429)
        .header('Retry-After', retryAfter.toString())
        .send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Login rate limit exceeded. Please try again later.', [
            { retry_after: retryAfter },
          ])
        );
    }

    try {
      // Validate request body
      const body = loginSchema.parse(request.body);

      // Authenticate user
      const user = await authenticateUser(opts.db, body.username, body.password);

      if (!user) {
        // Record failure and return generic error
        rateLimiter.recordFailure(sourceIp);
        return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid credentials'));
      }

      // Update last login timestamp
      const timestamp = new Date().toISOString();
      const { users: usersTable, compatUpdate } = await import('@mcpambassador/core');
      const { eq } = await import('drizzle-orm');
      await compatUpdate(opts.db, usersTable)
        .set({ last_login_at: timestamp })
        .where(eq(usersTable.user_id, user.user_id));

      // Reset rate limit on success
      rateLimiter.reset(sourceIp);

      // TD-015: new session id on login (fixation defence)
      await establishAuthenticatedSession(request, {
        userId: user.user_id,
        username: user.username,
        isAdmin: user.is_admin,
        displayName: user.display_name,
      });

      // Return user info (wrapped in user object, camelCase for frontend)
      return reply.status(200).send(
        wrapSuccess({
          user: {
            id: user.user_id,
            username: user.username,
            displayName: user.display_name,
            email: user.email,
            isAdmin: user.is_admin,
            createdAt: user.created_at,
            lastLoginAt: timestamp,
          },
        })
      );
    } catch (err) {
      if (err instanceof ZodError) {
        // M-3: Do not expose validation errors on login endpoint
        // Return generic message to prevent information leakage
        return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid credentials'));
      }

      fastify.log.error({ err }, '[Auth] Login error');
      return reply.status(500).send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Login failed'));
    }
  });

  /**
   * GET /v1/auth/session - Get current session info
   *
   * Returns current user info if authenticated, 401 otherwise
   */
  fastify.get('/v1/auth/session', async (request, reply) => {
    if (!request.session.userId) {
      return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Not authenticated'));
    }

    // Fetch fresh user data
    const user = await getUserById(opts.db, request.session.userId);

    if (!user) {
      // Session has stale user ID, clear it
      await request.session.destroy();
      return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Session invalid'));
    }

    return reply.status(200).send(
      wrapSuccess({
        user: {
          id: user.user_id,
          username: user.username,
          displayName: user.display_name,
          email: user.email,
          isAdmin: user.is_admin,
          createdAt: user.created_at,
          lastLoginAt: user.last_login_at,
        },
      })
    );
  });

  /**
   * POST /v1/auth/logout - Destroy session
   */
  fastify.post('/v1/auth/logout', async (request, reply) => {
    if (request.session.userId) {
      // N1 (ADR-023): drop any open step-up window before the session id disappears.
      // NOTE (N3): a password change does NOT clear an open step-up window; the window is bound to the
      // session id and lasts at most APPROVAL_REAUTH_WINDOW_SECONDS, and a password change keeps the session.
      if (request.session.sessionId) opts.stepUp?.clear(request.session.sessionId);
      await request.session.destroy();
    }

    return reply.status(200).send(
      wrapSuccess({
        message: 'Logged out successfully',
      })
    );
  });
}
