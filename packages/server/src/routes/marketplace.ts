/**
 * Marketplace Routes
 *
 * Public MCP marketplace endpoints for authenticated users.
 * Allows users to browse MCPs accessible to them via their groups.
 *
 * @see M23.4: Marketplace Route Handler
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { requireUserSession } from '../auth/user-session.js';
import { createPaginationEnvelope } from '../admin/pagination.js';
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';
import { marketplaceQuerySchema } from '../admin/mcp-schemas.js';
import { getAccessibleMcps } from '../services/mcp-catalog-service.js';

/**
 * Marketplace routes config
 */
export interface MarketplaceRoutesConfig {
  db: DatabaseClient;
}

/**
 * Register marketplace routes
 *
 * Routes:
 * - GET /v1/marketplace - Browse published MCPs accessible to user
 * - GET /v1/marketplace/:id - Get details of a specific MCP
 */
export async function registerMarketplaceRoutes(
  fastify: FastifyInstance,
  config: MarketplaceRoutesConfig
): Promise<void> {
  const { db } = config;

  // ==========================================================================
  // GET /v1/marketplace - Browse published MCPs
  // ==========================================================================
  fastify.get(
    '/v1/marketplace',
    { preHandler: requireUserSession },
    async (request, reply) => {
      // Get user ID from session
      const userId = request.session.userId;
      if (!userId) {
        return reply.status(401).send(
          wrapError(ErrorCodes.UNAUTHORIZED, 'User session required')
        );
      }

      // Parse query params
      const query = marketplaceQuerySchema.parse(request.query);

      try {
        // Get all MCPs accessible to user (via groups)
        const mcps = await getAccessibleMcps(db, userId);

        // Transform database rows to API contract format
        const transformedMcps = mcps.map((mcp) => {
          // Parse JSON fields safely
          let tools = [];
          try {
            const catalogData = typeof mcp.tool_catalog === 'string' 
              ? JSON.parse(mcp.tool_catalog) 
              : mcp.tool_catalog;
            tools = Array.isArray(catalogData) ? catalogData : [];
          } catch (err) {
            console.warn(`[Marketplace] Failed to parse tool_catalog for MCP ${mcp.mcp_id}:`, err);
          }

          let credentialSchema = undefined;
          if (mcp.credential_schema) {
            try {
              credentialSchema = typeof mcp.credential_schema === 'string'
                ? JSON.parse(mcp.credential_schema)
                : mcp.credential_schema;
            } catch (err) {
              console.warn(`[Marketplace] Failed to parse credential_schema for MCP ${mcp.mcp_id}:`, err);
            }
          }

          // Map snake_case database fields to camelCase API fields
          return {
            id: mcp.mcp_id,
            name: mcp.display_name || mcp.name, // Use display_name for user-facing name
            description: mcp.description || undefined,
            isolationMode: mcp.isolation_mode as 'shared' | 'per-user',
            requiresUserCredentials: mcp.requires_user_credentials || false,
            credentialSchema,
            tools,
            createdAt: mcp.created_at,
            updatedAt: mcp.updated_at,
          };
        });

        // Apply cursor pagination (by display name for consistent ordering)
        let filteredMcps = transformedMcps;
        if (query.cursor) {
          const cursor = query.cursor;
          filteredMcps = transformedMcps.filter((mcp) => mcp.name > cursor);
        }

        // Sort by name for consistent ordering
        filteredMcps.sort((a, b) => a.name.localeCompare(b.name));

        // Paginate
        const limit = query.limit || 25;
        const has_more = filteredMcps.length > limit;
        const page = has_more ? filteredMcps.slice(0, limit) : filteredMcps;
        const lastItem = page[page.length - 1];
        const next_cursor = has_more && lastItem ? lastItem.name : null;

        const envelope = createPaginationEnvelope(page, {
          next_cursor,
          has_more,
          total_count: page.length,
        });

        return reply.send(envelope);
      } catch (err) {
        console.error('[Marketplace] Error fetching MCPs:', err);
        return reply.status(500).send(
          wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to fetch marketplace MCPs')
        );
      }
    }
  );

  // ==========================================================================
  // GET /v1/marketplace/:id - Get MCP details
  // ==========================================================================
  fastify.get<{ Params: { id: string } }>(
    '/v1/marketplace/:id',
    { preHandler: requireUserSession },
    async (request, reply) => {
      // Get user ID from session
      const userId = request.session.userId;
      if (!userId) {
        return reply.status(401).send(
          wrapError(ErrorCodes.UNAUTHORIZED, 'User session required')
        );
      }

      const mcpId = request.params.id;

      try {
        // Get all accessible MCPs for the user and check if this one is accessible
        const accessibleMcps = await getAccessibleMcps(db, userId);
        const mcp = accessibleMcps.find(m => m.mcp_id === mcpId);

        if (!mcp) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, 'MCP not found or not accessible')
          );
        }

        // Transform to API format (same as list endpoint)
        let tools = [];
        try {
          const catalogData = typeof mcp.tool_catalog === 'string'
            ? JSON.parse(mcp.tool_catalog)
            : mcp.tool_catalog;
          tools = Array.isArray(catalogData) ? catalogData : [];
        } catch (err) {
          console.warn(`[Marketplace] Failed to parse tool_catalog for MCP ${mcp.mcp_id}:`, err);
        }

        let credentialSchema = undefined;
        if (mcp.credential_schema) {
          try {
            credentialSchema = typeof mcp.credential_schema === 'string'
              ? JSON.parse(mcp.credential_schema)
              : mcp.credential_schema;
          } catch (err) {
            console.warn(`[Marketplace] Failed to parse credential_schema for MCP ${mcp.mcp_id}:`, err);
          }
        }

        const response = {
          id: mcp.mcp_id,
          name: mcp.display_name || mcp.name,
          description: mcp.description || undefined,
          isolationMode: mcp.isolation_mode as 'shared' | 'per-user',
          requiresUserCredentials: mcp.requires_user_credentials || false,
          credentialSchema,
          tools,
          createdAt: mcp.created_at,
          updatedAt: mcp.updated_at,
        };

        return reply.send(wrapSuccess(response));
      } catch (err) {
        console.error('[Marketplace] Error fetching MCP details:', err);
        return reply.status(500).send(
          wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to fetch MCP details')
        );
      }
    }
  );
}
