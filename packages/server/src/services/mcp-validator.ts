/**
 * MCP Validation Engine
 *
 * Validates MCP catalog entry configuration without spawning actual MCP processes.
 * Checks configuration structure, transport-specific requirements, and env var syntax.
 *
 * @see M23.2: MCP Validation Engine
 */

import type { McpCatalogEntry } from '@mcpambassador/core';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  validated_at: string;
}

/**
 * Validate MCP catalog entry configuration
 *
 * Performs static validation without connecting to actual MCP servers:
 * - Transport-specific validation (stdio requires command, http/sse requires url)
 * - Config JSON is valid
 * - Credential schema (if requires_user_credentials=true) is valid JSON Schema
 * - ${ENV_VAR} references in config values are syntactically valid
 *
 * @param entry MCP catalog entry to validate
 * @returns Validation result with errors and warnings
 */
export async function validateMcpConfig(entry: McpCatalogEntry): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Parse config JSON
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(entry.config);
  } catch (err) {
    errors.push(`Invalid config JSON: ${err instanceof Error ? err.message : 'parse error'}`);
    return {
      valid: false,
      errors,
      warnings,
      validated_at: new Date().toISOString(),
    };
  }

  // Transport-specific validation
  switch (entry.transport_type) {
    case 'stdio':
      if (!config.command || !Array.isArray(config.command) || config.command.length === 0) {
        errors.push('stdio transport requires "command" array in config');
      } else {
        const command = config.command as unknown[];
        if (!command.every((item) => typeof item === 'string')) {
          errors.push('stdio command array must contain only strings');
        }
      }
      break;

    case 'http':
    case 'sse':
      if (!config.url || typeof config.url !== 'string') {
        errors.push(`${entry.transport_type} transport requires "url" string in config`);
      } else {
        try {
          new URL(config.url as string);
        } catch {
          errors.push(`Invalid URL in config: ${config.url}`);
        }
      }
      break;

    default:
      errors.push(`Unknown transport type: ${entry.transport_type}`);
  }

  // MCP-002: Command injection checks (matching downstream validator: F-SEC-M6-001)
  if (entry.transport_type === 'stdio' && config.command) {
    const [cmd] = config.command as string[];
    if (cmd) {
      // Check for shell metacharacters
      if (cmd.includes(';') || cmd.includes('|') || cmd.includes('&') || cmd.includes('`') || cmd.includes('$')) {
        errors.push(`Command contains shell metacharacters: ${cmd}`);
      }
    }
    
    // Check for dangerous environment variables
    const BLOCKED_ENV_VARS = ['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'];
    if (config.env && typeof config.env === 'object') {
      for (const key of Object.keys(config.env as Record<string, unknown>)) {
        if (BLOCKED_ENV_VARS.includes(key)) {
          errors.push(`Environment variable '${key}' is blocked for security reasons`);
        }
      }
    }
  }

  // Validate env var references in config
  const envVarPattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      const matches = value.matchAll(envVarPattern);
      for (const match of matches) {
        // Just validate syntax — don't check if env var exists
        // The actual resolution happens at runtime by config loader
        const varName = match[1];
        if (!varName || varName.length === 0) {
          warnings.push(`Empty environment variable reference in config.${key}`);
        }
      }

      // Check for malformed env var references
      if (value.includes('${') && !value.match(envVarPattern)) {
        warnings.push(
          `Possible malformed env var reference in config.${key}: "${value}". Expected format: \${VAR_NAME}`
        );
      }
    }
  }

  // Validate credential schema if required
  if (entry.requires_user_credentials) {
    let credentialSchema: unknown;
    try {
      credentialSchema = JSON.parse(entry.credential_schema);
    } catch (err) {
      errors.push(
        `Invalid credential_schema JSON: ${err instanceof Error ? err.message : 'parse error'}`
      );
    }

    if (credentialSchema) {
      // Basic JSON Schema validation
      if (typeof credentialSchema !== 'object' || credentialSchema === null) {
        errors.push('credential_schema must be a valid JSON Schema object');
      } else {
        const schema = credentialSchema as Record<string, unknown>;
        // Check for at least a "type" or "properties" field
        if (!schema.type && !schema.properties) {
          warnings.push(
            'credential_schema missing "type" or "properties" — may not be a valid JSON Schema'
          );
        }
      }
    }
  }

  // Validate tool_catalog if present
  try {
    const toolCatalog = JSON.parse(entry.tool_catalog);
    if (!Array.isArray(toolCatalog)) {
      warnings.push('tool_catalog should be a JSON array');
    }
  } catch (err) {
    warnings.push(
      `Invalid tool_catalog JSON: ${err instanceof Error ? err.message : 'parse error'}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    validated_at: new Date().toISOString(),
  };
}
