#!/usr/bin/env node
import { AmbassadorServer } from '../server.js';
import path from 'path';

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

async function main() {
  const args = parseArgs();
  
  const server = new AmbassadorServer({
    port: args.port,
    host: args.host,
    dataDir: args.dataDir || path.join(process.cwd(), 'data'),
    serverName: args.serverName,
    logLevel: args.logLevel,
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
