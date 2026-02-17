/**
 * Client Registration
 * 
 * Handles POST /v1/clients/register for API key client onboarding.
 * 
 * Security requirements:
 * - Rate limiting: 10 registrations/hour per source IP
 * - Max clients: 50 (Community tier)
 * - Body size validation: 4KB max
 * - Friendly name sanitization
 * 
 * @see Architecture §6.1 Registration Endpoint
 * @see Security Finding F-001
 */

import { v4 as uuidv4 } from 'uuid';
import type { DatabaseClient } from '@mcpambassador/core';
import { logger, AmbassadorError } from '@mcpambassador/core';
import { generateApiKey, hashApiKey } from './keys.js';
import { RateLimiter } from './utils/rate-limiter.js';
import { hashIp, redactIp } from './utils/privacy.js';

/**
 * Registration request body
 */
export interface RegisterClientRequest {
  friendly_name: string;
  host_tool: 'vscode' | 'claude-desktop' | 'claude-code' | 'opencode' | 'gemini-cli' | 'chatgpt' | 'custom';
  machine_fingerprint?: string;
  profile_id?: string; // Optional: defaults to 'all-tools' profile
}

/**
 * Registration response
 */
export interface RegisterClientResponse {
  client_id: string;
  api_key: string; // Plain key - shown only once
  friendly_name: string;
  profile_id: string;
  created_at: string;
  message: string; // Instructions to save the key
}

// F-SEC-M4-010: Use extracted RateLimiter utility
const registrationRateLimiter = new RateLimiter();

// Cleanup every 5 minutes
setInterval(() => registrationRateLimiter.cleanup(), 5 * 60 * 1000);

/**
 * Register a new client
 * 
 * @param db Database client
 * @param request Registration request
 * @param sourceIp Source IP address for rate limiting
 * @param maxClients Maximum allowed clients (default: 50 for Community)
 * @returns Registration response with api_key
 */
export async function registerClient(
  db: DatabaseClient,
  request: RegisterClientRequest,
  sourceIp: string,
  maxClients: number = 50
): Promise<RegisterClientResponse> {
  // Rate limiting check (10/hour per source IP per F-001)
  if (!registrationRateLimiter.check(sourceIp, 10, 60 * 60 * 1000)) {
    throw new AmbassadorError(
      'Registration rate limit exceeded - try again in 1 hour',
      'rate_limit_exceeded',
      429
    );
  }

  // Validate input
  if (!request.friendly_name || !request.host_tool) {
    throw new AmbassadorError(
      'Missing required fields: friendly_name and host_tool',
      'validation_error',
      400
    );
  }

  // Sanitize friendly_name (alphanumeric, spaces, dots, hyphens, underscores, max 128 chars)
  const sanitizedName = request.friendly_name
    .replace(/[^a-zA-Z0-9 ._-]/g, '')
    .substring(0, 128)
    .trim();

  if (!sanitizedName) {
    throw new AmbassadorError(
      'friendly_name must contain at least one valid character (alphanumeric, space, dot, dash, underscore)',
      'validation_error',
      400
    );
  }

  // Check max clients limit (per F-001)
  const currentClientCount = await db.query.clients.findMany({
    where: (clients, { ne }) => ne(clients.status, 'revoked'),
  });

  if (currentClientCount.length >= maxClients) {
    throw new AmbassadorError(
      `Maximum client limit reached (${maxClients}). Contact administrator.`,
      'max_clients_exceeded',
      403
    );
  }

  // Get default profile if not specified
  let profileId = request.profile_id;
  if (!profileId) {
    const defaultProfile = await db.query.tool_profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.name, 'all-tools'),
    });

    if (!defaultProfile) {
      throw new AmbassadorError(
        'Default profile "all-tools" not found - database not seeded',
        'internal_error',
        500
      );
    }

    profileId = defaultProfile.profile_id;
  } else {
    // Verify profile exists
    const profile = await db.query.tool_profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.profile_id, profileId),
    });

    if (!profile) {
      throw new AmbassadorError(
        `Profile ${profileId} not found`,
        'validation_error',
        400
      );
    }
  }

  // Generate API key and hash
  const clientId = uuidv4();
  const apiKey = generateApiKey('amb_sk');
  const apiKeyHash = await hashApiKey(apiKey);

  // Create client record
  const now = new Date().toISOString();
  await db.insert().into('clients').values({
    client_id: clientId,
    friendly_name: sanitizedName,
    host_tool: request.host_tool,
    machine_fingerprint: request.machine_fingerprint || null,
    owner_user_id: null, // Community tier - no user linkage
    auth_method: 'api_key',
    api_key_hash: apiKeyHash,
    profile_id: profileId,
    status: 'active',
    created_at: now,
    last_seen_at: now,
    // F-SEC-M4-007: Hash source IP for privacy compliance (GDPR)
    metadata: JSON.stringify({ source_ip_hash: hashIp(sourceIp) }),
  }).run();

  // F-SEC-M4-007: Redact IP in logs (show first octet only)
  logger.info(`[registration] Client registered: ${clientId} (${sanitizedName}) from ${redactIp(sourceIp)}`);

  return {
    client_id: clientId,
    api_key: apiKey, // Plain key - only shown once!
    friendly_name: sanitizedName,
    profile_id: profileId,
    created_at: now,
    message: 'IMPORTANT: Save this API key securely - it will not be shown again. Configure your client with X-API-Key and X-Client-Id headers.',
  };
}
