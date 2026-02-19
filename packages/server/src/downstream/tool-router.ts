/* eslint-disable no-console */

import type { SharedMcpManager } from './manager.js';
import type { UserMcpPool, UserMcpPoolStatus } from './user-mcp-pool.js';
import type {
  AggregatedTool,
  ToolInvocationRequest,
  ToolInvocationResponse,
} from './types.js';

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
  async invokeTool(userId: string, request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
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
}
