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

import { StdioMcpConnection, buildChildEnv } from '../../src/downstream/stdio-connection.js';

const KEYS = ['UV_PYTHON_DOWNLOADS', 'UV_PYTHON', 'UV_CACHE_DIR', 'NPM_CONFIG_CACHE'];
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
    process.env['NPM_CONFIG_CACHE'] = '/tmp/.npm-cache';
    const env = await spawnEnv({ MCP_ONLY: 'yes' });
    expect(env['UV_PYTHON_DOWNLOADS']).toBe('never');
    expect(env['UV_PYTHON']).toBe('/usr/bin/python3');
    expect(env['UV_CACHE_DIR']).toBe('/tmp/.uv-cache');
    expect(env['NPM_CONFIG_CACHE']).toBe('/tmp/.npm-cache');
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

  it('config.env (and so injected credentials) cannot set or override them', () => {
    for (const k of ['UV_PYTHON_DOWNLOADS', 'NPM_CONFIG_CACHE', 'uv_python']) {
      expect(
        () => new StdioMcpConnection(makeMcpConfig({ transport: 'stdio', env: { [k]: 'x' } }))
      ).toThrow(/blocked for security reasons/);
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it('buildChildEnv applies server-controlled values last, even if a caller bypasses validation', () => {
    const env = buildChildEnv(
      { UV_PYTHON_DOWNLOADS: 'automatic', NPM_CONFIG_CACHE: '/evil', K: 'v' },
      {
        PATH: '/bin',
        UV_PYTHON_DOWNLOADS: 'never',
        NPM_CONFIG_CACHE: '/tmp/.npm-cache',
        SECRET: 'no',
      }
    );
    expect(env).toEqual({
      PATH: '/bin',
      K: 'v',
      UV_PYTHON_DOWNLOADS: 'never',
      NPM_CONFIG_CACHE: '/tmp/.npm-cache',
    });
  });
});
