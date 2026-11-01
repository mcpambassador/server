/** TD-044: a registry entry whose command[0] is not on the spawn allowlist is refused at install. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getMcpEntryByName } from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { RegistryService } from '../../src/services/registry-service.js';
import { SecretStore } from '../../src/services/secret-store.js';

const CANARY = 'LEAKCANARY-td044';
const yamlDoc = (): string =>
  JSON.stringify({
    schema_version: '1',
    registry: { name: 't', maintainer: 't', updated_at: '2026-01-01' },
    mcps: [
      ['reg-docker', ['docker', 'run', '--rm', `${CANARY}/img`]],
      ['reg-npx', ['npx', '-y', 'pkg@1.2.3']],
    ].map(([name, command]) => ({
      name,
      display_name: name,
      description: 'd',
      transport_type: 'stdio',
      config: { command },
      auth_type: 'none',
    })),
  }); // JSON is valid YAML

describe('registry installEntry command allowlist (TD-044)', () => {
  let server: TestServerHandle;
  let prev: string | undefined;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prev === undefined) delete process.env['MCP_ALLOWED_COMMANDS'];
    else process.env['MCP_ALLOWED_COMMANDS'] = prev;
  });

  async function svc(): Promise<RegistryService> {
    prev = process.env['MCP_ALLOWED_COMMANDS'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(yamlDoc(), { status: 200 }));
    const s = new RegistryService(
      { url: 'https://registry.example/r.yaml', refreshIntervalHours: 24, enabled: true },
      server.db,
      new SecretStore({})
    );
    await s.fetchRegistry();
    return s;
  }

  it('default allowlist: docker entry is refused, nothing stored, value not echoed', async () => {
    const s = await svc();
    delete process.env['MCP_ALLOWED_COMMANDS'];
    const r = await s.installEntry('reg-docker');
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(await getMcpEntryByName(server.db, 'reg-docker')).toBeNull();
  });

  it('control: npx entry installs on the default allowlist', async () => {
    const s = await svc();
    delete process.env['MCP_ALLOWED_COMMANDS'];
    expect((await s.installEntry('reg-npx')).success).toBe(true);
  });

  it('opt-in via MCP_ALLOWED_COMMANDS: the docker entry installs', async () => {
    const s = await svc();
    process.env['MCP_ALLOWED_COMMANDS'] = 'npx,node,docker';
    const r = await s.installEntry('reg-docker');
    expect(r.success, r.message).toBe(true);
    expect(await getMcpEntryByName(server.db, 'reg-docker')).not.toBeNull();
  });
});
