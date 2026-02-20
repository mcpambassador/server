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

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { authenticateUser, getUserById } from './user-auth.js';
import { loginSchema } from './schemas.js';
import { LoginRateLimiter } from '../admin/session.js';
import { ZodError } from 'zod';
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';

export interface AuthRoutesOptions {
  db: DatabaseClient;
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
      return reply.status(429).header('Retry-After', retryAfter.toString()).send(
        wrapError(ErrorCodes.BAD_REQUEST, 'Login rate limit exceeded. Please try again later.', [{ retry_after: retryAfter }])
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
        return reply.status(401).send(
          wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid credentials')
        );
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

      // M-2: Session fixation prevention (H-2)
      // WORKAROUND: @fastify/session@10.9.0 has a bug where both destroy() and regenerate()
      // nullify the request.session object, making it impossible to set properties afterward.
      // As a workaround, we manually clear existing session data to prevent data leakage.
      // LIMITATION: This does not regenerate the session ID, which is less secure than proper
      // session regeneration. Consider upgrading @fastify/session when a fixed version is available.
      //
      // RATIONALE for accepting this limitation:
      // - Clearing session data prevents data leakage from prior sessions (primary risk)
      // - Session fixation risk is partially mitigated by httpOnly, secure, and sameSite=strict cookies
      // - Our authentication flow generates new sessions on first visit, reducing pre-auth fixation window
      // - The alternative (broken session after login) is worse for security and UX
      // - This is tracked for resolution when @fastify/session is patched

      // Clear any existing session data (prevents data leakage from previous sessions)
      if (request.session.userId) {
        delete request.session.userId;
      }
      if (request.session.username) {
        delete request.session.username;
      }
      if (request.session.isAdmin) {
        delete request.session.isAdmin;
      }
      if (request.session.displayName) {
        delete request.session.displayName;
      }

      // Set new authenticated session data
      request.session.userId = user.user_id;
      request.session.username = user.username;
      request.session.isAdmin = user.is_admin;
      request.session.displayName = user.display_name;

      await request.session.save();

      // Return user info (wrapped in user object, camelCase for frontend)
      return reply.status(200).send(wrapSuccess({
        user: {
          id: user.user_id,
          username: user.username,
          displayName: user.display_name,
          email: user.email,
          isAdmin: user.is_admin,
          createdAt: user.created_at,
          lastLoginAt: timestamp,
        },
      }));
    } catch (err) {
      if (err instanceof ZodError) {
        // M-3: Do not expose validation errors on login endpoint
        // Return generic message to prevent information leakage
        return reply.status(400).send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Invalid credentials')
        );
      }

      fastify.log.error({ err }, '[Auth] Login error');
      return reply.status(500).send(
        wrapError(ErrorCodes.INTERNAL_ERROR, 'Login failed')
      );
    }
  });

  /**
   * GET /v1/auth/session - Get current session info
   *
   * Returns current user info if authenticated, 401 otherwise
   */
  fastify.get('/v1/auth/session', async (request, reply) => {
    if (!request.session.userId) {
      return reply.status(401).send(
        wrapError(ErrorCodes.UNAUTHORIZED, 'Not authenticated')
      );
    }

    // Fetch fresh user data
    const user = await getUserById(opts.db, request.session.userId);

    if (!user) {
      // Session has stale user ID, clear it
      await request.session.destroy();
      return reply.status(401).send(
        wrapError(ErrorCodes.UNAUTHORIZED, 'Session invalid')
      );
    }

    return reply.status(200).send(wrapSuccess({
      user: {
        id: user.user_id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        isAdmin: user.is_admin,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
      },
    }));
  });

  /**
   * POST /v1/auth/logout - Destroy session
   */
  fastify.post('/v1/auth/logout', async (request, reply) => {
    if (request.session.userId) {
      await request.session.destroy();
    }

    return reply.status(200).send(wrapSuccess({
      message: 'Logged out successfully',
    }));
  });
}
