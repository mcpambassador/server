/**
 * TD-022 + KS-1/2/3: persisted kill switches, GET list, target validation, router-level enforcement,
 * killed tools hidden from tool lists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, runMigrations, closeDatabase } from '@mcpambassador/core';
import {
  isValidPolicyToolName,
  parseKillSwitchTarget,
  toolKillSwitchTarget,
} from '@mcpambassador/contracts';
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

describe('tool kill switch (ADR-025 M1)', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  // two MCPs expose the same tool name; the catalog stamps each tool with its MCP's catalog id
  const catalog = [
    { name: 'fetch', description: '', inputSchema: {}, source_mcp: 'alpha', mcp_id: A },
    { name: 'fetch', description: '', inputSchema: {}, source_mcp: 'beta', mcp_id: B },
    { name: 'read', description: '', inputSchema: {}, source_mcp: 'alpha', mcp_id: A },
  ];
  let owner = 'alpha';
  const mk = (ks: KillSwitchManager): ToolServiceDeps =>
    ({
      db: {},
      authz: { authorize: async () => ({ decision: 'permit' }) },
      toolRouter: {
        getIsolationAwareToolCatalog: async (
          _db: unknown,
          _u: string,
          _c: string,
          o?: { keepShadowed?: boolean }
        ) =>
          o?.keepShadowed
            ? catalog
            : catalog.filter((t, i) => catalog.findIndex(x => x.name === t.name) === i),
        invokeOnSource: async () => ({ content: 'ok' }),
      },
      mcpManager: {
        // the shared manager serves whichever MCP the test says currently owns the name
        getToolDescriptor: (n: string) => catalog.find(t => t.name === n && t.source_mcp === owner),
        invokeTool: async () => ({ content: 'ok' }),
      },
      userPool: { getToolDescriptor: () => undefined },
      killSwitch: ks,
    }) as unknown as ToolServiceDeps;

  it('kills exactly one (mcp_id, tool): absent from the list, rejected on call; the same name on another MCP and other tools stay', async () => {
    const ks = new KillSwitchManager();
    const deps = mk(ks);
    const session = { client_id: 'c1' } as never;
    await ks.set(toolKillSwitchTarget(A, 'fetch'), true, 'a');
    // list (first-wins catalog): alpha's fetch is gone, the rest remain
    expect(
      (await listPermittedTools(deps, session, 'u1')).map(
        t => `${t.metadata?.mcp_server}/${t.name}`
      )
    ).toEqual(['alpha/read']);
    const hit: { err?: KillSwitchError } = {};
    const route = buildInvocationRouter(deps, 'u1', 'c1', undefined, hit, undefined);
    await expect(route('fetch', {})).rejects.toBeInstanceOf(KillSwitchError);
    expect(hit.err).toBeInstanceOf(KillSwitchError);
    await expect(route('read', {})).resolves.toMatchObject({ content: 'ok' });
    // the same name on the other MCP, addressed explicitly (keepShadowed path), is not affected
    owner = 'beta';
    const routeB = buildInvocationRouter(deps, 'u1', 'c1', undefined, undefined, 'beta');
    await expect(routeB('fetch', {})).resolves.toMatchObject({ content: 'ok' });
    owner = 'alpha';
    await ks.set(toolKillSwitchTarget(A, 'fetch'), false, 'a');
    await expect(route('fetch', {})).resolves.toMatchObject({ content: 'ok' });
  });

  it('is keyed on mcp_id, never the name: a switch built from the MCP name does not match', async () => {
    const ks = new KillSwitchManager();
    const deps = mk(ks);
    await ks.set(toolKillSwitchTarget('alpha', 'read'), true, 'a');
    const session = { client_id: 'c1' } as never;
    expect((await listPermittedTools(deps, session, 'u1')).map(t => t.name)).toContain('read');
  });

  it('persists across a restart with type tool and an odd tool name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-'));
    const dbPath = path.join(dir, 'a.db');
    const name = 'Fetch URL/v2: ünï';
    let db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath });
    await runMigrations(db);
    await new KillSwitchManager(db).set(toolKillSwitchTarget(A, name), true, 'k');
    await closeDatabase(db);
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath });
    const m = new KillSwitchManager(db);
    expect(await m.load()).toBe(1);
    expect(m.isActive('tool', `${A}:${name}`)).toBe(true);
    expect(m.list()[0]).toMatchObject({ type: 'tool', target: `tool:${A}:${name}` });
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('target parser and name validator', () => {
    expect(parseKillSwitchTarget(`tool:${A}:a:b`)).toEqual({
      type: 'tool',
      mcpId: A,
      toolName: 'a:b',
    });
    expect(parseKillSwitchTarget('mcp:github')).toEqual({ type: 'mcp', id: 'github' });
    for (const bad of [
      'tool:x',
      'tool::x',
      `tool:${A}:`,
      'foo:bar',
      'tool',
      `tool:${A}:a\u202Eb`,
      `tool:${A}:a\u200Bb`,
      `tool:${A}:a\u0000b`,
    ]) {
      expect(parseKillSwitchTarget(bad), bad).toBeNull();
    }
    for (const ok of [
      'a',
      'with space',
      'Dots.and-dash_',
      '日本語',
      'a/b',
      'X'.repeat(128),
      '😀'.repeat(128),
    ]) {
      expect(isValidPolicyToolName(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'X'.repeat(129),
      'a\u0007',
      'a\u202Eb',
      'a\u200Db',
      'a\uFEFF',
      '\uD800',
      5,
      undefined,
    ]) {
      expect(isValidPolicyToolName(bad), String(bad)).toBe(false);
    }
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

  it('accepts a tool target (odd name, URL-encoded), lists it as type tool, rejects bidi/NUL names', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const name = 'Fetch URL/v2 ünï';
    const target = `tool:${id}:${name}`;
    const post = (t: string, enabled: boolean) =>
      s.api.inject({
        method: 'POST',
        url: `/v1/admin/kill-switch/${encodeURIComponent(t)}`,
        headers: h(),
        payload: { enabled },
      });
    expect((await post(target, true)).statusCode).toBe(200);
    const list = await s.api.inject({
      method: 'GET',
      url: '/v1/admin/kill-switches',
      headers: h(),
    });
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ target, type: 'tool' })])
    );
    for (const bad of [`tool:${id}:a\u202Eb`, `tool:${id}:a\u200Bb`, `tool:${id}:`, `tool:${id}`]) {
      expect((await post(bad, true)).statusCode, bad).toBe(400);
    }
    expect((await post(target, false)).statusCode).toBe(200);
    const after = await s.api.inject({
      method: 'GET',
      url: '/v1/admin/kill-switches',
      headers: h(),
    });
    expect(after.json().data.find((x: { target: string }) => x.target === target)).toBeUndefined();
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
