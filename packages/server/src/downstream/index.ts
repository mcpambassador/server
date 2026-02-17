/**
 * Downstream MCP Manager - Main exports
 *
 * M6.3: Manages connections to downstream MCP servers
 */

export { DownstreamMcpManager } from './manager.js';
export { StdioMcpConnection } from './stdio-connection.js';
export { validateMcpConfig } from './types.js';
export type {
  DownstreamMcpConfig,
  ToolDescriptor,
  AggregatedTool,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ConnectionHealth,
} from './types.js';
