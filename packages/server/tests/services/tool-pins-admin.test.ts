import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  closeDatabase,
  createMcpEntry,
  initializeDatabase,
  runMigrations,
  type DatabaseClient,
} from '@mcpambassador/core';
import { registerAdminToolPinRoutes } from '../../src/admin/tool-pin-routes.js';
import { ToolPinService } from '../../src/services/tool-pins/pin-service.js';

const tool = (name: string, description: string): Record<string, unknown> => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
});

describe('admin tool-pin routes (ADR-021)', () => {
  let dir: string;
  let db: DatabaseClient;
  let app: FastifyInstance;
  let pins: ToolPinService;
  let actions: Array<{ action: string; metadata: Record<string, unknown> }>;
  let changed: number;
  let mcpId: string;

  const mkMcp = async (name: string, origin: 'custom' | 'registry'): Promise<string> =>
    (
      await createMcpEntry(db, {
        name,
        display_name: name,
        transport_type: 'stdio',
        isolation_mode: 'shared',
        origin,
      } as never)
    ).mcp_id;

  const pendingPin = async (name = 'search', desc = 'v1') => {
    await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [tool(name, desc)],
      policy: 'review',
    });
    const rec = pins.getPin(mcpId, null, name)!;
    return rec;
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-pinadm-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    const ts = new Date().toISOString();
    for (const u of ['u1', 'u2']) {
      (db as any).session.client
        .prepare(
          `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
        )
        .run(u, u, u, ts, ts);
    }
    actions = [];
    changed = 0;
    pins = new ToolPinService(db, (action, metadata) => actions.push({ action, metadata }));
    await pins.load();
    mcpId = await mkMcp('m1', 'custom');
    app = Fastify();
    const audit = {
      emit: async (e: any) => void actions.push({ action: e.action, metadata: e.metadata }),
    } as any;
    await app.register(registerAdminToolPinRoutes, {
      db,
      audit,
      getPins: () => pins,
      onChanged: () => void changed++,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, payload: payload as never });

  it('/summary is not captured by /:pinId and counts pending', async () => {
    await pendingPin();
    const r = await app.inject({ method: 'GET', url: '/v1/admin/tool-pins/summary' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ pending_count: 1, baseline_unreviewed_count: 0 });
  });

  it('lists with status filter and returns detail with both definitions', async () => {
    const rec = await pendingPin();
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/tool-pins?status=pending_review',
    });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].mcp_name).toBe('m1');
    const none = await app.inject({ method: 'GET', url: '/v1/admin/tool-pins?status=approved' });
    expect(none.json().data).toHaveLength(0);
    const d = await app.inject({ method: 'GET', url: `/v1/admin/tool-pins/${rec.pin_id}` });
    expect(d.json().data.pending_definition.description).toBe('v1');
    expect((await app.inject({ method: 'GET', url: '/v1/admin/tool-pins/nope' })).statusCode).toBe(
      404
    );
  });

  it('approve requires matching expected_hash, then serves and audits hashes only', async () => {
    const rec = await pendingPin();
    const bad = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: 'a'.repeat(64),
    });
    expect(bad.statusCode).toBe(409);
    const ok = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
    });
    expect(ok.statusCode).toBe(200);
    expect(pins.resolveApproved(mcpId, null, 'search')?.hash).toBe(rec.pending_hash);
    expect(changed).toBe(1);
    const a = actions.find(x => x.action === 'tool_pin_approved')!;
    expect(JSON.stringify(a.metadata)).not.toContain('v1');
    // no longer pending
    const again = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
    });
    expect(again.statusCode).toBe(409);
  });

  it('approve is blocked for reserved names', async () => {
    const rec = await pendingPin('ambassador__x');
    const r = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
    });
    expect(r.statusCode).toBe(409);
    expect(pins.resolveApproved(mcpId, null, 'ambassador__x')).toBeUndefined();
  });

  it('apply_to=all_users on a per-user pin writes the NULL-scope baseline', async () => {
    await pins.observe({ mcpId, scopeUserId: 'u1', liveTools: [tool('t', 'x')], policy: 'review' });
    const rec = pins.getPin(mcpId, 'u1', 't')!;
    const r = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
      apply_to: 'all_users',
    });
    expect(r.statusCode).toBe(200);
    expect(pins.getPin(mcpId, null, 't')?.approved_hash).toBe(rec.pending_hash);
    // another user's identical definition needs no review
    const s = await pins.observe({
      mcpId,
      scopeUserId: 'u2',
      liveTools: [tool('t', 'x')],
      policy: 'review',
    });
    expect(s.created).toBe(0);
    expect(pins.resolveApproved(mcpId, 'u2', 't')).toBeDefined();
  });

  it('reject keeps the previous approved definition serving and does not re-raise', async () => {
    const first = await pendingPin('t', 'v1');
    await post(`/v1/admin/tool-pins/${first.pin_id}/approve`, {
      expected_hash: first.pending_hash,
    });
    await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [tool('t', 'v2')],
      policy: 'review',
    });
    const rec = pins.getPin(mcpId, null, 't')!;
    expect(rec.status).toBe('pending_review');
    const r = await post(`/v1/admin/tool-pins/${rec.pin_id}/reject`, {
      expected_hash: rec.pending_hash,
    });
    expect(r.statusCode).toBe(200);
    expect(pins.resolveApproved(mcpId, null, 't')?.definition.description).toBe('v1');
    await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [tool('t', 'v2')],
      policy: 'review',
    });
    expect(pins.getPin(mcpId, null, 't')!.status).toBe('rejected');
  });

  it('auto-holds an MCP after repeated rejections (no new pending recorded)', async () => {
    for (let i = 0; i < 5; i++) {
      const rec = await pendingPin(`t${i}`, 'x');
      await post(`/v1/admin/tool-pins/${rec.pin_id}/reject`, { expected_hash: rec.pending_hash });
    }
    expect(actions.some(a => a.action === 'mcp_auto_held')).toBe(true);
    const s = await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [tool('new', 'x')],
      policy: 'review',
    });
    expect(s.held).toBe(true);
    expect(pins.getPin(mcpId, null, 'new')).toBeUndefined();
    const sum = await app.inject({ method: 'GET', url: '/v1/admin/tool-pins/summary' });
    expect(sum.json().data.held_mcps).toEqual([{ mcp_id: mcpId, scope_user_id: null }]);
  });

  it('confirm-baseline needs a system:migration pin and the exact approved hash', async () => {
    const rec = await pendingPin();
    const notBase = await post(`/v1/admin/tool-pins/${rec.pin_id}/confirm-baseline`, {
      expected_hash: rec.pending_hash,
    });
    expect(notBase.statusCode).toBe(409);
    // make it a baseline pin
    const approved = {
      ...rec,
      status: 'approved' as const,
      approved_hash: rec.pending_hash,
      approved_definition: rec.pending_definition,
      pending_hash: null,
      pending_definition: null,
      approved_by: 'system:migration',
    };
    const { updateToolPin } = await import('@mcpambassador/core');
    await updateToolPin(db, rec.pin_id, approved);
    pins.index(approved);
    const wrong = await post(`/v1/admin/tool-pins/${rec.pin_id}/confirm-baseline`, {
      expected_hash: 'b'.repeat(64),
    });
    expect(wrong.statusCode).toBe(409);
    const ok = await post(`/v1/admin/tool-pins/${rec.pin_id}/confirm-baseline`, {
      expected_hash: approved.approved_hash,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.baseline_unreviewed).toBe(false);
  });

  it('pin-policy: auto only for custom MCPs; audits the change', async () => {
    const reg = await mkMcp('from-registry', 'registry');
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/mcps/${reg}/pin-policy`,
      payload: { pin_policy: 'auto' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/mcps/${mcpId}/pin-policy`,
      payload: { pin_policy: 'auto' },
    });
    expect(ok.statusCode).toBe(200);
    expect(actions.some(a => a.action === 'mcp_pin_policy_changed')).toBe(true);
    const back = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/mcps/${reg}/pin-policy`,
      payload: { pin_policy: 'review' },
    });
    expect(back.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/admin/mcps/nope/pin-policy`,
          payload: { pin_policy: 'review' },
        })
      ).statusCode
    ).toBe(404);
  });
});
