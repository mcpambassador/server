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

import { mkdtempSync, symlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveChildIsolation,
  parseCapEff,
  checkIsolationAvailable,
  wrapCommandForIsolation,
} from '../../src/downstream/child-isolation.js';
import { StdioMcpConnection, buildChildEnv } from '../../src/downstream/stdio-connection.js';

const iso = { uid: 1001, gid: 1001, home: '/tmp/mcp-home' };
// CAP_KILL(5) | CAP_SETGID(6) | CAP_SETUID(7)
const CAPS_OK = 0xe0n;

afterEach(() => {
  spawnCalls.length = 0;
  delete process.env['MCP_AMBASSADOR_CHILD_UID'];
});

describe('resolveChildIsolation', () => {
  it('is disabled by default', () => {
    expect(resolveChildIsolation({}, 1000, 1000)).toBeNull();
    expect(resolveChildIsolation({ MCP_AMBASSADOR_CHILD_UID: ' ' }, 1000, 1000)).toBeNull();
  });
  it('reads uid, defaults gid to uid and home', () => {
    expect(resolveChildIsolation({ MCP_AMBASSADOR_CHILD_UID: '1001' }, 1000, 1000)).toEqual(iso);
    expect(
      resolveChildIsolation(
        {
          MCP_AMBASSADOR_CHILD_UID: '1001',
          MCP_AMBASSADOR_CHILD_GID: '1002',
          MCP_AMBASSADOR_CHILD_HOME: '/tmp/h',
        },
        1000,
        1000
      )
    ).toEqual({ uid: 1001, gid: 1002, home: '/tmp/h' });
  });
  it('rejects bad values, root and the server uid', () => {
    for (const v of ['abc', '0', '-1', '1e3', '4294967295']) {
      expect(() => resolveChildIsolation({ MCP_AMBASSADOR_CHILD_UID: v }, 1000, 1000)).toThrow();
    }
    expect(() => resolveChildIsolation({ MCP_AMBASSADOR_CHILD_UID: '1000' }, 1000, 1000)).toThrow(
      /equals the server uid/
    );
    for (const h of [
      'rel',
      '/data',
      '/tmp',
      '/tmp/a/b',
      '/tmp/..',
      '/tmp/.',
      '/tmp/../data',
      '/tmp/a b',
    ]) {
      expect(() =>
        resolveChildIsolation(
          { MCP_AMBASSADOR_CHILD_UID: '1001', MCP_AMBASSADOR_CHILD_HOME: h },
          1000,
          1000
        )
      ).toThrow(/single path component/);
    }
    // gid 1000 == server gid, and gid 0
    expect(() =>
      resolveChildIsolation(
        { MCP_AMBASSADOR_CHILD_UID: '1001', MCP_AMBASSADOR_CHILD_GID: '1000' },
        1000,
        1000
      )
    ).toThrow(/server gid/);
    expect(() =>
      resolveChildIsolation(
        { MCP_AMBASSADOR_CHILD_UID: '1001', MCP_AMBASSADOR_CHILD_GID: '0' },
        1000,
        1000
      )
    ).toThrow();
  });
});

describe('checkIsolationAvailable', () => {
  const ok = { capEff: CAPS_OK, setprivOk: true, homeOk: true };
  it('passes when caps, setpriv and home are present', () => {
    expect(checkIsolationAvailable(iso, ok)).toBeNull();
  });
  it('reports missing capabilities with a clear message', () => {
    expect(checkIsolationAvailable(iso, { ...ok, capEff: 0n })).toMatch(
      /requires CAP_SETUID, CAP_SETGID and CAP_KILL/
    );
    expect(checkIsolationAvailable(iso, { ...ok, capEff: 0x80n })).toMatch(/missing cap/);
    expect(checkIsolationAvailable(iso, { ...ok, capEff: null })).toMatch(/could not read/);
  });
  it('rejects a symlinked or missing child home (lstat, never followed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    mkdirSync(join(dir, 'real'), { mode: 0o700 });
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const uid = process.getuid!();
    const base = { capEff: CAPS_OK, setprivOk: true };
    expect(checkIsolationAvailable({ ...iso, uid, home: join(dir, 'real') }, base)).toBeNull();
    expect(checkIsolationAvailable({ ...iso, uid, home: join(dir, 'link') }, base)).toMatch(
      /not a symlink/
    );
    // group/world-accessible home is rejected too
    mkdirSync(join(dir, 'open'), { mode: 0o755 });
    chmodSync(join(dir, 'open'), 0o755);
    expect(checkIsolationAvailable({ ...iso, uid, home: join(dir, 'open') }, base)).toMatch(
      /child home/
    );
    expect(checkIsolationAvailable({ ...iso, uid, home: join(dir, 'nope') }, base)).toMatch(
      /child home/
    );
  });

  it('reports missing setpriv and home', () => {
    expect(checkIsolationAvailable(iso, { ...ok, setprivOk: false })).toMatch(/setpriv/);
    expect(checkIsolationAvailable(iso, { ...ok, homeOk: false })).toMatch(/child home/);
  });
  it('parses CapEff', () => {
    expect(parseCapEff('Name:\tx\nCapEff:\t00000000000000e0\nCapBnd:\t0\n')).toBe(0xe0n);
    expect(parseCapEff('nothing')).toBeNull();
  });
});

