/**
 * Admin Audit Routes
 *
 * Fastify plugin for audit log and system observability endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M8.10: Audit Events Query
 * @see M8.12: Downstream MCP Health Status
 * @see Architecture §16.4 Admin API Design Principles
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { SharedMcpManager } from '../downstream/index.js';
import { createPaginationEnvelope } from './pagination.js';
import { wrapSuccess } from './reply-envelope.js';
import { queryAuditEvents } from './audit-reader.js';
import { listAuditEventsQuerySchema } from './schemas.js';

/**
 * Admin audit routes plugin configuration
 */
export interface AdminAuditRoutesConfig {
  dataDir: string;
  mcpManager: SharedMcpManager;
}

/**
 * Admin audit routes plugin
 */
export const registerAdminAuditRoutes: FastifyPluginCallback<AdminAuditRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminAuditRoutesConfig,
  done
) => {
  const { dataDir, mcpManager } = opts;

  // ==========================================================================
  // M8.10: GET /v1/audit/events
  // ==========================================================================
  fastify.get('/v1/audit/events', async (request, reply) => {
    const query = listAuditEventsQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    const { events, has_more, next_cursor } = await queryAuditEvents(dataDir, {
      start_time: query.start_time,
      end_time: query.end_time,
      client_id: query.client_id,
      event_type: query.event_type,
      limit,
      cursor: query.cursor,
    });

    return reply.send(
      createPaginationEnvelope(events, {
        has_more,
        next_cursor,
        total_count: events.length,
      })
    );
  });

  // ==========================================================================
  // M8.12: GET /v1/admin/downstream
  // ==========================================================================
  fastify.get('/v1/admin/downstream', async (_request, reply) => {
    const status = mcpManager.getStatus();

    return reply.send(
      wrapSuccess({
        total_connections: status.total_connections,
        healthy_connections: status.healthy_connections,
        total_tools: status.total_tools,
        connections: status.connections,
      })
    );
  });

  done();
};
