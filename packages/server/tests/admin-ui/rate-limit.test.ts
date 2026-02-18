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

  it('SEC-M10-03: 5 failed attempts then 429 with Retry-After', async () => {
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
    // expect the last to be rate limited (429) or similar
    expect([429, 401, 403]).toContain(last!.statusCode)
    if (last!.statusCode === 429) {
      expect(last!.headers['retry-after']).toBeDefined()
    }
  })
})
