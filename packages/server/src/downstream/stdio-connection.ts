/* eslint-disable no-console, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, no-useless-escape */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type {
  DownstreamMcpConfig,
  ToolDescriptor,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ConnectionHealth,
} from './types.js';
import { ToolInvocationResponseSchema, validateMcpConfig } from './types.js';

/**
 * SEC-M9-02: Safe environment variable whitelist
 * Only these system environment variables are passed to child processes
 */
export const SAFE_ENV_VARS = ['PATH', 'HOME', 'NODE_ENV', 'LANG', 'TZ', 'TERM', 'USER', 'SHELL'];

/**
 * Stdio-based MCP connection
 *
 * M6.3: Manages a child process running an MCP server over stdio
 * Implements JSON-RPC protocol over stdin/stdout
 *
 * Per Architecture §7.3:
 * - Spawns MCP process with command + env
 * - Injects credentials from resolved secrets
 * - Handles process lifecycle (spawn, health check, cleanup)
 */
export class StdioMcpConnection extends EventEmitter {
  // F-SEC-M6-003: Buffer size limits to prevent OOM
  private static readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly MAX_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB
  // F-SEC-M6-006: Pending request limit to prevent memory leak
  private static readonly MAX_PENDING_REQUESTS = 100;

  private config: DownstreamMcpConfig;
  private process: ChildProcess | null = null;
  private messageBuffer = '';
  private pendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private nextRequestId = 1;
  private toolCache: ToolDescriptor[] | null = null;
  private isHealthy = false;

  constructor(config: DownstreamMcpConfig) {
    super();
    this.config = config;

    // F-SEC-M6-001: Validate config (defense in depth)
    validateMcpConfig(config);

    if (!config.command || config.command.length === 0) {
      throw new Error(`[${config.name}] stdio transport requires command`);
    }
  }

