/**
 * Session-only guard for approval routes (ADR-023 A1/N4).
 *
 * An approval decision (and everything that reveals a request's argument preview) is a human act
 * performed from the SPA with a cookie session. So:
 *  - `X-Admin-Key` or `Authorization` present AT ALL is refused (403, audited as
 *    `approval_credential_refused`), whether or not it would validate.
 *  - the session user is re-read from the database (disabled users and demoted admins lose access
 *    at once; the cached session flags are not trusted),
 *  - CSRF is verified HERE for mutations, because the global hook skips CSRF whenever a valid admin
 *    key is present and these routes must never depend on that.
 * Check order for decisions: credential refusal -> session -> CSRF -> (route) visibility 404 ->
 * approver role 403 -> step-up 428.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { getUserById } from '../auth/user-auth.js';
import { ErrorCodes, wrapError } from '../admin/reply-envelope.js';

export interface ApprovalPrincipal {
  userId: string;
  isAdmin: boolean;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    approvalPrincipal?: ApprovalPrincipal;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface SessionGuardOptions {
  db: DatabaseClient;
  /** Audit sink (ids only). */
  emit: (action: string, meta: Record<string, unknown>) => void;
  /** Require an admin (users with is_admin) rather than any active user. */
  requireAdmin: boolean;
}

export function sessionOnlyGuard(
  fastify: FastifyInstance,
  opts: SessionGuardOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    if (
      request.headers['x-admin-key'] !== undefined ||
      request.headers['authorization'] !== undefined
    ) {
      opts.emit('approval_credential_refused', {
        route: request.routeOptions?.url ?? 'unknown',
        method: request.method,
        credential: request.headers['x-admin-key'] !== undefined ? 'admin_key' : 'authorization',
      });
      return reply
        .status(403)
        .send(wrapError(ErrorCodes.FORBIDDEN, 'Approvals require a signed-in browser session'));
    }

    const userId = request.session?.userId;
    if (!userId) {
      return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Authentication required'));
    }

    if (!SAFE.has(request.method)) {
      try {
        await new Promise<void>((resolve, reject) => {
          fastify.csrfProtection(request, reply, (err?: Error) => (err ? reject(err) : resolve()));
        });
      } catch {
        return reply.status(403).send(wrapError(ErrorCodes.FORBIDDEN, 'Invalid CSRF token'));
      }
    }

    const user = await getUserById(opts.db, userId);
    if (!user || user.status !== 'active') {
      return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Authentication required'));
    }
    if (opts.requireAdmin && !user.is_admin) {
      return reply.status(403).send(wrapError(ErrorCodes.FORBIDDEN, 'Admin access required'));
    }
    request.approvalPrincipal = {
      userId: user.user_id,
      isAdmin: user.is_admin,
      sessionId: request.session.sessionId,
    };
  };
}
