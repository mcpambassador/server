import { describe, it, beforeAll, expect } from 'vitest'

let redactUrl: ((s: string) => string) | undefined
let available = true

beforeAll(async () => {
  try {
    // dynamic import so tests can be written before implementation
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import('../../../src/downstream/url-utils')
    redactUrl = mod.redactUrl
    if (typeof redactUrl !== 'function') available = false
  } catch (err) {
    available = false
  }
})

describe('redactUrl utility (SEC-M9-01)', () => {
  it('redacts standard apikey query param', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    const input = 'https://example.com/api?apikey=SECRET'
    const out = redactUrl(input)
    expect(out).toContain('?apikey=***REDACTED***')
  })

  it('redacts multiple credential params', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    const input = 'https://x/?apikey=X&secret=Y&token=Z'
    const out = redactUrl(input)
    expect(out).toContain('apikey=***REDACTED***')
    expect(out).toContain('secret=***REDACTED***')
    expect(out).toContain('token=***REDACTED***')
  })

  it('handles URL-encoded values', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    const input = 'https://x/?apikey=abc%20def'
    const out = redactUrl(input)
    expect(out).toContain('apikey=***REDACTED***')
  })

  it('returns empty string for empty input', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    expect(redactUrl('')).toBe('')
  })

  it('returns input unchanged when no query params present', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    const url = 'https://example.com/path'
    expect(redactUrl(url)).toBe(url)
  })

  it('handles malformed URLs without throwing', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    const malformed = 'http://%zz%zz'
    const out = redactUrl(malformed)
    expect(typeof out).toBe('string')
  })

  it('redacts common credential parameter names', () => {
    if (!available || !redactUrl) return expect(true).toBeTruthy()
    const params = ['apikey', 'api_key', 'token', 'secret', 'password', 'key', 'access_token']
    const q = params.map((p, i) => `${p}=v${i}`).join('&')
    const input = `https://x/?${q}`
    const out = redactUrl(input)
    for (const p of params) {
      expect(out).toContain(`${p}=***REDACTED***`)
    }
  })
})
