/**
 * MCP Catalog Service
 *
 * Business logic layer for MCP catalog management. Wraps core repository functions
 * with validation, error handling, and business rules.
 *
 * @see M23.1: MCP Catalog Service
 */

import type { DatabaseClient, McpCatalogEntry } from '@mcpambassador/core';
import {
  createMcpEntry,
  getMcpEntryById,
  getMcpEntryByName,
  listMcpEntries,
  updateMcpEntry,
  deleteMcpEntry,
  publishMcpEntry,
  listMcpsForGroup,
  listUserGroups,
  listSubscriptionsForMcp,
  updateSubscription,
} from '@mcpambassador/core';

/**
 * Create MCP catalog entry (draft)
 *
 * @param db Database client
 * @param data MCP entry data
 * @returns Created MCP entry
 * @throws Error if name already exists
 */
export async function createMcpCatalogEntry(
  db: DatabaseClient,
  data: {
    name: string;
    display_name: string;
    description?: string;
    icon_url?: string | null;
    transport_type: 'stdio' | 'http' | 'sse';
    config: Record<string, unknown>;
    isolation_mode?: 'shared' | 'per_user';
    requires_user_credentials?: boolean;
    credential_schema?: Record<string, unknown>;
  }
): Promise<McpCatalogEntry> {
  // Validate unique name
  const existing = await getMcpEntryByName(db, data.name);
  if (existing) {
    throw new Error(`MCP with name '${data.name}' already exists`);
  }

  // Create entry
  const entry = await createMcpEntry(db, {
    name: data.name,
    display_name: data.display_name,
    description: data.description || '',
    icon_url: data.icon_url || null,
    transport_type: data.transport_type,
    config: JSON.stringify(data.config),
    isolation_mode: data.isolation_mode || 'shared',
    requires_user_credentials: data.requires_user_credentials ?? false,
    credential_schema: data.credential_schema ? JSON.stringify(data.credential_schema) : '{}',
    tool_catalog: '[]',
    tool_count: 0,
    status: 'draft',
    validation_status: 'pending',
  });

  return entry;
}

/**
 * Get MCP catalog entry by ID
 *
 * @param db Database client
 * @param mcpId MCP UUID
 * @returns MCP entry
 * @throws Error if not found
 */
export async function getMcpCatalogEntry(
  db: DatabaseClient,
  mcpId: string
): Promise<McpCatalogEntry> {
  const entry = await getMcpEntryById(db, mcpId);
  if (!entry) {
    throw new Error(`MCP not found: ${mcpId}`);
  }
  return entry;
}

/**
 * List MCP catalog entries with filters and pagination
 *
 * @param db Database client
 * @param filters Optional status and isolation mode filters
 * @param pagination Cursor-based pagination
 * @returns Array of MCP entries + pagination metadata
 */
export async function listMcpCatalogEntries(
  db: DatabaseClient,
  filters?: { status?: 'draft' | 'published' | 'archived'; isolation_mode?: 'shared' | 'per_user' },
  pagination?: { limit?: number; cursor?: string }
): Promise<{ entries: McpCatalogEntry[]; has_more: boolean; next_cursor?: string }> {
  return listMcpEntries(db, filters, pagination);
}

/**
 * Update MCP catalog entry
 *
 * @param db Database client
 * @param mcpId MCP UUID
 * @param updates Partial MCP entry data to update
 * @throws Error if entry not found or update violates business rules
 */
export async function updateMcpCatalogEntry(
  db: DatabaseClient,
  mcpId: string,
  updates: {
    display_name?: string;
    description?: string;
    icon_url?: string | null;
    transport_type?: 'stdio' | 'http' | 'sse';
    config?: Record<string, unknown>;
    isolation_mode?: 'shared' | 'per_user';
    requires_user_credentials?: boolean;
    credential_schema?: Record<string, unknown>;
  }
): Promise<void> {
  // Verify entry exists
  const entry = await getMcpEntryById(db, mcpId);
  if (!entry) {
    throw new Error(`MCP not found: ${mcpId}`);
  }

  // Prevent updates to published MCPs that would break existing subscriptions
  // (allow metadata updates but not structural changes)
  if (entry.status === 'published') {
    const structuralFields = ['transport_type', 'isolation_mode', 'requires_user_credentials'];
    const hasStructuralChanges = structuralFields.some((field) => field in updates);
    if (hasStructuralChanges) {
      throw new Error('Cannot modify transport, isolation, or credential requirements for published MCPs');
    }
  }

  // Prepare update payload
  const payload: Partial<McpCatalogEntry> = {};
  if (updates.display_name !== undefined) payload.display_name = updates.display_name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.icon_url !== undefined) payload.icon_url = updates.icon_url;
  if (updates.transport_type !== undefined) payload.transport_type = updates.transport_type;
  if (updates.config !== undefined) payload.config = JSON.stringify(updates.config);
  if (updates.isolation_mode !== undefined) payload.isolation_mode = updates.isolation_mode;
  if (updates.requires_user_credentials !== undefined)
    payload.requires_user_credentials = updates.requires_user_credentials;
  if (updates.credential_schema !== undefined)
    payload.credential_schema = JSON.stringify(updates.credential_schema);

  // Reset validation status when config changes
  if (updates.config || updates.transport_type) {
    payload.validation_status = 'pending';
  }

  await updateMcpEntry(db, mcpId, payload);
}

