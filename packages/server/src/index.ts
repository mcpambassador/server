/**
 * MCP Ambassador Server - Main exports
 * 
 * M6: HTTPS + TLS server with AAA pipeline integration
 */

export { AmbassadorServer } from './server.js';
export type { ServerConfig } from './server.js';
export { initializeTls } from './tls.js';
export type { TlsConfig, TlsCertificates } from './tls.js';

export { DownstreamMcpManager } from './downstream/index.js';
export type { 
  DownstreamMcpConfig,
  ToolDescriptor,
  AggregatedTool,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ConnectionHealth,
} from './downstream/index.js';
