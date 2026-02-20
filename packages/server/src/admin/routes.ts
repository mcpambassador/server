/**
 * Admin API Routes
 *
 * Fastify plugin that registers all admin endpoints.
 * All routes require admin authentication via X-Admin-Key header.
 *
 * This is the main orchestrator that sets up global auth, error handling,
 * and security headers, then delegates to focused route modules.
 *
 * @see Architecture §16.4 Admin API Design Principles
 * @see dev-plan.md M8: Admin API Implementation
 * @see dev-plan.md M30.6: Route Module Splitting
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { SharedMcpManager } from '../downstream/index.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import type { KillSwitchManager } from './kill-switch-manager.js';
import { authenticateAdminOrSession } from './middleware.js';
import { wrapError, ErrorCodes } from './reply-envelope.js';
import { registerAdminProfileRoutes } from './profile-routes.js';
import { registerAdminClientRoutes } from './client-routes.js';
import { registerAdminSessionRoutes } from './session-routes.js';
import { registerAdminSecurityRoutes } from './security-routes.js';
import { registerAdminAuditRoutes } from './audit-routes.js';
import { registerAdminUserRoutes } from './user-routes.js';
import { registerAdminGroupRoutes } from './group-routes.js';
import { registerAdminMcpRoutes } from './mcp-routes.js';

/**
 * Admin routes plugin configuration
 */
export interface AdminRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  mcpManager: SharedMcpManager;
  dataDir: string;
  killSwitchManager: KillSwitchManager;
  userPool: UserMcpPool | null;
  rotateHmacSecret: () => Promise<number>;
}

/**
 * Admin routes plugin
 */
export const adminRoutes: FastifyPluginCallback<AdminRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminRoutesConfig,
  done
) => {
  const { db, audit, mcpManager, dataDir, killSwitchManager, userPool, rotateHmacSecret } = opts;

  // ==========================================================================
  // ADMIN AUTHENTICATION HOOK (all routes)
  // ==========================================================================
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  fastify.addHook('preHandler', authenticateAdminOrSession(db));

  // ==========================================================================
  // SEC-M8-01: Security headers on all admin routes
  // ==========================================================================
  fastify.addHook('onSend', (_request, reply, _payload, done) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.header('X-Content-Type-Options', 'nosniff');
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    reply.header('Cache-Control', 'no-store');
    done();
  });

  // ==========================================================================
  // SEC-M8-02: Global error handler for admin routes
  // ==========================================================================
  fastify.setErrorHandler(async (error, _request, reply) => {
    // Log full error server-side
    console.error('[admin-api] Error:', error);

    // Return sanitized error to client
    const statusCode = reply.statusCode >= 400 ? reply.statusCode : 500;

    if (statusCode === 401) {
      return reply.status(401).send(
        wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid or missing admin key')
      );
    }

    if (statusCode === 403) {
      return reply.status(403).send(
        wrapError(ErrorCodes.FORBIDDEN, 'Access denied')
      );
    }

    if (statusCode === 404) {
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'Resource not found')
      );
    }

    if (statusCode === 409) {
      return reply.status(409).send(
        wrapError(
          ErrorCodes.CONFLICT,
          error instanceof Error ? error.message : 'Resource conflict'
        )
      );
    }

    if (statusCode === 400) {
      return reply.status(400).send(
        wrapError(
          ErrorCodes.BAD_REQUEST,
          error instanceof Error ? error.message : 'Invalid request'
        )
      );
    }

    // Generic 500 response (no stack traces, SQL errors, or file paths)
    return reply.status(500).send(
      wrapError(ErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred')
    );
  });

  // ==========================================================================
  // REGISTER ROUTE MODULES
  // ==========================================================================

  // Tool profile management (5 endpoints)
  fastify.register(registerAdminProfileRoutes, { db, audit });

  // Client API key management (3 endpoints)
  fastify.register(registerAdminClientRoutes, { db, audit, userPool });

  // Session management (2 endpoints)
  fastify.register(registerAdminSessionRoutes, { db, audit, userPool });

  // Security-critical operations (3 endpoints: kill-switch, HMAC rotation, credential key rotation)
  fastify.register(registerAdminSecurityRoutes, {
    db,
    audit,
    dataDir,
    killSwitchManager,
    rotateHmacSecret,
  });

  // Audit and observability (2 endpoints: audit events, downstream status)
  fastify.register(registerAdminAuditRoutes, { dataDir, mcpManager });

  // User management (6 endpoints)
  fastify.register(registerAdminUserRoutes, { db, audit, userPool });

  // Group management (9 endpoints)
  fastify.register(registerAdminGroupRoutes, { db, audit });

  // MCP catalog management (7 endpoints)
  fastify.register(registerAdminMcpRoutes, { db, audit });

  done();
};
