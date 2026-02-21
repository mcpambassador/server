/**
 * Client Service
 *
 * Business logic layer for user self-service client management.
 * Handles client CRUD operations with key generation and validation.
 *
 * @see M25.1: Client Service
 * @see Architecture §4.1 Client Key Management
 */

import crypto from 'crypto';
import argon2 from 'argon2';
import type { DatabaseClient } from '@mcpambassador/core';
import { clients, client_mcp_subscriptions, compatInsert, compatUpdate, compatSelect, compatTransaction } from '@mcpambassador/core';
import { eq, and } from 'drizzle-orm';

// CR-L3: Define constant for client key generation
const CLIENT_KEY_BYTES = 36; // 36 bytes → 48 base64 chars

export interface ClientWithKey {
  client: {
    client_id: string;
    client_name: string;
    key_prefix: string;
    user_id: string;
    profile_id: string | null;
    status: string;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    metadata: string;
    created_by: string | null;
    key_hash: string;
  };
  plaintextKey: string;
}

/**
 * Create a new client for a user with generated preshared key
 *
 * @param db Database client
 * @param data Client creation data
 * @returns Client record and plaintext key (only time it's ever returned)
 */
export async function createUserClient(
  db: DatabaseClient,
  data: {
    userId: string;
    clientName: string;
    profileId: string | null;
    expiresAt?: string | null;
  }
): Promise<ClientWithKey> {
  // Verify user exists and is active
  const userRecord = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.user_id, data.userId),
  });

  if (!userRecord) {
    throw new Error('User not found');
  }

  if (userRecord.status !== 'active') {
    throw new Error('User is not active');
  }

  // Verify profile exists if provided
  if (data.profileId) {
    const profileId = data.profileId; // Type narrowing for callback
    const profile = await db.query.tool_profiles.findFirst({
      where: (p, { eq }) => eq(p.profile_id, profileId),
    });

    if (!profile) {
      throw new Error('Profile not found');
    }
  }

  // Generate preshared key: amb_pk_ + 48 chars of base64url
  const randomBytes = crypto.randomBytes(CLIENT_KEY_BYTES);
  const base64url = randomBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const clientKey = `amb_pk_${base64url}`;

  // Extract prefix: first 8 chars after amb_pk_
  const keyPrefix = base64url.substring(0, 8);

  // Hash with Argon2id (same settings as admin)
  const keyHash = await argon2.hash(clientKey, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const clientId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  await compatInsert(db, clients).values({
    client_id: clientId,
    key_prefix: keyPrefix,
    key_hash: keyHash,
    client_name: data.clientName,
    user_id: data.userId,
    profile_id: data.profileId,
    status: 'active',
    created_by: data.userId,
    created_at: nowIso,
    expires_at: data.expiresAt || null,
    metadata: '{}',
  });

  console.log(`[ClientService] User ${data.userId} created client ${clientId}`);

  // CR-H1: Add null check instead of non-null assertion
  const createdClient = await db.query.clients.findFirst({
    where: (k, { eq }) => eq(k.client_id, clientId),
  });

  if (!createdClient) {
    throw new Error(`Failed to retrieve created client ${clientId}`);
  }

  return {
    client: {
      client_id: createdClient.client_id,
      client_name: createdClient.client_name,
      key_prefix: createdClient.key_prefix,
      key_hash: createdClient.key_hash,
      user_id: createdClient!.user_id,
      profile_id: createdClient!.profile_id,
      status: createdClient!.status,
      created_by: createdClient!.created_by,
      created_at: createdClient!.created_at,
      expires_at: createdClient!.expires_at,
      last_used_at: createdClient!.last_used_at,
      metadata: createdClient!.metadata || '{}',
    },
    plaintextKey: clientKey,
  };
}

/**
 * List all clients for a user
 *
 * @param db Database client
 * @param userId User UUID
 * @returns Array of client records
 */
export async function listUserClients(db: DatabaseClient, userId: string) {
  return compatSelect(db)
    .from(clients)
    .where(eq(clients.user_id, userId));
}

/**
 * Get a specific client, verifying ownership
 *
 * @param db Database client
 * @param userId User UUID
 * @param clientId Client UUID
 * @returns Client record
 * @throws Error if not found or user doesn't own the client
 */
export async function getUserClient(
  db: DatabaseClient,
  userId: string,
  clientId: string
) {
  const [client] = await compatSelect(db)
    .from(clients)
    .where(and(eq(clients.client_id, clientId), eq(clients.user_id, userId)))
    .limit(1);

  if (!client) {
    throw new Error('Client not found or access denied');
  }

  return client;
}

/**
 * Suspend a client
 *
 * @param db Database client
 * @param userId User UUID (for ownership verification)
 * @param clientId Client UUID
 */
export async function suspendUserClient(
  db: DatabaseClient,
  userId: string,
  clientId: string
): Promise<void> {
  // Verify ownership
  await getUserClient(db, userId, clientId);

  await compatUpdate(db, clients)
    .set({ status: 'suspended' })
    .where(and(eq(clients.client_id, clientId), eq(clients.user_id, userId)));

  console.log(`[ClientService] User ${userId} suspended client ${clientId}`);
}

/**
 * Reactivate a suspended client
 *
 * @param db Database client
 * @param userId User UUID (for ownership verification)
 * @param clientId Client UUID
 */
export async function reactivateUserClient(
  db: DatabaseClient,
  userId: string,
  clientId: string
): Promise<void> {
  // Verify ownership
  const client = await getUserClient(db, userId, clientId);

  if (client.status !== 'suspended') {
    throw new Error(`Client ${clientId} is not suspended (current status: ${client.status})`);
  }

  await compatUpdate(db, clients)
    .set({ status: 'active' })
    .where(and(eq(clients.client_id, clientId), eq(clients.user_id, userId)));

  console.log(`[ClientService] User ${userId} reactivated client ${clientId}`);
}

/**
 * Revoke a client and cascade all subscriptions to 'removed'
 *
 * @param db Database client
 * @param userId User UUID (for ownership verification)
 * @param clientId Client UUID
 */
export async function revokeUserClient(
  db: DatabaseClient,
  userId: string,
  clientId: string
): Promise<void> {
  // Verify ownership
  await getUserClient(db, userId, clientId);

  const now = new Date().toISOString();

  // CR-M4: Wrap in transaction for atomicity
  await compatTransaction(db, async () => {
    // Update client status
    await compatUpdate(db, clients)
      .set({ status: 'revoked' })
      .where(and(eq(clients.client_id, clientId), eq(clients.user_id, userId)));

    // Cascade subscriptions to 'removed'
    await compatUpdate(db, client_mcp_subscriptions)
      .set({ status: 'removed', updated_at: now })
      .where(eq(client_mcp_subscriptions.client_id, clientId));
  });

  console.log(`[ClientService] User ${userId} revoked client ${clientId} and cascaded subscriptions`);
}

/**
 * Update client name
 *
 * @param db Database client
 * @param userId User UUID (for ownership verification)
 * @param clientId Client UUID
 * @param clientName New client name
 */
export async function updateUserClientName(
  db: DatabaseClient,
  userId: string,
  clientId: string,
  clientName: string
): Promise<void> {
  // Verify ownership
  await getUserClient(db, userId, clientId);

  await compatUpdate(db, clients)
    .set({ client_name: clientName })
    .where(and(eq(clients.client_id, clientId), eq(clients.user_id, userId)));

  console.log(`[ClientService] User ${userId} updated client ${clientId} name`);
}
