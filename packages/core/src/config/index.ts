/**
 * Configuration loader with secrets resolution
 *
 * Implements ${ENV_VAR} and ${file:/path} resolution with startup validation.
 *
 * @see Architecture §6 Configuration & Secrets Management
 * @see ADR-005 Secrets Management Strategy
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import {
  AmbassadorConfigSchema,
  buildCredentialPatterns,
  type AmbassadorConfig,
} from './schema.js';
import { logger } from '../utils/logger.js';
import { AmbassadorError } from '../utils/errors.js';

// Re-export types
export type { AmbassadorConfig } from './schema.js';
export { AmbassadorConfigSchema } from './schema.js';

/**
 * Configuration loading options
 */
export interface ConfigLoadOptions {
  /** Additional credential field patterns (beyond defaults) */
  additional_credential_patterns?: string[];
  /** Enforcement mode: warn or block on literal secrets */
  enforcement?: 'warn' | 'block';
  /** Whether to scrub env vars after loading (default: true per ADR-005) */
  scrub_env_vars?: boolean;
  /** Base directory for ${file:} resolution (default: config file directory) */
  secrets_base_dir?: string;
}

/**
 * Load configuration from YAML file with secrets resolution
 *
 * @param configPath Path to ambassador-server.yaml
 * @param options Loading options
 * @returns Validated and resolved configuration
 * @throws AmbassadorError if config is invalid or contains literal secrets (block mode)
 */
export async function loadConfig(
  configPath: string,
  options: ConfigLoadOptions = {}
): Promise<AmbassadorConfig> {
  const {
    additional_credential_patterns = [],
    enforcement = 'block',
    scrub_env_vars = true,
    secrets_base_dir,
  } = options;

  logger.info(`[config] Loading configuration from ${configPath}`);

  try {
    // 1. Read YAML file with size check (F-SEC-M3-003)
    const stats = await fs.stat(configPath);
    if (stats.size > 1024 * 1024) {
      throw new AmbassadorError(
        `Config file ${configPath} exceeds 1MB size limit`,
        'config_too_large'
      );
    }

    const fileContent = await fs.readFile(configPath, 'utf-8');

    // Parse YAML with explicit limits (F-SEC-M3-003)
    const rawConfig = yaml.parse(fileContent, {
      maxAliasCount: 50,
      schema: 'core',
      uniqueKeys: true,
    });

    // 2. Resolve secrets (${ENV_VAR} and ${file:/path})
    const credentialPatterns = buildCredentialPatterns(additional_credential_patterns);
    const baseDir = secrets_base_dir || path.dirname(path.resolve(configPath));
    const resolvedConfig = await resolveSecrets(
      rawConfig,
      credentialPatterns,
      enforcement,
      baseDir
    );

    // 3. Validate schema with Zod
    const validatedConfig = AmbassadorConfigSchema.parse(resolvedConfig);

    // 4. Scrub environment variables (ADR-005 §2.3.3)
    if (scrub_env_vars) {
      scrubEnvironmentVariables(credentialPatterns);
    }

    logger.info('[config] Configuration loaded successfully');
    return validatedConfig;
  } catch (error) {
    if (error instanceof AmbassadorError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new AmbassadorError(`Failed to load config: ${error.message}`, 'configuration_error');
    }
    throw error;
  }
}

/**
 * Resolve ${ENV_VAR} and ${file:/path} references in config
 *
 * @param obj Config object (mutated in place)
 * @param credentialPatterns List of credential field patterns
 * @param enforcement Enforcement mode ('warn' | 'block')
 * @param secretsBaseDir Base directory for file resolution
 * @returns Resolved config object
 */
