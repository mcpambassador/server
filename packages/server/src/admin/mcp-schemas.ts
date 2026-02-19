/**
 * MCP Catalog Zod Schemas
 *
 * Request validation schemas for MCP catalog admin endpoints.
 *
 * @see M23.6: Zod Schemas
 */

import { z } from 'zod';

/**
 * Transport type enum
 */
const transportTypeSchema = z.enum(['stdio', 'http', 'sse']);

/**
 * Isolation mode enum
 */
const isolationModeSchema = z.enum(['shared', 'per_user']);

/**
 * Status enum
 */
const statusSchema = z.enum(['draft', 'published', 'archived']);

/**
 * Create MCP catalog entry schema
 */
export const createMcpSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9-_]+$/, 'Name must be lowercase alphanumeric with hyphens/underscores'),
  display_name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon_url: z.string().url().optional().nullable(),
  transport_type: transportTypeSchema,
  config: z.record(z.unknown()),
  isolation_mode: isolationModeSchema.optional(),
  requires_user_credentials: z.boolean().optional(),
  credential_schema: z.record(z.unknown()).optional(),
});

/**
 * Update MCP catalog entry schema (partial)
 */
export const updateMcpSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  icon_url: z.string().url().optional().nullable(),
  transport_type: transportTypeSchema.optional(),
  config: z.record(z.unknown()).optional(),
  isolation_mode: isolationModeSchema.optional(),
  requires_user_credentials: z.boolean().optional(),
  credential_schema: z.record(z.unknown()).optional(),
});

/**
 * MCP params schema (for /:mcpId routes)
 */
export const mcpParamsSchema = z.object({
  mcpId: z.string().uuid(),
});

/**
 * List MCPs query schema
 */
export const listMcpsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 25))
    .pipe(z.number().int().min(1).max(100)),
  status: statusSchema.optional(),
  isolation_mode: isolationModeSchema.optional(),
});

/**
 * Marketplace query schema (simplified - only cursor+limit)
 */
export const marketplaceQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 25))
    .pipe(z.number().int().min(1).max(100)),
});