describe('spawn wrapping', () => {
  it('wraps the command in setpriv that clears ambient/inheritable caps', () => {
    const w = wrapCommandForIsolation('npx', ['-y', 'pkg'], iso, undefined, 0);
    expect(w.cmd).toBe('/usr/bin/setpriv');
    expect(w.args).toEqual([
      '--reuid=1001',
      '--regid=1001',
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--',
      '/bin/sh',
      '-c',
      'chmod 0700 "$HOME" 2>/dev/null; mkdir -p -m 0700 "$TMPDIR" 2>/dev/null; cd -- "$0" && exec "$@"',
      '/tmp/mcp-home',
      'npx',
      '-y',
      'pkg',
    ]);
  });

  it('enters the requested cwd inside the child', () => {
    expect(wrapCommandForIsolation('npx', [], iso, '/work', 0).args).toContain('/work');
  });

  it('child env: isolated HOME/caches, server env does not leak, caches not overridable', () => {
    const env = buildChildEnv(
      { NPM_CONFIG_CACHE: '/evil', UV_CACHE_DIR: '/evil', K: 'v' },
      {
        PATH: '/bin',
        HOME: '/tmp',
        NPM_CONFIG_CACHE: '/tmp/.npm-cache',
        UV_CACHE_DIR: '/tmp/.uv-cache',
        MCP_AMBASSADOR_DATA_DIR: '/data',
        GITHUB_OAUTH_CLIENT_SECRET: 's',
      },
      iso
    );
    expect(env['HOME']).toBe('/tmp/mcp-home');
    expect(env['NPM_CONFIG_CACHE']).toBe('/tmp/mcp-home/.npm-cache');
    expect(env['UV_CACHE_DIR']).toBe('/tmp/mcp-home/.uv-cache');
    expect(env['TMPDIR']).toBe('/tmp/mcp-home/tmp');
    expect(env['K']).toBe('v');
    expect(env['MCP_AMBASSADOR_DATA_DIR']).toBeUndefined();
    expect(env['GITHUB_OAUTH_CLIENT_SECRET']).toBeUndefined();
  });

  it('env without isolation is unchanged (HOME from server)', () => {
    expect(buildChildEnv(undefined, { PATH: '/bin', HOME: '/tmp' })['HOME']).toBe('/tmp');
  });

  it('default (unset): spawns the command directly', async () => {
    const conn = new StdioMcpConnection(
      makeMcpConfig({ transport: 'stdio', command: ['node', 'x.js'] })
    );
    void conn.start().catch(() => undefined);
    expect(spawnCalls[0]![0]).toBe('node');
  });

  it('fails closed when isolation is configured but unavailable (no spawn)', async () => {
    // this test environment has neither /usr/bin/setpriv caps nor /tmp/mcp-home owned by uid 4242
    process.env['MCP_AMBASSADOR_CHILD_UID'] = '4242';
    const conn = new StdioMcpConnection(
      makeMcpConfig({ transport: 'stdio', command: ['node', 'x.js'] })
    );
    await expect(conn.start()).rejects.toThrow(/cannot start: child isolation/);
    expect(spawnCalls).toHaveLength(0);
  });
});
