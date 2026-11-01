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
  /** Catalog id (TD-040): lets the per-user pool spawn only MCPs the user is granted and subscribed to */
  mcp_id?: string;
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
import { checkRunnerCommand, isBlockedEnvName } from '../services/runner-guard.js';

/**
 * @deprecated Exact-name list kept for compatibility. Use `isBlockedEnvName` (TD-039): it is
 * case-insensitive and also covers whole prefix families (npm_config_*, PIP_*, UV_*, PYTHON*, ...).
 */
export const BLOCKED_ENV_VARS = [
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'DYLD_INSERT_LIBRARIES', // macOS equivalent of LD_PRELOAD
  'DYLD_LIBRARY_PATH',
];

/**
 * M26.4: User MCP credentials for injection
 *
 * For OAuth2 credentials:
 * - envVars: Environment variables for stdio transport
 * - headers: HTTP headers (e.g., Authorization: Bearer <token>) for HTTP/SSE transport
 *
 * For static credentials:
 * - envVars: Environment variables (stdio only)
 * - headers: Empty (not applicable)
 */
export interface UserMcpCredentials {
  envVars: Record<string, string>; // For stdio transport
  headers: Record<string, string>; // For HTTP/SSE transport (e.g., Authorization: Bearer xyz)
}

/**
 * F-SEC-M6-001: Default allowlist of permitted base commands for stdio MCP transport.
 *
 * Configurable via the MCP_ALLOWED_COMMANDS environment variable as a
 * comma-separated list (e.g. "npx,uvx"). When the env var is set,
 * it replaces this default entirely.
 */
export const DEFAULT_ALLOWED_COMMANDS = ['npx', 'node', 'uvx', 'python', 'python3', 'deno', 'bun'];

/**
 * Returns the effective command allowlist, respecting the MCP_ALLOWED_COMMANDS
 * environment variable override.
 */
export function getAllowedCommands(): string[] {
  const override = process.env['MCP_ALLOWED_COMMANDS'];
  if (override && override.trim().length > 0) {
    return override
      .split(',')
      .map(c => c.trim())
      .filter(c => c.length > 0);
  }
  return DEFAULT_ALLOWED_COMMANDS;
}

/**
 * Shell metacharacters that are dangerous in command or argument strings.
 * These indicate an attempt to chain or redirect shell commands.
 */
const SHELL_METACHARACTERS = [';', '|', '&', '`', '$', '>', '<', '\n', '\r', '\0'];

/**
 * Returns true when the string contains any shell metacharacter.
 */
export function containsShellMetacharacters(value: string): boolean {
  return SHELL_METACHARACTERS.some(ch => value.includes(ch));
}

/**
 * Argument flags that allow arbitrary code evaluation. Checked against the
 * full argument string (case-insensitive where appropriate).
 *
 * Covers:
 *   node -e / --eval          → execute inline JavaScript
 *   python/python3 -c         → execute inline Python
 *   ruby -e                   → execute inline Ruby
 *   inline-eval / exec calls  → string patterns that suggest code injection
 */
