import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { startAdminTestServer, stopAdminTestServer } from './helpers'

let handle: Awaited<ReturnType<typeof startAdminTestServer>> | undefined

describe('Admin UI security headers', () => {
  beforeEach(async () => {
    handle = await startAdminTestServer()
  })
  afterEach(async () => {
    await stopAdminTestServer(handle)
    handle = undefined
  })

  it('SEC-M10-01: CSP header present with required directives on admin pages', async () => {
    if (!handle) throw new Error('test server not available')
    const pages = ['/admin/login', '/admin/dashboard']
    for (const p of pages) {
      const resp = await handle.fastify.inject({ method: 'GET', url: p })
      expect(resp.headers['content-security-policy'] || resp.headers['Content-Security-Policy']).toBeDefined()
      const csp = (resp.headers['content-security-policy'] || resp.headers['Content-Security-Policy']) as string
      // SEC-M18-007: Updated CSP to allow 'self' resources for admin UI functionality
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("style-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("form-action 'self'")
    }
  })

  it('SEC-M10-10: HTML admin pages have Cache-Control: no-store', async () => {
    if (!handle) throw new Error('test server not available')
    const resp = await handle.fastify.inject({ method: 'GET', url: '/admin/dashboard' })
    expect(resp.headers['cache-control']).toBeDefined()
    expect((resp.headers['cache-control'] || '').toLowerCase()).toContain('no-store')
  })
})
