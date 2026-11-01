import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, redactSecretsInString, serializeErr, REDACT_PATHS } from '../src/index.js';

// Canary values: if any of these appear in log output, redaction failed.
const CANARIES = {
  password: 'canary-password-7f3a',
  token: 'canary-token-8b21',
  secret: 'canary-secret-91cd',
  client_secret: 'canary-client-secret-44ef',
  preshared_key: 'canary-psk-02aa',
  access_token: 'canary-access-1d9e',
  refresh_token: 'canary-refresh-5c7b',
  id_token: 'canary-id-token-6e10',
  code_verifier: 'canary-verifier-3b8c',
  authorization: 'Bearer canary-bearer-aa11',
  cookie: 'sid=canary-cookie-bb22',
  'set-cookie': 'sid=canary-setcookie-cc33',
  'x-admin-key': 'amb_ak_canaryadminkeydd44',
  'x-session-token': 'amb_st_canarysessionee55',
};

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger(stream), out: () => lines.join('') };
}

const expectNoCanaries = (out: string) => {
  for (const v of Object.values(CANARIES)) expect(out).not.toContain(v);
  expect(out).not.toMatch(/canary/);
};

describe('log redaction (TD-026)', () => {
  it('redacts every secret key at top level and one level deep', () => {
    const { logger, out } = capture();
    const keys = Object.keys(CANARIES).filter(
      k => !k.includes('-') && k !== 'authorization' && k !== 'cookie'
    );
    const flat = Object.fromEntries(keys.map(k => [k, CANARIES[k as keyof typeof CANARIES]]));
    logger.info({ ...flat, nested: flat, creds: flat }, 'flat');
    expectNoCanaries(out());
    expect(out()).toContain('[REDACTED]');
  });

  it('redacts secret headers (top level, one level deep, and under headers)', () => {
    const { logger, out } = capture();
    const h = {
      authorization: CANARIES.authorization,
      cookie: CANARIES.cookie,
      'set-cookie': CANARIES['set-cookie'],
      'x-admin-key': CANARIES['x-admin-key'],
      'x-session-token': CANARIES['x-session-token'],
    };
    logger.info({ ...h, req: { headers: h }, headers: h }, 'headers');
    expectNoCanaries(out());
  });

  it('keeps non-secret fields', () => {
    const { logger, out } = capture();
    logger.info({ user: 'alice', password: CANARIES.password }, 'who');
    expect(out()).toContain('alice');
  });

  it('err serializer keeps name/message/code/stack and drops HTTP client payloads', () => {
    const { logger, out } = capture();
    const err = Object.assign(new Error('upstream failed'), {
      code: 'ECONNRESET',
      response: {
        status: 401,
        headers: { authorization: CANARIES.authorization },
        data: { access_token: CANARIES.access_token },
      },
      config: {
        headers: { Authorization: CANARIES.authorization },
        data: `client_secret=${CANARIES.client_secret}`,
      },
      request: { headers: { cookie: CANARIES.cookie } },
      body: { refresh_token: CANARIES.refresh_token },
      headers: { 'x-admin-key': CANARIES['x-admin-key'] },
    });
    logger.error({ err }, 'call failed');
    const o = out();
    expectNoCanaries(o);
    const rec = JSON.parse(o) as { err: Record<string, unknown> };
    expect(rec.err.message).toBe('upstream failed');
    expect(rec.err.code).toBe('ECONNRESET');
    expect(rec.err.type).toBe('Error');
    expect(typeof rec.err.stack).toBe('string');
    for (const dropped of ['response', 'config', 'request', 'body', 'headers']) {
      expect(rec.err).not.toHaveProperty(dropped);
    }
  });

  it('redacts secrets embedded in message, stack and cause', () => {
    const { logger, out } = capture();
    const cause = new Error(
      `GET https://idp.example/cb?code=canary-code-ff66&state=canary-state-0077 failed, ${CANARIES.authorization}`
    );
    const err = new Error(
      `refresh failed token=${CANARIES.token} key amb_pk_canarypresharedkey88`,
      { cause }
    );
    logger.error({ err }, 'oauth');
    logger.error({ error: err }, 'oauth alias');
    expectNoCanaries(out());
    expect(out()).toContain('cause');
  });

  it('serializes non-Error throwables safely', () => {
    expect(serializeErr('boom token=canary-token-8b21').message).not.toContain('canary');
    expect(serializeErr(undefined).message).toBe('undefined');
  });

  it('redactSecretsInString covers Ambassador keys, JWTs, bearer and URL query secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeQ';
    const s = redactSecretsInString(
      `amb_pk_abc123 amb_ak_def456 amb_st_g789 amb_rt_h012 ${jwt} Bearer abc.def ` +
        'https://x/?code=C1&state=S1&access_token=T1&keep=1 password: hunter2'
    );
    for (const bad of [
      'abc123',
      'def456',
      'g789',
      'h012',
      jwt,
      'abc.def',
      'C1',
      'S1',
      'T1',
      'hunter2',
    ]) {
      expect(s).not.toContain(bad);
    }
    expect(s).toContain('keep=1');
  });

  it('exports the redact path list covering each documented key', () => {
    for (const k of [
      'password',
      'token',
      'secret',
      'client_secret',
      'preshared_key',
      'access_token',
      'refresh_token',
      'code_verifier',
    ]) {
      expect(REDACT_PATHS).toContain(k);
      expect(REDACT_PATHS).toContain(`*.${k}`);
    }
    for (const h of ['authorization', 'cookie', 'set-cookie', 'x-admin-key', 'x-session-token']) {
      expect(REDACT_PATHS).toContain(`["${h}"]`);
    }
  });
});
