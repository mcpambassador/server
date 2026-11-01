/**
 * TD-026 / TD-028 end-to-end: drive real error paths with canary credentials in a child process
 * and assert none reaches (a) stdout/stderr logs, (b) the admin MCP logs endpoint, (c) the
 * connection error history.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const N = 'cnry' + Math.random().toString(36).slice(2, 8);
const PKG = path.resolve(__dirname, '../..');

interface Capture {
  endpoint: Record<string, string>;
  history: Record<string, unknown>;
  thrown: Record<string, string>;
}

let logs = '';
let cap: Capture;

/** Credential values (not prefixes) that must never appear. tag → cores. */
const cores = (tag: string): string[] => [
  `${N}${tag}pkcore`,
  `${N}${tag}akcore`,
  `${N}${tag}stcore`,
  `${N}${tag}rtcore`,
  `${N}${tag}bearercore`,
  `${N}${tag}urlpass`,
  `${N}${tag}hdr0000`,
  `${N}${tag}pay0000`,
  `${N}${tag}sig00000`,
  `${N}${tag}codeval`,
  `${N}${tag}stateval`,
  `${N}${tag}atval`,
  `${N}${tag}pwval`,
  `${N}${tag}tokval`,
];

beforeAll(() => {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-')), 'cap.json');
  const r = spawnSync(
    path.join(PKG, 'node_modules/.bin/tsx'),
    [path.join(__dirname, 'driver.ts'), outFile],
    {
      cwd: PKG,
      env: { ...process.env, CANARY_NONCE: N, LOG_LEVEL: 'debug' },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  logs = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (!fs.existsSync(outFile)) {
    throw new Error(`driver failed (status ${r.status}): ${logs.slice(-1500)}`);
  }
  cap = JSON.parse(fs.readFileSync(outFile, 'utf8')) as Capture;
}, 120_000);

const leaks = (haystack: string, needles: string[]): string[] =>
  needles.filter(n => haystack.includes(n));

describe('driver sanity (the error paths really ran and logged)', () => {
  it('produced log output for each scenario', () => {
    for (const m of ['http-500', 'http-rpcerr', 'stdio-noisy', 'OAuthTokenManager']) {
      expect(logs, `no log lines mention ${m}`).toContain(m);
    }
  });
  it('error history recorded for the failing connections', () => {
    for (const n of ['http-500', 'http-rpcerr', 'stdio-noisy']) {
      expect(JSON.stringify(cap.history[n]).length, n).toBeGreaterThan(20);
    }
  });
});

describe('no canary credential in stdout/stderr logs', () => {
  const tags = ['h5body', 'hrpc', 'hrpcdata', 'se', 'oa'];
  for (const t of tags) {
    it(`logs: ${t}`, () => {
      expect(leaks(logs, cores(t))).toEqual([]);
    });
  }
  it('logs: reason phrases / response bodies / URL userinfo / query tokens', () => {
    expect(
      leaks(logs, [
        `${N}h5reason`,
        `${N}oareason`,
        `${N}oabodyat`,
        `${N}oabodyrt`,
        `${N}deadpass`,
        `${N}deadat`,
        `${N}oauthclientsecret`,
        `${N}authcode`,
        `${N}oldrefresh`,
      ])
    ).toEqual([]);
  });
  it('logs: long stderr line credential', () => {
    expect(leaks(logs, [`${N}longcore`])).toEqual([]);
  });
});

describe('no canary credential in the admin MCP logs endpoint or error history', () => {
  const tagsFor: Record<string, string[]> = {
    'http-500': ['h5body'],
    'http-rpcerr': ['hrpc', 'hrpcdata'],
    'stdio-noisy': ['se'],
  };
  for (const [name, tags] of Object.entries(tagsFor)) {
    it(`endpoint ${name}`, () => {
      const body = cap.endpoint[name] ?? '';
      expect(body.length).toBeGreaterThan(20);
      for (const t of tags) expect(leaks(body, cores(t)), t).toEqual([]);
      expect(leaks(body, [`${N}h5reason`, `${N}longcore`, `${N}deadpass`, `${N}deadat`])).toEqual(
        []
      );
    });
    it(`history ${name}`, () => {
      const h = JSON.stringify(cap.history[name]);
      for (const t of tags) expect(leaks(h, cores(t)), t).toEqual([]);
    });
  }
  it('endpoint http-dead (credentials in the configured URL)', () => {
    expect(leaks(cap.endpoint['http-dead'] ?? '', [`${N}deadpass`, `${N}deadat`])).toEqual([]);
  });
  it('endpoint summary', () => {
    expect(leaks(cap.endpoint['__summary'] ?? '', [`${N}deadpass`, `${N}deadat`])).toEqual([]);
  });
});

describe('secrets split across stderr chunks', () => {
  it('amb_pk_ split mid-token: neither half is exposed', () => {
    const all = logs + JSON.stringify(cap.endpoint);
    expect(leaks(all, [`${N}splitA`, `splitB${N}splittail`, `${N}splittail`])).toEqual([]);
  });
  it('Bearer split mid-token: neither half is exposed', () => {
    const all = logs + JSON.stringify(cap.endpoint);
    expect(leaks(all, [`${N}bsplitA`, `bsplitB${N}bsplittail`, `${N}bsplittail`])).toEqual([]);
  });
});

describe('PEM, parse errors and spawn-line args', () => {
  const sinks = (): string => logs + JSON.stringify(cap.endpoint) + JSON.stringify(cap.history);
  it('PEM block split across chunks: no key material', () => {
    expect(leaks(sinks(), [`${N}pemA`, `${N}pemB`, `${N}pemline2`])).toEqual([]);
  });
  it('malformed JSON from stdout: credentials not logged raw', () => {
    expect(leaks(sinks(), [`${N}jsoncore`, `${N}jsonbearer`])).toEqual([]);
  });
  it('spawn log line: secrets in command args are redacted', () => {
    const spawnLines = logs.split('\n').filter(l => l.includes('Spawning subprocess'));
    expect(spawnLines.length).toBeGreaterThan(0);
    expect(leaks(spawnLines.join('\n'), [`${N}argtoken`, `${N}argkey`, `${N}argurlpass`])).toEqual([]);
    expect(leaks(sinks(), [`${N}argtoken`, `${N}argkey`, `${N}argurlpass`])).toEqual([]);
  });
});
