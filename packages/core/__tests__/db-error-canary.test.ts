/**
 * TD-019: drizzle-orm >=0.44 wraps driver errors in DrizzleQueryError whose message embeds every
 * bound parameter. A forced constraint violation with a canary value must not surface the canary in
 * logs, persistent audit metadata, agent-facing pipeline responses, or HTTP error echoes.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql, DrizzleQueryError } from 'drizzle-orm';
import { Pipeline } from '../src/pipeline/index.js';
import { publicErrorMessage, isDbQueryError } from '../src/utils/redact.js';
import { createLogger } from '../src/utils/logger.js';
import type { AuditEvent } from '@mcpambassador/protocol';
import type { SessionContext } from '../src/spi/index.js';

const CANARY = 'CANARY-bound-param-9f3a77e1';

async function forceConstraintViolation(): Promise<unknown> {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (id TEXT PRIMARY KEY, secret TEXT UNIQUE)');
  const db = drizzle(raw);
  await db.run(sql`INSERT INTO t (id, secret) VALUES ('a', ${CANARY})`);
  try {
    await db.run(sql`INSERT INTO t (id, secret) VALUES ('b', ${CANARY})`);
  } catch (e) {
    // The sync SQLite driver throws raw; async drivers (postgres-js) are wrapped by drizzle >=0.44.
    // Wrap exactly as drizzle does: the driver error stays in `.cause`, params go in the message.
    return new DrizzleQueryError(
      'INSERT INTO t (id, secret) VALUES ($1, $2)',
      ['b', CANARY],
      e as Error
    );
  } finally {
    raw.close();
  }
  throw new Error('constraint violation was not raised');
}

const session: SessionContext = {
  session_id: 's',
  client_id: 'c',
  user_id: 'u',
  auth_method: 'api_key',
  groups: [],
  attributes: {},
  issued_at: 0,
  expires_at: 9e9,
};

describe('DrizzleQueryError never leaks bound params', () => {
  it('the raw error does carry the canary (the premise of the test)', async () => {
    const err = await forceConstraintViolation();
    expect(isDbQueryError(err)).toBe(true);
    expect((err as Error).message).toContain(CANARY);
  });

  it('log line: SQL and driver cause survive, params are dropped', async () => {
    const err = await forceConstraintViolation();
    const lines: string[] = [];
    const logger = createLogger(
      new Writable({
        write(chunk: Buffer, _e, cb) {
          lines.push(chunk.toString());
          cb();
        },
      })
    );
    logger.error({ err }, 'db failed');
    const out = lines.join('');
    expect(out).not.toContain(CANARY);
    expect(out).toContain('INSERT INTO t');
    expect(out).toContain('UNIQUE');
  });

  it('publicErrorMessage hides DB errors and passes ordinary errors through', async () => {
    expect(publicErrorMessage(await forceConstraintViolation())).toBe('Database error');
    expect(publicErrorMessage(new Error('Tool not found'))).toBe('Tool not found');
    expect(publicErrorMessage('plain')).toBe('plain');
  });

  it('pipeline: agent response and audit metadata omit the canary', async () => {
    const err = await forceConstraintViolation();
    const events: AuditEvent[] = [];
    const pipeline = new Pipeline(
      {
        id: 'a',
        initialize: async () => {},
        authenticate: async () => ({ success: true, session }),
        healthCheck: async () => ({ status: 'healthy', last_checked: '' }),
      } as never,
      {
        id: 'z',
        initialize: async () => {},
        authorize: async () => ({ decision: 'permit', reason: 'ok', policy_id: 'p' }),
        listAuthorizedTools: async () => [],
        healthCheck: async () => ({ status: 'healthy', last_checked: '' }),
      } as never,
      {
        id: 'au',
        initialize: async () => {},
        emit: async (e: AuditEvent) => {
          events.push(e);
        },
        flush: async () => {},
        healthCheck: async () => ({ status: 'healthy', last_checked: '' }),
      } as never,
      { audit_on_failure: 'buffer' }
    );

    // Routing failure -> metadata.error returned to the agent
    const res = await pipeline.invoke(
      { client_id: 'c', tool_name: 'x.y', arguments: {} },
      { headers: {}, sourceIp: '127.0.0.1' },
      async () => {
        throw err;
      }
    );
    expect(res.metadata?.error).toBe('Database error');
    expect(JSON.stringify(res)).not.toContain(CANARY);
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });
});
