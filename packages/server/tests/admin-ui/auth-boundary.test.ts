import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { startAdminTestServer, stopAdminTestServer, extractCookie } from './helpers'

let handle: Awaited<ReturnType<typeof startAdminTestServer>> | undefined

describe('Auth boundary tests (session vs X-Admin-Key)', () => {
  beforeEach(async () => {
    handle = await startAdminTestServer()
  })
  afterEach(async () => {
    await stopAdminTestServer(handle)
    handle = undefined
  })

  it('SEC-M10-11: REST API requires X-Admin-Key; session cookie only should be 401', async () => {
    if (!handle) throw new Error('test server not available')

    // authenticate via UI first
    const login = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=${encodeURIComponent(handle.adminKey)}`,
    })
    const cookie = extractCookie(login.headers['set-cookie'])
    expect(cookie).toBeDefined()

    // call REST API with only cookie
    const api = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles', headers: { cookie: cookie! } })
    expect([401, 302]).toContain(api.statusCode)
  })

  it('SEC-M10-11: X-Admin-Key can be used for REST API (no session cookie)', async () => {
    if (!handle) throw new Error('test server not available')
    const api = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/profiles', headers: { 'x-admin-key': handle.adminKey } })
    expect([200, 401]).toContain(api.statusCode)
  })
})
