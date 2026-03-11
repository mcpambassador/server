#!/usr/bin/env node

/* eslint-disable no-console, @typescript-eslint/no-floating-promises, @typescript-eslint/explicit-function-return-type */

import { AmbassadorServer } from '../server.js';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';
import type { DownstreamMcpConfig } from '../downstream/index.js';
import { loadConfig, type AmbassadorConfig } from '@mcpambassador/core';

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
 *   --config <path>        Path to ambassador-server.yaml config file
 */

interface CliArgs {
  port?: number;
  host?: string;
  dataDir?: string;
  serverName?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  config?: string;
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
      case '--config':
        if (next) {
          config.config = next;
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
  --config <path>        Path to ambassador-server.yaml config file
  --help, -h             Show this help message

Examples:
  # Start server with defaults
  mcpambassador-server

  # Start server on custom port
  mcpambassador-server --port 9443

  # Start with debug logging
  mcpambassador-server --log-level debug

  # Start with specific config file
  mcpambassador-server --config /etc/ambassador/config.yaml
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
    } catch {
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

  // Load full AmbassadorConfig using the core config loader
  let ambassadorConfig: AmbassadorConfig | undefined;
  let downstreamMcps: DownstreamMcpConfig[] = [];
  let userPoolConfig: { maxInstancesPerUser?: number; maxTotalInstances?: number } = {};

  // Determine config file path: CLI arg > env var > auto-discover
  const configPath = args.config || process.env.AMBASSADOR_CONFIG_PATH || findConfigFile(dataDir);

  if (configPath) {
    try {
      console.log(`[Server] Loading configuration from ${configPath}...`);
      ambassadorConfig = await loadConfig(configPath, {
        enforcement: 'block',
        scrub_env_vars: true,
      });
      console.log('[Server] Configuration loaded successfully');

      // Extract downstream MCPs from loaded config
      downstreamMcps = ambassadorConfig.downstream_mcps as DownstreamMcpConfig[];
      console.log(`[Server] Loaded ${downstreamMcps.length} downstream MCP(s) from config`);

      // SEC-M17-005: Load user_pool config from validated config
      if (ambassadorConfig.user_pool) {
        userPoolConfig = {
          maxInstancesPerUser: ambassadorConfig.user_pool.max_instances_per_user,
          maxTotalInstances: ambassadorConfig.user_pool.max_total_instances,
        };
        console.log('[Server] Loaded user_pool config:', userPoolConfig);
      }

      // Log key configuration values at startup
      console.log('[Server] Session config:', {
        ttl_seconds: ambassadorConfig.session?.ttl_seconds ?? 28800,
        idle_timeout_seconds: ambassadorConfig.session?.idle_timeout_seconds ?? 1800,
        spindown_delay_seconds: ambassadorConfig.session?.spindown_delay_seconds ?? 300,
        heartbeat_interval: ambassadorConfig.session?.heartbeat_expected_interval_seconds ?? 120,
      });
    } catch (err) {
      console.error('[Server] Failed to load config file:', err);
      // In production mode, fail hard if config can't be loaded
      if (process.env.NODE_ENV === 'production') {
        console.error('[Server] Config loading failed in production mode, aborting startup');
        process.exit(1);
      }
      console.warn('[Server] Starting with default configuration');
    }
  } else {
    console.warn('[Server] No config file found - starting with default configuration');
    console.log('[Server] Checked locations:');
    console.log('  - /config/ambassador-server.yaml');
    console.log(`  - ${path.join(dataDir, 'config', 'ambassador-server.yaml')}`);
    if (args.config) console.log(`  - ${args.config}`);
    if (process.env.AMBASSADOR_CONFIG_PATH)
      console.log(`  - ${process.env.AMBASSADOR_CONFIG_PATH}`);
  }

  // Load registry config (supports both YAML and env vars)
  // Registry config is separate from AmbassadorConfig schema, loaded manually from YAML or env vars
  const registryConfig = loadRegistryConfig(configPath);
  console.log(
    `[Server] Registry config: url=${registryConfig.url}, enabled=${registryConfig.enabled}`
  );

  const server = new AmbassadorServer({
    port:
      args.port ||
      ambassadorConfig?.server.port ||
      (process.env.MCP_AMBASSADOR_PORT ? parseInt(process.env.MCP_AMBASSADOR_PORT, 10) : undefined),
    host: args.host || ambassadorConfig?.server.host || process.env.MCP_AMBASSADOR_HOST,
    dataDir,
    serverName: args.serverName || process.env.MCP_AMBASSADOR_SERVER_NAME,
    logLevel: (args.logLevel || process.env.MCP_AMBASSADOR_LOG_LEVEL) as CliArgs['logLevel'],
    downstreamMcps,
    maxMcpInstancesPerUser: userPoolConfig.maxInstancesPerUser, // SEC-M17-005
    maxTotalMcpInstances: userPoolConfig.maxTotalInstances, // SEC-M17-005
    publicUrl: process.env.PUBLIC_URL, // OAuth callback base URL for reverse proxy deployments
    registryConfig, // Community registry configuration
    ambassadorConfig, // Pass full config to server for runtime use
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
