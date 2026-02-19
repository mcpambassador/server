/**
 * Catalog Resolver Service
 *
 * Resolves the effective tool catalog for a client based on subscriptions,
 * tool selections, and profile restrictions.
 *
 * @see M25.3: Catalog Resolver
 * @see Architecture §4.3 Tool Catalog Resolution
 */

import type { DatabaseClient } from '@mcpambassador/core';
import type { AggregatedTool } from '../downstream/types.js';
import { listSubscriptionsForClient, getMcpEntryById, compatSelect, clients } from '@mcpambassador/core';
import { eq } from 'drizzle-orm';

/**
 * Resolve the effective tool catalog for a client
 *
 * Algorithm:
 * 1. Get all active subscriptions for the client
 * 2. For each subscription, get the MCP's tool_catalog
 * 3. If selected_tools is non-empty, filter to only those tools
 * 4. If profile has allowed_tools, intersect: profile.allowed_tools ∩ selected_tools
 * 5. Return aggregated list
 *
 * @param db Database client
 * @param clientId Client UUID
 * @returns Array of aggregated tools
 */
export async function resolveEffectiveTools(
  db: DatabaseClient,
  clientId: string
): Promise<AggregatedTool[]> {
  // Get client and profile
  const [client] = await compatSelect(db)
    .from(clients)
    .where(eq(clients.client_id, clientId))
    .limit(1);

  if (!client) {
    throw new Error('Client not found');
  }

  // Get profile to check allowed_tools
  const profile = await db.query.tool_profiles.findFirst({
    where: (p, { eq }) => eq(p.profile_id, client.profile_id),
  });

  if (!profile) {
    throw new Error('Profile not found');
  }

  const profileAllowedTools: string[] | null = profile.allowed_tools 
    ? (typeof profile.allowed_tools === 'string' 
        ? JSON.parse(profile.allowed_tools) 
        : profile.allowed_tools)
    : null;

  // Get all active subscriptions
  const subscriptions = await listSubscriptionsForClient(db, clientId);
  const activeSubscriptions = subscriptions.filter(sub => sub.status === 'active');

  const aggregatedTools: AggregatedTool[] = [];

  for (const subscription of activeSubscriptions) {
    // Get MCP catalog
    const mcp = await getMcpEntryById(db, subscription.mcp_id);
    if (!mcp || mcp.status !== 'published') {
      continue;
    }

    // Parse tool catalog
    const toolCatalog: any[] = typeof mcp.tool_catalog === 'string'
      ? JSON.parse(mcp.tool_catalog)
      : mcp.tool_catalog || [];

    // Parse selected_tools
    const selectedTools: string[] = typeof subscription.selected_tools === 'string'
      ? JSON.parse(subscription.selected_tools)
      : subscription.selected_tools || [];

    // Determine which tools to include
    let toolsToInclude: any[] = toolCatalog;

    // Filter by selected_tools if non-empty
    if (selectedTools.length > 0) {
      toolsToInclude = toolCatalog.filter(tool => selectedTools.includes(tool.name));
    }

    // Filter by profile allowed_tools if present
    if (profileAllowedTools && profileAllowedTools.length > 0) {
      toolsToInclude = toolsToInclude.filter(tool => profileAllowedTools.includes(tool.name));
    }

    // Add to aggregated catalog
    for (const tool of toolsToInclude) {
      aggregatedTools.push({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
        source_mcp: mcp.name,
      });
    }
  }

  console.log(`[CatalogResolver] Resolved ${aggregatedTools.length} tools for client ${clientId}`);
  return aggregatedTools;
}
