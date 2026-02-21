/**
 * MCP Tool Discovery Engine
 *
 * Performs ephemeral connect → initialize → tools/list → disconnect cycles
 * against MCP servers for admin tool discovery.
 *
 * Reuses existing StdioMcpConnection / HttpMcpConnection from downstream/
 * but wraps them in a one-shot lifecycle for discovery purposes.
 *
 * @see ADR-P3-07: MCP Tool Discovery Engine
 * @see Architecture §7.3: Downstream MCP Management
 */

import type { McpCatalogEntry } from '@mcpambassador/core';
import { StdioMcpConnection } from '../downstream/stdio-connection.js';
import { HttpMcpConnection } from '../downstream/http-connection.js';
import type { DownstreamMcpConfig, ToolDescriptor } from '../downstream/types.js';
import { validateToolName } from '../downstream/types.js';

/**
 * Error codes for tool discovery failures
 */
export type DiscoveryErrorCode =
  | 'credential_required' // MCP requires user credentials, can't discover as admin
  | 'validation_required' // Static validation must pass first
  | 'connection_timeout' // Failed to connect within timeout
  | 'process_crashed' // stdio process exited unexpectedly
  | 'unreachable' // HTTP endpoint unreachable (DNS, ECONNREFUSED)
  | 'tls_error' // TLS certificate validation failed
  | 'discovery_failed' // tools/list returned an error
  | 'invalid_response' // tools/list returned unparseable data
  | 'unknown_transport' // Unrecognized transport_type
  | 'internal_error'; // Unexpected server-side error

/**
 * Result of a tool discovery attempt
 */
export interface DiscoveryResult {
  /** Outcome of the discovery attempt */
  status: 'success' | 'skipped' | 'error';

  /** Discovered tools (empty array if status != 'success') */
  tools_discovered: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;

  /** Number of tools discovered */
  tool_count: number;

  /** Error code if status = 'error' or 'skipped' */
  error_code?: DiscoveryErrorCode;

  /** Human-readable error/skip message */
  message?: string;

  /** ISO 8601 timestamp of discovery attempt */
  discovered_at: string;

  /** Time taken for discovery in milliseconds */
  duration_ms: number;

  /** Server capabilities reported during initialize (if available) */
  server_info?: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };

  /** Warnings encountered during discovery (e.g., invalid tool names, tool count capped) */
  warnings?: string[];
}

/**
 * Configuration constants for the discovery engine
 */
export const DEFAULT_DISCOVERY_TIMEOUT = 45_000; // 45 seconds overall
export const MAX_TOOLS = 500;

/**
 * Tool Discovery Engine
 *
 * Performs ephemeral connect → initialize → tools/list → disconnect cycles
 * against MCP servers for admin tool discovery.
 *
 * All errors are caught and returned as DiscoveryResult with status='error'.
 * This function never throws.
 */
