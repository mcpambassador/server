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
 * comma-separated list (e.g. "npx,uvx,docker"). When the env var is set,
 * it replaces this default entirely.
 */
export const DEFAULT_ALLOWED_COMMANDS = [
  'npx',
  'node',
  'uvx',
  'docker',
  'python',
  'python3',
  'deno',
  'bun',
];

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
 *   eval() / exec()           → string patterns that suggest code injection
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
  content: z
    .array(
      z.object({
        type: z.enum(['text', 'image', 'resource']),
        text: z
          .string()
          .max(10 * 1024 * 1024)
          .optional(), // 10MB max per text content
        data: z
          .string()
          .max(10 * 1024 * 1024)
          .optional(), // 10MB max per data content
        mimeType: z.string().optional(),
      })
    )
    .max(100), // Max 100 content items
  isError: z.boolean().optional(),
});
