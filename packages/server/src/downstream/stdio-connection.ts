/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, no-useless-escape */

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
import { ErrorRingBuffer, type ErrorLogEntry } from './error-ring-buffer.js';

import { StringDecoder } from 'node:string_decoder';
import { logger, redactSecretsInString, StreamRedactor } from '@mcpambassador/core';
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
// A flag whose name looks secret (`--api-key VALUE`) carries the secret in the NEXT argv element
const SECRET_FLAG_RE = /^--?[\w-]*(key|token|secret|password|passwd|auth|credential)[\w-]*$/i;

// `--api-key=VALUE` form
const SECRET_FLAG_EQ_RE =
  /^(--?[\w-]*(?:key|token|secret|password|passwd|auth|credential)[\w-]*)=.*$/i;

function redactSecretFlagValues(args: string[]): string[] {
  return args.map((a, i) =>
    i > 0 && SECRET_FLAG_RE.test(args[i - 1]!) ? '***' : a.replace(SECRET_FLAG_EQ_RE, '$1=***')
  );
}

export class StdioMcpConnection extends EventEmitter {
  private static readonly MAX_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB
  // TD-045: an oversize line is discarded in streaming mode (bounded memory) and fails only the request
  // it answers. A line that never ends past this many bytes is a runaway: kill the process (it respawns).
  private static readonly MAX_DISCARD_BYTES = 64 * 1024 * 1024;
  private static readonly EDGE_BYTES = 512;
  // F-SEC-M6-006: Pending request limit to prevent memory leak
  private static readonly MAX_PENDING_REQUESTS = 100;

  private config: DownstreamMcpConfig;
  private process: ChildProcess | null = null;
  private messageBuffer = '';
  // TD-045: set while discarding the rest of an oversize line
  private discarding: { head: string; tail: string; bytes: number; failed?: boolean } | null = null;
  private stopRequested = false;
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
  private processExited = false;
  private startedAt: number | null = null;
  // M33.1: Error/stderr ring buffer
  private errorBuffer = new ErrorRingBuffer(50);
  /** config.env values (can be decrypted user credentials): scrubbed by exact value from stderr/errors */
  private secretValues: string[] = [];

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
    // TD-045: never overwrite a live process (it would be orphaned, still holding credentials)
    if (this.process && !this.processExited) {
      throw new Error(`[${this.config.name}] Process already running`);
    }
    this.stopRequested = false;
    this.messageBuffer = '';
    this.discarding = null;
    logger.info(`[MCP:${this.config.name}] Starting stdio process...`);

    // Reset state for restart support
    this.processExited = false;
    this.isHealthy = false;
    this.messageBuffer = '';
    this.toolCache = null;

    const [cmd, ...args] = this.config.command!;

    if (!cmd) {
      throw new Error(`[${this.config.name}] Empty command array`);
    }

    // Exact config.env values (can be decrypted user credentials) are scrubbed from every output
    this.secretValues = Object.values(this.config.env ?? {}).filter(
      (v): v is string => typeof v === 'string'
    );

