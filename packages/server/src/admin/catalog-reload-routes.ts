/**
 * Admin Catalog Reload Routes
 *
 * ADR-013: Hot reload endpoints for MCP catalog changes.
 * Allows admins to apply catalog changes without restarting the server.
 *
 * All routes require admin authentication (applied globally by parent plugin).
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import type { SharedMcpManager } from '../downstream/index.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { CatalogReloader, CatalogReloadConflictError } from '../services/catalog-reloader.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';

/**
 * Admin catalog reload routes plugin configuration
 */
export interface AdminCatalogReloadRoutesConfig {
  db: DatabaseClient;
  mcpManager: SharedMcpManager;
  userPool: UserMcpPool | null;
}

/**
 * Admin catalog reload routes plugin
 */
export const registerAdminCatalogReloadRoutes: FastifyPluginCallback<
  AdminCatalogReloadRoutesConfig
> = (fastify: FastifyInstance, opts: AdminCatalogReloadRoutesConfig, done) => {
  const { db, mcpManager, userPool } = opts;

  // Validate dependencies
  if (!mcpManager || !userPool) {
    throw new Error('[AdminCatalogReloadRoutes] Missing required dependencies');
  }

  // Create reloader service
  const reloader = new CatalogReloader(db, mcpManager, userPool);

  // ==========================================================================
  // GET /v1/admin/catalog/status
  // Preview pending changes without applying them
  // ==========================================================================
  fastify.get('/v1/admin/catalog/status', async (_request, reply) => {
    try {
      const pendingChanges = await reloader.previewChanges();
      return reply.send(wrapSuccess(pendingChanges));
    } catch (err) {
      console.error('[AdminCatalogReload] Error previewing changes:', err);
      return reply
        .status(500)
        .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to preview catalog changes'));
    }
  });

  // ==========================================================================
  // POST /v1/admin/catalog/apply
  // Apply catalog changes (execute hot reload)
  // ==========================================================================
  fastify.post('/v1/admin/catalog/apply', async (_request, reply) => {
    try {
      const result = await reloader.applyChanges();
      return reply.send(wrapSuccess(result));
    } catch (err) {
      // N3 fix: Use instanceof check for custom error class
      if (err instanceof CatalogReloadConflictError) {
        return reply
          .status(409)
          .send(wrapError(ErrorCodes.CONFLICT, 'Catalog reload already in progress'));
      }

      console.error('[AdminCatalogReload] Error applying changes:', err);
      return reply
        .status(500)
        .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to apply catalog changes'));
    }
  });

  done();
};