export async function discoverTools(entry: McpCatalogEntry): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const warnings: string[] = [];

  try {
    // Precondition 1: Check if MCP requires user credentials
    if (entry.requires_user_credentials) {
      return {
        status: 'skipped',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'credential_required',
        message:
          'This MCP requires user credentials. Tool discovery is skipped during admin setup. Tools will be discovered when a user provides their credentials.',
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    // Precondition 2: Check validation status
    if (entry.validation_status !== 'valid') {
      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'validation_required',
        message: `Run validation first. Current validation status: ${entry.validation_status}`,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    // Parse config JSON
    let configObj: Record<string, unknown>;
    try {
      configObj = JSON.parse(entry.config) as Record<string, unknown>;
    } catch (err) {
      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'internal_error',
        message: `Failed to parse config JSON: ${err instanceof Error ? err.message : String(err)}`,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    // Build DownstreamMcpConfig
    const dsConfig: DownstreamMcpConfig = {
      name: entry.name,
      transport: entry.transport_type,
      command: configObj.command as string[] | undefined,
      env: configObj.env as Record<string, string> | undefined,
      cwd: undefined,
      url: configObj.url as string | undefined,
      headers: configObj.headers as Record<string, string> | undefined,
      timeout_ms: (configObj.timeout_ms as number) ?? 30_000,
    };

    // Create connection based on transport
    let connection: StdioMcpConnection | HttpMcpConnection;
    if (entry.transport_type === 'stdio') {
      connection = new StdioMcpConnection(dsConfig);
    } else if (entry.transport_type === 'http' || entry.transport_type === 'sse') {
      connection = new HttpMcpConnection(dsConfig);
    } else {
      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'unknown_transport',
        message: `Unsupported transport type: ${entry.transport_type}`,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    try {
      // Wrap in timeout
      const discoveryPromise = performDiscovery(connection);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Discovery timeout')), DEFAULT_DISCOVERY_TIMEOUT);
      });

      const tools = await Promise.race([discoveryPromise, timeoutPromise]);

      // Filter invalid tool names
      const validTools: ToolDescriptor[] = [];
      for (const tool of tools) {
        if (validateToolName(tool.name)) {
          validTools.push(tool);
        } else {
          warnings.push(`Tool name '${tool.name}' is invalid and was filtered out.`);
        }
      }

      // Cap at MAX_TOOLS
      let finalTools = validTools;
      if (validTools.length > MAX_TOOLS) {
        finalTools = validTools.slice(0, MAX_TOOLS);
        warnings.push(
          `Tool count exceeded ${MAX_TOOLS}. Only the first ${MAX_TOOLS} tools were saved.`
        );
      }

      // Map to simplified shape
      const toolsDiscovered = finalTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      return {
        status: 'success',
        tools_discovered: toolsDiscovered,
        tool_count: toolsDiscovered.length,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err) {
      // Classify error
      const errorMessage = err instanceof Error ? err.message : String(err);
      let errorCode: DiscoveryErrorCode;
      let userMessage: string;

      if (errorMessage.includes('timeout') || errorMessage.includes('Discovery timeout')) {
        errorCode = 'connection_timeout';
        userMessage =
          'Could not connect to MCP server within 45 seconds. Check the URL/command and ensure the server is running.';
      } else if (errorMessage.includes('exited') || errorMessage.includes('Process')) {
        errorCode = 'process_crashed';
        userMessage = 'MCP process exited unexpectedly. Check command path and dependencies.';
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        errorCode = 'unreachable';
        userMessage =
          'Could not reach MCP server. Verify the URL is correct and accessible from this server.';
      } else if (errorMessage.includes('TLS') || errorMessage.includes('certificate')) {
        errorCode = 'tls_error';
        userMessage =
          'TLS certificate validation failed. The MCP server may have an invalid or self-signed certificate.';
      } else if (errorMessage.includes('tools/list')) {
        errorCode = 'discovery_failed';
        userMessage = `Connected to MCP but tool listing failed: ${errorMessage}`;
      } else if (errorMessage.includes('parse') || errorMessage.includes('JSON')) {
        errorCode = 'invalid_response';
        userMessage = 'Connected to MCP but received an invalid tools/list response.';
      } else {
        errorCode = 'internal_error';
        userMessage = `Unexpected error during discovery: ${errorMessage}`;
      }

      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: errorCode,
        message: userMessage,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } finally {
      // ALWAYS clean up connection
      try {
        await connection.stop();
      } catch (cleanupErr) {
        // Ignore cleanup errors
        console.warn(`[ToolDiscoveryEngine] Cleanup error for ${entry.name}:`, cleanupErr);
      }
    }
  } catch (outerErr) {
    // Catch any unexpected errors in the outer try block
    return {
      status: 'error',
      tools_discovered: [],
      tool_count: 0,
      error_code: 'internal_error',
      message: `Unexpected error: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`,
      discovered_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

/**
 * Internal helper: Perform the actual discovery (start → getTools → stop)
 */
async function performDiscovery(
  connection: StdioMcpConnection | HttpMcpConnection
): Promise<ToolDescriptor[]> {
  // Start connection (initialize + tools/list)
  await connection.start();

  // Get cached tools
  const tools = connection.getTools();

  return tools;
}