async function resolveSecrets(
  obj: unknown,
  credentialPatterns: string[],
  enforcement: 'warn' | 'block',
  secretsBaseDir: string
): Promise<unknown> {
  if (typeof obj === 'string') {
    // Check for resolution syntax (F-SEC-M3-011: case-sensitive)
    const envMatch = obj.match(/^\$\{ENV:([A-Z_][A-Z0-9_]*)\}$/);
    if (envMatch) {
      const envVar = envMatch[1];
      if (!envVar) {
        throw new AmbassadorError(
          'Invalid ENV reference: variable name is empty',
          'config_resolution_error'
        );
      }
      const value = process.env[envVar];
      if (value === undefined) {
        throw new AmbassadorError(
          `Environment variable ${envVar} not found`,
          'config_resolution_error'
        );
      }
      return value;
    }

    const fileMatch = obj.match(/^\$\{file:(.+)\}$/);
    if (fileMatch) {
      const filePath = fileMatch[1]!; // Non-null assertion: regex capture group always defined when match succeeds
      return await resolveFileReference(filePath, secretsBaseDir);
    }

    // No resolution syntax - return as-is
    return obj;
  }

  if (Array.isArray(obj)) {
    return Promise.all(
      obj.map(item => resolveSecrets(item, credentialPatterns, enforcement, secretsBaseDir))
    );
  }

  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Check if this is a credential field with literal value
      if (typeof value === 'string' && isCredentialFieldKey(key, credentialPatterns)) {
        const hasResolverSyntax = value.startsWith('${');
        if (hasResolverSyntax) {
          // F-SEC-M3-008: Verify it's a valid resolver, not just ${anything}
          const isValidResolver = value.match(/^\$\{(ENV:[A-Z_][A-Z0-9_]*|file:.+)\}$/);
          if (!isValidResolver) {
            const message = `Credential field '${key}' has unresolved reference: ${value}`;
            if (enforcement === 'block') {
              throw new AmbassadorError(message, 'unresolved_credential');
            } else {
              logger.warn(`[config] ${message}`);
            }
          }
        } else {
          // No resolver syntax - literal secret
          const message = `Credential field '${key}' contains literal value - use \${ENV:VAR} or \${file:/path}`;
          if (enforcement === 'block') {
            throw new AmbassadorError(message, 'literal_secret_detected');
          } else {
            logger.warn(`[config] ${message}`);
          }
        }
      }
      resolved[key] = await resolveSecrets(value, credentialPatterns, enforcement, secretsBaseDir);
    }
    return resolved;
  }

  return obj;
}

/**
 * Resolve ${file:/path} reference with path containment (F-SEC-M3-001)
 *
 * @param filePath Path to secret file (absolute or relative to secrets base dir)
 * @param secretsBaseDir Base directory for path containment
 * @returns Secret value (trimmed)
 * @throws AmbassadorError if file cannot be read or validation fails
 */
async function resolveFileReference(filePath: string, secretsBaseDir: string): Promise<string> {
  try {
    // Resolve to absolute path (relative to secrets base dir)
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(secretsBaseDir, filePath);

    // Resolve canonical path (follows symlinks) and validate containment
    const realPath = await fs.realpath(absolutePath);
    const realBase = await fs.realpath(secretsBaseDir);

    if (!realPath.startsWith(realBase + path.sep) && realPath !== realBase) {
      throw new AmbassadorError(
        `Secret file path escapes allowed directory: ${filePath}`,
        'path_traversal_blocked'
      );
    }

    // Validate file exists and is readable
    const stats = await fs.lstat(realPath);

    // Reject symlinks (defense in depth - realpath already resolved them)
    if (stats.isSymbolicLink()) {
      throw new AmbassadorError(
        `Secret file cannot be a symlink: ${filePath}`,
        'symlink_not_allowed'
      );
    }

    // Check file size (max 1MB per ADR-005)
    if (stats.size > 1024 * 1024) {
      throw new AmbassadorError(`Secret file ${realPath} exceeds 1MB`, 'file_too_large');
    }

    // Check permissions (should be 0600 or 0400)
    const mode = stats.mode & 0o777;
    if (mode > 0o600) {
      logger.warn(
        `[config] Secret file ${realPath} has permissive permissions (${mode.toString(8)}) - should be 0600 or 0400`
      );
    }

    // Read file content
    const content = await fs.readFile(realPath, 'utf-8');
    return content.trim();
  } catch (error) {
    if (error instanceof AmbassadorError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new AmbassadorError(
        `Cannot read secret file ${filePath}: ${error.message}`,
        'file_resolution_error'
      );
    }
    throw error;
  }
}

/**
 * Check if a key matches credential field patterns
 */
function isCredentialFieldKey(key: string, patterns: string[]): boolean {
  const lowerKey = key.toLowerCase();
  return patterns.some(pattern => lowerKey.includes(pattern));
}

/**
 * Scrub environment variables matching credential patterns (ADR-005 §2.3.3)
 *
 * F-SEC-M3-009: delete process.env.VAR actually works in Node.js
 */
function scrubEnvironmentVariables(credentialPatterns: string[]): void {
  const scrubbed: string[] = [];

  for (const key of Object.keys(process.env)) {
    if (isCredentialFieldKey(key, credentialPatterns)) {
      delete process.env[key]; // This works in Node.js (F-SEC-M3-009)
      scrubbed.push(key);
    }
  }

  if (scrubbed.length > 0) {
    logger.info(
      `[config] Scrubbed ${scrubbed.length} environment variables: ${scrubbed.join(', ')}`
    );
  }
}
