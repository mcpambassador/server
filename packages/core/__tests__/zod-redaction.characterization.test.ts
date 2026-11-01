/**
 * TD-020 characterization (written on zod 3, must stay green on zod 4): enum / literal failures
 * echo the received value in zod's own message; the config error must never contain it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadConfig, formatZodIssues } from '../src/config/index.js';

const CANARY = 'LEAKCANARY-7c1e';

const caught = (fn: () => unknown): z.ZodError => {
  try {
    fn();
  } catch (e) {
    return e as z.ZodError;
  }
  throw new Error('expected a ZodError');
};

describe('formatZodIssues never echoes received values', () => {
  it('enum', () => {
    const msg = formatZodIssues(
      caught(() => z.object({ t: z.enum(['a', 'b']) }).parse({ t: CANARY }))
    );
    expect(msg).toContain('t:');
    expect(msg).not.toContain(CANARY);
  });
  it('literal', () => {
    const msg = formatZodIssues(caught(() => z.object({ t: z.literal('a') }).parse({ t: CANARY })));
    expect(msg).toContain('t:');
    expect(msg).not.toContain(CANARY);
  });
  it('discriminated union', () => {
    const s = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a') }),
      z.object({ k: z.literal('b') }),
    ]);
    const msg = formatZodIssues(caught(() => s.parse({ k: CANARY })));
    expect(msg).not.toContain(CANARY);
  });
  it('nested path is kept', () => {
    const msg = formatZodIssues(
      caught(() =>
        z.object({ a: z.array(z.object({ t: z.enum(['x']) })) }).parse({ a: [{ t: CANARY }] })
      )
    );
    expect(msg).toContain('a.0.t');
    expect(msg).not.toContain(CANARY);
  });
});

describe('loadConfig error for enum values', () => {
  let dir: string;
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not contain the offending enum value', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zod-char-'));
    const p = path.join(dir, 'config.yaml');
    await fs.writeFile(
      p,
      `
server:
  host: 0.0.0.0
  port: 8443
authentication:
  provider: api_key
  config: {}
authorization:
  provider: local_rbac
  config: {}
audit:
  provider: file
  on_failure: ${CANARY}
  config: {}
database:
  type: sqlite
  url: ./data/ambassador.db
downstream_mcps:
  - name: x
    transport: ${CANARY}
`
    );
    const err = await loadConfig(p, { scrub_env_vars: false, enforcement: 'warn' }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain('Config validation failed');
    expect(err!.message).toContain('on_failure');
    expect(err!.message).toContain('transport');
    expect(err!.message).not.toContain(CANARY);
  });
});
