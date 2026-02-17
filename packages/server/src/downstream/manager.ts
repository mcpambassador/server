/* eslint-disable no-console, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */

import type {
  DownstreamMcpConfig,
  AggregatedTool,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ConnectionHealth,
} from './types.js';
import { validateMcpConfig, validateToolName } from './types.js';
import { StdioMcpConnection } from './stdio-connection.js';
import { HttpMcpConnection } from './http-connection.js';

/**
 * Downstream MCP Connection Manager
 *
 * M6.3: Manages all downstream MCP connections
 *
 * Responsibilities:
 * - Initialize connections from config (stdio and HTTP)
 * - Aggregate tool catalogs from all MCPs
 * - Route tool invocations to correct MCP
 * - Health monitoring and reconnection
 * - Credential injection (via env vars for stdio)
 *
 * Per Architecture §7.3 and dev-plan M6.3
 */
export class DownstreamMcpManager {
  private connections = new Map<string, StdioMcpConnection | HttpMcpConnection>();
  private toolToMcpMap = new Map<string, string>(); // tool_name -> mcp_name
  private aggregatedTools: AggregatedTool[] = [];

  constructor() {
    console.log('[DownstreamMcpManager] Initialized');
  }

  /**
   * Initialize all downstream MCP connections from config
   */
  async initialize(configs: DownstreamMcpConfig[]): Promise<void> {
    console.log(`[DownstreamMcpManager] Initializing ${configs.length} downstream MCPs...`);

    const startPromises = configs.map(async config => {
      try {
        // F-SEC-M6-001: Validate config before spawning
        validateMcpConfig(config);

        if (config.transport === 'stdio') {
          const connection = new StdioMcpConnection(config);
          await connection.start();
          this.connections.set(config.name, connection);

          // Register connection event handlers
          connection.on('disconnect', () => {
            console.log(`[DownstreamMcpManager] MCP ${config.name} disconnected`);
            this.aggregateTools(); // Refresh tool catalog
          });

          connection.on('error', err => {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            console.error(`[DownstreamMcpManager] MCP ${config.name} error:`, err);
          });
        } else if (config.transport === 'http' || config.transport === 'sse') {
          const connection = new HttpMcpConnection(config);
          await connection.start();
          this.connections.set(config.name, connection);

          // Register connection event handlers
          connection.on('disconnect', () => {
            console.log(`[DownstreamMcpManager] MCP ${config.name} disconnected`);
            this.aggregateTools(); // Refresh tool catalog
          });

          connection.on('error', err => {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            console.error(`[DownstreamMcpManager] MCP ${config.name} error:`, err);
          });
        } else {
          console.warn(
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            `[DownstreamMcpManager] Unknown transport ${config.transport} for ${config.name}`
          );
        }
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`[DownstreamMcpManager] Failed to start ${config.name}:`, err);
        // Continue with other MCPs even if one fails
      }
    });

    await Promise.allSettled(startPromises);

    // Aggregate tools from all connected MCPs
    await this.aggregateTools();

