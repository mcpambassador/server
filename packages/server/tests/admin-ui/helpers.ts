import os from 'os'
import path from 'path'
import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { runMigrations, initializeDatabase, closeDatabase, type DatabaseClient, createAdminKey } from '@mcpambassador/core'
import { AmbassadorServer } from '@mcpambassador/server'

export interface AdminTestHandle {
  fastify: FastifyInstance
  adminKey: string
  dataDir: string
  stop: () => Promise<void>
}

export async function startAdminTestServer(opts: { uiEnabled?: boolean } = {}): Promise<AdminTestHandle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-test-'))

  const dbPath = path.join(tmp, 'ambassador.db')
  const db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath, seedOnInit: true })
  await runMigrations(db as DatabaseClient)

  const { admin_key } = await createAdminKey(db as DatabaseClient, tmp)
  await closeDatabase(db as DatabaseClient)

  // Start the server with admin UI enabled on ephemeral ports
  const server = new AmbassadorServer({ dataDir: tmp, port: 0, adminPort: 0, adminUiEnabled: opts.uiEnabled ?? true, host: '127.0.0.1' })
  // initialize may start Fastify instances; implementation may vary
  await server.initialize()

  return {
    fastify: server.getAdminServer(),
    adminKey: admin_key,
    dataDir: tmp,
    stop: async () => {
      try {
        await server.stop()
      } catch (e) {
        // ignore
      }
    },
  }
}

export async function stopAdminTestServer(handle?: AdminTestHandle) {
  if (!handle) return
  await handle.stop()
  try {
    fs.rmSync(handle.dataDir, { recursive: true, force: true })
  } catch (e) {
    // ignore
  }
}

export function extractCookie(setCookieHeader?: string | string[] | undefined): string | undefined {
  const sc = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  if (!sc) return undefined
  const m = sc.match(/([^=]+)=([^;]+);?/)
  return m ? `${m[1]}=${m[2]}` : undefined
}

export default {
  startAdminTestServer,
  stopAdminTestServer,
  extractCookie,
}
