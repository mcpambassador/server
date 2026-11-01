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
import { authenticateAdminKeyId } from '@mcpambassador/core';
import { wrapError, ErrorCodes } from './reply-envelope.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set once an X-Admin-Key header has been VERIFIED for this request (S4 audit identity). */
    adminKeyId?: string;
  }
}

/**
 * Verify the X-Admin-Key header once per request (result cached on the request).
 * 'none'    — no header presented
 * 'valid'   — header verified; request.adminKeyId is set
 * 'invalid' — header presented but wrong: callers MUST answer 401 and never fall back to a cookie session (S2)
 */
export async function verifyAdminKeyHeader(
  db: DatabaseClient,
  request: FastifyRequest
): Promise<'none' | 'valid' | 'invalid'> {
  const header = request.headers['x-admin-key'];
  if (header === undefined) return 'none';
  if (request.adminKeyId) return 'valid';
  if (typeof header !== 'string' || header.length === 0) return 'invalid';
  const id = await authenticateAdminKeyId(db, header);
  if (id === null) return 'invalid';
  request.adminKeyId = String(id);
  return 'valid';
}

/** Audit actor for key-authenticated requests: `admin-key:<key id>` (never any part of the secret). */
export function adminKeyActor(request: FastifyRequest): string | undefined {
  return request.adminKeyId ? `admin-key:${request.adminKeyId}` : undefined;
}

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
    if ((await verifyAdminKeyHeader(db, request)) !== 'valid') {
      return reply
        .status(401)
        .send(wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid or missing admin key'));
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
    // Option 1: X-Admin-Key header. A header that is present but invalid is a hard 401 (S2):
    // it must never fall through to a cookie session.
    const keyState = await verifyAdminKeyHeader(db, request);
    if (keyState === 'valid') return;
    if (keyState === 'invalid') {
      return reply
        .status(401)
        .send(wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid or missing admin key'));
    }

    // Option 2: Check for user session with admin privileges
    if (request.session?.userId && request.session?.isAdmin === true) {
      return; // Authentication successful
    }

    // Both authentication methods failed
    return reply
      .status(401)
      .send(
        wrapError(
          ErrorCodes.UNAUTHORIZED,
          'Admin authentication required (API key or admin session)'
        )
      );
  };
}
