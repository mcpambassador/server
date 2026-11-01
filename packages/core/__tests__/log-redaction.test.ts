import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import {
  createLogger,
  redactSecretsInString,
  StreamRedactor,
  serializeErr,
  REDACT_PATHS,
} from '../src/index.js';

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
      `amb_pk_abc123abc123abc123 amb_ak_def456def456def456 amb_st_g789g789g789g789 amb_rt_h012h012h012h012 ${jwt} Bearer abc.def ` +
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

  // Reviewer gaps R1-R4, exact-value (S1) and PEM: each leak must be scrubbed from the message and
  // the stack of an Error, including one reached through `cause`.
  describe('credential shapes (R1-R4, S1, PEM)', () => {
    const PEM =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqcanarypem0123456789\nabcdefcanarypemline2\n-----END PRIVATE KEY-----';
    const LEAKS: Record<string, { text: string; secret: string }> = {
      'R1 amb_at_': {
        text: 'tok amb_at_canaryaccess0123456789ab',
        secret: 'canaryaccess0123456789ab',
      },
      'R1 amb_ac_': {
        text: 'code amb_ac_canaryauthcode0123456789',
        secret: 'canaryauthcode0123456789',
      },
      'R2 userinfo': {
        text: 'connect postgres://dbuser:canaryDbPass99@db.internal:5432/x',
        secret: 'canaryDbPass99',
      },
      'R2 userinfo https': {
        text: 'GET https://svc:canarySvcPw77@api.example/v1',
        secret: 'canarySvcPw77',
      },
      'R3 basic': {
        text: 'Authorization: Basic Y2FuYXJ5dXNlcjpjYW5hcnlwdw== extra',
        secret: 'Y2FuYXJ5dXNlcjpjYW5hcnlwdw',
      },
      'R3 other scheme': {
        text: 'authorization: Digest username=canaryuser response=canarydigest01',
        secret: 'canarydigest01',
      },
      'R4 cookie': {
        text: 'Cookie: a=1; sid=canarycookie11; other=canarycookie22',
        secret: 'canarycookie22',
      },
      'R4 set-cookie': {
        text: 'Set-Cookie: sessionId=canarysetck33; Path=/; HttpOnly',
        secret: 'canarysetck33',
      },
      'R4 sessionId': { text: 'sessionId=canarysession44 ok', secret: 'canarysession44' },
      'R4 _csrf': { text: '"_csrf": "canarycsrf55"', secret: 'canarycsrf55' },
      PEM: { text: `key follows ${PEM} done`, secret: 'canarypem' },
    };

    for (const [name, { text, secret }] of Object.entries(LEAKS)) {
      it(`${name}: scrubbed from string, message, stack and cause`, () => {
        expect(redactSecretsInString(text)).not.toContain(secret);

        const { logger, out } = capture();
        const cause = new Error(`inner: ${text}`);
        const err = new Error(`outer: ${text}`, { cause });
        err.stack = `Error: outer\n    at ${text.replace(/\n/g, ' ')} (file.ts:1:1)`;
        logger.error({ err }, 'boom');
        expect(out()).not.toContain(secret);
      });
    }

    it('keeps the line after a Cookie header untouched', () => {
      expect(redactSecretsInString('Cookie: a=canary1234\nnext line ok')).toContain('next line ok');
    });

    it('S1: exact values (len >= 8) are scrubbed even when they look like nothing', () => {
      const vals = ['plainvaultsecret', 'short', 'p@ss.word/with+regex(chars)'];
      const text = 'fail plainvaultsecret then short then p@ss.word/with+regex(chars) done';
      const s = redactSecretsInString(text, vals);
      expect(s).not.toContain('plainvaultsecret');
      expect(s).not.toContain('p@ss.word/with+regex(chars)');
      expect(s).toContain('short'); // under 8 chars: left alone
      expect(redactSecretsInString(text)).toContain('plainvaultsecret'); // no list, no scrub
    });

    it('S1: the longest exact value wins when values overlap', () => {
      const s = redactSecretsInString('x supersecretvalue99 y', [
        'supersecret',
        'supersecretvalue99',
      ]);
      expect(s).not.toContain('value99');
    });
  });

  describe('StreamRedactor (stateful stderr)', () => {
    const feed = (chunks: string[], vals: string[] = []) => {
      const r = new StreamRedactor(vals);
      return [...chunks.flatMap(c => r.push(c)), ...r.flush()];
    };

    it('joins a pattern secret split across 2 chunks', () => {
      const out = feed(['auth failed amb_pk_canarysplit01', '23456789abcd for user\nnext\n']);
      expect(out.join('\n')).not.toContain('canarysplit');
      expect(out).toContain('next');
    });

    it('joins an exact-value secret split across 2 chunks', () => {
      const out = feed(['boom plainvault', 'secret99 done\n'], ['plainvaultsecret99']);
      expect(out.join('\n')).not.toContain('plainvault');
      expect(out.join('\n')).not.toContain('secret99');
    });

    it('redacts a PEM block spread over 3 chunks, then resumes normal output', () => {
      const out = feed([
        'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEcanarypemA',
        'AAA\ncanarypemBBBB\n',
        '-----END RSA PRIVATE KEY-----\nafter ok\n',
      ]);
      const all = out.join('\n');
      expect(all).not.toContain('canarypem');
      expect(all).not.toContain('BEGIN');
      expect(out).toContain('before');
      expect(out).toContain('after ok');
    });

    it('PEM with no END marker stays redacted until the stream ends', () => {
      const out = feed(['-----BEGIN PRIVATE KEY-----\n', 'canarypemX\n', 'canarypemY']);
      expect(out.join('\n')).not.toContain('canarypem');
    });

    it('flushes a partial line on flush() (scrubbed)', () => {
      const r = new StreamRedactor([], 64);
      expect(r.push('token=canarytail12')).toEqual([]);
      expect(r.flush().join('')).not.toContain('canarytail12');
    });

    it('size cap: emits the scrubbed head with a truncation marker, drops the rest of the line, no overlap', () => {
      const r = new StreamRedactor([], 64);
      const out = r.push('a'.repeat(40) + ' ' + 'b'.repeat(40) + 'CANARYTAIL');
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('…[line truncated]');
      expect(out[0]).not.toContain('CANARYTAIL');
      // continuation of the same line is dropped, next line is kept
      expect(r.push('more CANARYMORE')).toEqual([]);
      expect(r.push(' still\nnext line\n')).toEqual(['next line']);
      expect(r.flush()).toEqual([]);
    });

    it('size cap: a long line that does include its newline is truncated too', () => {
      const r = new StreamRedactor([], 32);
      const out = r.push('x'.repeat(100) + '\nok\n');
      expect(out).toHaveLength(2);
      expect(out[0]).toContain('…[line truncated]');
      expect(out[1]).toBe('ok');
    });

    it('size cap: does not keep half of a token at the cut', () => {
      const r = new StreamRedactor([], 140);
      const out = r.push('y'.repeat(100) + ' amb_pk_' + 'Z'.repeat(60));
      expect(out[0]).not.toContain('amb_pk_');
    });

    it('userinfo without a password (token as the user) is redacted', () => {
      const s = redactSecretsInString(
        'clone https://ghs_canaryuserinfo0123456789@github.com/o/r.git'
      );
      expect(s).not.toContain('canaryuserinfo');
      expect(s).toContain('@github.com');
      expect(redactSecretsInString('https://short@host/x')).toContain('short@host');
    });

    it('strips CR from CRLF lines', () => {
      expect(feed(['a\r\nb\r\n'])).toEqual(['a', 'b']);
    });
  });
});
