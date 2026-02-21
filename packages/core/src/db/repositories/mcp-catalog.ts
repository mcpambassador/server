/**
 * MCP Catalog Repository
 *
 * Data access layer for MCP catalog entries and group access control.
 * Manages the central catalog of available MCPs and their configuration.
 *
 * @see Architecture §4 MCP Catalog Management
 * @see schema/index.ts mcp_catalog, mcp_group_access tables
 */

import { eq, and, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  mcp_catalog,
  mcp_group_access,
  type McpCatalogEntry,
  type NewMcpCatalogEntry,
  type McpGroupAccess,
  type NewMcpGroupAccess,
} from '../../schema/index.js';
import { v4 as uuidv4 } from 'uuid';
import { compatInsert, compatSelect, compatUpdate, compatDelete } from '../compat.js';

/**
 * Create a new MCP catalog entry
 *
 * @param db Database client
 * @param data MCP catalog entry data
 * @returns Created MCP entry
 */
export async function createMcpEntry(
  db: DatabaseClient,
  data: Omit<NewMcpCatalogEntry, 'mcp_id' | 'created_at' | 'updated_at'>
): Promise<McpCatalogEntry> {
  const now = new Date().toISOString();
  const mcp_id = uuidv4();

  const newEntry: NewMcpCatalogEntry = {
    mcp_id,
    name: data.name,
    display_name: data.display_name,
    description: data.description || '',
    icon_url: data.icon_url || null,
    transport_type: data.transport_type,
    config: data.config || '{}',
    isolation_mode: data.isolation_mode || 'shared',
    requires_user_credentials: data.requires_user_credentials ?? false,
    credential_schema: data.credential_schema || '{}',
    tool_catalog: data.tool_catalog || '[]',
    tool_count: data.tool_count || 0,
    status: data.status || 'draft',
    published_by: data.published_by || null,
    published_at: data.published_at || null,
    validation_status: data.validation_status || 'pending',
    validation_result: data.validation_result || '{}',
    last_validated_at: data.last_validated_at || null,
    created_at: now,
    updated_at: now,
  };

  await compatInsert(db, mcp_catalog).values(newEntry);

  console.log(`[db:mcp-catalog] Created MCP entry: ${mcp_id} (${newEntry.name})`);

  return newEntry as McpCatalogEntry;
}

/**
 * Get MCP entry by ID
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @returns MCP entry or null if not found
 */
export async function getMcpEntryById(
  db: DatabaseClient,
  mcp_id: string
): Promise<McpCatalogEntry | null> {
  const [entry] = await compatSelect(db)
    .from(mcp_catalog)
    .where(eq(mcp_catalog.mcp_id, mcp_id))
    .limit(1);

  return entry || null;
}

/**
 * Get MCP entry by name
 *
 * @param db Database client
 * @param name MCP name (unique)
 * @returns MCP entry or null if not found
 */
export async function getMcpEntryByName(
  db: DatabaseClient,
  name: string
): Promise<McpCatalogEntry | null> {
  const [entry] = await compatSelect(db)
    .from(mcp_catalog)
    .where(eq(mcp_catalog.name, name))
    .limit(1);

  return entry || null;
}

/**
 * List MCP catalog entries with optional filters
 *
 * @param db Database client
 * @param filters Optional status and isolation mode filters
 * @param pagination Cursor-based pagination
 * @returns Array of MCP entries + pagination metadata
 */
