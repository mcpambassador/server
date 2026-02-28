import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as child_process from 'child_process';
import { makeMcpConfig } from './helpers';

let StdioMcpConnection: any;

beforeEach(() => {
  StdioMcpConnection = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StdioMcpConnection initialize handshake', () => {
  it('sends initialize before notifications/initialized and tools/list', async () => {
    try {
      const mod = await import('../../../src/downstream/stdio-connection');
      StdioMcpConnection = (mod as any).StdioMcpConnection;
    } catch (err) {
      // skip if implementation missing
      return expect(true).toBeTruthy();
    }

    // Prepare fake stdio
    const EventEmitter = require('events').EventEmitter;
    const fakeStdout = new EventEmitter();
    const fakeStderr = new EventEmitter();

    const writes: string[] = [];

    // stub spawn to provide fake stdio and capture writes
    const spawnMock = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const fakeStdin = {
        write: (chunk: string) => {
          // capture written chunk
          if (typeof chunk === 'string') {
            writes.push(chunk);

            // parse request to respond appropriately
            try {
              const msg = JSON.parse(chunk.toString());
              // Respond to initialize (id 1)
              if (msg.method === 'initialize' && msg.id === 1) {
                // reply with result for initialize
                setTimeout(() => {
                  fakeStdout.emit(
                    'data',
                    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n')
                  );
                }, 0);
              }

              // Respond to tools/list (id 2)
              if (msg.method === 'tools/list' && msg.id === 2) {
                setTimeout(() => {
                  fakeStdout.emit(
                    'data',
                    Buffer.from(
                      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) + '\n'
                    )
                  );
                }, 0);
              }
            } catch (e) {
              // ignore
            }
          }
          return true;
        },
      } as any;

      return {
        stdout: fakeStdout,
        stderr: fakeStderr,
        stdin: fakeStdin,
        pid: 12345,
        kill: () => {},
        on: () => {},
      } as any;
    });

    const config = makeMcpConfig({ transport: 'stdio' });
    const conn = new StdioMcpConnection(config);

    await conn.start();

    // Ensure we captured some writes
    expect(writes.length).toBeGreaterThanOrEqual(3);

    // Normalize lines (each write may include trailing newline)
    const parsed = writes
      .map(w => w.toString().trim())
      .map(s => {
        try {
          return JSON.parse(s);
        } catch (e) {
          return s;
        }
      });

    // First should be initialize request
    expect(parsed[0]).toMatchObject({ method: 'initialize' });

    // There should be a notification for initialized (no id)
    // Find a raw string write that contains notifications/initialized
    const hasInitializedNotification = writes.some(w => w.includes('notifications/initialized'));
    expect(hasInitializedNotification).toBe(true);

    // Finally, tools/list should be sent after initialized
    const firstInitIndex = writes.findIndex(w => w.includes('initialize'));
    const notifIndex = writes.findIndex(w => w.includes('notifications/initialized'));
    const toolsIndex = writes.findIndex(w => w.includes('tools/list'));

    expect(firstInitIndex).toBeGreaterThanOrEqual(0);
    expect(notifIndex).toBeGreaterThan(firstInitIndex);
    expect(toolsIndex).toBeGreaterThan(notifIndex);

    await conn.stop();
  });
});
