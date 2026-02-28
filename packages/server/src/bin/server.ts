#!/usr/bin/env node

/* eslint-disable no-console, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/explicit-function-return-type */

import { AmbassadorServer } from '../server.js';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';
import type { DownstreamMcpConfig } from '../downstream/index.js';

/**
 * MCP Ambassador Server CLI
 *
 * Usage:
 *   mcpambassador-server [options]
 *
 * Options:
 *   --port <port>          Server port (default: 8443)
 *   --host <host>          Server host (default: 0.0.0.0)
 *   --data-dir <path>      Data directory (default: ./data)
 *   --server-name <name>   Server name for TLS cert (default: localhost)
 *   --log-level <level>    Log level (default: info)
 */

interface CliArgs {
  port?: number;
  host?: string;
  dataDir?: string;
  serverName?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const config: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--port':
        if (next) {
          config.port = parseInt(next, 10);
          i++;
        }
        break;
      case '--host':
        if (next) {
          config.host = next;
          i++;
        }
        break;
      case '--data-dir':
        if (next) {
          config.dataDir = next;
          i++;
        }
        break;
      case '--server-name':
        if (next) {
          config.serverName = next;
          i++;
        }
        break;
      case '--log-level':
        if (next && ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(next)) {
          config.logLevel = next as CliArgs['logLevel'];
          i++;
        }
        break;
      case '--help':
      case '-h':
        console.log(`
MCP Ambassador Server v0.1.0

Usage:
  mcpambassador-server [options]

Options:
  --port <port>          Server port (default: 8443)
  --host <host>          Server host (default: 0.0.0.0)
  --data-dir <path>      Data directory (default: ./data)
  --server-name <name>   Server name for TLS cert (default: localhost)
  --log-level <level>    Log level: trace|debug|info|warn|error|fatal (default: info)
  --help, -h             Show this help message

Examples:
  # Start server with defaults
  mcpambassador-server

  # Start server on custom port
  mcpambassador-server --port 9443

  # Start with debug logging
  mcpambassador-server --log-level debug
        `);
        process.exit(0);
    }
  }

  return config;
}

/**
 * Find config file by checking multiple locations in order
 * 1. /config/ambassador-server.yaml (dedicated config mount - Docker bind mount)
 * 2. {dataDir}/config/ambassador-server.yaml (legacy location for backwards compatibility)
 *
 * Example files are NOT auto-loaded to prevent test MCPs from being installed on fresh production servers.
 */
