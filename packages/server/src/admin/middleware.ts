/**
 * Admin API Middleware
 *
 * Authentication middleware for admin endpoints.
 * Validates X-Admin-Key header against admin_keys table using argon2id.
 *
 * @see ADR-006 Admin Authentication Model
 * @see dev-plan.md M8.2: Admin auth middleware
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { authenticateAdminKey } from '@mcpambassador/core';

/**
 * Admin authentication pre-handler hook
 *
 * Validates X-Admin-Key header and returns 401 if invalid or missing.
 *
 * @param db Database client
 * @returns Fastify preHandler hook
 */
export function authenticateAdmin(db: DatabaseClient): preHandlerHookHandler {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const adminKey = request.headers['x-admin-key'];

    if (!adminKey || typeof adminKey !== 'string') {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing admin key',
      });
    }

    const isValid = await authenticateAdminKey(db, adminKey);

    if (!isValid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing admin key',
      });
    }

    // Authentication successful - continue to route handler
  };
}
