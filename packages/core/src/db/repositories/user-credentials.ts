/**
 * User MCP Credentials Repository
 *
 * Data access layer for encrypted per-user MCP credentials.
 * Manages secure storage of user-specific authentication data for per-user MCPs.
 *
 * @see Architecture §4.3 Per-User Credential Management
 * @see SEC-V2-004 Credential Vault
 * @see schema/index.ts user_mcp_credentials table
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable no-console, @typescript-eslint/require-await */

import { eq, and } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  user_mcp_credentials,
  type UserMcpCredential,
  type NewUserMcpCredential,
} from '../../schema/index.js';
import { v4 as uuidv4 } from 'uuid';
import { compatInsert, compatSelect, compatUpdate, compatDelete } from '../compat.js';

/**
 * Store encrypted credential for user-MCP pair
 *
 * @param db Database client
 * @param data Credential data (encrypted)
 * @returns Created credential record
 */
export async function storeCredential(
  db: DatabaseClient,
  data: { user_id: string; mcp_id: string; encrypted_credentials: string; encryption_iv: string }
): Promise<UserMcpCredential> {
  const now = new Date().toISOString();
  const credential_id = uuidv4();

  const newCredential: NewUserMcpCredential = {
    credential_id,
    user_id: data.user_id,
    mcp_id: data.mcp_id,
    encrypted_credentials: data.encrypted_credentials,
    encryption_iv: data.encryption_iv,
    created_at: now,
    updated_at: now,
  };

  await compatInsert(db, user_mcp_credentials).values(newCredential);

  console.log(
    `[db:user-credentials] Stored credential: ${credential_id} (user ${data.user_id} -> MCP ${data.mcp_id})`
  );

  return newCredential as UserMcpCredential;
}

/**
 * Get credential for user-MCP pair
 *
 * @param db Database client
 * @param user_id User UUID
 * @param mcp_id MCP UUID
 * @returns Credential or null if not found
 */
export async function getCredential(
  db: DatabaseClient,
  user_id: string,
  mcp_id: string
): Promise<UserMcpCredential | null> {
  const [credential] = await compatSelect(db)
    .from(user_mcp_credentials)
    .where(
      and(eq(user_mcp_credentials.user_id, user_id), eq(user_mcp_credentials.mcp_id, mcp_id))
    )
    .limit(1);

  return credential || null;
}

/**
 * List all credentials for a user
 *
 * @param db Database client
 * @param user_id User UUID
 * @returns Array of credentials
 */
export async function listCredentialsForUser(
  db: DatabaseClient,
  user_id: string
): Promise<UserMcpCredential[]> {
  return compatSelect(db)
    .from(user_mcp_credentials)
    .where(eq(user_mcp_credentials.user_id, user_id));
}

/**
 * Update credential
 *
 * Updates the encrypted credentials and IV for an existing credential record.
 *
 * @param db Database client
 * @param credential_id Credential UUID
 * @param data New encrypted credentials and IV
 */
export async function updateCredential(
  db: DatabaseClient,
  credential_id: string,
  data: { encrypted_credentials: string; encryption_iv: string }
): Promise<void> {
  const now = new Date().toISOString();

  await compatUpdate(db, user_mcp_credentials)
    .set({
      encrypted_credentials: data.encrypted_credentials,
      encryption_iv: data.encryption_iv,
      updated_at: now,
    })
    .where(eq(user_mcp_credentials.credential_id, credential_id));

  console.log(`[db:user-credentials] Credential updated: ${credential_id}`);
}

/**
 * Delete credential by ID
 *
 * @param db Database client
 * @param credential_id Credential UUID
 */
export async function deleteCredential(db: DatabaseClient, credential_id: string): Promise<void> {
  await compatDelete(db, user_mcp_credentials).where(
    eq(user_mcp_credentials.credential_id, credential_id)
  );

  console.log(`[db:user-credentials] Credential deleted: ${credential_id}`);
}

/**
 * Delete credentials for user-MCP pair
 *
 * Useful when a user revokes access to an MCP.
 *
 * @param db Database client
 * @param user_id User UUID
 * @param mcp_id MCP UUID
 */
export async function deleteCredentialsForMcp(
  db: DatabaseClient,
  user_id: string,
  mcp_id: string
): Promise<void> {
  await compatDelete(db, user_mcp_credentials).where(
    and(eq(user_mcp_credentials.user_id, user_id), eq(user_mcp_credentials.mcp_id, mcp_id))
  );

  console.log(`[db:user-credentials] Credentials deleted for user ${user_id}, MCP ${mcp_id}`);
}
