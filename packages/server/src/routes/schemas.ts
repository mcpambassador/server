/**
 * User Route Schemas
 *
 * Zod validation schemas for user-facing client and subscription routes.
 *
 * @see M25.6: Zod Schemas
 */

import { z } from 'zod';

// ==========================================================================
// CLIENT SCHEMAS
// ==========================================================================

export const createClientSchema = z.object({
  client_name: z.string().min(1).max(255),
  profile_id: z.string().uuid(),
}).strict();

export const updateClientSchema = z.object({
  client_name: z.string().min(1).max(255).optional(),
  status: z.enum(['active', 'suspended']).optional(),
}).strict();

export const clientIdParamsSchema = z.object({
  clientId: z.string().uuid(),
});

// ==========================================================================
// SUBSCRIPTION SCHEMAS
// ==========================================================================

export const createSubscriptionSchema = z.object({
  mcp_id: z.string().uuid(),
  selected_tools: z.array(z.string()).optional(),
}).strict();

export const updateSubscriptionSchema = z.object({
  selected_tools: z.array(z.string()).optional(),
  status: z.enum(['active', 'paused']).optional(),
}).strict();

export const subscriptionParamsSchema = z.object({
  clientId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
});

export const clientSubscriptionParamsSchema = z.object({
  clientId: z.string().uuid(),
});

// ==========================================================================
// CREDENTIAL SCHEMAS
// ==========================================================================

export const credentialParamsSchema = z.object({
  mcpId: z.string().uuid(),
});

// SEC-M5: Credential values should be strings only (not arbitrary objects)
export const setCredentialBodySchema = z.object({
  credentials: z.record(z.string(), z.string()),
}).strict();
