/**
 * Client Repository
 * 
 * Data access layer for registered Ambassador Clients.
 * Handles client registration, authentication, lifecycle management.
 * 
 * @see Architecture §3.2 ClientRecord
 * @see schema/index.ts clients table
 */

// @ts-expect-error - drizzle-orm will be installed in M2
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { clients, type Client, type NewClient, type ClientMetadata } from '../../schema/index.js';
// @ts-expect-error - uuid will be installed in M2
import { v4 as uuidv4 } from 'uuid';
// @ts-expect-error - argon2 will be installed in M2
import argon2 from 'argon2';

/**
 * Argon2id parameters (OWASP minimum)
 * @see ADR-006, Security Finding F-004
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Sanitize friendly_name to allowed characters: [a-zA-Z0-9 _.-]
 */
export function sanitizeFriendlyName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 128);
}

/**
 * Register a new client
 * 
 * @param db Database client
 * @param data Client registration data
 * @param apiKey Plaintext API key to hash (only for api_key auth_method)
 * @returns Created client record
 * @throws Error if profile_id doesn't exist (FK validation)
 */
export async function registerClient(
  db: DatabaseClient,
  data: Omit<NewClient, 'client_id' | 'created_at' | 'last_seen_at' | 'api_key_hash'>,
  apiKey?: string
): Promise<Client> {
  const now = new Date().toISOString();
  const client_id = uuidv4();
  
  // Sanitize friendly_name
  const friendly_name = sanitizeFriendlyName(data.friendly_name);
  
  // Hash API key if provided
  let api_key_hash: string | undefined;
  if (data.auth_method === 'api_key' && apiKey) {
    api_key_hash = await argon2.hash(apiKey, ARGON2_OPTIONS);
  }
  
  const newClient: NewClient = {
    client_id,
    friendly_name,
    host_tool: data.host_tool,
    machine_fingerprint: data.machine_fingerprint,
    owner_user_id: data.owner_user_id,
    auth_method: data.auth_method,
    api_key_hash,
    profile_id: data.profile_id,
    status: data.status || 'active',
    created_at: now,
    last_seen_at: now,
    metadata: data.metadata || '{}',
  };
  
  await db.insert(clients).values(newClient);
  
  console.log(`[db:clients] Registered client: ${client_id} (${friendly_name})`);
  
  return newClient as Client;
}

/**
 * Authenticate client with API key
 * 
 * @param db Database client
 * @param client_id Client UUID
 * @param apiKey Plaintext API key
 * @returns Client record if authenticated, null otherwise
 */
export async function authenticateClient(
  db: DatabaseClient,
  client_id: string,
  apiKey: string
): Promise<Client | null> {
  // Timing-safe lookup: fetch by client_id, then verify hash
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.client_id, client_id))
    .limit(1);
  
  if (!client || !client.api_key_hash) {
    return null;
  }
  
  if (client.status !== 'active') {
    console.warn(`[db:clients] Authentication rejected: client ${client_id} status is ${client.status}`);
    return null;
  }
  
  // Timing-safe verification
  try {
    const match = await argon2.verify(client.api_key_hash, apiKey);
    if (!match) {
      return null;
    }
  } catch (err) {
    console.error(`[db:clients] Argon2 verification error for client ${client_id}:`, err);
    return null;
  }
  
  // Update last_seen_at (fire-and-forget with error logging - C-3 fix)
  updateLastSeen(db, client_id).catch(err => {
    console.error(`[db:clients] Failed to update last_seen for ${client_id}:`, err);
  });
  
  return client;
}

/**
 * Get client by ID
 */
export async function getClientById(db: DatabaseClient, client_id: string): Promise<Client | null> {
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.client_id, client_id))
    .limit(1);
  
  return client || null;
}

/**
 * List clients with filtering and pagination
 * 
 * @param db Database client
 * @param filters Optional filters
 * @param pagination Cursor-based pagination (§16.4)
 * @returns Array of clients + pagination metadata
 */
export async function listClients(
  db: DatabaseClient,
  filters?: {
    status?: 'active' | 'suspended' | 'revoked';
    host_tool?: string;
    profile_id?: string;
  },
  pagination?: {
    limit?: number;
    cursor?: string; // last_seen_at ISO timestamp
  }
): Promise<{ clients: Client[]; has_more: boolean; next_cursor?: string }> {
  const limit = pagination?.limit || 25;
  
  let query = db.select().from(clients);
  
  // Apply filters
  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(clients.status, filters.status));
  }
  if (filters?.host_tool) {
    conditions.push(eq(clients.host_tool, filters.host_tool as any));
  }
  if (filters?.profile_id) {
    conditions.push(eq(clients.profile_id, filters.profile_id));
  }
  
  // Cursor pagination (by last_seen_at DESC)
  if (pagination?.cursor) {
    conditions.push(sql`${clients.last_seen_at} < ${pagination.cursor}`);
  }
  
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }
  
  // Order by last_seen_at DESC, limit + 1 to detect has_more
  const results = await query
    .orderBy(desc(clients.last_seen_at))
    .limit(limit + 1);
  
  const has_more = results.length > limit;
  const clientsPage = has_more ? results.slice(0, limit) : results;
  const next_cursor = has_more ? clientsPage[clientsPage.length - 1].last_seen_at : undefined;
  
  return {
    clients: clientsPage,
    has_more,
    next_cursor,
  };
}

/**
 * Update client status (suspend, activate, revoke)
 */
export async function updateClientStatus(
  db: DatabaseClient,
  client_id: string,
  status: 'active' | 'suspended' | 'revoked'
): Promise<void> {
  await db
    .update(clients)
    .set({ status })
    .where(eq(clients.client_id, client_id));
  
  console.log(`[db:clients] Client ${client_id} status updated to ${status}`);
}

/**
 * Update client's last_seen_at timestamp
 */
export async function updateLastSeen(db: DatabaseClient, client_id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(clients)
    .set({ last_seen_at: now })
    .where(eq(clients.client_id, client_id));
}

/**
 * Rotate client API key
 * 
 * @param db Database client
 * @param client_id Client UUID
 * @param newApiKey New plaintext API key
 */
export async function rotateClientApiKey(
  db: DatabaseClient,
  client_id: string,
  newApiKey: string
): Promise<void> {
  const api_key_hash = await argon2.hash(newApiKey, ARGON2_OPTIONS);
  
  await db
    .update(clients)
    .set({ api_key_hash })
    .where(eq(clients.client_id, client_id));
  
  console.log(`[db:clients] API key rotated for client ${client_id}`);
}

/**
 * Update client metadata
 */
export async function updateClientMetadata(
  db: DatabaseClient,
  client_id: string,
  metadata: ClientMetadata
): Promise<void> {
  await db
    .update(clients)
    .set({ metadata: JSON.stringify(metadata) })
    .where(eq(clients.client_id, client_id));
}

/**
 * Delete client (hard delete - use with caution)
 * 
 * Audit events referencing this client are preserved (no FK constraint).
 */
export async function deleteClient(db: DatabaseClient, client_id: string): Promise<void> {
  await db.delete(clients).where(eq(clients.client_id, client_id));
  console.log(`[db:clients] Client deleted: ${client_id}`);
}

/**
 * Count clients by status (for dashboard metrics)
 */
export async function countClientsByStatus(
  db: DatabaseClient
): Promise<{ status: string; count: number }[]> {
  const results = await db
    .select({
      status: clients.status,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(clients)
    .groupBy(clients.status);
  
  return results;
}
