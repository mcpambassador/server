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
import { logger } from '@mcpambassador/core';
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
import { registerAdminHealthRoutes } from './health-routes.js';
import { registerAdminUserRoutes } from './user-routes.js';
import { registerAdminGroupRoutes } from './group-routes.js';
import { registerAdminToolPinRoutes } from './tool-pin-routes.js';
import { registerAdminToolPolicyRoutes } from './tool-policy-routes.js';
import type { SecretStore } from '../services/secret-store.js';
import { registerAdminMcpRoutes } from './mcp-routes.js';
import { registerAdminCatalogReloadRoutes } from './catalog-reload-routes.js';
import { CatalogReloader } from '../services/catalog-reloader.js';
import { registerAdminUserMcpRoutes } from './user-mcp-routes.js';
import { registerAdminRegistryRoutes } from './registry-routes.js';
import type { RegistryService } from '../services/registry-service.js';

interface ZodIssueLike {
  code: string;
  path: Array<string | number>;
  message: string;
}

/** Zod enum/literal messages echo the received value; replace those. */
export function safeIssueMessage(i: ZodIssueLike): string {
  return i.code === 'invalid_enum_value' ||
    i.code === 'invalid_literal' ||
    i.code === 'invalid_value'
    ? 'Invalid value'
    : i.message;
}

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
  onGrantsRevoked?: (grantIds: string[]) => void;
  rotateHmacSecret: () => Promise<number>;
  registryService: RegistryService | null;
  secretStore?: SecretStore;
  /** ADR-021: tool pin service accessor (null until initialised) */
  getToolPins?: () => import('../services/tool-pins/pin-service.js').ToolPinService | null;
  /** Called after a pin decision / policy change so cached catalog observations are re-evaluated */
  onToolPinsChanged?: () => void;
  /** ADR-023: approval service accessor (null until initialised) */
  getApprovals?: () => import('../services/approvals/service.js').ApprovalService | null;
  /** One instance per server so the reload mutex spans both listeners (8443 and 9443). */
  catalogReloader?: CatalogReloader;
}

/**
 * Admin routes plugin
 */
export const adminRoutes: FastifyPluginCallback<AdminRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminRoutesConfig,
  done
) => {
  const {
    db,
    audit,
    mcpManager,
    dataDir,
    killSwitchManager,
    userPool,
    rotateHmacSecret,
    registryService,
    secretStore,
  } = opts;
  const catalogReloader =
    opts.catalogReloader ?? (userPool ? new CatalogReloader(db, mcpManager, userPool) : undefined);

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
    // Schema validation failures are the client's fault: 400 with paths and messages only
    // (never received values).
    if (error instanceof Error && error.name === 'ZodError') {
      const issues = (error as unknown as { issues?: ZodIssueLike[] }).issues ?? [];
      return reply.status(400).send(
        wrapError(
          ErrorCodes.VALIDATION_ERROR,
          'Invalid request',
          issues.map(i => ({ path: i.path.join('.'), message: safeIssueMessage(i) }))
        )
      );
    }

    // Log full error server-side
    logger.error({ err: error }, '[admin-api] Error:');

    // Return sanitized error to client
    const statusCode = reply.statusCode >= 400 ? reply.statusCode : 500;

    if (statusCode === 401) {
      return reply
        .status(401)
        .send(wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid or missing admin key'));
    }

    if (statusCode === 403) {
      return reply.status(403).send(wrapError(ErrorCodes.FORBIDDEN, 'Access denied'));
    }

    if (statusCode === 404) {
      return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Resource not found'));
    }

    if (statusCode === 409) {
      return reply
        .status(409)
        .send(
          wrapError(
            ErrorCodes.CONFLICT,
            error instanceof Error ? error.message : 'Resource conflict'
          )
        );
    }

    if (statusCode === 400) {
      return reply
        .status(400)
        .send(
          wrapError(
            ErrorCodes.BAD_REQUEST,
            error instanceof Error ? error.message : 'Invalid request'
          )
        );
    }

    // Generic 500 response (no stack traces, SQL errors, or file paths)
    return reply
      .status(500)
      .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred'));
  });

  // ==========================================================================
  // REGISTER ROUTE MODULES
  // ==========================================================================

  // Tool profile management (5 endpoints)
  fastify.register(registerAdminProfileRoutes, { db, audit });

  // Client API key management (3 endpoints)
  fastify.register(registerAdminClientRoutes, {
    db,
    audit,
    userPool,
    onGrantsRevoked: opts.onGrantsRevoked,
  });

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

  // MCP Health monitoring (3 endpoints: health summary, instances, restart)
  fastify.register(registerAdminHealthRoutes, {
    mcpManager,
    userPool,
  });

  // Per-User MCP instance visibility (4 endpoints: user-mcps list, user detail, refresh, restart) - M33.2
  if (userPool) {
    fastify.register(registerAdminUserMcpRoutes, { db, userPool });
  }

  // User management (6 endpoints)
  fastify.register(registerAdminUserRoutes, { db, audit, userPool });

  // Group management (9 endpoints)
  fastify.register(registerAdminGroupRoutes, { db, audit });
  fastify.register(registerAdminToolPinRoutes, {
    db,
    audit,
    getPins: opts.getToolPins ?? (() => null),
    onChanged: opts.onToolPinsChanged,
  });

  // ADR-023: tool approval policy + MCP approval default (3 endpoints)
  fastify.register(registerAdminToolPolicyRoutes, {
    db,
    getApprovals: opts.getApprovals ?? (() => null),
  });

  // MCP catalog management (7 endpoints)
  // Shared reloader so the reload mutex covers publish/archive auto-apply and manual apply.
  fastify.register(registerAdminMcpRoutes, { db, audit, secretStore, catalogReloader });

  // Community registry (4 endpoints)
  if (registryService) {
    fastify.register(registerAdminRegistryRoutes, { db, audit, registryService });
  }

  // MCP catalog hot reload (2 endpoints) - ADR-013
  fastify.register(registerAdminCatalogReloadRoutes, {
    db,
    mcpManager,
    userPool,
    reloader: catalogReloader,
  });

  done();
};
