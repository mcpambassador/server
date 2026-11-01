/** TD-045: an oversize downstream response fails only its own request, never hangs, never kills the MCP. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpConnection } from '../../src/downstream/stdio-connection.js';
import { SharedMcpManager } from '../../src/downstream/manager.js';

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
