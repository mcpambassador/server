import { describe, it, afterEach, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { STDIO_SAFE_ENV, makeMcpConfig } from './helpers';

// Mock child_process.spawn so no real process starts and we can inspect the env it was given.
// (The previous version imported '../../../src/...' (wrong depth), caught the failure and returned,
// so it asserted nothing.)
const spawnCalls: any[][] = [];
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      spawnCalls.push(args);
      return {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: () => {}, end: () => {}, on: () => {} },
        pid: 12345,
        kill: () => {},
        on: () => {},
      };
    },
  };
});

import {
  StdioMcpConnection,
  SAFE_ENV_VARS,
  SERVER_CONTROLLED_ENV_VARS,
} from '../../src/downstream/stdio-connection.js';

// Server-controlled vars (UV_*, NPM_CONFIG_CACHE) are forwarded when set in the server env, so clear
// them here: the exact-key assertion must hold even if the developer's shell exports them.
const touched = [...STDIO_SAFE_ENV, ...SERVER_CONTROLLED_ENV_VARS, 'SHOULD_NOT_PASS'];
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of touched) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  spawnCalls.length = 0;
});

describe('StdioMcpConnection environment whitelist (SEC-M9-02)', () => {
  it('whitelist in the product matches the one this test expects', () => {
    expect([...SAFE_ENV_VARS].sort()).toEqual([...STDIO_SAFE_ENV].sort());
  });

  it('passes only whitelisted env vars + config.env to spawn', async () => {
    for (const k of touched) saved[k] = process.env[k];
    for (const k of STDIO_SAFE_ENV) process.env[k] = `val-${k}`;
    process.env['SHOULD_NOT_PASS'] = 'bad';
    for (const k of SERVER_CONTROLLED_ENV_VARS) delete process.env[k];

    const conn = new StdioMcpConnection(
      makeMcpConfig({ transport: 'stdio', env: { MCP_ONLY: 'yes' } }) as any
    );
    void conn.start().catch(() => undefined); // fake child never answers; spawn is synchronous
    await new Promise(r => setTimeout(r, 20));

    expect(spawnCalls.length).toBe(1);
    const env = spawnCalls[0]![2].env as Record<string, string>;

    for (const k of STDIO_SAFE_ENV) expect(env[k]).toBe(`val-${k}`);
    expect(env['MCP_ONLY']).toBe('yes');
    expect(env['SHOULD_NOT_PASS']).toBeUndefined();
    // nothing beyond whitelist + config.env
    expect(Object.keys(env).sort()).toEqual([...STDIO_SAFE_ENV, 'MCP_ONLY'].sort());
  });
});
