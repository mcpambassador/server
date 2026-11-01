/**
 * TD-022 + KS-1/2/3: persisted kill switches, GET list, target validation, router-level enforcement,
 * killed tools hidden from tool lists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, runMigrations, closeDatabase } from '@mcpambassador/core';
import { KillSwitchManager } from '../src/admin/kill-switch-manager.js';
import {
  buildInvocationRouter,
  listPermittedTools,
  KillSwitchError,
  type ToolServiceDeps,
} from '../src/services/tool-service.js';
import {
  startAgentTestServer,
  stopAgentTestServer,
  type AgentTestServer,
} from './agent-endpoint/helpers.js';

describe('KillSwitchManager persistence', () => {
  it('survives a restart; deactivate removes the row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
    const dbPath = path.join(dir, 'a.db');
    let db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath });
    await runMigrations(db);
    const m1 = new KillSwitchManager(db);
    await m1.set('mcp:github', true, 'admin-key:k1');
    await m1.set('client:c1', true, 'u1');
    await m1.set('mcp:github', true, 'someone-else'); // idempotent: keeps original activation
    await closeDatabase(db);

    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath });
    const m2 = new KillSwitchManager(db);
    expect(await m2.load()).toBe(2);
    expect(m2.isActive('mcp', 'github')).toBe(true);
    expect(m2.isActive('client', 'c1')).toBe(true);
    expect(m2.list().find(s => s.target === 'mcp:github')).toMatchObject({
      type: 'mcp',
      activated_by: 'admin-key:k1',
    });
    await m2.set('mcp:github', false, 'u1');
    await closeDatabase(db);

    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath });
    const m3 = new KillSwitchManager(db);
    expect(await m3.load()).toBe(1);
    expect(m3.isActive('mcp', 'github')).toBe(false);
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('enforcement in tool-service (KS-1/KS-2)', () => {
  const catalog = [
    { name: 'gh_search', description: '', inputSchema: {}, source_mcp: 'github' },
    { name: 'sl_post', description: '', inputSchema: {}, source_mcp: 'slack' },
  ];
  const mk = (ks: KillSwitchManager): ToolServiceDeps =>
    ({
      db: {},
      authz: { authorize: async () => ({ decision: 'permit' }) },
      toolRouter: { getIsolationAwareToolCatalog: async () => catalog },
      mcpManager: {
        getToolDescriptor: (n: string) => catalog.find(t => t.name === n),
        invokeTool: async () => ({ content: 'ok' }),
      },
      userPool: { getToolDescriptor: () => undefined },
      killSwitch: ks,
    }) as unknown as ToolServiceDeps;

  it('router blocks killed MCP and killed client, records the hit; others pass', async () => {
    const ks = new KillSwitchManager();
    const deps = mk(ks);
    await ks.set('mcp:github', true, 'a');
    const hit: { err?: KillSwitchError } = {};
    const route = buildInvocationRouter(deps, 'u1', 'c1', undefined, hit);
    await expect(route('gh_search', {})).rejects.toBeInstanceOf(KillSwitchError);
    expect(hit.err).toBeInstanceOf(KillSwitchError);
    await expect(route('sl_post', {})).resolves.toMatchObject({ content: 'ok' });
    await ks.set('client:c1', true, 'a');
    await expect(route('sl_post', {})).rejects.toBeInstanceOf(KillSwitchError);
  });

  it('killed tools/clients are hidden from listPermittedTools', async () => {
    const ks = new KillSwitchManager();
    const deps = mk(ks);
    const session = { client_id: 'c1' } as never;
    expect((await listPermittedTools(deps, session, 'u1')).map(t => t.name)).toEqual([
      'gh_search',
      'sl_post',
    ]);
    await ks.set('mcp:github', true, 'a');
    expect((await listPermittedTools(deps, session, 'u1')).map(t => t.name)).toEqual(['sl_post']);
    await ks.set('client:c1', true, 'a');
    expect(await listPermittedTools(deps, session, 'u1')).toEqual([]);
  });
});

describe('kill switch API (GET + KS-3)', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer();
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });
  const h = () => ({ 'x-admin-key': s.adminKey });

  it('rejects malformed targets with 400', async () => {
    for (const t of ['test-tool', 'tool:x', 'mcp:', 'client:']) {
      const r = await s.api.inject({
        method: 'POST',
        url: `/v1/admin/kill-switch/${encodeURIComponent(t)}`,
        headers: h(),
        payload: { enabled: true },
      });
      expect(r.statusCode, t).toBe(400);
    }
  });

  it('activate → listed (active only) with actor; deactivate → gone; GET needs auth', async () => {
    expect((await s.api.inject({ method: 'GET', url: '/v1/admin/kill-switches' })).statusCode).toBe(
      401
    );
    const on = await s.api.inject({
      method: 'POST',
      url: '/v1/admin/kill-switch/mcp:github',
      headers: h(),
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    const list = await s.api.inject({
      method: 'GET',
      url: '/v1/admin/kill-switches',
      headers: h(),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ target: 'mcp:github', type: 'mcp' });
    expect(body.data[0].activated_by).toMatch(/^admin-key:/);
    expect(typeof body.data[0].activated_at).toBe('string');
    await s.api.inject({
      method: 'POST',
      url: '/v1/admin/kill-switch/mcp:github',
      headers: h(),
      payload: { enabled: false },
    });
    const after = await s.api.inject({
      method: 'GET',
      url: '/v1/admin/kill-switches',
      headers: h(),
    });
    expect(after.json().data).toEqual([]);
  });
});