/**
 * Archive MCP entry
 *
 * Sets status to 'archived' and pauses active subscriptions.
 *
 * @param db Database client
 * @param mcpId MCP UUID
 */
export async function archiveMcpEntry(db: DatabaseClient, mcpId: string): Promise<void> {
  // Verify entry exists
  const entry = await getMcpEntryById(db, mcpId);
  if (!entry) {
    throw new Error(`MCP not found: ${mcpId}`);
  }

  // Set status to archived
  await updateMcpEntry(db, mcpId, { status: 'archived' });

  // Pause active subscriptions
  const subscriptions = await listSubscriptionsForMcp(db, mcpId);
  for (const sub of subscriptions) {
    if (sub.status === 'active') {
      await updateSubscription(db, sub.subscription_id, { status: 'paused' });
    }
  }
}

/**
 * Delete MCP catalog entry
 *
 * Only allows deletion of draft or archived entries.
 *
 * @param db Database client
 * @param mcpId MCP UUID
 * @throws Error if entry is published
 */
export async function deleteMcpCatalogEntry(db: DatabaseClient, mcpId: string): Promise<void> {
  // Verify entry exists
  const entry = await getMcpEntryById(db, mcpId);
  if (!entry) {
    throw new Error(`MCP not found: ${mcpId}`);
  }

  // Only allow deletion of draft or archived entries
  if (entry.status === 'published') {
    throw new Error('Cannot delete published MCP. Archive it first.');
  }

  await deleteMcpEntry(db, mcpId);
}

/**
 * Publish MCP catalog entry
 *
 * Requires validation_status='valid'. Sets status to 'published'.
 *
 * @param db Database client
 * @param mcpId MCP UUID
 * @param publishedBy User ID of publisher
 * @throws Error if validation failed or entry not found
 */
export async function publishMcpCatalogEntry(
  db: DatabaseClient,
  mcpId: string,
  publishedBy: string
): Promise<void> {
  // Verify entry exists
  const entry = await getMcpEntryById(db, mcpId);
  if (!entry) {
    throw new Error(`MCP not found: ${mcpId}`);
  }

  // Require valid validation status
  if (entry.validation_status !== 'valid') {
    throw new Error(
      `Cannot publish MCP with validation status '${entry.validation_status}'. Run validation first.`
    );
  }

  await publishMcpEntry(db, mcpId, publishedBy);
}

/**
 * Get MCPs accessible to a user (via their groups)
 *
 * Returns only published MCPs.
 *
 * @param db Database client
 * @param userId User UUID
 * @returns Array of accessible MCP entries
 */
export async function getAccessibleMcps(
  db: DatabaseClient,
  userId: string
): Promise<McpCatalogEntry[]> {
  // Get user's groups
  const userGroups = await listUserGroups(db, userId);

  // Get all MCPs accessible to these groups
  const mcpAccessMap = new Map<string, boolean>();
  for (const userGroup of userGroups) {
    const mcpAccess = await listMcpsForGroup(db, userGroup.group_id);
    for (const access of mcpAccess) {
      mcpAccessMap.set(access.mcp_id, true);
    }
  }

  // Fetch full MCP entries (only published ones)
  const accessibleMcps: McpCatalogEntry[] = [];
  for (const mcpId of mcpAccessMap.keys()) {
    const entry = await getMcpEntryById(db, mcpId);
    if (entry && entry.status === 'published') {
      accessibleMcps.push(entry);
    }
  }

  return accessibleMcps;
}
