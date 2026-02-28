/**
 * Admin Registry Routes
 *
 * Fastify plugin for community registry endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see mcpambassador_docs/community-registry-spec.md
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { RegistryService } from '../services/registry-service.js';
import { wrapError, ErrorCodes } from './reply-envelope.js';
import { z } from 'zod';

/**
 * Admin registry routes plugin configuration
 */
export interface AdminRegistryRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  registryService: RegistryService;
}

/**
 * Schema for registry query parameters
 */
const registryQuerySchema = z.object({
  search: z.string().optional(),
  tags: z.string().optional(), // Comma-separated
  category: z.string().optional(),
});

/**
 * Schema for registry name parameter
 */
const registryNameParamsSchema = z.object({
  name: z.string().regex(/^[a-z0-9-_]+$/),
});

/**
 * Admin registry routes plugin
 */
export const registerAdminRegistryRoutes: FastifyPluginCallback<AdminRegistryRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminRegistryRoutesConfig,
  done
) => {
  const { audit, registryService } = opts;

  // ==========================================================================
  // GET /v1/admin/registry - List all registry MCPs
  // ==========================================================================
  fastify.get('/v1/admin/registry', async (request, reply) => {
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      const query = registryQuerySchema.parse(request.query);

      // Parse tags from comma-separated string
      const tags = query.tags ? query.tags.split(',').map(t => t.trim()) : undefined;

      const entries = await registryService.getEntries({
        search: query.search,
        tags,
        category: query.category,
      });

      const status = registryService.getStatus();

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'registry_list',
        metadata: {
          entry_count: entries.length,
          filters: query,
        },
      });

      return reply.send({
        ok: true,
        data: {
          registry: {
            name: 'MCP Ambassador Community Registry',
            updated_at: status.lastFetchedAt?.toISOString() || null,
            mcp_count: entries.length,
            last_fetched_at: status.lastFetchedAt?.toISOString() || null,
            url: status.url,
            enabled: status.enabled,
          },
          mcps: entries,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Registry not loaded')) {
        return reply
          .status(502)
          .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Registry not available. Try refreshing.'));
      }

      throw error;
    }
  });

  // ==========================================================================
  // GET /v1/admin/registry/:name - Get single registry MCP
  // ==========================================================================
  fastify.get<{ Params: { name: string } }>('/v1/admin/registry/:name', async (request, reply) => {
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      const params = registryNameParamsSchema.parse(request.params);

      const entry = await registryService.getEntry(params.name);

      if (!entry) {
        return reply
          .status(404)
          .send(wrapError(ErrorCodes.NOT_FOUND, `MCP '${params.name}' not found in registry`));
      }

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'registry_get',
        metadata: {
          mcp_name: params.name,
        },
      });

      return reply.send({ ok: true, data: entry });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Registry not loaded')) {
        return reply
          .status(502)
          .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Registry not available. Try refreshing.'));
      }

      throw error;
    }
  });

  // ==========================================================================
  // POST /v1/admin/registry/:name/install - Install MCP from registry
  // ==========================================================================
  fastify.post<{ Params: { name: string } }>(
    '/v1/admin/registry/:name/install',
    async (request, reply) => {
      const sourceIp = request.ip || '127.0.0.1';
      const nowIso = new Date().toISOString();

      try {
        const params = registryNameParamsSchema.parse(request.params);

        const result = await registryService.installEntry(params.name);

        // Emit audit event
        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action',
          severity: result.success ? 'info' : 'warn',
          client_id: undefined,
          user_id: undefined,
          source_ip: sourceIp,
          action: 'registry_install',
          metadata: {
            mcp_name: params.name,
            success: result.success,
            mcp_id: result.mcp_id,
            message: result.message,
          },
        });

        if (!result.success) {
          // Check if already installed
          if (result.message.includes('already installed')) {
            return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, result.message));
          }

          // Check if not found
          if (result.message.includes('not found in registry')) {
            return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, result.message));
          }

          // Other errors
          return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, result.message));
        }

        return reply.status(201).send({
          ok: true,
          data: {
            mcp_id: result.mcp_id,
            message: result.message,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Registry not loaded')) {
          return reply
            .status(502)
            .send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Registry not available. Try refreshing.'));
        }

        throw error;
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/registry/refresh - Force refresh registry cache
  // ==========================================================================
  fastify.post('/v1/admin/registry/refresh', async (request, reply) => {
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      await registryService.fetchRegistry();

      const status = registryService.getStatus();

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'registry_refresh',
        metadata: {
          entry_count: status.entryCount,
          last_fetched_at: status.lastFetchedAt?.toISOString(),
        },
      });

      return reply.send({
        ok: true,
        data: {
          message: 'Registry refreshed successfully',
          entry_count: status.entryCount,
          last_fetched_at: status.lastFetchedAt?.toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Log error but return 502 for network failures
      console.error('[registry-routes] Failed to refresh registry:', message);

      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'error',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'registry_refresh_failed',
        metadata: {
          error: message,
        },
      });

      return reply
        .status(502)
        .send(wrapError(ErrorCodes.INTERNAL_ERROR, `Failed to refresh registry: ${message}`));
    }
  });

  done();
};