    // F-SEC-M6-001: Log spawned command for auditability
    logger.warn(
      redactSecretsInString(
        `[MCP:${this.config.name}] Spawning subprocess: ${cmd} ${redactSecretFlagValues(args).join(' ')}`,
        this.secretValues
      )
    );
    if (this.config.env) {
      const envKeys = Object.keys(this.config.env).join(', ');
      logger.warn(`[MCP:${this.config.name}] Environment variables injected: ${envKeys}`);
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

    // TD-045: a write to a dead child emits EPIPE asynchronously on stdin. Unhandled, it would crash the
    // whole server. Fail the in-flight requests instead; the exit handler does the rest.
    childProcess.stdin?.on('error', (err: Error) => {
      logger.warn({ errName: err.name }, `[MCP:${this.config.name}] stdin error`);
      this.errorBuffer.push(`stdin error: ${err.name}`, 'error');
      this.rejectAllPending(new Error(`[${this.config.name}] MCP process unavailable`));
    });

    // Handle stdout (JSON-RPC responses)
    childProcess.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data);
    });

    // Handle stderr (debug logs)
    // F-SEC-M6-004: Redact potential credentials in stderr
    // M33.1: Capture stderr in error buffer
    // Line-buffered so a secret split across chunks is joined before it is scrubbed
    const stderrRedactor = new StreamRedactor(this.secretValues);
    const emitStderr = (lines: string[]): void => {
      // TD-028: the buffer is exposed via the admin API, so it gets the same redaction as the log
      const kept = lines.filter(line => line.trim().length > 0);
      if (kept.length === 0) return;
      for (const line of kept) this.errorBuffer.push(line, 'error');

      // Truncate to 500 chars per chunk for console logging
      const joined = kept.join('\n');
      const truncated = joined.length > 500 ? joined.substring(0, 500) + '... (truncated)' : joined;
      logger.error({ stderr: truncated }, `[MCP:${this.config.name}] stderr`);
    };
    // StringDecoder: a multibyte character split across chunks must not break exact-value matches
    const stderrDecoder = new StringDecoder('utf8');
    childProcess.stderr?.on('data', (data: string | Buffer) => {
      emitStderr(stderrRedactor.push(typeof data === 'string' ? data : stderrDecoder.write(data)));
    });
    childProcess.stderr?.on('end', () => {
      emitStderr(stderrRedactor.push(stderrDecoder.end()));
      emitStderr(stderrRedactor.flush());
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const exitMsg = `Process exited: code=${code} signal=${signal}`;
      logger.info(`[MCP:${this.config.name}] ${exitMsg}`);
      // M33.1: Log exit to error buffer
      this.errorBuffer.push(exitMsg, 'error');
      this.processExited = true;
      this.isHealthy = false;
      this.rejectAllPending(new Error(`[${this.config.name}] MCP process exited`));
      this.emit('disconnect', { intentional: this.stopRequested });
    });

    // Handle process errors
    childProcess.on('error', (err: Error) => {
      logger.error({ err }, `[MCP:${this.config.name}] Process error:`);
      // M33.1: Log error to buffer
      this.errorBuffer.push(
        // td036-allow: already passed through redactSecretsInString
        `Process error: ${redactSecretsInString(err.message, this.secretValues)}`,
        'error'
      );
      this.isHealthy = false;
      this.emit('error', err);
    });

    // Wait for process to be ready (simple heuristic: wait 500ms)
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if process already exited (e.g., npx install failure)
    if (this.processExited) {
      throw new Error(`[${this.config.name}] Process exited during startup`);
    }

    // MCP protocol: send initialize handshake before any other requests
    try {
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

      // Send initialized notification (no response expected)
      if (this.process?.stdin) {
        this.process.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }) + '\n'
        );
      }
    } catch (err) {
      logger.error({ err }, `[MCP:${this.config.name}] Initialize handshake failed:`);
      // Some legacy MCPs may not support initialize — continue anyway
    }

    // Fetch initial tool list
    try {
      await this.refreshToolList();
    } catch (err) {
      // If tool list fetch fails, mark unhealthy but don't crash
      logger.error({ err }, `[MCP:${this.config.name}] Failed to fetch initial tool list:`);
      this.isHealthy = false;
      return; // Continue without tools — will retry on health check
    }

    this.isHealthy = true;
    this.startedAt = Date.now();
    logger.info(`[MCP:${this.config.name}] Started successfully`);
  }

  /**
   * Handle stdout data (JSON-RPC messages, newline-delimited).
   * TD-045: memory stays bounded by MAX_MESSAGE_SIZE. A line over the limit is dropped in streaming mode and
   * only the request it answers is failed (id read from the line's head/tail); the process is not killed.
   */
  private handleStdout(data: Buffer): void {
    let chunk = data.toString();

    while (chunk.length > 0) {
      if (this.discarding) {
        const nl = chunk.indexOf('\n');
        const part = nl === -1 ? chunk : chunk.slice(0, nl);
        this.discarding.bytes += part.length;
        this.discarding.tail = (this.discarding.tail + part).slice(-StdioMcpConnection.EDGE_BYTES);
        if (nl === -1) {
          this.failRunaway(this.discarding);
          return;
        }
        const d = this.discarding;
        this.discarding = null;
        if (!d.failed) this.failOversize(d.head, d.tail, d.bytes);
        chunk = chunk.slice(nl + 1);
        continue;
      }

      this.messageBuffer += chunk;
      chunk = '';
      const lines = this.messageBuffer.split('\n');
      this.messageBuffer = lines.pop() ?? ''; // incomplete tail stays buffered

      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > StdioMcpConnection.MAX_MESSAGE_SIZE) {
          this.failOversize(
            line.slice(0, StdioMcpConnection.EDGE_BYTES),
            line.slice(-StdioMcpConnection.EDGE_BYTES),
            line.length
          );
          continue;
        }
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (err) {
          // Metadata only: a raw downstream line can carry tool results or tokens
          // (never the SyntaxError message: it embeds a snippet of the input)
          logger.error(
            { errName: err instanceof Error ? err.name : typeof err, lineLength: line.length },
            `[MCP:${this.config.name}] Failed to parse message`
          );
        }
      }

      if (this.messageBuffer.length > StdioMcpConnection.MAX_MESSAGE_SIZE) {
        // Partial line already over the limit: switch to discard mode, keep only its edges.
        const buf = this.messageBuffer;
        this.messageBuffer = '';
        this.discarding = {
          head: buf.slice(0, StdioMcpConnection.EDGE_BYTES),
          tail: buf.slice(-StdioMcpConnection.EDGE_BYTES),
          bytes: buf.length,
        };
        this.failRunaway(this.discarding);
      }
    }
  }

  /** TD-045: fail the request an oversize response answers (never hangs to the 30s timeout). */
  private failOversize(head: string, tail: string, bytes: number): void {
    logger.error(
      `[MCP:${this.config.name}] Message of ${bytes} bytes exceeded ${StdioMcpConnection.MAX_MESSAGE_SIZE}, discarded`
    );
    this.errorBuffer.push(`Oversize message (${bytes} bytes) discarded`, 'error');
    const err = new Error(
      `[${this.config.name}] Response too large (limit ${StdioMcpConnection.MAX_MESSAGE_SIZE} bytes)`
    );
    // Top-level id only: right after the opening brace, or right before the closing one.
    const m =
      /^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(\d+)\s*,/.exec(head) ??
      /,\s*"id"\s*:\s*(\d+)\s*\}\s*$/.exec(tail);
    const id = m ? Number(m[1]) : undefined;
    const pending = id !== undefined ? this.pendingRequests.get(id) : undefined;
    if (pending && id !== undefined) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.reject(err);
    } else {
      // Cannot tell whose answer it was: fail all in-flight requests fast rather than let them hang.
      this.rejectAllPending(err);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pendingRequests) {
      clearTimeout(p.timeout);
      this.pendingRequests.delete(id);
      p.reject(err);
    }
  }

  /**
   * TD-045: a line that never ends. Discarding is O(1) memory, so the process is left alone; the requests
   * in flight cannot be matched to the line, so fail them once instead of letting them hang.
   */
  private failRunaway(d: { bytes: number; failed?: boolean }): void {
    if (d.failed || d.bytes <= StdioMcpConnection.MAX_DISCARD_BYTES) return;
    d.failed = true;
    logger.error(`[MCP:${this.config.name}] Unterminated output over limit, discarding`);
    this.errorBuffer.push('Unterminated oversize output discarded', 'error');
    this.rejectAllPending(
      new Error(
        `[${this.config.name}] Response too large (limit ${StdioMcpConnection.MAX_MESSAGE_SIZE} bytes)`
      )
    );
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
      if (message.method === 'notifications/tools/list_changed') {
        // ADR-021: the caller re-fetches tools/list; the pin filter decides what the agent may see.
        this.emit('tools_list_changed');
        return;
      }
      // Metadata only: notification params are arbitrary downstream payload
      logger.info(
        { method: typeof message.method === 'string' ? message.method : undefined },
        `[MCP:${this.config.name}] Notification`
      );
    }
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
        // td036-allow: wraps a downstream error, not a DB error
        reject(err instanceof Error ? err : new Error(String(err)));
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
      logger.info(`[MCP:${this.config.name}] Loaded ${this.toolCache.length} tools`);
      return this.toolCache;
    } catch (err) {
      logger.error({ err }, `[MCP:${this.config.name}] Failed to fetch tool list:`);
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
      logger.error({ err }, `[MCP:${this.config.name}] Tool invocation failed:`);
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
        // td036-allow: downstream connection error, not a DB error; admin health needs the raw text
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Stop the MCP process
   */
  async stop(): Promise<void> {
    logger.info(`[MCP:${this.config.name}] Stopping...`);
    this.stopRequested = true;

    if (this.process) {
      this.process.kill('SIGTERM');

      // Wait for graceful exit (max 5s)
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.info(`[MCP:${this.config.name}] Force killing...`);
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

    this.startedAt = null;
    this.isHealthy = false;
    this.processExited = false;
    this.messageBuffer = '';
    this.discarding = null;
    this.rejectAllPending(new Error(`[${this.config.name}] MCP stopped`));
    logger.info(`[MCP:${this.config.name}] Stopped`);
  }

  /**
   * Check if connection is healthy
   */
  isConnected(): boolean {
    return this.isHealthy && this.process !== null;
  }

  /**
   * Get detailed health information for troubleshooting
   */
  getHealthDetail(): {
    pid: number | null;
    pendingRequests: number;
    uptime_ms: number | null;
    processExited: boolean;
    toolCount: number;
  } {
    const uptime_ms = this.startedAt !== null ? Date.now() - this.startedAt : null;

    return {
      pid: this.process?.pid ?? null,
      pendingRequests: this.pendingRequests.size,
      uptime_ms,
      processExited: this.processExited,
      toolCount: this.toolCache?.length || 0,
    };
  }

  /**
   * M33.1: Get error/stderr history
   */
  getErrorHistory(): ErrorLogEntry[] {
    return this.errorBuffer.getAll();
  }

  /**
   * M33.1: Get most recent error entry
   */
  getLastError(): ErrorLogEntry | null {
    return this.errorBuffer.getLast();
  }

  /**
   * M33.1: Clear error history buffer
   */
  clearErrorHistory(): void {
    this.errorBuffer.clear();
  }

  /**
   * M33.1: Get error count
   */
  getErrorCount(): number {
    return this.errorBuffer.getCount();
  }
}
