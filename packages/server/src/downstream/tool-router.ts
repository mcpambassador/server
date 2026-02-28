/* eslint-disable no-console */

import type { SharedMcpManager } from './manager.js';
import type { UserMcpPool, UserMcpPoolStatus } from './user-mcp-pool.js';
import type { AggregatedTool, ToolInvocationRequest, ToolInvocationResponse } from './types.js';
import type { DatabaseClient } from '@mcpambassador/core';

/**
 * Combined MCP Status
 * Merges status from shared manager + user pool
 */
export interface CombinedMcpStatus {
  shared: {
    total_connections: number;
    healthy_connections: number;
    total_tools: number;
    connections: Array<{ name: string; connected: boolean; tool_count: number }>;
  };
  perUser: UserMcpPoolStatus;
}

/**
 * Tool Router
 *
 * M17.2: Composition layer that unifies shared and per-user tool catalogs
 *
 * Responsibilities:
 * - Merge tool catalogs from SharedMcpManager + UserMcpPool
 * - Route tool invocations to correct manager (shared or per-user)
 * - Handle tool name conflicts (shared wins)
 * - Provide combined status for admin dashboard
 *
 * Per ADR-012 §Design/Tool Catalog Composition Strategy
 */
export class ToolRouter {
  constructor(
    private sharedManager: SharedMcpManager,
    private userPool: UserMcpPool
  ) {
    console.log('[ToolRouter] Initialized');
  }

  /**
   * Get composed tool catalog for a user: shared + per-user union
   * Shared tools come first. Per-user tools are appended.
   * Tool name conflicts: shared wins (per-user tool is skipped with warning)
   *
   * Per ADR-012: "Shared MCPs are admin-configured and represent the stable,
   * server-wide tool surface. Per-user MCPs are user-provisioned. If a user
   * subscribes to an MCP that provides a tool with the same name as a shared
   * MCP tool, the shared version takes precedence."
   */
  getToolCatalog(userId: string): AggregatedTool[] {
    const sharedTools = this.sharedManager.getToolCatalog();
    const userTools = this.userPool.getToolCatalog(userId);

    // Build set of shared tool names for deduplication
    const sharedToolNames = new Set(sharedTools.map(tool => tool.name));

    // Filter out user tools that conflict with shared tools
    const deduplicatedUserTools = userTools.filter(tool => {
      if (sharedToolNames.has(tool.name)) {
        console.warn(
          `[ToolRouter] User ${userId} tool name conflict: ${tool.name} ` +
            `from per-user MCP ${tool.source_mcp} conflicts with shared tool. Using shared.`
        );
        return false;
      }
      return true;
    });

    // Return union: shared first, then deduplicated user tools
    return [...sharedTools, ...deduplicatedUserTools];
  }

  /**
   * Route tool invocation to the correct manager
   * Checks shared manager first, then user pool
   */
  async invokeTool(
    userId: string,
    request: ToolInvocationRequest
  ): Promise<ToolInvocationResponse> {
    // Check shared manager first
    const sharedTool = this.sharedManager.getToolDescriptor(request.tool_name);
    if (sharedTool) {
      console.log(`[ToolRouter] Routing ${request.tool_name} to shared manager`);
      return await this.sharedManager.invokeTool(request);
    }

    // Check user pool
    const userTool = this.userPool.getToolDescriptor(userId, request.tool_name);
    if (userTool) {
      console.log(`[ToolRouter] Routing ${request.tool_name} to user pool for ${userId}`);
      return await this.userPool.invokeTool(userId, request);
    }

    // Tool not found in either
    throw new Error(`Tool not found: ${request.tool_name}`);
  }

  /**
   * Get tool descriptor from either shared or per-user catalog
   * Shared takes precedence
   */
  getToolDescriptor(userId: string, toolName: string): AggregatedTool | undefined {
    // Check shared first
    const sharedTool = this.sharedManager.getToolDescriptor(toolName);
    if (sharedTool) {
      return sharedTool;
    }

    // Check user pool
    return this.userPool.getToolDescriptor(userId, toolName);
  }

  /**
   * Get combined status (for admin health endpoint)
   * Merges status from shared manager + user pool
   */
  getStatus(): CombinedMcpStatus {
    return {
      shared: this.sharedManager.getStatus(),
      perUser: this.userPool.getStatus(),
    };
  }

  /**
   * Get subscription-filtered catalog for a client
   *
   * M25.7: Returns tools filtered by the client's active subscriptions.
   * This is intended for use by the MCP protocol handler when a client connects.
   *
   * @param db Database client
   * @param clientId Client UUID
   * @returns Aggregated tools based on client's subscriptions
   */
  async getSubscriptionFilteredCatalog(
    db: DatabaseClient,
    clientId: string
  ): Promise<AggregatedTool[]> {
    // Import catalog resolver service
    const { resolveEffectiveTools } = await import('../services/catalog-resolver.js');
    return resolveEffectiveTools(db, clientId);
  }

  /**
   * Get isolation-mode-aware tool catalog for a user
   *
   * M26.6: Returns tools considering isolation_mode from catalog.
   * - Shared MCPs: get tools from SharedMcpManager
   * - Per-user MCPs: get tools from UserMcpPool
   * - Applies subscription tool selection filters
   *
   * @param db Database client
   * @param userId User UUID
   * @param clientId Client UUID
   * @returns Aggregated tools based on isolation mode and subscriptions
   */
  async getIsolationAwareToolCatalog(
    db: DatabaseClient,
    userId: string,
    clientId: string
  ): Promise<AggregatedTool[]> {
    // Get client's subscriptions
    const { listClientSubscriptions } = await import('../services/subscription-service.js');
    const subscriptions = await listClientSubscriptions(db, { userId, clientId });

    const tools: AggregatedTool[] = [];
    const seenToolNames = new Set<string>();

    for (const sub of subscriptions) {
      if (sub.status !== 'active') {
        continue;
      }

      // Get MCP entry from catalog
      const { getMcpEntryById } = await import('@mcpambassador/core');
      const mcpEntry = await getMcpEntryById(db, sub.mcp_id);
      if (!mcpEntry) {
        console.warn(`[ToolRouter] MCP ${sub.mcp_id} not found in catalog`);
        continue;
      }

      let mcpTools: AggregatedTool[] = [];

      // Route to correct manager based on isolation_mode
      if (mcpEntry.isolation_mode === 'shared') {
        // Get tools from SharedMcpManager
        const sharedTools = this.sharedManager.getToolCatalog();
        mcpTools = sharedTools.filter(tool => tool.source_mcp === mcpEntry.name);
      } else if (mcpEntry.isolation_mode === 'per_user') {
        // Get tools from UserMcpPool
        const userTools = this.userPool.getToolCatalog(userId);
        mcpTools = userTools.filter(tool => tool.source_mcp === mcpEntry.name);
      }

      // Apply tool selection filter if specified
      if (sub.selected_tools && sub.selected_tools.length > 0) {
        const selectedSet = new Set(sub.selected_tools);
        mcpTools = mcpTools.filter(tool => selectedSet.has(tool.name));
      }

      // Add tools to result (deduplicate by name, first wins)
      for (const tool of mcpTools) {
        if (!seenToolNames.has(tool.name)) {
          tools.push(tool);
          seenToolNames.add(tool.name);
        } else {
          console.warn(`[ToolRouter] Tool name conflict: ${tool.name} already seen, skipping`);
        }
      }
    }

    return tools;
  }
}
