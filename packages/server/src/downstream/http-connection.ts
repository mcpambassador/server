/* eslint-disable no-console, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

import { EventEmitter } from 'events';
import type {
  DownstreamMcpConfig,
  ToolDescriptor,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ConnectionHealth,
} from './types.js';
import { ToolInvocationResponseSchema } from './types.js';
import { redactUrl } from './url-utils.js';

/**
 * HTTP-based MCP connection
 *
 * M9: Implements MCP Streamable HTTP protocol
 * Connects to downstream MCPs over HTTP/HTTPS
 * SEC-M9-03: Always validates TLS certificates
 * SEC-M9-04: Enforces 10MB max response body size
 * SEC-M9-08: Redacts credentials from URLs in logs/status
 */
export class HttpMcpConnection extends EventEmitter {
  // SEC-M9-04: Response body size limit
  private static readonly MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

  /**
   * F-SEC-M9-001: Sanitize error messages to prevent credential leakage.
   * Node fetch errors can contain the full URL with resolved credentials.
   */
  private sanitizeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return redactUrl(msg);
  }

  private config: DownstreamMcpConfig;
  private toolCache: ToolDescriptor[] | null = null;
  private isHealthy = false;
  private nextRequestId = 1;
  private consecutiveFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;
  private templateUrl: string; // URL with ${ENV_VAR} placeholders for status
  private startedAt: number | null = null;

  constructor(config: DownstreamMcpConfig) {
    super();
    this.config = config;

    if (!config.url) {
      throw new Error(`[${config.name}] http transport requires url`);
    }

    // SEC-M9-08: Store template URL for health check responses
    this.templateUrl = config.url;
  }

  /**
   * Resolve environment variables in URL
   * SEC-M9-08: Resolve credentials only when making actual requests
   */
  private resolveUrl(): string {
    let url = this.config.url!;

    // Replace ${ENV_VAR} patterns with process.env values
    const envVarPattern = /\$\{([A-Z0-9_]+)\}/g;
    url = url.replace(envVarPattern, (match, varName) => {
      const value = process.env[varName];
      if (!value) {
        console.warn(
          `[MCP:${this.config.name}] Environment variable ${varName} not found, using placeholder`
        );
        return match; // Keep placeholder if env var not found
      }
      return value;
    });

    return url;
  }

  /**
   * Make HTTP request with size limit and timeout
   * SEC-M9-03: TLS validation always enabled
   * SEC-M9-04: 10MB max response size
   */
  private async fetch(body: object): Promise<unknown> {
    const url = this.resolveUrl();
    const timeout = this.config.timeout_ms || 30000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // SEC-M9-03: Never disable TLS validation (default is true)
      });

      clearTimeout(timeoutId);

      // Check response status
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // SEC-M9-04: Read response with size limit
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.length;

        // SEC-M9-04: Enforce max response size
        if (totalSize > HttpMcpConnection.MAX_RESPONSE_SIZE) {
          await reader.cancel();
          throw new Error(
            `Response exceeded ${HttpMcpConnection.MAX_RESPONSE_SIZE} bytes (SEC-M9-04)`
          );
        }

        chunks.push(value);
      }

      // Combine chunks and parse JSON
      const responseText = Buffer.concat(chunks).toString('utf-8');
      const jsonResponse = JSON.parse(responseText);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return jsonResponse;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    };

    try {
      const response = (await this.fetch(request)) as {
        id: number;
        result?: unknown;
        error?: unknown;
      };

      if (response.error) {
        throw new Error(`JSON-RPC error: ${JSON.stringify(response.error)}`);
      }

      // Reset failure counter on success
      this.consecutiveFailures = 0;

      return response.result;
    } catch (err) {
      // Circuit breaker: track consecutive failures
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[MCP:${this.config.name}] Circuit breaker triggered after ${this.consecutiveFailures} failures`
        );
        this.isHealthy = false;
        this.emit('error', new Error('Circuit breaker: too many consecutive failures'));
      }
      throw err;
    }
  }

  /**
   * Start the MCP connection
   */
  async start(): Promise<void> {
    const redacted = redactUrl(this.templateUrl);
    console.log(`[MCP:${this.config.name}] Starting HTTP connection to ${redacted}...`);

    try {
      // Initialize session
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: 'mcp-ambassador-server',
          version: '1.0.0',
        },
      });

      // Fetch initial tool list
      await this.refreshToolList();

      this.isHealthy = true;
      this.startedAt = Date.now();
      console.log(`[MCP:${this.config.name}] Started successfully`);
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Failed to start:`, this.sanitizeError(err));
      throw err;
    }
  }

  /**
   * Stop the connection
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    console.log(`[MCP:${this.config.name}] Stopping HTTP connection...`);
    this.startedAt = null;
    this.isHealthy = false;
    this.toolCache = null;
    this.emit('disconnect');
  }

  /**
   * Get cached tool list
   */
  getTools(): ToolDescriptor[] {
    return this.toolCache || [];
  }

  /**
   * Check if connection is healthy
   */
  isConnected(): boolean {
    return this.isHealthy;
  }

  /**
   * Get detailed health information for troubleshooting
   */
  getHealthDetail(): {
    consecutiveFailures: number;
    maxFailures: number;
    templateUrl: string | null;
    uptime_ms: number | null;
    toolCount: number;
  } {
    const uptime_ms = this.startedAt !== null ? Date.now() - this.startedAt : null;

    // Redact URL to avoid exposing credentials in query params
    const redactedUrl = (() => {
      const url = this.config.url!;
      // Strip query params and hash (where credentials might be exposed)
      // Use string manipulation to preserve ${...} placeholders in path
      const queryIndex = url.indexOf('?');
      const hashIndex = url.indexOf('#');
      
      let endIndex = url.length;
      if (queryIndex !== -1) {
        endIndex = queryIndex;
      }
      if (hashIndex !== -1 && hashIndex < endIndex) {
        endIndex = hashIndex;
      }
      
      return url.substring(0, endIndex);
    })();

    return {
      consecutiveFailures: this.consecutiveFailures,
      maxFailures: this.MAX_CONSECUTIVE_FAILURES,
      templateUrl: redactedUrl,
      uptime_ms,
      toolCount: this.toolCache?.length || 0,
    };
  }

  /**
   * Invoke a tool
   */
  async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    try {
      const response = await this.sendRequest('tools/call', {
        name: request.tool_name,
        arguments: request.arguments,
      });

      // Validate response against schema
      const validated = ToolInvocationResponseSchema.parse(response);

      return validated;
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Tool invocation failed:`, this.sanitizeError(err));
      throw err;
    }
  }

  /**
   * Health check
   * SEC-M9-08: Returns template URL (with placeholders) in status
   */
  async healthCheck(): Promise<ConnectionHealth> {
    try {
      // Simple health check: try to list tools
      await this.sendRequest('tools/list');

      return {
        name: this.config.name,
        transport: 'http',
        status: 'healthy',
        last_check: new Date(),
        tool_count: this.toolCache?.length || 0,
      };
    } catch (err) {
      return {
        name: this.config.name,
        transport: 'http',
        status: 'unhealthy',
        last_check: new Date(),
        // F-SEC-M9-001/004: Sanitize error to prevent credential leakage via admin API
        error: this.sanitizeError(err),
      };
    }
  }

  /**
   * Refresh tool list
   */
  async refreshToolList(): Promise<ToolDescriptor[]> {
    try {
      const response = (await this.sendRequest('tools/list')) as { tools: ToolDescriptor[] };
      this.toolCache = response.tools || [];
      console.log(`[MCP:${this.config.name}] Loaded ${this.toolCache.length} tools`);
      return this.toolCache;
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Failed to fetch tool list:`, this.sanitizeError(err));
      throw err;
    }
  }
}
