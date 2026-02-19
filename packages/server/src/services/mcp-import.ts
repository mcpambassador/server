/**
 * MCP YAML Import Service
 *
 * One-time migration to import downstream MCPs from YAML config into the catalog.
 * Runs on server startup if catalog is empty.
 *
 * @see M23.5: YAML → Catalog Auto-Import
 */

import type { DatabaseClient } from '@mcpambassador/core';
import type { DownstreamMcpConfig } from '../downstream/index.js';
import {
  createMcpEntry,
  listMcpEntries,
  getGroupByName,
  grantGroupAccess,
} from '@mcpambassador/core';

/**
 * Import result
 */
export interface ImportResult {
  imported: number;
  skipped: number;
}

/**
 * Import YAML downstream MCPs to catalog
 *
 * One-time migration that:
 * 1. Checks if mcp_catalog table is empty
 * 2. If empty, imports each YAML MCP as a published catalog entry
 * 3. Assigns all imported MCPs to the "all-users" group
 * 4. Marks validation as valid (YAML config is trusted)
 *
 * @param db Database client
 * @param yamlMcps Array of downstream MCP configs from YAML
 * @returns Import result with counts
 */
export async function importYamlMcps(
  db: DatabaseClient,
  yamlMcps: DownstreamMcpConfig[]
): Promise<ImportResult> {
  // Check if catalog already has entries
  const { entries: existingEntries } = await listMcpEntries(db, {}, { limit: 1 });
  if (existingEntries.length > 0) {
    console.log('[MCP Import] Catalog not empty — skipping YAML import');
    return { imported: 0, skipped: yamlMcps.length };
  }

  // Check if all-users group exists (should be seeded)
  const allUsersGroup = await getGroupByName(db, 'all-users');
  if (!allUsersGroup) {
    console.warn('[MCP Import] "all-users" group not found — cannot assign group access');
  }

  let imported = 0;
  const now = new Date().toISOString();

  for (const yamlMcp of yamlMcps) {
    try {
      // Build config object from YAML MCP
      const config: Record<string, unknown> = {};
      if (yamlMcp.command) config.command = yamlMcp.command;
      if (yamlMcp.url) config.url = yamlMcp.url;
      if (yamlMcp.env) config.env = yamlMcp.env;
      if (yamlMcp.timeout_ms) config.timeout_ms = yamlMcp.timeout_ms;

      // Create catalog entry (published + valid)
      const entry = await createMcpEntry(db, {
        name: yamlMcp.name,
        display_name: yamlMcp.name.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        description: `YAML-imported MCP: ${yamlMcp.name}`,
        icon_url: null,
        transport_type: yamlMcp.transport,
        config: JSON.stringify(config),
        isolation_mode: 'shared',
        requires_user_credentials: false,
        credential_schema: '{}',
        tool_catalog: '[]',
        tool_count: 0,
        status: 'published',
        published_by: 'system',
        published_at: now,
        validation_status: 'valid',
        validation_result: JSON.stringify({
          valid: true,
          errors: [],
          warnings: [],
          validated_at: now,
        }),
        last_validated_at: now,
      });

      // Assign to all-users group
      if (allUsersGroup) {
        await grantGroupAccess(db, {
          mcp_id: entry.mcp_id,
          group_id: allUsersGroup.group_id,
          assigned_by: 'system',
        });
      }

      console.log(`[MCP Import] Imported: ${yamlMcp.name} -> ${entry.mcp_id}`);
      imported++;
    } catch (err) {
      console.error(`[MCP Import] Failed to import ${yamlMcp.name}:`, err);
    }
  }

  console.log(`[MCP Import] Import complete: ${imported} imported, ${yamlMcps.length - imported} failed`);

  return {
    imported,
    skipped: yamlMcps.length - imported,
  };
}