    console.log(
      `[DownstreamMcpManager] Initialized ${this.connections.size} connections, ${this.aggregatedTools.length} tools`
    );
  }

  /**
   * Aggregate tool catalogs from all MCPs
   */
  private async aggregateTools(): Promise<void> {
    this.aggregatedTools = [];
    this.toolToMcpMap.clear();

    for (const [mcpName, connection] of this.connections) {
      if (!connection.isConnected()) {
        continue;
      }

      const tools = connection.getTools();

      for (const tool of tools) {
        // SEC-M9-05: Validate tool name
        if (!validateToolName(tool.name)) {
          console.warn(
            `[DownstreamMcpManager] Skipping tool with invalid name from ${mcpName}: ${tool.name}`
          );
          continue;
        }

        // Check for tool name conflicts
        if (this.toolToMcpMap.has(tool.name)) {
          const existingMcp = this.toolToMcpMap.get(tool.name);
          console.warn(
            `[DownstreamMcpManager] Tool name conflict: ${tool.name} ` +
              `provided by both ${existingMcp} and ${mcpName}. ` +
              `Using ${existingMcp}.`
          );
          continue;
        }

        // SEC-M9-05: Truncate description to 500 chars
        let description = tool.description;
        if (description && description.length > 500) {
          description = description.substring(0, 500);
        }

        // Add to aggregated catalog
        this.aggregatedTools.push({
          ...tool,
          description,
          source_mcp: mcpName,
        });

        this.toolToMcpMap.set(tool.name, mcpName);
      }
    }

    console.log(
      `[DownstreamMcpManager] Aggregated ${this.aggregatedTools.length} tools from ${this.connections.size} MCPs`
    );
  }

  /**
   * Get aggregated tool catalog
   */
  getToolCatalog(): AggregatedTool[] {
    return this.aggregatedTools;
  }

  /**
   * Get tools filtered by client's authorized list
   * (Authorization filtering happens upstream in the AAA pipeline)
   */
  getToolsForClient(authorizedToolNames: string[]): AggregatedTool[] {
    const authorizedSet = new Set(authorizedToolNames);
    return this.aggregatedTools.filter(tool => authorizedSet.has(tool.name));
  }

  /**
   * Invoke a tool by routing to the correct downstream MCP
   */
  async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    const mcpName = this.toolToMcpMap.get(request.tool_name);

    if (!mcpName) {
      throw new Error(`Tool not found: ${request.tool_name}`);
    }

    const connection = this.connections.get(mcpName);

    if (!connection) {
      throw new Error(`MCP connection not found: ${mcpName}`);
    }

    if (!connection.isConnected()) {
      throw new Error(`MCP not connected: ${mcpName}`);
    }

    // Route invocation to the correct MCP
    return await connection.invokeTool(request);
  }

  /**
   * Get tool descriptor by name
   */
  getToolDescriptor(toolName: string): AggregatedTool | undefined {
    return this.aggregatedTools.find(tool => tool.name === toolName);
  }

  /**
   * Health check all connections
   */
  async healthCheckAll(): Promise<ConnectionHealth[]> {
    const healthChecks = Array.from(this.connections.values()).map(conn => conn.healthCheck());

    return await Promise.all(healthChecks);
  }

  /**
   * Refresh tool list for a specific MCP
   */
  async refreshMcp(mcpName: string): Promise<void> {
    const connection = this.connections.get(mcpName);

    if (!connection) {
      throw new Error(`MCP not found: ${mcpName}`);
    }

    await connection.refreshToolList();
    await this.aggregateTools();
  }

  /**
   * Refresh tool lists for all MCPs
   */
  async refreshAll(): Promise<void> {
    const refreshPromises = Array.from(this.connections.values()).map(conn =>
      conn.refreshToolList().catch(err => {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`[DownstreamMcpManager] Failed to refresh:`, err);
      })
    );

    await Promise.allSettled(refreshPromises);
    await this.aggregateTools();
  }

  /**
   * Shutdown all connections
   */
  async shutdown(): Promise<void> {
    console.log('[DownstreamMcpManager] Shutting down all connections...');

    const stopPromises = Array.from(this.connections.values()).map(conn =>
      conn.stop().catch(err => {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`[DownstreamMcpManager] Error stopping connection:`, err);
      })
    );

    await Promise.allSettled(stopPromises);

    this.connections.clear();
    this.toolToMcpMap.clear();
    this.aggregatedTools = [];

    console.log('[DownstreamMcpManager] Shutdown complete');
  }

  /**
   * Get connection status summary
   */
  getStatus(): {
    total_connections: number;
    healthy_connections: number;
    total_tools: number;
    connections: Array<{ name: string; connected: boolean; tool_count: number }>;
  } {
    const connections = Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      connected: conn.isConnected(),
      tool_count: conn.getTools().length,
    }));

    return {
      total_connections: this.connections.size,
      healthy_connections: connections.filter(c => c.connected).length,
      total_tools: this.aggregatedTools.length,
      connections,
    };
  }
}
