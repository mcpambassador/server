import { describe, it, afterEach, beforeEach, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { makeMcpConfig } from './helpers';

const procs: any[] = [];
const spawnCalls: any[][] = [];
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      spawnCalls.push(args);
      const p: any = new EventEmitter();
      Object.assign(p, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: () => {}, end: () => {}, on: () => {} },
        pid: 100 + procs.length,
        kill: () => {},
      });
      procs.push(p);
      return p;
    },
  };
});
vi.mock('../../src/downstream/child-isolation.js', async orig => {
  const actual = await orig<typeof import('../../src/downstream/child-isolation.js')>();
  return { ...actual, checkIsolationAvailable: () => null };
});
// in-memory map; injected allocator so no real fs, setpriv or runner uid is involved
let mapFile: string | null = null;
const wipes: number[] = [];
vi.mock('../../src/downstream/child-uid-allocator.js', async orig => {
  const actual = await orig<typeof import('../../src/downstream/child-uid-allocator.js')>();
  return {
    ...actual,
    getChildUidAllocator: (range: any) => {
      (globalThis as any).__td059Alloc ??= new actual.ChildUidAllocator(range, {
        readMap: () => mapFile,
        writeMap: (_p: string, d: string) => {
          mapFile = d;
        },
        wipeHome: (uid: number) => {
          wipes.push(uid);
        },
      });
      return (globalThis as any).__td059Alloc;
    },
  };
});

import { StdioMcpConnection } from '../../src/downstream/stdio-connection.js';

beforeEach(() => {
  process.env['MCP_AMBASSADOR_CHILD_UID_RANGE'] = '20000-20001';
});
afterEach(() => {
  spawnCalls.length = 0;
  procs.length = 0;
  wipes.length = 0;
  mapFile = null;
  (globalThis as any).__td059Alloc = undefined;
  delete process.env['MCP_AMBASSADOR_CHILD_UID_RANGE'];
});

const cfg = () => makeMcpConfig({ transport: 'stdio', command: ['node', 'x.js'] });
const start = (c: StdioMcpConnection) => void c.start().catch(() => undefined);

describe('per-instance child uid through StdioMcpConnection', () => {
  it('two instances spawn under different uids and homes', () => {
    start(new StdioMcpConnection(cfg(), 'user:u1:a'));
    start(new StdioMcpConnection(cfg(), 'user:u2:a'));
    const [a, b] = spawnCalls;
    expect(a![1]).toContain('--reuid=20000');
    expect(b![1]).toContain('--reuid=20001');
    expect(a![2].env.HOME).toBe('/tmp/mcp-homes/20000');
    expect(b![2].env.HOME).toBe('/tmp/mcp-homes/20001');
    expect(a![2].env.NPM_CONFIG_CACHE).toBe('/tmp/mcp-homes/20000/.npm-cache');
    expect(b![2].env.UV_CACHE_DIR).toBe('/tmp/mcp-homes/20001/.uv-cache');
    expect(b![2].env.TMPDIR).toBe('/tmp/mcp-homes/20001/tmp');
  });

  it('a restart of the same instance keeps its uid', () => {
    start(new StdioMcpConnection(cfg(), 'user:u1:a'));
    procs[0].emit('exit', 1, null);
    start(new StdioMcpConnection(cfg(), 'user:u1:a'));
    expect(spawnCalls[1]![1]).toContain('--reuid=20000');
    expect(wipes).toEqual([20000]); // wiped once, on first assignment only
  });

  it('refuses to spawn without an instance key (never shares a uid)', async () => {
    await expect(new StdioMcpConnection(cfg()).start()).rejects.toThrow(/no instance key/);
    expect(spawnCalls).toHaveLength(0);
  });

  it('refuses to spawn when the range is exhausted by live children', async () => {
    start(new StdioMcpConnection(cfg(), 'k1'));
    start(new StdioMcpConnection(cfg(), 'k2'));
    await expect(new StdioMcpConnection(cfg(), 'k3').start()).rejects.toThrow(/exhausted/);
    expect(spawnCalls).toHaveLength(2);
  });

  it('frees the uid when the child exits so another instance can be reclaimed into it', async () => {
    start(new StdioMcpConnection(cfg(), 'k1'));
    start(new StdioMcpConnection(cfg(), 'k2'));
    procs[0].emit('exit', 0, null);
    start(new StdioMcpConnection(cfg(), 'k3'));
    expect(spawnCalls[2]![1]).toContain('--reuid=20000');
    expect(wipes).toEqual([20000, 20001, 20000]);
  });

  it('fails closed on a corrupt map', async () => {
    mapFile = '{garbage';
    await expect(new StdioMcpConnection(cfg(), 'k').start()).rejects.toThrow(/is invalid/);
    expect(spawnCalls).toHaveLength(0);
  });
});
