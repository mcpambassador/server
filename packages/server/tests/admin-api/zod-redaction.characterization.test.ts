/**
 * TD-020 characterization (written on zod 3, must stay green on zod 4): the admin 400 body never
 * contains a received enum/literal value, and keeps path + a fixed "Invalid value" message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { startTestServer, stopTestServer, type TestServerHandle } from './helpers.js';
import { safeIssueMessage } from '../../src/admin/routes.js';

const CANARY = 'LEAKCANARY-7c1e';

describe('safeIssueMessage', () => {
  const issuesOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as z.ZodError).issues as unknown as Parameters<typeof safeIssueMessage>[0][];
    }
    throw new Error('expected a ZodError');
  };
  it('enum -> Invalid value', () => {
    const [i] = issuesOf(() => z.enum(['a', 'b']).parse(CANARY));
    expect(safeIssueMessage(i!)).toBe('Invalid value');
  });
  it('literal -> Invalid value', () => {
    const [i] = issuesOf(() => z.literal('a').parse(CANARY));
    expect(safeIssueMessage(i!)).toBe('Invalid value');
  });
  it('other issues keep their message and never contain the value', () => {
    const [i] = issuesOf(() => z.string().min(50).parse(CANARY));
    expect(safeIssueMessage(i!)).not.toBe('Invalid value');
    expect(safeIssueMessage(i!)).not.toContain(CANARY);
  });
});

describe('admin 400 body', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });

  it('enum failures: no canary, path kept, fixed message', async () => {
    const r = await server.admin.inject({
      method: 'POST',
      url: '/v1/admin/mcps',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: {
        name: 'char-mcp',
        display_name: 'Char',
        transport_type: CANARY,
        auth_type: CANARY,
        config: {},
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('VALIDATION_ERROR');
    expect(r.body.includes(CANARY), r.body.slice(0, 600)).toBe(false);
    const details = JSON.stringify(r.json());
    expect(details).toContain('transport_type');
    expect(details).toContain('auth_type');
    expect(details).toContain('Invalid value');
  });
});
