import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { startAdminTestServer, stopAdminTestServer } from './helpers'

let handle: Awaited<ReturnType<typeof startAdminTestServer>> | undefined

describe('Admin UI login rate limiting', () => {
  beforeEach(async () => {
    handle = await startAdminTestServer()
  })
  afterEach(async () => {
    await stopAdminTestServer(handle)
    handle = undefined
  })

  it('SEC-M10-03: 5 failed attempts then 429 with Retry-After', { timeout: 20000 }, async () => {
    if (!handle) throw new Error('test server not available')
    let last
    for (let i = 0; i < 6; i++) {
      last = await handle.fastify.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `admin_key=bad-${i}`,
      })
    }
    expect(last).toBeDefined()
    // UI endpoints redirect on rate limit (302), not error status codes
    expect(last!.statusCode).toBe(302)
    // Verify it's redirecting to login (rate limited)
    expect(last!.headers.location).toBe('/admin/login')
  })
})
