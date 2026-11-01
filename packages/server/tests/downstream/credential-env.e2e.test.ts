import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserMcpPool } from '../../src/downstream/user-mcp-pool';
import { mapStaticCredentialEnv } from '../../src/services/credential-env';
import type { DownstreamMcpConfig, UserMcpCredentials } from '../../src/downstream/types';

// TD-048 / TD-049 end to end: registry-shaped per-user static MCP, real UserMcpPool, real stdio
// child (tests/fixtures/env-probe-mcp.mjs). The child only reports presence/match, never values.

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/env-probe-mcp.mjs'
);

const API_KEY = 'PKTESTKEY-' + 'a1b2c3d4e5';
const SECRET = 'sekrit-' + 'f6g7h8i9j0';

// Registry-shaped alpaca entry: credential properties have NO env_var; fixed ALPACA_PAPER_TRADE.
const credentialSchema = {
  type: 'object',
  properties: {
    ALPACA_API_KEY: { type: 'string', title: 'Alpaca API Key' },
    ALPACA_SECRET_KEY: { type: 'string', title: 'Alpaca Secret Key' },
  },
  required: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
};

// A user can only store credentials for properties in the schema, so a collision needs a schema
// that (wrongly or maliciously) declares the fixed-env name as a credential field.
const collidingSchema = {
  ...credentialSchema,
  properties: {
    ...credentialSchema.properties,
    ALPACA_PAPER_TRADE: { type: 'string', title: 'Paper trade' },
    alpaca_paper_trade: { type: 'string', title: 'Paper trade (lowercase)' },
  },
};

const MCP_ID = 'mcp-alpaca-probe';
const USER = 'user-1';

function config(env: Record<string, string> = { ALPACA_PAPER_TRADE: 'true' }): DownstreamMcpConfig {
  return {
    name: 'alpaca',
    mcp_id: MCP_ID,
    transport: 'stdio',
    command: ['node', FIXTURE],
    env,
    cwd: process.cwd(),
    timeout_ms: 15000,
  };
}

let pool: UserMcpPool | undefined;

afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
  vi.restoreAllMocks();
});

async function spawnAndProbe(
  decrypted: Record<string, string>,
  expect_: Record<string, string>,
  schema: unknown = credentialSchema,
  fixedEnv?: Record<string, string>
): Promise<{ report: Record<string, { present: boolean; matches: boolean }>; raw: string }> {
  // Same mapping the server uses when loading user credentials.
  const envVars = mapStaticCredentialEnv(schema, decrypted);
  const creds = new Map<string, UserMcpCredentials>([['alpaca', { envVars, headers: {} }]]);

  pool = new UserMcpPool({
    mcpConfigs: [config(fixedEnv)],
    maxInstancesPerUser: 5,
    maxTotalInstances: 10,
    healthCheckIntervalMs: 0,
  });
  await pool.spawnForUser(USER, creds, new Set([MCP_ID]));

  const tools = pool.getToolCatalog(USER);
  expect(tools.map(t => t.name)).toContain('env_probe');

  const res = await pool.invokeToolOn(USER, 'alpaca', {
    tool_name: 'env_probe',
    arguments: { expect: expect_ },
  });
  expect(res.isError).toBeFalsy();
  const raw = res.content[0]?.text ?? '';
  return { report: JSON.parse(raw), raw };
}

