import os from 'os';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { AmbassadorServer } from '@mcpambassador/server';
import {
  initializeDatabase,
  closeDatabase,
  runMigrations,
  type DatabaseClient,
  createAdminKey,
} from '@mcpambassador/core';

export interface TestServerHandle {
  fastify: FastifyInstance;
  adminKey: string;
  dataDir: string;
  db: DatabaseClient; // M19.2a: Expose database for test assertions
  stop: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServerHandle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));

  // Initialize database and create admin key BEFORE starting server
  const dbPath = path.join(tmp, 'ambassador.db');
  const db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath, seedOnInit: true });

  // Ensure schema is present
  await runMigrations(db as DatabaseClient);

  // Create admin key for tests (plaintext returned)
  const { admin_key } = await createAdminKey(db as DatabaseClient, tmp);

  // Close the temporary DB connection
  await closeDatabase(db as DatabaseClient);

  // Now initialize the server - it will open its own DB connection
  const server = new AmbassadorServer({ dataDir: tmp, port: 0, host: '127.0.0.1' });
  await server.initialize();

  return {
    fastify: server.getServer(),
    adminKey: admin_key,
    dataDir: tmp,
    db: (server as any).db, // M19.2a: Expose database for test assertions
    stop: async () => {
      try {
        await server.stop();
      } catch (e) {
        // ignore
      }
    },
  };
}

export async function stopTestServer(handle: TestServerHandle) {
  if (!handle) return;
  await handle.stop();
  // best-effort cleanup
  try {
    fs.rmSync(handle.dataDir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}
