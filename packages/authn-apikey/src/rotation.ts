/**
 * API Key Rotation
 *
 * Handles POST /v1/clients/{id}/rotate-key for key rotation.
 *
 * Requires current valid API key. Generates new key, invalidates old hash.
 *
 * @see Architecture §9.3 Key Rotation
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

import type { DatabaseClient } from '@mcpambassador/core';
import { logger, AmbassadorError, compatUpdate, clients } from '@mcpambassador/core';
import { eq } from 'drizzle-orm';
import { generateApiKey, hashApiKey } from './keys.js';

/**
 * Key rotation response
 */
export interface RotateKeyResponse {
  client_id: string;
  api_key: string; // New plain key - shown only once
  rotated_at: string;
  message: string;
}

/**
 * Rotate client API key
 *
 * @param db Database client
 * @param clientId Client ID to rotate key for
 * @param currentApiKey Current API key (for verification)
 * @returns New API key
 */
export async function rotateClientKey(
  db: DatabaseClient,
  clientId: string,
  currentApiKey: string
): Promise<RotateKeyResponse> {
  // Verify client exists and current key is valid
  const client = await db.query.clients.findFirst({
    where: (clients, { eq }) => eq(clients.client_id, clientId),
  });

  if (!client) {
    throw new AmbassadorError('Client not found', 'not_found', 404);
  }

  if (client.status !== 'active') {
    throw new AmbassadorError(
      `Cannot rotate key for client with status: ${client.status}`,
      'client_suspended',
      403
    );
  }

  // Verify current API key (prevent unauthorized key rotation)
  const argon2 = await import('argon2');
  const isValid = await argon2.verify(client.api_key_hash!, currentApiKey);

  if (!isValid) {
    throw new AmbassadorError('Invalid current API key', 'invalid_credentials', 401);
  }

  // Generate new key and hash
  const newApiKey = generateApiKey('amb_sk');
  const newApiKeyHash = await hashApiKey(newApiKey);

  // Update database
  const now = new Date().toISOString();
  await compatUpdate(db, clients)
    .set({
      api_key_hash: newApiKeyHash,
      last_seen_at: now,
    })
    .where(eq(clients.client_id, clientId));

  logger.info(`[key-rotation] Client key rotated: ${clientId}`);

  return {
    client_id: clientId,
    api_key: newApiKey,
    rotated_at: now,
    message: 'IMPORTANT: Save this new API key securely - the old key is now invalid.',
  };
}
