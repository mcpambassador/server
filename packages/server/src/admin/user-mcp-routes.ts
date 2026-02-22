/**
 * Admin User MCP Routes
 *
 * Fastify plugin for per-user MCP instance visibility and management.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * M33.2: Cross-user MCP instance visibility endpoints
 * Provides admin dashboard with visibility into all per-user MCP instances,
 * not just instances for a specific MCP name.
 *
 * Routes:
 * - GET /v1/admin/health/user-mcps - All user MCP instances (cross-cutting view)
 * - GET /v1/admin/health/user-mcps/:userId - Specific user's instances
 * - POST /v1/admin/health/user-mcps/:userId/refresh - Refresh all user's MCPs
 * - POST /v1/admin/health/user-mcps/:userId/mcps/:mcpName/restart - Restart specific MCP
 *
 * @see Architecture §16.4 Admin API Design Principles
 * @see dev-plan.md M33.2: Per-User MCP Instance Visibility
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { users } from '@mcpambassador/core';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';
import { eq } from 'drizzle-orm';

/**
 * Admin user MCP routes plugin configuration
 */
export interface AdminUserMcpRoutesConfig {
  db: DatabaseClient;
  userPool: UserMcpPool | null;
}

/**
 * Admin user MCP routes plugin
 */
export const registerAdminUserMcpRoutes: FastifyPluginCallback<AdminUserMcpRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminUserMcpRoutesConfig,
  done
) => {
  const { db, userPool } = opts;

  // ==========================================================================
  // GET /v1/admin/health/user-mcps
  // Summary of all per-user MCP instances across all users
  // ==========================================================================
  fastify.get('/v1/admin/health/user-mcps', async (_request, reply) => {
    try {
      if (!userPool) {
        return reply.send(
          wrapSuccess({
            timestamp: new Date().toISOString(),
            summary: {
              total_instances: 0,
              active_users: 0,
              total_users: 0,
              total_tools_served: 0,
              healthy_instances: 0,
              unhealthy_instances: 0,
            },
            instances: [],
          })
        );
      }

      // Get all users from database
      const allUsers = await db.query.users.findMany({
        columns: {
          user_id: true,
          username: true,
        },
      });

      // Create username lookup map
      const usernameMap = new Map<string, string>();
      for (const user of allUsers) {
        usernameMap.set(user.user_id, user.username);
      }

      // Get all per-user instances from the pool
      // We need to access internal state. Since getInstancesForMcp exists,
      // we'll iterate through all MCP configs to gather all instances.
      // Better approach: access the internal state (but that's private).
      // Let's create a helper method to get all instances.

      // For now, we'll iterate through all users who have active instances
      const status = userPool.getStatus();
      const userIds = Array.from(status.instancesByUser.keys());

      const instances: Array<{
        user_id: string;
        username: string;
        mcp_name: string;
        status: 'connected' | 'disconnected' | 'error';
        tool_count: number;
        spawned_at: string | null;
        uptime_ms: number | null;
        last_error: string | null;
        error_count: number;
      }> = [];

      let totalToolsServed = 0;
      let healthyInstances = 0;
      let unhealthyInstances = 0;

      // Get tool catalog and connection details for each user
      for (const userId of userIds) {
        const username = usernameMap.get(userId) ?? 'unknown';
        const toolCatalog = userPool.getToolCatalog(userId);

        // Get all connections for this user by checking each tool's source MCP
        const mcpNames = new Set<string>();
        for (const tool of toolCatalog) {
          mcpNames.add(tool.source_mcp);
        }

        // For each MCP this user has, get its status
        for (const mcpName of mcpNames) {
          const mcpInstances = userPool.getInstancesForMcp(mcpName);
          const userInstance = mcpInstances.find(inst => inst.userId === userId);

          if (userInstance) {
            const isConnected = userInstance.connected;
            const hasError = userInstance.error_count > 0 || userInstance.last_error !== null;

            let instanceStatus: 'connected' | 'disconnected' | 'error';
            if (hasError) {
              instanceStatus = 'error';
              unhealthyInstances++;
            } else if (isConnected) {
              instanceStatus = 'connected';
              healthyInstances++;
            } else {
              instanceStatus = 'disconnected';
              unhealthyInstances++;
            }

            const spawnedAt = userInstance.spawnedAt.toISOString();
            const uptimeMs = Date.now() - userInstance.spawnedAt.getTime();
            totalToolsServed += userInstance.toolCount;

            instances.push({
              user_id: userId,
              username,
              mcp_name: mcpName,
              status: instanceStatus,
              tool_count: userInstance.toolCount,
              spawned_at: spawnedAt,
              uptime_ms: uptimeMs,
              last_error: userInstance.last_error,
              error_count: userInstance.error_count,
            });
          }
        }
      }

      const response = {
        timestamp: new Date().toISOString(),
        summary: {
          total_instances: instances.length,
          active_users: userIds.length,
          total_users: allUsers.length,
          total_tools_served: totalToolsServed,
          healthy_instances: healthyInstances,
          unhealthy_instances: unhealthyInstances,
        },
        instances,
      };

      return reply.send(wrapSuccess(response));
    } catch (err) {
      console.error('[admin-user-mcps] Error fetching user MCP instances:', err);
      return reply.status(500).send(
        wrapError(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : 'Failed to fetch user MCP instances'
        )
      );
    }
  });

  // ==========================================================================
  // GET /v1/admin/health/user-mcps/:userId
  // Detailed info for a specific user's MCP instances
  // ==========================================================================
  fastify.get<{ Params: { userId: string } }>(
    '/v1/admin/health/user-mcps/:userId',
    async (request, reply) => {
      try {
        const { userId } = request.params;

        if (!userPool) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `User pool not available`)
          );
        }

        // Get user info from database
        const user = await db.query.users.findFirst({
          where: eq(users.user_id, userId),
          columns: {
            user_id: true,
            username: true,
          },
        });

        if (!user) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `User not found: ${userId}`)
          );
        }

        // Get user's tool catalog to determine which MCPs they have
        const toolCatalog = userPool.getToolCatalog(userId);

        // Get unique MCP names
        const mcpNames = new Set<string>();
        for (const tool of toolCatalog) {
          mcpNames.add(tool.source_mcp);
        }

        const instances: Array<{
          mcp_name: string;
          status: 'connected' | 'disconnected' | 'error';
          tool_count: number;
          spawned_at: string | null;
          uptime_ms: number | null;
          last_error: string | null;
          error_count: number;
          stderr_tail: Array<{
            timestamp: string;
            message: string;
          }>;
        }> = [];

        // Get detailed info for each MCP instance
        for (const mcpName of mcpNames) {
          const mcpInstances = userPool.getInstancesForMcp(mcpName);
          const userInstance = mcpInstances.find(inst => inst.userId === userId);

          if (userInstance) {
            const isConnected = userInstance.connected;
            const hasError = userInstance.error_count > 0 || userInstance.last_error !== null;

            let instanceStatus: 'connected' | 'disconnected' | 'error';
            if (hasError) {
              instanceStatus = 'error';
            } else if (isConnected) {
              instanceStatus = 'connected';
            } else {
              instanceStatus = 'disconnected';
            }

            const spawnedAt = userInstance.spawnedAt.toISOString();
            const uptimeMs = Date.now() - userInstance.spawnedAt.getTime();

            instances.push({
              mcp_name: mcpName,
              status: instanceStatus,
              tool_count: userInstance.toolCount,
              spawned_at: spawnedAt,
              uptime_ms: uptimeMs,
              last_error: userInstance.last_error,
              error_count: userInstance.error_count,
              stderr_tail: userInstance.stderr_tail,
            });
          }
        }

        const response = {
          user_id: userId,
          username: user.username,
          instances,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-user-mcps] Error fetching user MCP details:', err);
        return reply.status(500).send(
          wrapError(
            ErrorCodes.INTERNAL_ERROR,
            err instanceof Error ? err.message : 'Failed to fetch user MCP details'
          )
        );
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/health/user-mcps/:userId/refresh
  // Force-refresh all of a user's per-user MCP instances
  // ==========================================================================
  fastify.post<{ Params: { userId: string } }>(
    '/v1/admin/health/user-mcps/:userId/refresh',
    async (request, reply) => {
      try {
        const { userId } = request.params;

        if (!userPool) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `User pool not available`)
          );
        }

        // Get user info from database
        const user = await db.query.users.findFirst({
          where: eq(users.user_id, userId),
          columns: {
            user_id: true,
            username: true,
          },
        });

        if (!user) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `User not found: ${userId}`)
          );
        }

        // Get the MCPs this user has before termination
        const toolCatalog = userPool.getToolCatalog(userId);
        const mcpNames = Array.from(new Set(toolCatalog.map(t => t.source_mcp)));

        // Terminate all instances for this user
        await userPool.terminateForUser(userId);

        const response = {
          user_id: userId,
          refreshed_mcps: mcpNames,
          message: `Terminated ${mcpNames.length} MCP instance(s) for user ${user.username}. Instances will respawn on next client connection.`,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-user-mcps] Error refreshing user MCPs:', err);
        return reply.status(500).send(
          wrapError(
            ErrorCodes.INTERNAL_ERROR,
            err instanceof Error ? err.message : 'Failed to refresh user MCPs'
          )
        );
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/health/user-mcps/:userId/mcps/:mcpName/restart
  // Restart a specific per-user MCP instance
  // ==========================================================================
  fastify.post<{ Params: { userId: string; mcpName: string } }>(
    '/v1/admin/health/user-mcps/:userId/mcps/:mcpName/restart',
    async (request, reply) => {
      try {
        const { userId, mcpName } = request.params;

        if (!userPool) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `User pool not available`)
          );
        }

        // Get user info from database
        const user = await db.query.users.findFirst({
          where: eq(users.user_id, userId),
          columns: {
            user_id: true,
            username: true,
          },
        });

        if (!user) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `User not found: ${userId}`)
          );
        }

        // Check if the user has this MCP instance
        const toolCatalog = userPool.getToolCatalog(userId);
        const hasMcp = toolCatalog.some(t => t.source_mcp === mcpName);

        if (!hasMcp) {
          return reply.status(404).send(
            wrapError(
              ErrorCodes.NOT_FOUND,
              `User ${user.username} does not have MCP instance: ${mcpName}`
            )
          );
        }

        // UserMcpPool doesn't have a method to terminate a specific MCP for a user.
        // We can only terminate all instances for the user.
        // For now, we'll terminate all and document this behavior.
        // In the future, we could add a terminateMcpForUser(userId, mcpName) method.

        // For M33.2, let's implement a workaround: terminate all and note this limitation
        await userPool.terminateForUser(userId);

        const response = {
          user_id: userId,
          mcp_name: mcpName,
          restarted: true,
          message: `Terminated all MCP instances for user ${user.username} (including ${mcpName}). Instances will respawn on next client connection. Note: Per-MCP termination not yet implemented.`,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[admin-user-mcps] Error restarting user MCP:', err);
        return reply.status(500).send(
          wrapError(
            ErrorCodes.INTERNAL_ERROR,
            err instanceof Error ? err.message : 'Failed to restart user MCP'
          )
        );
      }
    }
  );

  done();
};
