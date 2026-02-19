/**
 * Group Route Schemas
 *
 * Zod schemas for group management endpoint validation.
 * All schemas use .strict() to reject unexpected fields.
 *
 * @see M22.2: Group Route Handlers
 */

import { z } from 'zod';

// ==========================================================================
// GROUP SCHEMAS
// ==========================================================================

export const createGroupSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();

export const updateGroupSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    description: z.string().optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();

export const groupParamsSchema = z.object({
  groupId: z.string().uuid(),
});

export const listGroupsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ==========================================================================
// GROUP MEMBER SCHEMAS
// ==========================================================================

export const addGroupMemberSchema = z
  .object({
    user_id: z.string().uuid(),
  })
  .strict();

export const groupMemberParamsSchema = z.object({
  groupId: z.string().uuid(),
  userId: z.string().uuid(),
});

// ==========================================================================
// GROUP MCP SCHEMAS
// ==========================================================================

export const assignGroupMcpSchema = z
  .object({
    mcp_id: z.string().uuid(),
  })
  .strict();

export const groupMcpParamsSchema = z.object({
  groupId: z.string().uuid(),
  mcpId: z.string().uuid(),
});
