import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserMcpPool } from '../../src/downstream/user-mcp-pool';
import type { DownstreamMcpConfig, UserMcpCredentials } from '../../src/downstream/types';

// Spawn-path check for the runtime-uv image settings: a REAL UserMcpPool spawns a REAL stdio child
// (tests/fixtures/env-probe-mcp.mjs, which reports only presence/match, never values) and the child
// must see the server-controlled UV_* values, even if the MCP config tries to override them.

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/env-probe-mcp.mjs'
);

const SERVER_UV = {
  UV_PYTHON_DOWNLOADS: 'never',
  UV_PYTHON: '/usr/bin/python3',
  UV_CACHE_DIR: '/tmp/.uv-cache',
  UV_TOOL_DIR: '/tmp/.uv-tools',
};
const KEYS = Object.keys(SERVER_UV);
const saved: Record<string, string | undefined> = {};
let pool: UserMcpPool | undefined;

afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function probe(
  configEnv: Record<string, string>
): Promise<Record<string, { present: boolean; matches: boolean }>> {
  const cfg: DownstreamMcpConfig = {
    name: 'uvprobe',
    mcp_id: 'mcp-uv-probe',
    transport: 'stdio',
    command: ['node', FIXTURE],
    env: configEnv,
    cwd: process.cwd(),
    timeout_ms: 15000,
  };
  pool = new UserMcpPool({
    mcpConfigs: [cfg],
    maxInstancesPerUser: 5,
    maxTotalInstances: 10,
    healthCheckIntervalMs: 0,
  });
  const creds = new Map<string, UserMcpCredentials>([['uvprobe', { envVars: {}, headers: {} }]]);
  await pool.spawnForUser('user-1', creds, new Set(['mcp-uv-probe']));
  const res = await pool.invokeToolOn('user-1', 'uvprobe', {
    tool_name: 'env_probe',
    arguments: { expect: SERVER_UV },
  });
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0]?.text ?? '{}');
}

describe('uv env reaches spawned stdio MCPs (real child)', () => {
  it('child sees server UV_* values', async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, SERVER_UV);
    const report = await probe({});
    for (const k of KEYS) expect(report[k], k).toEqual({ present: true, matches: true });
  });

  it('config.env cannot set UV_*: the MCP is refused and no child starts', async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, SERVER_UV);
    await expect(
      probe({ UV_PYTHON_DOWNLOADS: 'automatic', UV_PYTHON: '/evil/python' })
    ).rejects.toThrow(/not found|no active/i);
  });

  it('UV_* absent from the server env stays absent in the child', async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    const report = await probe({});
    for (const k of KEYS) expect(report[k], k).toEqual({ present: false, matches: false });
  });
});