describe('credential env injection at spawn (TD-048, TD-049)', () => {
  it('gives the child the user secret under the field name when env_var is absent', async () => {
    const { report, raw } = await spawnAndProbe(
      { ALPACA_API_KEY: API_KEY, ALPACA_SECRET_KEY: SECRET },
      { ALPACA_API_KEY: API_KEY, ALPACA_SECRET_KEY: SECRET, ALPACA_PAPER_TRADE: 'true' }
    );
    expect(report['ALPACA_API_KEY']).toEqual({ present: true, matches: true });
    expect(report['ALPACA_SECRET_KEY']).toEqual({ present: true, matches: true });
    expect(report['ALPACA_PAPER_TRADE']).toEqual({ present: true, matches: true });
    // the probe never echoes values
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(SECRET);
  });

  it('a user credential named ALPACA_PAPER_TRADE=false does not override the fixed value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { report } = await spawnAndProbe(
      { ALPACA_API_KEY: API_KEY, ALPACA_SECRET_KEY: SECRET, ALPACA_PAPER_TRADE: 'false' },
      { ALPACA_PAPER_TRADE: 'true', ALPACA_API_KEY: API_KEY },
      collidingSchema
    );
    // fixed env wins: child still sees 'true', and the legitimate credential still arrives
    expect(report['ALPACA_PAPER_TRADE']).toEqual({ present: true, matches: true });
    expect(report['ALPACA_API_KEY']).toEqual({ present: true, matches: true });
    warn.mockRestore();
  });

  it('collision is case-insensitive (alpaca_paper_trade=false cannot override either)', async () => {
    const { report } = await spawnAndProbe(
      { ALPACA_API_KEY: API_KEY, ALPACA_SECRET_KEY: SECRET, alpaca_paper_trade: 'false' },
      { ALPACA_PAPER_TRADE: 'true', alpaca_paper_trade: 'false' },
      collidingSchema
    );
    expect(report['ALPACA_PAPER_TRADE']).toEqual({ present: true, matches: true });
    // the lowercase credential was dropped, not set alongside
    expect(report['alpaca_paper_trade']).toEqual({ present: false, matches: false });
  });

  describe('registry placeholder slots (${NAME})', () => {
    const slotEnv = {
      ALPACA_PAPER_TRADE: 'true',
      ALPACA_API_KEY: '${ALPACA_API_KEY}',
      ALPACA_SECRET_KEY: '${ALPACA_SECRET_KEY}',
    };

    it('fills ${NAME} slots with the real credential (schema property, no env_var)', async () => {
      const { report, raw } = await spawnAndProbe(
        { ALPACA_API_KEY: API_KEY, ALPACA_SECRET_KEY: SECRET },
        {
          ALPACA_API_KEY: API_KEY,
          ALPACA_SECRET_KEY: SECRET,
          ALPACA_PAPER_TRADE: 'true',
        },
        credentialSchema,
        slotEnv
      );
      expect(report['ALPACA_API_KEY']).toEqual({ present: true, matches: true });
      expect(report['ALPACA_SECRET_KEY']).toEqual({ present: true, matches: true });
      expect(report['ALPACA_PAPER_TRADE']).toEqual({ present: true, matches: true });
      expect(raw).not.toContain(API_KEY);
      expect(raw).not.toContain(SECRET);
    });

    it('removes unfilled slots: the child never sees the literal ${NAME}', async () => {
      const { report } = await spawnAndProbe(
        { ALPACA_API_KEY: API_KEY }, // secret not supplied
        {
          ALPACA_API_KEY: API_KEY,
          ALPACA_SECRET_KEY: '${ALPACA_SECRET_KEY}',
        },
        credentialSchema,
        slotEnv
      );
      expect(report['ALPACA_API_KEY']).toEqual({ present: true, matches: true });
      // not present at all, and in particular not the literal placeholder
      expect(report['ALPACA_SECRET_KEY']).toEqual({ present: false, matches: false });
    });

    it('keeps a slot for a different name locked (literal stays, credential dropped)', async () => {
      const { report } = await spawnAndProbe(
        { ALPACA_API_KEY: API_KEY, ALPACA_SECRET_KEY: SECRET },
        { ALPACA_API_KEY: '${ALPACA_SECRET_KEY}', ALPACA_SECRET_KEY: SECRET },
        credentialSchema,
        { ALPACA_API_KEY: '${ALPACA_SECRET_KEY}' }
      );
      expect(report['ALPACA_API_KEY']).toEqual({ present: true, matches: true });
      expect(report['ALPACA_SECRET_KEY']).toEqual({ present: true, matches: true });
    });
  });
});
