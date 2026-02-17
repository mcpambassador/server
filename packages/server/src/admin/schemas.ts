/**
 * Admin API Validation Schemas
 *
 * Zod schemas for all admin endpoint request validation.
 * All schemas use .strict() to reject unexpected fields (SEC-M8-03).
 *
 * @see dev-plan.md M8: Admin API Implementation
 * @see Architecture §16.4 Admin API Design Principles
 */

import { z } from 'zod';

// ==========================================================================
// PROFILE SCHEMAS
// ==========================================================================

export const createProfileSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().optional(),
    parent_profile_id: z.string().uuid().optional(),
    allowed_tools: z.array(z.string()).optional(),
    denied_tools: z.array(z.string()).optional(),
  })
  .strict();

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    description: z.string().optional(),
    parent_profile_id: z.string().uuid().optional(),
    allowed_tools: z.array(z.string()).optional(),
    denied_tools: z.array(z.string()).optional(),
  })
  .strict();

export const getProfileParamsSchema = z.object({
  profileId: z.string().uuid(),
});

export const listProfilesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  name: z.string().optional(),
  sort: z
    .enum(['name:asc', 'name:desc', 'created_at:asc', 'created_at:desc'])
    .optional()
    .default('name:asc'),
});

// ==========================================================================
// KILL SWITCH SCHEMAS
// ==========================================================================

export const killSwitchSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const killSwitchParamsSchema = z.object({
  target: z.string().min(1),
});

// ==========================================================================
// CLIENT SCHEMAS
// ==========================================================================

export const clientStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'revoked']),
  })
  .strict();

export const updateClientStatusParamsSchema = z.object({
  clientId: z.string().uuid(),
});

export const listClientsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['active', 'suspended', 'revoked']).optional(),
  host_tool: z
    .enum([
      'vscode',
      'claude-desktop',
      'claude-code',
      'opencode',
      'gemini-cli',
      'chatgpt',
      'custom',
    ])
    .optional(),
  sort: z
    .enum(['last_seen_at:asc', 'last_seen_at:desc', 'created_at:asc', 'created_at:desc'])
    .optional()
    .default('last_seen_at:desc'),
});

// ==========================================================================
// AUDIT SCHEMAS
// ==========================================================================

export const listAuditEventsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  client_id: z.string().uuid().optional(),
  event_type: z.string().optional(),
});
