/**
 * Downstream MCP Manager - Main exports
 *
 * M6.3: Manages connections to downstream MCP servers
 */

export { DownstreamMcpManager } from './manager.js';
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
