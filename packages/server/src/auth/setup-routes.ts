import { z, ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import { LoginRateLimiter } from '../admin/session.js';
import { createUser } from './user-auth.js';
import { validatePassword } from './password-policy.js';
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface SetupRoutesOptions {
  db: DatabaseClient;
  audit?: AuditProvider | null;
}

// Setup admin request schema (as ADR-019)
export const setupAdminSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(255)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'Username may only contain letters, numbers, hyphens, and underscores'
    ),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(255),
  email: z.string().email().optional(),
});

/**
 * Register setup routes
 */
export async function registerSetupRoutes(
  fastify: FastifyInstance,
  opts: SetupRoutesOptions
): Promise<void> {
  const rateLimiter = new LoginRateLimiter();

  // Additional, stricter rate limiter: 3 attempts per minute per IP
  const windowMs = 60 * 1000;
  const maxAttempts = 3;
  const attempts = new Map<string, { count: number; first: number }>();

  // In-memory mutex (process-scoped)
  let setupLock = false;

  // Server version (optional)
  let serverVersion: string | undefined;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      serverVersion = pkg?.version;
    }
  } catch (e) {
    // ignore
  }

  async function acquireLock(): Promise<void> {
    while (setupLock) {
      // Wait until lock is released
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    setupLock = true;
  }

  function releaseLock(): void {
    setupLock = false;
  }

  // GET /v1/setup/status
  fastify.get('/v1/setup/status', async (_request, reply) => {
    try {
      // Check whether any users exist. Use a lightweight query.
      const rows = await opts.db.query.users.findMany({ limit: 1 });
      const needsSetup = rows.length === 0;

      // No-store header
      reply.header('Cache-Control', 'no-store');

      const payload: any = { needsSetup };
      if (needsSetup && serverVersion) payload.serverVersion = serverVersion;

      return reply.status(200).send(wrapSuccess(payload));
    } catch (err) {
      fastify.log.error({ err }, '[Setup] Failed to determine setup status');
      reply.header('Cache-Control', 'no-store');
      return reply
        .status(500)
        .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to determine setup status'));
    }
  });

  // POST /v1/setup/admin
  fastify.post('/v1/setup/admin', { bodyLimit: 8192 }, async (request, reply) => {
    const sourceIp = request.ip ?? '0.0.0.0';

    // Strict per-minute rate limiting (3/min)
    const now = Date.now();
    const rec = attempts.get(sourceIp);
    if (!rec) {
      attempts.set(sourceIp, { count: 1, first: now });
    } else {
      const elapsed = now - rec.first;
      if (elapsed > windowMs) {
        attempts.set(sourceIp, { count: 1, first: now });
      } else {
        if (rec.count >= maxAttempts) {
          const retryAfter = Math.ceil((windowMs - elapsed) / 1000);
          return reply
            .status(429)
            .header('Retry-After', String(retryAfter))
            .send(
              wrapError(ErrorCodes.BAD_REQUEST, 'Rate limit exceeded. Please try again later.', [
                { retry_after: retryAfter },
              ])
            );
        }
        rec.count += 1;
        attempts.set(sourceIp, rec);
      }
    }

    // Also consult shared LoginRateLimiter for broader throttling behaviour
    if (rateLimiter.isRateLimited(sourceIp)) {
      const retryAfter = rateLimiter.getRetryAfter(sourceIp);
      return reply
        .status(429)
        .header('Retry-After', String(retryAfter))
        .send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Rate limit exceeded. Please try again later.', [
            { retry_after: retryAfter },
          ])
        );
    }

    try {
      const body = setupAdminSchema.parse(request.body);

      // Additional password policy validation
      const validation = validatePassword(body.password);
      if (!validation.valid) {
        // Record failure
        rateLimiter.recordFailure(sourceIp);
        return reply
          .status(400)
          .send(
            wrapError(
              ErrorCodes.VALIDATION_ERROR,
              validation.errors[0] ?? 'Invalid password',
              validation.errors
            )
          );
      }

      // Acquire mutex
      await acquireLock();
      try {
        // Re-check whether users exist
        const rows = await opts.db.query.users.findMany({ limit: 1 });
        if (rows.length > 0) {
          // Emit warn audit if provider available
          const nowIso = new Date().toISOString();
          if (opts.audit && opts.audit.emit) {
            try {
              await opts.audit.emit({
                event_id: (await import('crypto')).randomUUID(),
                timestamp: nowIso,
                event_type: 'admin_action' as any,
                severity: 'warn',
                client_id: undefined,
                user_id: undefined,
                source_ip: sourceIp,
                action: 'setup_attempt_after_complete',
                metadata: { outcome: 'failure', reason: 'setup_already_complete' },
              });
            } catch (e) {
              fastify.log.warn({ err: e }, '[Setup] Failed to emit audit event (warn)');
            }
          }

          return reply
            .status(403)
            .send(wrapError('SETUP_COMPLETE', 'Initial setup has already been completed'));
        }

        // Create first admin user
        const user = await createUser(opts.db, {
          username: body.username,
          password: body.password,
          display_name: body.display_name,
          email: body.email,
          is_admin: true,
          created_by: 'setup_wizard',
        });

        // Log success audit
        const nowIso = new Date().toISOString();
        if (opts.audit && opts.audit.emit) {
          try {
            await opts.audit.emit({
              event_id: (await import('crypto')).randomUUID(),
              timestamp: nowIso,
              event_type: 'admin_action' as any,
              severity: 'critical',
              client_id: undefined,
              user_id: user.user_id,
              source_ip: sourceIp,
              action: 'setup_admin_created',
              metadata: { username: user.username, source_ip: sourceIp },
            });
          } catch (e) {
            fastify.log.warn({ err: e }, '[Setup] Failed to emit audit event (critical)');
          }
        }

        // Establish session (follow login pattern)
        if (request.session.userId) delete request.session.userId;
        if (request.session.username) delete request.session.username;
        if (request.session.isAdmin) delete request.session.isAdmin;
        if (request.session.displayName) delete request.session.displayName;

        request.session.userId = user.user_id;
        request.session.username = user.username;
        request.session.isAdmin = user.is_admin;
        request.session.displayName = user.display_name;

        await request.session.save();

        // Reset rate limiter on success
        rateLimiter.reset(sourceIp);

        return reply.status(201).send(
          wrapSuccess({
            user: {
              id: user.user_id,
              username: user.username,
              displayName: user.display_name,
              email: user.email,
              isAdmin: user.is_admin,
              createdAt: user.created_at,
            },
          })
        );
      } finally {
        releaseLock();
      }
    } catch (err) {
      // Validation errors
      if (err instanceof ZodError) {
        rateLimiter.recordFailure(sourceIp);
        return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, 'Invalid request'));
      }

      // Unique constraint / conflict from createUser
      const msg = (err as Error)?.message ?? '';
      if (msg.includes('UNIQUE') || msg.includes('unique') || msg.includes('already exists')) {
        rateLimiter.recordFailure(sourceIp);
        return reply
          .status(409)
          .send(
            wrapError(
              'SETUP_CONFLICT',
              'Another administrator was created while you were completing setup'
            )
          );
      }

      fastify.log.error({ err }, '[Setup] Failed to create admin');
      rateLimiter.recordFailure(sourceIp);
      return reply.status(500).send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to create admin'));
    }
  });
}
