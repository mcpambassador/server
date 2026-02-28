/**
 * Admin Middleware
 *
 * Authorization middleware for admin-only operations.
 * Checks that authenticated user has admin privileges.
 *
 * @see M21.4: Admin Middleware
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Require admin privileges middleware
 *
 * Checks if authenticated user has admin privileges (isAdmin === true).
 * Returns 403 Forbidden if user is not an admin.
 *
 * Prerequisites: Must be used AFTER requireUserSession middleware.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.session.isAdmin) {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Administrator privileges required',
    });
  }
}
