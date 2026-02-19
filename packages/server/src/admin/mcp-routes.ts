/**
 * Admin MCP Routes
 *
 * Fastify plugin for MCP catalog management endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M23.3: Admin MCP Route Handlers
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import { updateValidationStatus } from '@mcpambassador/core'; 
import { createPaginationEnvelope } from './pagination.js';
import {
  createMcpSchema,
  updateMcpSchema,
  mcpParamsSchema,
  listMcpsQuerySchema,
} from './mcp-schemas.js';
import {
  createMcpCatalogEntry,
  getMcpCatalogEntry,
  listMcpCatalogEntries,
  updateMcpCatalogEntry,
  archiveMcpEntry,
  deleteMcpCatalogEntry,
  publishMcpCatalogEntry,
} from '../services/mcp-catalog-service.js';
import { validateMcpConfig } from '../services/mcp-validator.js';

/**
 * Admin MCP routes plugin configuration
 */
export interface AdminMcpRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
}

/**
 * Admin MCP routes plugin
 */
export const registerAdminMcpRoutes: FastifyPluginCallback<AdminMcpRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminMcpRoutesConfig,
  done
) => {
  const { db, audit } = opts;

  // ==========================================================================
  // POST /v1/admin/mcps - Create MCP catalog entry
  // ==========================================================================
  fastify.post('/v1/admin/mcps', async (request, reply) => {
    const body = createMcpSchema.parse(request.body);
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      const entry = await createMcpCatalogEntry(db, {
        name: body.name,
        display_name: body.display_name,
        description: body.description,
        icon_url: body.icon_url,
        transport_type: body.transport_type,
        config: body.config,
        isolation_mode: body.isolation_mode,
        requires_user_credentials: body.requires_user_credentials,
        credential_schema: body.credential_schema,
      });

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'info',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'mcp_created',
        metadata: {
          mcp_id: entry.mcp_id,
          mcp_name: entry.name,
        },
      });

      return reply.status(201).send({ data: entry });
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: err.message,
        });
      }
      throw err;
    }
  });

  // ==========================================================================
  // GET /v1/admin/mcps - List MCP entries
  // ==========================================================================
  fastify.get('/v1/admin/mcps', async (request, reply) => {
    const query = listMcpsQuerySchema.parse(request.query);

    const { entries, has_more, next_cursor } = await listMcpCatalogEntries(
      db,
      {
        status: query.status,
        isolation_mode: query.isolation_mode,
      },
      {
        limit: query.limit,
        cursor: query.cursor,
      }
    );

    const envelope = createPaginationEnvelope(entries, {
      next_cursor: next_cursor || null,
      has_more,
      total_count: entries.length,
    });

    return reply.send(envelope);
  });

  // ==========================================================================
  // GET /v1/admin/mcps/:mcpId - Get MCP entry by ID
  // ==========================================================================
  fastify.get<{ Params: { mcpId: string } }>('/v1/admin/mcps/:mcpId', async (request, reply) => {
    const params = mcpParamsSchema.parse(request.params);

    try {
      const entry = await getMcpCatalogEntry(db, params.mcpId);
      return reply.send({ data: entry });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      throw err;
    }
  });

  // ==========================================================================
  // PATCH /v1/admin/mcps/:mcpId - Update MCP entry
  // ==========================================================================
  fastify.patch<{ Params: { mcpId: string } }>(
    '/v1/admin/mcps/:mcpId',
    async (request, reply) => {
      const params = mcpParamsSchema.parse(request.params);
      const body = updateMcpSchema.parse(request.body);
      const sourceIp = request.ip || '127.0.0.1';
      const nowIso = new Date().toISOString();

      try {
        await updateMcpCatalogEntry(db, params.mcpId, body);

        // Emit audit event
        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: undefined,
          source_ip: sourceIp,
          action: 'mcp_updated',
          metadata: {
            mcp_id: params.mcpId,
            updated_fields: Object.keys(body),
          },
        });

        // Fetch updated entry
        const entry = await getMcpCatalogEntry(db, params.mcpId);
        return reply.send({ data: entry });
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes('not found')) {
            return reply.status(404).send({
              error: 'Not Found',
              message: err.message,
            });
          }
          // MCP-001: Generic message for structural change attempts
          if (err.message === 'PUBLISHED_MCP_STRUCTURAL_CHANGE') {
            return reply.status(422).send({
              error: 'Unprocessable Entity',
              message: 'Cannot modify structural fields on a published MCP. Archive and recreate instead.',
            });
          }
          if (err.message.includes('Cannot modify')) {
            return reply.status(422).send({
              error: 'Unprocessable Entity',
              message: err.message,
            });
          }
        }
        throw err;
      }
    }
  );

  // ==========================================================================
  // DELETE /v1/admin/mcps/:mcpId - Delete MCP entry
  // ==========================================================================
  fastify.delete<{ Params: { mcpId: string } }>(
    '/v1/admin/mcps/:mcpId',
    async (request, reply) => {
      const params = mcpParamsSchema.parse(request.params);
      const sourceIp = request.ip || '127.0.0.1';
      const nowIso = new Date().toISOString();

      try {
        await deleteMcpCatalogEntry(db, params.mcpId);

        // Emit audit event
        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: undefined,
          source_ip: sourceIp,
          action: 'mcp_deleted',
          metadata: {
            mcp_id: params.mcpId,
          },
        });

        return reply.status(204).send();
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes('not found')) {
            return reply.status(404).send({
              error: 'Not Found',
              message: err.message,
            });
          }
          if (err.message.includes('Cannot delete')) {
            return reply.status(422).send({
              error: 'Unprocessable Entity',
              message: err.message,
            });
          }
        }
        throw err;
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/mcps/:mcpId/validate - Trigger validation
  // ==========================================================================
  fastify.post<{ Params: { mcpId: string } }>(
    '/v1/admin/mcps/:mcpId/validate',
    async (request, reply) => {
      const params = mcpParamsSchema.parse(request.params);
      const sourceIp = request.ip || '127.0.0.1';
      const nowIso = new Date().toISOString();

      try {
        // Get entry
        const entry = await getMcpCatalogEntry(db, params.mcpId);

        // Run validation
        const result = await validateMcpConfig(entry);

        // Update validation status
        await updateValidationStatus(
          db,
          params.mcpId,
          result.valid ? 'valid' : 'invalid',
          result
        );

        // Emit audit event
        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action',
          severity: result.valid ? 'info' : 'warn',
          client_id: undefined,
          user_id: undefined,
          source_ip: sourceIp,
          action: 'mcp_validated',
          metadata: {
            mcp_id: params.mcpId,
            validation_status: result.valid ? 'valid' : 'invalid',
            error_count: result.errors.length,
            warning_count: result.warnings.length,
          },
        });

        return reply.send({ data: result });
      } catch (err) {
        if (err instanceof Error && err.message.includes('not found')) {
          return reply.status(404).send({
            error: 'Not Found',
            message: err.message,
          });
        }
        throw err;
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/mcps/:mcpId/publish - Publish MCP
  // ==========================================================================
  fastify.post<{ Params: { mcpId: string } }>(
    '/v1/admin/mcps/:mcpId/publish',
    async (request, reply) => {
      const params = mcpParamsSchema.parse(request.params);
      const sourceIp = request.ip || '127.0.0.1';
      const nowIso = new Date().toISOString();

      try {
        await publishMcpCatalogEntry(db, params.mcpId, 'admin');

        // Emit audit event
        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: undefined,
          source_ip: sourceIp,
          action: 'mcp_published',
          metadata: {
            mcp_id: params.mcpId,
          },
        });

        // Fetch updated entry
        const entry = await getMcpCatalogEntry(db, params.mcpId);
        return reply.send({ data: entry });
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes('not found')) {
            return reply.status(404).send({
              error: 'Not Found',
              message: err.message,
            });
          }
          if (err.message.includes('Cannot publish')) {
            return reply.status(422).send({
              error: 'Unprocessable Entity',
              message: err.message,
            });
          }
        }
        throw err;
      }
    }
  );

  // ==========================================================================
  // POST /v1/admin/mcps/:mcpId/archive - Archive MCP
  // ==========================================================================
  fastify.post<{ Params: { mcpId: string } }>(
    '/v1/admin/mcps/:mcpId/archive',
    async (request, reply) => {
      const params = mcpParamsSchema.parse(request.params);
      const sourceIp = request.ip || '127.0.0.1';
      const nowIso = new Date().toISOString();

      try {
        await archiveMcpEntry(db, params.mcpId);

        // Emit audit event
        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: undefined,
          source_ip: sourceIp,
          action: 'mcp_archived',
          metadata: {
            mcp_id: params.mcpId,
          },
        });

        // Fetch updated entry
        const entry = await getMcpCatalogEntry(db, params.mcpId);
        return reply.send({ data: entry });
      } catch (err) {
        if (err instanceof Error && err.message.includes('not found')) {
          return reply.status(404).send({
            error: 'Not Found',
            message: err.message,
          });
        }
        throw err;
      }
    }
  );

  done();
};
