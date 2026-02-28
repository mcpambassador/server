/**
 * Downstream MCP Manager - Main exports
 *
 * M6.3: Manages connections to downstream MCP servers
 * M17.2: Adds per-user MCP pools and tool routing
 */

export { SharedMcpManager } from './manager.js';
export { SharedMcpManager as DownstreamMcpManager } from './manager.js'; // Backward compatibility
export { UserMcpPool } from './user-mcp-pool.js';
export { ToolRouter } from './tool-router.js';
export { StdioMcpConnection, SAFE_ENV_VARS } from './stdio-connection.js';
export { HttpMcpConnection } from './http-connection.js';
export { validateMcpConfig, validateToolName } from './types.js';
export { redactUrl } from './url-utils.js';
export type {
  DownstreamMcpConfig,
  ToolDescriptor,
  AggregatedTool,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ConnectionHealth,
} from './types.js';
export type { UserMcpPoolConfig, UserMcpPoolStatus } from './user-mcp-pool.js';
export type { CombinedMcpStatus } from './tool-router.js';