function findConfigFile(dataDir: string): string | null {
  const candidates = [
    '/config/ambassador-server.yaml',
    path.join(dataDir, 'config', 'ambassador-server.yaml'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[Server] Found config file: ${candidate}`);
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve ${ENV_VAR} references in a string
 * Supports both ${VAR} and ${ENV:VAR} syntax for compatibility
 */
function resolveEnvVar(value: string): string {
  // Match ${VAR} or ${ENV:VAR}
  return value.replace(/\$\{(?:ENV:)?([A-Z_][A-Z0-9_]*)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(`[Server] Environment variable ${varName} not set, substituting empty string`);
      return '';
    }
    return envValue;
  });
}

/**
 * Recursively resolve ${ENV_VAR} references in config object
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvVar(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVars(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

/**
 * Load downstream MCP config from YAML file
 * Only extracts downstream_mcps section, doesn't require full config
 */
async function loadDownstreamMcpConfig(configPath: string): Promise<DownstreamMcpConfig[]> {
  const fileContent = fs.readFileSync(configPath, 'utf-8');
  const rawConfig = yaml.parse(fileContent);

  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Invalid config file: not an object');
  }

  const downstreamMcps = (rawConfig as Record<string, unknown>).downstream_mcps;

  if (!downstreamMcps) {
    console.warn('[Server] No downstream_mcps section found in config');
    return [];
  }

  if (!Array.isArray(downstreamMcps)) {
    throw new Error('Invalid config: downstream_mcps must be an array');
  }

  // Resolve environment variables in the config
  const resolved = resolveEnvVars(downstreamMcps) as DownstreamMcpConfig[];

  return resolved;
}

/**
 * Load user_pool config from YAML file
 * SEC-M17-005: Support configurable per-user MCP pool limits
 */
function loadUserPoolConfig(configPath: string): {
  maxInstancesPerUser?: number;
  maxTotalInstances?: number;
} {
  const fileContent = fs.readFileSync(configPath, 'utf-8');
  const rawConfig = yaml.parse(fileContent);

  if (!rawConfig || typeof rawConfig !== 'object') {
    return {};
  }

  const userPoolConfig = (rawConfig as Record<string, unknown>).user_pool;

  if (!userPoolConfig || typeof userPoolConfig !== 'object') {
    return {};
  }

  const config = userPoolConfig as Record<string, unknown>;

  return {
    maxInstancesPerUser:
      typeof config.max_instances_per_user === 'number' ? config.max_instances_per_user : undefined,
    maxTotalInstances:
      typeof config.max_total_instances === 'number' ? config.max_total_instances : undefined,
  };
}

/**
 * Load registry config from YAML file and env vars
 * Supports community MCP registry configuration
 */
function loadRegistryConfig(configPath: string | null): {
  url: string;
  refreshIntervalHours: number;
  enabled: boolean;
  token?: string;
} {
  // Default values
  const defaults = {
    url: 'https://api.github.com/repos/mcpambassador/community-registry/contents/registry.yaml',
    refreshIntervalHours: 24,
    enabled: true,
  };

  // Check env vars first (they override YAML)
  const envUrl = process.env.REGISTRY_URL;
  const envRefreshHours = process.env.REGISTRY_REFRESH_HOURS;
  const envEnabled = process.env.REGISTRY_ENABLED;
  const envToken = process.env.REGISTRY_TOKEN;

  // Load from YAML if config file exists
  let yamlConfig: Record<string, unknown> | null = null;
  if (configPath) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const rawConfig = yaml.parse(fileContent);

      if (rawConfig && typeof rawConfig === 'object') {
        const serverConfig = (rawConfig as Record<string, unknown>).server;
        if (serverConfig && typeof serverConfig === 'object') {
          yamlConfig = (serverConfig as Record<string, unknown>).registry as Record<
            string,
            unknown
          > | null;
        }
      }
    } catch (err) {
      // Ignore parse errors, use defaults
    }
  }

  return {
    url: envUrl || (yamlConfig?.url as string) || defaults.url,
    refreshIntervalHours: envRefreshHours
      ? parseInt(envRefreshHours, 10)
      : (yamlConfig?.refresh_interval_hours as number) || defaults.refreshIntervalHours,
    enabled:
      envEnabled !== undefined
        ? envEnabled !== 'false'
        : ((yamlConfig?.enabled as boolean) ?? defaults.enabled),
    token: envToken || (yamlConfig?.token as string) || undefined,
  };
}

async function main() {
  const args = parseArgs();

  const dataDir =
    args.dataDir || process.env.MCP_AMBASSADOR_DATA_DIR || path.join(process.cwd(), 'data');

  // Try to load downstream MCP configuration
  let downstreamMcps: DownstreamMcpConfig[] = [];
  let userPoolConfig: { maxInstancesPerUser?: number; maxTotalInstances?: number } = {};
  const configFile = findConfigFile(dataDir);

  if (configFile) {
    try {
      console.log('[Server] Loading downstream MCP configuration...');
      downstreamMcps = await loadDownstreamMcpConfig(configFile);
      console.log(`[Server] Loaded ${downstreamMcps.length} downstream MCP(s) from config`);

      // SEC-M17-005: Load user_pool config
      userPoolConfig = loadUserPoolConfig(configFile);
      if (userPoolConfig.maxInstancesPerUser || userPoolConfig.maxTotalInstances) {
        console.log('[Server] Loaded user_pool config:', userPoolConfig);
      }
    } catch (err) {
      console.error('[Server] Failed to load config file:', err);
      console.warn('[Server] Starting without downstream MCPs');
    }
  } else {
    console.warn('[Server] No config file found - starting without downstream MCPs');
    console.log('[Server] Checked locations:');
    console.log('  - /config/ambassador-server.yaml');
    console.log(`  - ${path.join(dataDir, 'config', 'ambassador-server.yaml')}`);
    console.log('  - /app/config/ambassador-server.example.yaml');
    console.log(`  - ${path.join(process.cwd(), 'config', 'ambassador-server.example.yaml')}`);
  }

  // Load registry config (supports both YAML and env vars)
  const registryConfig = loadRegistryConfig(configFile);
  console.log(
    `[Server] Registry config: url=${registryConfig.url}, enabled=${registryConfig.enabled}`
  );

  const server = new AmbassadorServer({
    port:
      args.port ||
      (process.env.MCP_AMBASSADOR_PORT ? parseInt(process.env.MCP_AMBASSADOR_PORT, 10) : undefined),
    host: args.host || process.env.MCP_AMBASSADOR_HOST,
    dataDir,
    serverName: args.serverName || process.env.MCP_AMBASSADOR_SERVER_NAME,
    logLevel: (args.logLevel || process.env.MCP_AMBASSADOR_LOG_LEVEL) as CliArgs['logLevel'],
    downstreamMcps,
    maxMcpInstancesPerUser: userPoolConfig.maxInstancesPerUser, // SEC-M17-005
    maxTotalMcpInstances: userPoolConfig.maxTotalInstances, // SEC-M17-005
    publicUrl: process.env.PUBLIC_URL, // OAuth callback base URL for reverse proxy deployments
    registryConfig, // Community registry configuration
  });

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);
    try {
      await server.stop();
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start server
  try {
    await server.initialize();
    await server.start();
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

main();
