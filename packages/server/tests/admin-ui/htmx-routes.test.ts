import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { startAdminTestServer, stopAdminTestServer, extractCookie } from './helpers'

let handle: Awaited<ReturnType<typeof startAdminTestServer>> | undefined

describe('Admin UI htmx fragment endpoints', () => {
  beforeEach(async () => {
    handle = await startAdminTestServer()
  })
  afterEach(async () => {
    await stopAdminTestServer(handle)
    handle = undefined
  })

  it('SEC-M10-12: htmx endpoints require HX-Request header', async () => {
    if (!handle) throw new Error('test server not available')

    // attempt without HX-Request
    const noHx = await handle.fastify.inject({ method: 'POST', url: '/admin/api/kill-switch/tool/test' })
    expect([400, 401, 415]).toContain(noHx.statusCode)

    // authenticate and then call with HX-Request
    const login = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=${encodeURIComponent(handle.adminKey)}`,
    })
    const cookie = extractCookie(login.headers['set-cookie'])
    expect(cookie).toBeDefined()

    const good = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/api/kill-switch/tool/test',
      headers: { 'HX-Request': 'true', cookie: cookie! },
    })
    expect(good.statusCode).toBeGreaterThanOrEqual(200)
    expect(good.headers['content-type'] || '').toContain('text/html')
    expect(good.body).toContain('<')
  })
})
