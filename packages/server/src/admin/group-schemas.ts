/**
 * Group Route Schemas
 *
 * Zod schemas for group management endpoint validation.
 * All schemas use .strict() to reject unexpected fields.
 *
 * @see M22.2: Group Route Handlers
 */

import { z } from 'zod';
import {
  assignGroupMcpRequestSchema,
  groupToolPolicyRequestSchema,
} from '@mcpambassador/contracts';

// ==========================================================================
// GROUP SCHEMAS
// ==========================================================================

export const createGroupSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
        'Group name must start with alphanumeric and contain only letters, numbers, spaces, hyphens, and underscores'
      ),
    description: z.string().optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();

export const updateGroupSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
        'Group name must start with alphanumeric and contain only letters, numbers, spaces, hyphens, and underscores'
      )
      .optional(),
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

// ADR-025: optional per-tool policy (defaults to 'all'); shared with the SPA via contracts.
export const assignGroupMcpSchema = assignGroupMcpRequestSchema;
export const putGroupMcpToolsSchema = groupToolPolicyRequestSchema;

export const groupMcpParamsSchema = z.object({
  groupId: z.string().uuid(),
  mcpId: z.string().uuid(),
});

export const mcpToolsParamsSchema = z.object({
  mcpId: z.string().uuid(),
});
