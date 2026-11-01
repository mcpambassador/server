/**
 * POST /v1/auth/reauth (ADR-023): step-up for admin-class approval decisions.
 *
 * Session-only (see session-guard). Verifies the signed-in user's password and opens a 5-minute
 * window recorded in memory against THIS session id. Failures are rate limited per user, audited
 * as `approval_reauth_failed` (no password material), and answered generically.
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { AUTH_REAUTH_ROUTE, reauthRequestSchema } from '@mcpambassador/contracts';
import { authenticateUser, getUserById } from './user-auth.js';
import { LoginRateLimiter } from '../admin/session.js';
import { ErrorCodes, wrapError, wrapSuccess } from '../admin/reply-envelope.js';
import { sessionOnlyGuard } from '../approvals-api/session-guard.js';
import type { StepUpStore } from './step-up.js';

export interface ReauthRoutesOptions {
  db: DatabaseClient;
  stepUp: StepUpStore;
  emit: (action: string, meta: Record<string, unknown>) => void;
  /** Injectable for tests. */
  limiter?: LoginRateLimiter;
}

export async function registerReauthRoute(
  fastify: FastifyInstance,
  opts: ReauthRoutesOptions
): Promise<void> {
  const limiter = opts.limiter ?? new LoginRateLimiter();
  const guard = sessionOnlyGuard(fastify, { db: opts.db, emit: opts.emit, requireAdmin: false });

  fastify.post(
    AUTH_REAUTH_ROUTE,
    { preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const principal = request.approvalPrincipal!;
      const key = `reauth:${principal.userId}`;

      if (limiter.isRateLimited(key)) {
        return reply
          .status(429)
          .header('Retry-After', String(limiter.getRetryAfter(key)))
          .send(wrapError(ErrorCodes.BAD_REQUEST, 'Too many attempts. Try again later.'));
      }

      const body = reauthRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid request'));
      }

      const user = await getUserById(opts.db, principal.userId);
      const ok = user ? await authenticateUser(opts.db, user.username, body.data.password) : null;
      if (!ok || ok.user_id !== principal.userId) {
        limiter.recordFailure(key);
        opts.emit('approval_reauth_failed', { user_id: principal.userId });
        return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid credentials'));
      }

      limiter.reset(key);
      const until = opts.stepUp.mark(principal.sessionId);
      return reply.send(
        wrapSuccess({
          reauthenticated_until: new Date(until).toISOString(),
          window_seconds: opts.stepUp.window,
        })
      );
    }
  );
}
