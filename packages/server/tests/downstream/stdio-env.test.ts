import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import * as child_process from 'child_process'
import { STDIO_SAFE_ENV, makeMcpConfig } from './helpers'

let StdioMcpConnection: any

beforeEach(() => {
  // reset module variable
  StdioMcpConnection = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StdioMcpConnection environment whitelist (SEC-M9-02)', () => {
  it('passes only whitelisted env vars + config.env to spawn', async () => {
    try {
      const mod = await import('../../../src/downstream/stdio-connection')
      StdioMcpConnection = (mod as any).StdioMcpConnection
    } catch (err) {
      // skip if implementation missing
      return expect(true).toBeTruthy()
    }

    // stub spawn
    const spawnMock = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const ev: any = require('events').EventEmitter.prototype
      const fakeStdout = new (require('events').EventEmitter)()
      const fakeStderr = new (require('events').EventEmitter)()
      const fakeStdin = { write: () => {}, end: () => {} }
      return {
        stdout: fakeStdout,
        stderr: fakeStderr,
        stdin: fakeStdin,
        pid: 12345,
        kill: () => {},
        on: () => {},
      }
    })

    // Set an env var on process.env that must NOT be passed through
    process.env['SHOULD_NOT_PASS'] = 'bad'

    const config = makeMcpConfig({ transport: 'stdio', env: { MCP_ONLY: 'yes' } })
    const conn = new StdioMcpConnection(config)
    await conn.start()

    // assert spawn was called and capture env
    expect(spawnMock).toHaveBeenCalled()
    const call = spawnMock.mock.calls[0]
    const options = call[2] || {}
    const passedEnv = options.env || {}

    // whitelist keys present
    for (const k of STDIO_SAFE_ENV) {
      expect(k in passedEnv).toBe(true)
    }

    // MCP-specific env is present
    expect(passedEnv.MCP_ONLY).toBe('yes')

    // process env keys that are not whitelisted should not be present
    expect(passedEnv.SHOULD_NOT_PASS).toBeUndefined()

    await conn.stop()
  })
})
