import { describe, it, afterEach, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { makeMcpConfig } from './helpers';

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
        pid: 1,
        kill: () => {},
        on: () => {},
      };
    },
  };
});

import { StdioMcpConnection } from '../../src/downstream/stdio-connection.js';

const KEYS = ['UV_PYTHON_DOWNLOADS', 'UV_PYTHON', 'UV_CACHE_DIR', 'UV_TOOL_DIR'];
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  spawnCalls.length = 0;
});

const spawnEnv = async (configEnv: Record<string, string>) => {
  for (const k of KEYS) saved[k] = process.env[k];
  const conn = new StdioMcpConnection(makeMcpConfig({ transport: 'stdio', env: configEnv }));
  void conn.start().catch(() => undefined); // the fake child never answers; spawn happens synchronously
  await new Promise(r => setTimeout(r, 20));
  return spawnCalls[0]![2].env as Record<string, string>;
};

describe('StdioMcpConnection server-controlled uv env', () => {
  it('forwards UV_* from the server env', async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env['UV_PYTHON_DOWNLOADS'] = 'never';
    process.env['UV_PYTHON'] = '/usr/bin/python3';
    process.env['UV_CACHE_DIR'] = '/tmp/.uv-cache';
    process.env['UV_TOOL_DIR'] = '/tmp/.uv-tools';
    const env = await spawnEnv({ MCP_ONLY: 'yes' });
    expect(env['UV_PYTHON_DOWNLOADS']).toBe('never');
    expect(env['UV_PYTHON']).toBe('/usr/bin/python3');
    expect(env['UV_CACHE_DIR']).toBe('/tmp/.uv-cache');
    expect(env['UV_TOOL_DIR']).toBe('/tmp/.uv-tools');
    expect(env['MCP_ONLY']).toBe('yes');
  });

  it('does not invent UV_* when the server env has none', async () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const env = await spawnEnv({});
    for (const k of KEYS) expect(k in env).toBe(false);
  });

  it('config.env cannot set UV_* (the connection refuses to be created)', () => {
    expect(
      () =>
        new StdioMcpConnection(
          makeMcpConfig({ transport: 'stdio', env: { UV_PYTHON_DOWNLOADS: 'automatic' } })
        )
    ).toThrow(/blocked for security reasons/);
    expect(spawnCalls).toHaveLength(0);
  });
});
