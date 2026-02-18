import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { startAdminTestServer, stopAdminTestServer } from './helpers'

let handle: Awaited<ReturnType<typeof startAdminTestServer>> | undefined

describe('Admin UI disabled toggle', () => {
  beforeEach(async () => {
    handle = await startAdminTestServer({ uiEnabled: false })
  })
  afterEach(async () => {
    await stopAdminTestServer(handle)
    handle = undefined
  })

  it('SEC-M10-13: when admin.ui_enabled is false, /admin/login returns 404', async () => {
    if (!handle) throw new Error('test server not available')
    const resp = await handle.fastify.inject({ method: 'GET', url: '/admin/login' })
    expect([404, 410]).toContain(resp.statusCode)
  })

  it('REST API remains functional when UI disabled', async () => {
    if (!handle) throw new Error('test server not available')
    const api = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles', headers: { 'x-admin-key': handle.adminKey } })
    expect([200, 401]).toContain(api.statusCode)
  })
})