const DANGEROUS_ARG_PATTERNS: RegExp[] = [/^-e$/, /^--eval$/, /^-c$/, /eval\s*\(/, /exec\s*\(/];

/**
 * Returns true when the argument string matches a known dangerous eval pattern.
 */
export function isDangerousArgument(arg: string): boolean {
  return DANGEROUS_ARG_PATTERNS.some(pattern => pattern.test(arg));
}

/**
 * F-SEC-M6-001: Validate downstream MCP config for command injection risks.
 *
 * Checks:
 * 1. All command array elements for shell metacharacters (not only command[0])
 * 2. Base command (command[0]) against the configured allowlist
 * 3. Arguments (command[1:]) for dangerous eval patterns
 * 4. Environment variable keys against BLOCKED_ENV_VARS
 */
export function validateMcpConfig(config: DownstreamMcpConfig): void {
  if (config.transport === 'stdio') {
    if (!config.command || config.command.length === 0) {
      throw new Error(`[${config.name}] stdio transport requires command array`);
    }

    const [cmd, ...args] = config.command;
    if (!cmd || cmd.trim() === '') {
      throw new Error(`[${config.name}] Empty command not allowed`);
    }

    // Check ALL elements of the command array for shell metacharacters
    for (const element of config.command) {
      if (containsShellMetacharacters(element)) {
        throw new Error(
          `[${config.name}] Command element contains shell metacharacters: ${element}`
        );
      }
    }

    // Enforce base command allowlist
    const allowedCommands = getAllowedCommands();
    if (!allowedCommands.includes(cmd)) {
      throw new Error(
        `[${config.name}] Command '${cmd}' is not in the allowed command list. ` +
          `Permitted commands: ${allowedCommands.join(', ')}. ` +
          `Override via MCP_ALLOWED_COMMANDS environment variable.`
      );
    }

    // Check arguments for dangerous eval/exec patterns
    for (const arg of args) {
      if (isDangerousArgument(arg)) {
        throw new Error(
          `[${config.name}] Argument '${arg}' matches a dangerous eval/exec pattern and is not permitted`
        );
      }
    }

    // TD-039: runner-changing options (--registry, --from, -p/--print, ...) in either form
    const runnerIssue = checkRunnerCommand(config.command);
    if (runnerIssue) {
      throw new Error(`[${config.name}] ${runnerIssue}`);
    }

    // Check for dangerous environment variables
    if (config.env) {
      for (const key of Object.keys(config.env)) {
        if (isBlockedEnvName(key)) {
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
 * SEC-M9-05: Tool name validation regex
 * Allows alphanumeric, underscore, dot, and hyphen (1-128 chars)
 */
const TOOL_NAME_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;

/**
 * SEC-M9-05: Validate tool name against allowed pattern
 * @param name - Tool name to validate
 * @returns true if valid, false otherwise
 */
export function validateToolName(name: string): boolean {
  return TOOL_NAME_REGEX.test(name);
}

/**
 * Aggregated tool catalog with source tracking
 */
export interface AggregatedTool extends ToolDescriptor {
  source_mcp: string; // Which downstream MCP provides this tool
  /** Catalog id of that MCP, stamped by the ToolRouter catalog builder (tool kill switch key, ADR-025) */
  mcp_id?: string;
  /** ADR-021: set when the definition is the admin-approved pinned one (hash of the served canonical form) */
  pinned_hash?: string;
}

/**
 * Tool invocation request
 */
export interface ToolInvocationRequest {
  tool_name: string;
  arguments: Record<string, unknown>;
}

/**
 * One MCP content block (TD-041): text, image, audio, resource_link or an embedded resource,
 * with the optional `annotations` / `_meta` the spec allows. Fields beyond the ones named here are
 * dropped (F-SEC-M6-011); each block is size-bounded.
 */
export interface ToolContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  size?: number;
  resource?: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Tool invocation response (MCP protocol)
 */
export interface ToolInvocationResponse {
  content: ToolContentBlock[];
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
const MAX_BLOCK_STRING = 10 * 1024 * 1024; // 10MB per text/data/blob
const MAX_BLOCK_JSON = MAX_BLOCK_STRING + 256 * 1024; // whole block incl. annotations/_meta

const metaRecord = z.record(z.string(), z.unknown());

const embeddedResourceSchema = z.object({
  uri: z.string().max(8192),
  mimeType: z.string().max(256).optional(),
  text: z.string().max(MAX_BLOCK_STRING).optional(),
  blob: z.string().max(MAX_BLOCK_STRING).optional(),
  annotations: metaRecord.optional(),
  _meta: metaRecord.optional(),
});

const contentBlockSchema = z
  .object({
    type: z.enum(['text', 'image', 'audio', 'resource_link', 'resource']),
    text: z.string().max(MAX_BLOCK_STRING).optional(),
    data: z.string().max(MAX_BLOCK_STRING).optional(),
    mimeType: z.string().max(256).optional(),
    uri: z.string().max(8192).optional(),
    name: z.string().max(1024).optional(),
    title: z.string().max(1024).optional(),
    description: z.string().max(8192).optional(),
    size: z.number().optional(),
    resource: embeddedResourceSchema.optional(),
    annotations: metaRecord.optional(),
    _meta: metaRecord.optional(),
  })
  .superRefine((b, ctx) => {
    // An embedded resource must carry its resource (the part the spec requires); other block
    // types stay as lenient as before so no previously-accepted result starts failing.
    if (b.type === 'resource' && !b.resource) {
      ctx.addIssue({ code: 'custom', message: 'resource block needs resource' });
    }
    if (JSON.stringify(b).length > MAX_BLOCK_JSON) {
      ctx.addIssue({ code: 'custom', message: 'content block too large' });
    }
  });

/**
 * F-SEC-M6-011: Zod schema for validating tool invocation responses
 * Prevents XSS, data exfiltration, and OOM from malicious MCPs
 */
export const ToolInvocationResponseSchema = z.object({
  content: z.array(contentBlockSchema).max(100), // Max 100 content items
  isError: z.boolean().optional(),
});
