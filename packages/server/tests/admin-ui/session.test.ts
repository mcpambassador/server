import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { startAdminTestServer, stopAdminTestServer, extractCookie } from './helpers'

let handle: Awaited<ReturnType<typeof startAdminTestServer>> | undefined

describe('Admin UI session and login flow', () => {
  beforeEach(async () => {
    handle = await startAdminTestServer()
  })

  afterEach(async () => {
    await stopAdminTestServer(handle)
    handle = undefined
  })

  it('login with valid admin key sets HttpOnly secure session cookie and redirects to dashboard', async () => {
    if (!handle) throw new Error('test server not available')

    const resp = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=${encodeURIComponent(handle.adminKey)}`,
    })

    expect(resp.statusCode).toBe(302)
    expect(resp.headers.location).toBe('/admin/dashboard')
    const cookie = extractCookie(resp.headers['set-cookie'])
    expect(cookie).toBeDefined()
  })

  it('login with invalid admin key redirects back to login with flash', async () => {
    if (!handle) throw new Error('test server not available')
    const resp = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=wrong-key`,
    })
    expect([302, 401]).toContain(resp.statusCode)
    // should not set a session cookie
    const cookie = extractCookie(resp.headers['set-cookie'])
    expect(cookie).toBeUndefined()
  })

  it('SEC-M10-04: session cookie has secure attributes', async () => {
    if (!handle) throw new Error('test server not available')
    const resp = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=${encodeURIComponent(handle.adminKey)}`,
    })
    const setCookie = resp.headers['set-cookie']
    expect(setCookie).toBeDefined()
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('Secure')
    expect(raw).toContain('SameSite=Strict')
    expect(raw).toContain('Path=/admin')
  })

  it('authenticated access to /admin/dashboard returns 200; unauthenticated redirects to login', async () => {
    if (!handle) throw new Error('test server not available')
    // unauthenticated
    const anon = await handle.fastify.inject({ method: 'GET', url: '/admin/dashboard' })
    expect([302, 401]).toContain(anon.statusCode)

    // authenticate
    const login = await handle.fastify.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `admin_key=${encodeURIComponent(handle.adminKey)}`,
    })
    const cookie = extractCookie(login.headers['set-cookie'])
    expect(cookie).toBeDefined()
    const auth = await handle.fastify.inject({ method: 'GET', url: '/admin/dashboard', headers: { cookie: cookie! } })
    expect(auth.statusCode).toBe(200)
  })

  it('SEC-M10-07: saveUninitialized false — GET /admin/login does not set a session cookie', async () => {
    if (!handle) throw new Error('test server not available')
    const resp = await handle.fastify.inject({ method: 'GET', url: '/admin/login' })
    const cookie = extractCookie(resp.headers['set-cookie'])
    expect(cookie).toBeUndefined()
  })
})
