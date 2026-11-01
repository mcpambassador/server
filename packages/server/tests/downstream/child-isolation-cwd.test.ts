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
// the host has no capabilities / child home: pretend the isolation preflight passes
vi.mock('../../src/downstream/child-isolation.js', async orig => {
  const actual = await orig<typeof import('../../src/downstream/child-isolation.js')>();
  return { ...actual, checkIsolationAvailable: () => null };
});

import { StdioMcpConnection } from '../../src/downstream/stdio-connection.js';

afterEach(() => {
  spawnCalls.length = 0;
  delete process.env['MCP_AMBASSADOR_CHILD_UID'];
});

describe('isolated spawn through StdioMcpConnection', () => {
  it('wraps in setpriv, spawns at "/", and enters config.cwd inside the child', () => {
    process.env['MCP_AMBASSADOR_CHILD_UID'] = '4242';
    const conn = new StdioMcpConnection(
      makeMcpConfig({ transport: 'stdio', command: ['node', 'x.js'], cwd: '/work' })
    );
    void conn.start().catch(() => undefined);
    const [cmd, args, opts] = spawnCalls[0]!;
    expect(cmd).toBe('/usr/bin/setpriv');
    expect(args).toContain('--reuid=4242');
    expect(args.indexOf('/work')).toBe(args.indexOf('node') - 1);
    expect(opts.cwd).toBe('/');
    expect(opts.env.HOME).toBe('/tmp/mcp-home');
  });

  it('defaults the child cwd to its home when config.cwd is unset', () => {
    process.env['MCP_AMBASSADOR_CHILD_UID'] = '4242';
    const cfg = makeMcpConfig({ transport: 'stdio', command: ['node', 'x.js'] });
    delete (cfg as any).cwd;
    void new StdioMcpConnection(cfg).start().catch(() => undefined);
    expect(spawnCalls[0]![1]).toContain('/tmp/mcp-home');
  });
});