export async function listMcpEntries(
  db: DatabaseClient,
  filters?: { status?: string; isolation_mode?: string },
  pagination?: {
    limit?: number;
    cursor?: string; // MCP name (lexicographic sort)
  }
): Promise<{ entries: McpCatalogEntry[]; has_more: boolean; next_cursor?: string }> {
  const limit = pagination?.limit || 25;

  let query = compatSelect(db).from(mcp_catalog);

  // Apply filters
  const conditions = [];
  if (filters?.status) {
    conditions.push(sql`${mcp_catalog.status} = ${filters.status}`);
  }
  if (filters?.isolation_mode) {
    conditions.push(sql`${mcp_catalog.isolation_mode} = ${filters.isolation_mode}`);
  }

  // Cursor pagination (by name ASC)
  if (pagination?.cursor) {
    conditions.push(sql`${mcp_catalog.name} > ${pagination.cursor}`);
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const results = await query.orderBy(mcp_catalog.name).limit(limit + 1);

  const has_more = results.length > limit;
  const entriesPage = has_more ? results.slice(0, limit) : results;
  const next_cursor = has_more ? entriesPage[entriesPage.length - 1].name : undefined;

  return {
    entries: entriesPage,
    has_more,
    next_cursor,
  };
}

/**
 * Update MCP catalog entry
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @param updates Partial MCP entry data to update
 */
export async function updateMcpEntry(
  db: DatabaseClient,
  mcp_id: string,
  updates: Partial<Omit<McpCatalogEntry, 'mcp_id' | 'created_at'>>
): Promise<void> {
  const now = new Date().toISOString();

  await compatUpdate(db, mcp_catalog)
    .set({ ...updates, updated_at: now })
    .where(eq(mcp_catalog.mcp_id, mcp_id));

  console.log(`[db:mcp-catalog] MCP entry updated: ${mcp_id}`);
}

/**
 * Delete MCP catalog entry
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @throws Error if subscriptions exist (FK constraint CASCADE will remove them)
 */
export async function deleteMcpEntry(db: DatabaseClient, mcp_id: string): Promise<void> {
  await compatDelete(db, mcp_catalog).where(eq(mcp_catalog.mcp_id, mcp_id));
  console.log(`[db:mcp-catalog] MCP entry deleted: ${mcp_id}`);
}

/**
 * Publish MCP entry
 *
 * Updates status to 'published' and records publisher info.
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @param published_by User ID of publisher
 */
export async function publishMcpEntry(
  db: DatabaseClient,
  mcp_id: string,
  published_by: string
): Promise<void> {
  const now = new Date().toISOString();

  await compatUpdate(db, mcp_catalog)
    .set({
      status: 'published',
      published_by,
      published_at: now,
      updated_at: now,
    })
    .where(eq(mcp_catalog.mcp_id, mcp_id));

  console.log(`[db:mcp-catalog] MCP entry published: ${mcp_id} by ${published_by}`);
}

/**
 * Update MCP validation status
 *
 * Records validation result and timestamp.
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @param status Validation status
 * @param result Validation result object
 */
export async function updateValidationStatus(
  db: DatabaseClient,
  mcp_id: string,
  status: 'pending' | 'valid' | 'invalid',
  result: object
): Promise<void> {
  const now = new Date().toISOString();

  await compatUpdate(db, mcp_catalog)
    .set({
      validation_status: status,
      validation_result: JSON.stringify(result),
      last_validated_at: now,
      updated_at: now,
    })
    .where(eq(mcp_catalog.mcp_id, mcp_id));

  console.log(`[db:mcp-catalog] MCP validation updated: ${mcp_id} -> ${status}`);
}

/**
 * Update tool catalog for an MCP entry after discovery
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @param tools Array of discovered tool descriptors
 * @param tool_count Number of tools discovered
 */
export async function updateToolCatalog(
  db: DatabaseClient,
  mcp_id: string,
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  tool_count: number
): Promise<void> {
  const now = new Date().toISOString();

  await compatUpdate(db, mcp_catalog)
    .set({
      tool_catalog: JSON.stringify(tools),
      tool_count: tool_count,
      updated_at: now,
    })
    .where(eq(mcp_catalog.mcp_id, mcp_id));

  console.log(`[db:mcp-catalog] Tool catalog updated: ${mcp_id} (${tool_count} tools)`);
}

/**
 * Grant group access to MCP
 *
 * @param db Database client
 * @param data MCP-group access association data
 */
export async function grantGroupAccess(
  db: DatabaseClient,
  data: { mcp_id: string; group_id: string; assigned_by: string }
): Promise<void> {
  const now = new Date().toISOString();

  const newAccess: NewMcpGroupAccess = {
    mcp_id: data.mcp_id,
    group_id: data.group_id,
    assigned_at: now,
    assigned_by: data.assigned_by,
  };

  await compatInsert(db, mcp_group_access).values(newAccess);

  console.log(`[db:mcp-catalog] Group ${data.group_id} granted access to MCP ${data.mcp_id}`);
}

/**
 * Revoke group access to MCP
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @param group_id Group UUID
 */
export async function revokeGroupAccess(
  db: DatabaseClient,
  mcp_id: string,
  group_id: string
): Promise<void> {
  await compatDelete(db, mcp_group_access).where(
    and(eq(mcp_group_access.mcp_id, mcp_id), eq(mcp_group_access.group_id, group_id))
  );

  console.log(`[db:mcp-catalog] Group ${group_id} access revoked for MCP ${mcp_id}`);
}

/**
 * List all groups that have access to an MCP
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @returns Array of MCP-group access associations
 */
export async function listGroupsForMcp(
  db: DatabaseClient,
  mcp_id: string
): Promise<McpGroupAccess[]> {
  return compatSelect(db).from(mcp_group_access).where(eq(mcp_group_access.mcp_id, mcp_id));
}

/**
 * List all MCPs accessible to a group
 *
 * @param db Database client
 * @param group_id Group UUID
 * @returns Array of enriched MCP entries with catalog details
 */
export async function listMcpsForGroup(
  db: DatabaseClient,
  group_id: string
): Promise<McpCatalogEntry[]> {
  const rows = await compatSelect(db)
    .from(mcp_group_access)
    .innerJoin(mcp_catalog, eq(mcp_group_access.mcp_id, mcp_catalog.mcp_id))
    .where(eq(mcp_group_access.group_id, group_id));

  return rows.map((row: any) => row.mcp_catalog);
}
