import { describe, it, afterEach, expect, vi } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '@mcpambassador/core';
import { StdioMcpConnection } from '../../src/downstream/stdio-connection';
import { makeMcpConfig } from './helpers';

vi.mock('child_process', async orig => ({
  ...(await orig<typeof import('child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

/** Start a connection against a fake child that answers the handshake; returns handles */
async function startWithFakeChild(env: Record<string, string>, extraArgs: string[] = []) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  vi.mocked(spawn).mockImplementation(() => {
    const stdin = {
      write: (chunk: string) => {
        try {
          const msg = JSON.parse(chunk.toString()) as { method?: string; id?: number };
          const reply = (result: unknown) =>
            setTimeout(
              () =>
                stdout.emit(
                  'data',
                  Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
                ),
              0
            );
          if (msg.method === 'initialize') reply({});
          if (msg.method === 'tools/list') reply({ tools: [] });
        } catch {
          /* notifications etc. */
        }
        return true;
      },
      end: () => {},
    };
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      pid: 1,
      kill: () => {
        setTimeout(() => child.emit('exit', 0, null), 0);
        return true;
      },
    });
    return child as never;
  });
  const logs: string[] = [];
  const capture = (...a: unknown[]) => void logs.push(JSON.stringify(a));
  vi.spyOn(logger, 'warn').mockImplementation(capture as never);
  vi.spyOn(logger, 'error').mockImplementation(capture as never);
  vi.spyOn(logger, 'info').mockImplementation(capture as never);
  const conn = new StdioMcpConnection(
    makeMcpConfig({
      transport: 'stdio',
      env,
      command: ['node', 'srv.js', '--key', env['API_KEY']!, ...extraArgs],
    }) as never
  );
  await conn.start();
  const buffered = () => JSON.stringify(conn.getErrorHistory());
  return { conn, stdout, stderr, logs, buffered };
}

describe('StdioMcpConnection output redaction (TD-028)', () => {
  it('spawn log line scrubs config.env values appearing in the command', async () => {
    const { conn, logs } = await startWithFakeChild({ API_KEY: 'canary-vault-secret-001' });
    expect(logs.join('\n')).not.toContain('canary-vault-secret-001');
    await conn.stop();
  });

  it('spawn log masks the value after a secret-looking flag, even if not in config.env', async () => {
    const { conn, logs } = await startWithFakeChild({ API_KEY: 'canary-vault-secret-001' }, [
      '--api-key',
      'literal-flag-secret-xyz789',
      '--verbose',
      '--region',
      'eu-west-1',
    ]);
    const out = logs.join('\n');
    expect(out).not.toContain('literal-flag-secret-xyz789');
    expect(out).toContain('eu-west-1');
    await conn.stop();
  });

  it('exact secret split across stderr chunks is scrubbed from errorBuffer and log', async () => {
    const { conn, stderr, logs, buffered } = await startWithFakeChild({
      API_KEY: 'canary-vault-secret-002',
    });
    stderr.emit('data', Buffer.from('auth failed with canary-vault'));
    stderr.emit('data', Buffer.from('-secret-002 for user\n'));
    expect(buffered()).not.toContain('canary-vault');
    expect(buffered()).toContain('auth failed');
    expect(logs.join('\n')).not.toContain('canary-vault');
    await conn.stop();
  });

  it('multibyte character split across chunks does not defeat exact-value matching', async () => {
    const secret = 'pässwörd-canary-€-003';
    const { conn, stderr, buffered } = await startWithFakeChild({ API_KEY: secret });
    const bytes = Buffer.from(`oops ${secret} end\n`, 'utf8');
    const at = bytes.indexOf(Buffer.from('€')) + 1; // split inside the 3-byte euro sign
    stderr.emit('data', bytes.subarray(0, at));
    stderr.emit('data', bytes.subarray(at));
    expect(buffered()).not.toContain('pässwörd');
    expect(buffered()).not.toContain('canary');
    await conn.stop();
  });

  it('stdout JSON parse failure logs only errName and lineLength, never the input snippet', async () => {
    const { conn, stdout, logs } = await startWithFakeChild({ API_KEY: 'canary-vault-secret-004' });
    stdout.emit('data', Buffer.from('{"token":"canary-stdout-snippet-005" oops not json\n'));
    const all = logs.join('\n');
    expect(all).not.toContain('canary-stdout-snippet');
    expect(all).toContain('lineLength');
    expect(all).toContain('SyntaxError');
    await conn.stop();
  });
});