  /**
   * Start the MCP process
   */
  async start(): Promise<void> {
    console.log(`[MCP:${this.config.name}] Starting stdio process...`);

    const [cmd, ...args] = this.config.command!;

    if (!cmd) {
      throw new Error(`[${this.config.name}] Empty command array`);
    }

    // F-SEC-M6-001: Log spawned command for auditability
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    console.warn(`[MCP:${this.config.name}] Spawning subprocess: ${cmd} ${args.join(' ')}`);
    if (this.config.env) {
      const envKeys = Object.keys(this.config.env).join(', ');
      console.warn(`[MCP:${this.config.name}] Environment variables injected: ${envKeys}`);
    }

    // SEC-M9-02: Build safe environment - whitelist + config overrides
    const safeEnv: Record<string, string> = {};
    for (const key of SAFE_ENV_VARS) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key]!;
      }
    }
    // Add MCP-specific env vars from config
    if (this.config.env) {
      Object.assign(safeEnv, this.config.env);
    }

    this.process = spawn(cmd, args, {
      cwd: this.config.cwd || process.cwd(),
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const childProcess = this.process; // Capture for closure

    // Handle stdout (JSON-RPC responses)
    childProcess.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data);
    });

    // Handle stderr (debug logs)
    // F-SEC-M6-004: Redact potential credentials in stderr
    childProcess.stderr?.on('data', (data: Buffer) => {
      const stderr = data.toString();
      const redacted = this.redactCredentials(stderr);

      // Truncate to 500 chars per chunk
      const truncated =
        redacted.length > 500 ? redacted.substring(0, 500) + '... (truncated)' : redacted;

      console.error(`[MCP:${this.config.name}] stderr:`, truncated);
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.log(`[MCP:${this.config.name}] Process exited: code=${code} signal=${signal}`);
      this.isHealthy = false;
      this.emit('disconnect');
    });

    // Handle process errors
    childProcess.on('error', (err: Error) => {
      console.error(`[MCP:${this.config.name}] Process error:`, err);
      this.isHealthy = false;
      this.emit('error', err);
    });

    // Wait for process to be ready (simple heuristic: wait 500ms)
    await new Promise(resolve => setTimeout(resolve, 500));

    // Fetch initial tool list
    await this.refreshToolList();

    this.isHealthy = true;
    console.log(`[MCP:${this.config.name}] Started successfully`);
  }

  /**
   * Handle stdout data (JSON-RPC messages)
   */
  private handleStdout(data: Buffer): void {
    this.messageBuffer += data.toString();

    // F-SEC-M6-003: Check buffer size limit
    if (this.messageBuffer.length > StdioMcpConnection.MAX_BUFFER_SIZE) {
      console.error(
        `[MCP:${this.config.name}] Buffer exceeded ${StdioMcpConnection.MAX_BUFFER_SIZE} bytes, killing process`
      );
      this.process?.kill('SIGKILL');
      this.isHealthy = false;
      this.messageBuffer = '';
      this.emit('error', new Error('Buffer size limit exceeded'));
      return;
    }

    // Try to parse complete JSON-RPC messages (newline-delimited)
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      // F-SEC-M6-003: Check individual message size
      if (line.length > StdioMcpConnection.MAX_MESSAGE_SIZE) {
        console.error(
          `[MCP:${this.config.name}] Message exceeded ${StdioMcpConnection.MAX_MESSAGE_SIZE} bytes, discarding`
        );
        continue;
      }

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (err) {
        console.error(
          `[MCP:${this.config.name}] Failed to parse message:`,
          line.substring(0, 100),
          err
        );
      }
    }
  }

  /**
   * Handle parsed JSON-RPC message
   */
  private handleMessage(message: Record<string, unknown>): void {
    if (message.id && typeof message.id === 'number') {
      // Response to a request we sent
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
    } else {
      // Notification or unsolicited message
      console.log(`[MCP:${this.config.name}] Notification:`, message);
    }
  }

  /**
   * Redact potential credentials from stderr output
   * F-SEC-M6-004: Prevent credential leakage in logs
   */
  private redactCredentials(text: string): string {
    return (
      text
        // API keys (OpenAI, Anthropic, etc.)
        .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***')
        .replace(/sk_[a-z]+_[a-zA-Z0-9]{20,}/g, 'sk_***REDACTED***')
        // GitHub tokens
        .replace(/ghp_[a-zA-Z0-9]{36,}/g, 'ghp_***REDACTED***')
        .replace(/github_pat_[a-zA-Z0-9_]{82}/g, 'github_pat_***REDACTED***')
        // Bearer tokens
        .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer ***REDACTED***')
        // Generic tokens/passwords in key=value or "key": "value" format
        .replace(
          /(token|password|secret|key|apikey|api_key)[\s]*[:=][\s]*["']?[^\s"',}]+/gi,
          '$1=***REDACTED***'
        )
    );
  }

  /**
   * Send JSON-RPC request to MCP process
   */
  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      throw new Error(`[${this.config.name}] Process not running`);
    }

    // F-SEC-M6-006: Check pending request limit
    if (this.pendingRequests.size >= StdioMcpConnection.MAX_PENDING_REQUESTS) {
      throw new Error(
        `[${this.config.name}] Too many pending requests (${this.pendingRequests.size}), MCP may be unresponsive`
      );
    }

    const id = this.nextRequestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`[${this.config.name}] Request timeout: ${method}`));
      }, 30000); // 30s timeout

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.process!.stdin!.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Fetch tool list from MCP
   */
  async refreshToolList(): Promise<ToolDescriptor[]> {
    try {
      const response = (await this.sendRequest('tools/list')) as { tools: ToolDescriptor[] };
      this.toolCache = response.tools || [];
      console.log(`[MCP:${this.config.name}] Loaded ${this.toolCache.length} tools`);
      return this.toolCache;
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Failed to fetch tool list:`, err);
      throw err;
    }
  }

  /**
   * Get cached tool list
   */
  getTools(): ToolDescriptor[] {
    return this.toolCache || [];
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

      // F-SEC-M6-011: Validate response against schema
      const validated = ToolInvocationResponseSchema.parse(response);

      return validated;
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Tool invocation failed:`, err);
      throw err;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<ConnectionHealth> {
    try {
      // Simple health check: try to list tools
      await this.sendRequest('tools/list');

      return {
        name: this.config.name,
        transport: 'stdio',
        status: 'healthy',
        last_check: new Date(),
        tool_count: this.toolCache?.length || 0,
      };
    } catch (err) {
      return {
        name: this.config.name,
        transport: 'stdio',
        status: 'unhealthy',
        last_check: new Date(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Stop the MCP process
   */
  async stop(): Promise<void> {
    console.log(`[MCP:${this.config.name}] Stopping...`);

    if (this.process) {
      this.process.kill('SIGTERM');

      // Wait for graceful exit (max 5s)
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (this.process) {
            console.log(`[MCP:${this.config.name}] Force killing...`);
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }

    this.isHealthy = false;
    console.log(`[MCP:${this.config.name}] Stopped`);
  }

  /**
   * Check if connection is healthy
   */
  isConnected(): boolean {
    return this.isHealthy && this.process !== null;
  }
}
