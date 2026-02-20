/**
 * Admin API Middleware
 *
 * Authentication middleware for admin endpoints.
 * Supports TWO authentication methods:
 * 1. X-Admin-Key header (for external API clients)
 * 2. Session-based authentication with admin privileges (for SPA)
 *
 * @see ADR-006 Admin Authentication Model
 * @see dev-plan.md M8.2: Admin auth middleware
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { authenticateAdminKey } from '@mcpambassador/core';

/**
 * Admin authentication pre-handler hook (API key only)
 *
 * Validates X-Admin-Key header and returns 401 if invalid or missing.
 * Use this for strict API key-only authentication.
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

/**
 * Flexible admin authentication pre-handler hook
 *
 * Accepts EITHER:
 * 1. X-Admin-Key header → validates against admin_keys table
 * 2. User session with isAdmin=true → validates session + admin privileges
 *
 * This allows the SPA (using sessions) and external clients (using API keys)
 * to access the same admin endpoints.
 *
 * @param db Database client
 * @returns Fastify preHandler hook
 */
export function authenticateAdminOrSession(db: DatabaseClient): preHandlerHookHandler {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Option 1: Check for X-Admin-Key header
    const adminKey = request.headers['x-admin-key'];
    if (adminKey && typeof adminKey === 'string') {
      const isValid = await authenticateAdminKey(db, adminKey);
      if (isValid) {
        return; // Authentication successful
      }
      // If key provided but invalid, fall through to session check
    }

    // Option 2: Check for user session with admin privileges
    if (request.session?.userId && request.session?.isAdmin === true) {
      return; // Authentication successful
    }

    // Both authentication methods failed
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Admin authentication required (API key or admin session)',
    });
  };
}
