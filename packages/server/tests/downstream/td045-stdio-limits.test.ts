/** TD-045: an oversize downstream response fails only its own request, never hangs, never kills the MCP. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { RespawnController } from '../../src/downstream/respawn.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpConnection } from '../../src/downstream/stdio-connection.js';
import { SharedMcpManager } from '../../src/downstream/manager.js';
import { UserMcpPool } from '../../src/downstream/user-mcp-pool.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-mcp.mjs');
const MB = 1024 * 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td045-'));
const cleanups: Array<() => Promise<void>> = [];

const resultFile = (name: string, bytes: number): string => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ content: [{ type: 'text', text: 'a'.repeat(bytes) }] }));
  return f;
};
const cfg = (name: string, file: string) => ({
  name,
  transport: 'stdio' as const,
  command: ['node', FAKE],
  env: { FAKE_MCP_TOOLS: 'big', FAKE_MCP_RESULT_FILE: file },
});
const until = async (fn: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return fn();
};

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('TD-045 oversize response', () => {
  for (const [label, size] of [
    ['1.5MB (over the 1MB message limit)', 1.5 * MB],
    ['12MB (over the old 10MB buffer limit)', 12 * MB],
  ] as const) {
    it(`${label}: fails that request fast, MCP stays up and serves the next call`, async () => {
      const c = new StdioMcpConnection(cfg('td045-a', resultFile('r', size)));
      let disconnected = false;
      c.on('disconnect', () => {
        disconnected = true;
      });
      await c.start();
      cleanups.push(() => c.stop());

      const t0 = Date.now();
      await expect(c.invokeTool({ tool_name: 'big', arguments: {} })).rejects.toThrow(/too large/);
      expect(Date.now() - t0).toBeLessThan(10_000); // not the 30s request timeout

      expect(disconnected).toBe(false);
      expect(c.isConnected()).toBe(true);
      // same process still answers
      const ok = await c.invokeTool({ tool_name: '__env', arguments: {} });
      expect(JSON.stringify(ok)).toContain('FAKE_MCP_TOOLS');
    }, 30_000);
  }

  it('an in-flight small request is not failed by a concurrent oversize one', async () => {
    const c = new StdioMcpConnection(cfg('td045-b', resultFile('r2', 2 * MB)));
    await c.start();
    cleanups.push(() => c.stop());
    const [big, small] = await Promise.allSettled([
      c.invokeTool({ tool_name: 'big', arguments: {} }),
      c.invokeTool({ tool_name: '__env', arguments: {} }),
    ]);
    expect(big.status).toBe('rejected');
    expect(small.status).toBe('fulfilled');
  }, 30_000);
});

describe('TD-045 shared MCP respawn', () => {
  it('respawns a shared stdio MCP that dies unexpectedly', async () => {
    const m = new SharedMcpManager();
    await m.addMcp(cfg('td045-r', resultFile('r3', 10)));
    cleanups.push(() => m.shutdown());
    const conn = m.getConnection('td045-r') as StdioMcpConnection;
    expect(conn.isConnected()).toBe(true);
    (conn as any).process.kill('SIGKILL');
    expect(await until(() => !conn.isConnected(), 3000)).toBe(true);
    expect(await until(() => conn.isConnected(), 15_000)).toBe(true);
  }, 30_000);

  it('does not respawn an intentionally removed MCP', async () => {
    const m = new SharedMcpManager();
    await m.addMcp(cfg('td045-x', resultFile('r4', 10)));
    cleanups.push(() => m.shutdown());
    const conn = m.getConnection('td045-x') as StdioMcpConnection;
    await m.removeMcp('td045-x');
    await new Promise(r => setTimeout(r, 2500));
    expect(conn.isConnected()).toBe(false);
  }, 30_000);
});

describe('TD-045 respawn audit and per-user pool', () => {
  it('shared: audits the exit and the respawn', async () => {
    const m = new SharedMcpManager();
    const events: string[] = [];
    m.setAuditSink(a => events.push(a));
    await m.addMcp(cfg('td045-au', resultFile('r5', 10)));
    cleanups.push(() => m.shutdown());
    const conn = m.getConnection('td045-au') as StdioMcpConnection;
    (conn as any).process.kill('SIGKILL');
    expect(await until(() => events.includes('mcp_respawned'), 15_000)).toBe(true);
    expect(events[0]).toBe('mcp_process_exited');
  }, 30_000);

  it('per-user pool: respawns an instance that dies, not one terminated on purpose', async () => {
    const pool = new UserMcpPool({
      mcpConfigs: [{ ...cfg('td045-u', resultFile('r6', 10)), mcp_id: 'id-1' } as never],
      maxInstancesPerUser: 5,
      maxTotalInstances: 10,
      healthCheckIntervalMs: 3_600_000,
    });
    const events: string[] = [];
    pool.setAuditSink(a => events.push(a));
    await pool.spawnForUser('u1', undefined, new Set(['id-1']));
    cleanups.push(() => pool.shutdown());
    const conn = (pool as any).userInstances
      .get('u1')
      .connections.get('td045-u') as StdioMcpConnection;
    (conn as any).process.kill('SIGKILL');
    expect(await until(() => events.includes('mcp_respawned'), 15_000)).toBe(true);
    expect(conn.isConnected()).toBe(true);

    await pool.terminateForUser('u1');
    const n = events.length;
    await new Promise(r => setTimeout(r, 2500));
    expect(events.length).toBe(n);
    expect(conn.isConnected()).toBe(false);
  }, 45_000);
});

describe('TD-045 review fixes', () => {
  it('a runaway line (>64MB, no kill) fails the call and the process keeps serving', async () => {
    const c = new StdioMcpConnection(cfg('td045-run', resultFile('r7', 66 * MB)));
    await c.start();
    cleanups.push(() => c.stop());
    const pid = (c as any).process.pid;
    await expect(c.invokeTool({ tool_name: 'big', arguments: {} })).rejects.toThrow(/too large/);
    expect((c as any).process.pid).toBe(pid);
    expect(c.isConnected()).toBe(true);
    expect(JSON.stringify(await c.invokeTool({ tool_name: '__env', arguments: {} }))).toContain(
      'FAKE_MCP_TOOLS'
    );
  }, 60_000);

  it('start() refuses to overwrite a live process', async () => {
    const c = new StdioMcpConnection(cfg('td045-g', resultFile('r8', 10)));
    await c.start();
    cleanups.push(() => c.stop());
    const pid = (c as any).process.pid;
    await expect(c.start()).rejects.toThrow(/already running/);
    expect((c as any).process.pid).toBe(pid);
  }, 30_000);

  it('a stdin error (EPIPE) fails pending requests and does not throw uncaught', async () => {
    const c = new StdioMcpConnection(cfg('td045-e', resultFile('r9', 10)));
    await c.start();
    cleanups.push(() => c.stop());
    const p = c.invokeTool({ tool_name: '__env', arguments: {} });
    (c as any).process.stdin.emit('error', new Error('write EPIPE'));
    await expect(p).rejects.toThrow(/unavailable/);
  }, 30_000);

  it('restartMcp during a pending respawn leaves exactly one live process', async () => {
    const m = new SharedMcpManager();
    const events: string[] = [];
    m.setAuditSink(a => events.push(a));
    await m.addMcp(cfg('td045-rs', resultFile('r10', 10)));
    cleanups.push(() => m.shutdown());
    const conn = m.getConnection('td045-rs') as StdioMcpConnection;
    (conn as any).process.kill('SIGKILL');
    expect(await until(() => !conn.isConnected(), 3000)).toBe(true);
    await m.restartMcp('td045-rs');
    const pid = (conn as any).process.pid;
    await new Promise(r => setTimeout(r, 2500)); // past the 1s respawn timer
    expect((conn as any).process.pid).toBe(pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(events).not.toContain('mcp_respawned');
  }, 30_000);

  it('a respawn superseded while start() is in flight stops the new process', async () => {
    const stop = vi.fn(async () => undefined);
    const conn = {
      start: () => new Promise<void>(r => setTimeout(r, 600)),
      stop,
    } as never;
    const rc = new RespawnController('shared');
    rc.schedule(
      'k',
      conn,
      () => true,
      () => undefined
    );
    await new Promise(r => setTimeout(r, 1300)); // timer (1s) fired, start() in flight
    expect(rc.status('k').state).toBe('respawning');
    rc.cancel('k');
    await new Promise(r => setTimeout(r, 700));
    expect(stop).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('keeps retrying past the attempt budget instead of giving up', async () => {
    const events: string[] = [];
    const rc = new RespawnController('shared', a => events.push(a));
    let starts = 0;
    const conn = {
      start: () => {
        starts++;
        return Promise.reject(new Error('boom'));
      },
      stop: async () => undefined,
    } as never;
    vi.useFakeTimers();
    try {
      rc.schedule(
        'k',
        conn,
        () => true,
        () => undefined
      );
      for (let i = 0; i < 9; i++) await vi.advanceTimersByTimeAsync(31_000);
      expect(starts).toBeGreaterThan(RespawnController.FAILING_AFTER);
      expect(rc.status('k').state).toBe('failing');
      expect(events).toContain('mcp_respawn_failing');
    } finally {
      rc.close();
      vi.useRealTimers();
    }
  });
  it('throttles audit after the failing threshold: once, then hourly summary, none per retry', async () => {
    const events: string[] = [];
    const rc = new RespawnController('shared', a => events.push(a));
    const conn = {
      start: () => Promise.reject(new Error('boom')),
      stop: async () => undefined,
    } as never;
    vi.useFakeTimers();
    try {
      rc.schedule(
        'k',
        conn,
        () => true,
        () => undefined
      );
      // ~2h of retries at the 30s cap
      for (let i = 0; i < 240; i++) await vi.advanceTimersByTimeAsync(31_000);
      const failing = events.filter(e => e === 'mcp_respawn_failing').length;
      expect(failing).toBeGreaterThanOrEqual(2);
      expect(failing).toBeLessThanOrEqual(4);
      expect(events.filter(e => e === 'mcp_process_exited').length).toBeLessThanOrEqual(
        RespawnController.FAILING_AFTER
      );
      expect(events.filter(e => e === 'mcp_respawn_failed').length).toBeLessThanOrEqual(
        RespawnController.FAILING_AFTER
      );
    } finally {
      rc.close();
      vi.useRealTimers();
    }
  });
});
