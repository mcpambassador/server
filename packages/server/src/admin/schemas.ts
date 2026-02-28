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

// ==========================================================================
// USER SCHEMAS (M18)
// ==========================================================================

export const createUserSchema = z
  .object({
    display_name: z.string().min(1).max(256),
    email: z.string().email().optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    display_name: z.string().min(1).max(256).optional(),
    email: z.string().email().optional(),
    status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  })
  .strict();

export const updateUserParamsSchema = z.object({
  userId: z.string().uuid(),
});

export const listUsersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  sort: z
    .enum(['display_name:asc', 'display_name:desc', 'created_at:asc', 'created_at:desc'])
    .optional()
    .default('display_name:asc'),
});

// ==========================================================================
// CLIENT SCHEMAS (M18)
// ==========================================================================

export const createClientSchema = z
  .object({
    user_id: z.string().uuid(),
    profile_id: z.string().uuid(),
    client_name: z.string().min(1).max(256),
    expires_at: z.string().datetime().optional(),
  })
  .strict();

export const updateClientSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'revoked']).optional(),
    profile_id: z.string().uuid().optional(),
  })
  .strict();

export const updateClientParamsSchema = z.object({
  clientId: z.string().uuid(),
});

export const listClientKeysQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  user_id: z.string().uuid().optional(),
  status: z.enum(['active', 'suspended', 'revoked']).optional(),
  sort: z
    .enum(['created_at:asc', 'created_at:desc', 'client_name:asc', 'client_name:desc'])
    .optional()
    .default('created_at:desc'),
});

// ==========================================================================
// SESSION SCHEMAS (M18)
// ==========================================================================

export const listSessionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  user_id: z.string().uuid().optional(),
  status: z.enum(['active', 'idle', 'spinning_down', 'suspended', 'expired']).optional(),
  sort: z
    .enum(['last_activity_at:asc', 'last_activity_at:desc', 'created_at:asc', 'created_at:desc'])
    .optional()
    .default('last_activity_at:desc'),
});

export const deleteSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

// ==========================================================================
// HMAC SECRET ROTATION SCHEMA (M19.2a)
// ==========================================================================

export const rotateHmacSecretResponseSchema = z.object({
  success: z.boolean(),
  sessionsInvalidated: z.number().int().min(0),
  message: z.string(),
});
