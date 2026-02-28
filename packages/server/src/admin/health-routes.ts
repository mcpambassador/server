/**
 * Admin Health Routes
 *
 * Fastify plugin for MCP health monitoring endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * Provides real-time health status for shared MCPs and per-user instances:
 * - GET /v1/admin/health/mcps - Summary of all MCP health status
 * - GET /v1/admin/health/mcps/:mcpName/instances - Detailed instance info for specific MCP
 * - POST /v1/admin/health/mcps/:mcpName/restart - Restart a shared MCP connection
 *
 * @see Architecture §16.4 Admin API Design Principles
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { SharedMcpManager } from '../downstream/index.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { StdioMcpConnection } from '../downstream/stdio-connection.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';

/**
 * Admin health routes plugin configuration
 */
export interface AdminHealthRoutesConfig {
  mcpManager: SharedMcpManager;
  userPool?: UserMcpPool | null;
}

/**
 * Admin health routes plugin
 */
export const registerAdminHealthRoutes: FastifyPluginCallback<AdminHealthRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminHealthRoutesConfig,
  done
) => {
  const { mcpManager, userPool } = opts;

  // ==========================================================================
  // GET /v1/admin/health/mcps
  // Summary of health status for all MCPs (shared + per-user info)
  // ==========================================================================
  fastify.get('/v1/admin/health/mcps', async (_request, reply) => {
    try {
      const connectionNames = mcpManager.getConnectionNames();
      const shared: Array<{
        name: string;
        transport: 'stdio' | 'http';
        connected: boolean;
        detail: unknown;
        user_instances: number;
        last_error: string | null; // M33.1: NEW
        error_count: number; // M33.1: NEW
      }> = [];

      let totalUserInstances = 0;
      let healthyShared = 0;

      for (const name of connectionNames) {
        const connection = mcpManager.getConnection(name);
        if (!connection) {
          continue;
        }

        const connected = connection.isConnected();
        if (connected) {
          healthyShared++;
        }

        const detail = connection.getHealthDetail();
        const userInstances = userPool?.getInstancesForMcp(name) ?? [];
        totalUserInstances += userInstances.length;

        // Determine transport type
        const transport = connection instanceof StdioMcpConnection ? 'stdio' : 'http';

        // M33.1: Get error info
        const lastError = connection.getLastError();
        const errorCount = connection.getErrorCount();

        shared.push({
          name,
          transport,
          connected,
          detail,
          user_instances: userInstances.length,
          last_error: lastError?.message ?? null,
          error_count: errorCount,
        });
      }

      const response = {
        timestamp: new Date().toISOString(),
        shared,
        summary: {
          total_shared: shared.length,
          healthy_shared: healthyShared,
          total_user_instances: totalUserInstances,
        },
      };

      return reply.send(wrapSuccess(response));
    } catch (err) {
      console.error('[admin-health] Error fetching MCP health summary:', err);
      return reply
        .status(500)
        .send(
          wrapError(
            ErrorCodes.INTERNAL_ERROR,
            err instanceof Error ? err.message : 'Failed to fetch MCP health summary'
          )
        );
    }
  });

  // ==========================================================================
  // GET /v1/admin/health/mcps/:mcpName/instances
  // Detailed instance information for a specific MCP
  // ==========================================================================
  fastify.get<{ Params: { mcpName: string } }>(
    '/v1/admin/health/mcps/:mcpName/instances',
    async (request, reply) => {
      try {
        const { mcpName } = request.params;

        // Get the shared connection
        const connection = mcpManager.getConnection(mcpName);
        if (!connection) {
          return reply
            .status(404)
            .send(wrapError(ErrorCodes.NOT_FOUND, `MCP not found: ${mcpName}`));
        }

        // Run a live health check
        const health = await connection.healthCheck();

        // Get health detail
        const detail = connection.getHealthDetail();

        // Determine transport type
        const transport = connection instanceof StdioMcpConnection ? 'stdio' : 'http';

        // M33.1: Get error history
        const stderrTail = connection.getErrorHistory();
        const errorCount = connection.getErrorCount();

        // Get per-user instances
        const userInstances = userPool?.getInstancesForMcp(mcpName) ?? [];

        // Format user instances with ISO string dates
        const formattedUserInstances = userInstances.map(instance => ({
          userId: instance.userId,
          status: instance.status,
          spawnedAt: instance.spawnedAt.toISOString(),
          connected: instance.connected,
          toolCount: instance.toolCount,
          last_error: instance.last_error, // M33.1: NEW
          error_count: instance.error_count, // M33.1: NEW
          stderr_tail: instance.stderr_tail, // M33.1: NEW
        }));

        const response = {
          name: mcpName,
          transport,
          shared: {
            health,
            detail,
            stderr_tail: stderrTail, // M33.1: NEW
            error_count: errorCount, // M33.1: NEW
          },
          user_instances: formattedUserInstances,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-health] Error fetching MCP instances:', err);
        return reply
          .status(500)
          .send(
            wrapError(
              ErrorCodes.INTERNAL_ERROR,
              err instanceof Error ? err.message : 'Failed to fetch MCP instances'
            )
          );
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/health/mcps/:mcpName/restart
  // Restart a shared MCP connection
  // ==========================================================================
  fastify.post<{ Params: { mcpName: string } }>(
    '/v1/admin/health/mcps/:mcpName/restart',
    async (request, reply) => {
      try {
        const { mcpName } = request.params;

        // Restart the MCP (throws if not found)
        await mcpManager.restartMcp(mcpName);

        // Get connection and check if connected
        const connection = mcpManager.getConnection(mcpName);
        if (!connection) {
          return reply
            .status(500)
            .send(wrapError(ErrorCodes.INTERNAL_ERROR, `MCP not found after restart: ${mcpName}`));
        }

        const connected = connection.isConnected();
        const toolCount = connection.getTools().length;

        const response = {
          name: mcpName,
          restarted: true,
          connected,
          tool_count: toolCount,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-health] Error restarting MCP:', err);

        // Check if it's a "not found" error
        if (err instanceof Error && err.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, err.message));
        }

        return reply
          .status(500)
          .send(
            wrapError(
              ErrorCodes.INTERNAL_ERROR,
              err instanceof Error ? err.message : 'Failed to restart MCP'
            )
          );
      }
    }
  );

  // ==========================================================================
  // GET /v1/admin/health/mcps/:mcpName/logs
  // M33.1: Get full error log for an MCP
  // ==========================================================================
  fastify.get<{ Params: { mcpName: string } }>(
    '/v1/admin/health/mcps/:mcpName/logs',
    async (request, reply) => {
      try {
        const { mcpName } = request.params;

        // Get the shared connection
        const connection = mcpManager.getConnection(mcpName);
        if (!connection) {
          return reply
            .status(404)
            .send(wrapError(ErrorCodes.NOT_FOUND, `MCP not found: ${mcpName}`));
        }

        // Determine transport type
        const transport = connection instanceof StdioMcpConnection ? 'stdio' : 'http';

        // Get error history
        const entries = connection.getErrorHistory();
        const totalCount = connection.getErrorCount();

        const response = {
          name: mcpName,
          transport,
          entries,
          total_count: totalCount,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-health] Error fetching MCP logs:', err);
        return reply
          .status(500)
          .send(
            wrapError(
              ErrorCodes.INTERNAL_ERROR,
              err instanceof Error ? err.message : 'Failed to fetch MCP logs'
            )
          );
      }
    }
  );

  // ==========================================================================
  // DELETE /v1/admin/health/mcps/:mcpName/logs
  // M33.1: Clear error buffer for an MCP
  // ==========================================================================
  fastify.delete<{ Params: { mcpName: string } }>(
    '/v1/admin/health/mcps/:mcpName/logs',
    async (request, reply) => {
      try {
        const { mcpName } = request.params;

        // Get the shared connection
        const connection = mcpManager.getConnection(mcpName);
        if (!connection) {
          return reply
            .status(404)
            .send(wrapError(ErrorCodes.NOT_FOUND, `MCP not found: ${mcpName}`));
        }

        // Clear error history
        connection.clearErrorHistory();

        const response = {
          cleared: true,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-health] Error clearing MCP logs:', err);
        return reply
          .status(500)
          .send(
            wrapError(
              ErrorCodes.INTERNAL_ERROR,
              err instanceof Error ? err.message : 'Failed to clear MCP logs'
            )
          );
      }
    }
  );

  done();
};
