/**
 * Downstream MCP Manager Types
 * 
 * M6.3: Type definitions for downstream MCP connections
 * Supports stdio and HTTP transports per Architecture §7.3
 */

import { z } from 'zod';

/**
 * Downstream MCP configuration (from ambassador-server.yaml)
 */
export interface DownstreamMcpConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  
  // stdio transport
  command?: string[];
  env?: Record<string, string>;
  cwd?: string;
  
  // HTTP/SSE transport
  url?: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
}

/**
 * F-SEC-M6-001: Security-sensitive environment variables that must not be overridden
 */
const BLOCKED_ENV_VARS = [
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'DYLD_INSERT_LIBRARIES', // macOS equivalent of LD_PRELOAD
  'DYLD_LIBRARY_PATH',
];

/**
 * F-SEC-M6-001: Validate downstream MCP config for command injection risks
 */
export function validateMcpConfig(config: DownstreamMcpConfig): void {
  if (config.transport === 'stdio') {
    if (!config.command || config.command.length === 0) {
      throw new Error(`[${config.name}] stdio transport requires command array`);
    }
    
    const [cmd] = config.command;
    if (!cmd || cmd.trim() === '') {
      throw new Error(`[${config.name}] Empty command not allowed`);
    }
    
    // Check for shell injection attempts in command
    if (cmd.includes(';') || cmd.includes('|') || cmd.includes('&') || cmd.includes('`') || cmd.includes('$')) {
      throw new Error(
        `[${config.name}] Command contains shell metacharacters: ${cmd}`
      );
    }
    
    // Check for dangerous environment variables
    if (config.env) {
      for (const key of Object.keys(config.env)) {
        if (BLOCKED_ENV_VARS.includes(key)) {
          throw new Error(
            `[${config.name}] Environment variable '${key}' is blocked for security reasons`
          );
        }
      }
    }
  }
}

/**
 * Tool descriptor from downstream MCP
 * Based on MCP protocol tools/list response
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Aggregated tool catalog with source tracking
 */
export interface AggregatedTool extends ToolDescriptor {
  source_mcp: string; // Which downstream MCP provides this tool
}

/**
 * Tool invocation request
 */
export interface ToolInvocationRequest {
  tool_name: string;
  arguments: Record<string, unknown>;
}

/**
 * Tool invocation response (MCP protocol)
 */
export interface ToolInvocationResponse {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Connection health status
 */
export interface ConnectionHealth {
  name: string;
  transport: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  last_check: Date;
  error?: string;
  tool_count?: number;
}

/**
 * F-SEC-M6-011: Zod schema for validating tool invocation responses
 * Prevents XSS, data exfiltration, and OOM from malicious MCPs
 */
export const ToolInvocationResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.enum(['text', 'image', 'resource']),
      text: z.string().max(10 * 1024 * 1024).optional(), // 10MB max per text content
      data: z.string().max(10 * 1024 * 1024).optional(), // 10MB max per data content
      mimeType: z.string().optional(),
    })
  ).max(100), // Max 100 content items
  isError: z.boolean().optional(),
});
