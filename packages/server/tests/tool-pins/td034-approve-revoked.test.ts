/**
 * TD-034: approving a pending definition whose exact hash was revoked earlier needs `force: true`.
 */
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
  updateToolPin,
  type DatabaseClient,
} from '@mcpambassador/core';
import { registerAdminToolPinRoutes } from '../../src/admin/tool-pin-routes.js';
import { ToolPinService } from '../../src/services/tool-pins/pin-service.js';

describe('approve of a previously revoked hash (TD-034)', () => {
  let dir: string;
  let db: DatabaseClient;
  let app: FastifyInstance;
  let pins: ToolPinService;
  let actions: Array<{ action: string; metadata: Record<string, unknown> }>;
  let mcpId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-td034-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    actions = [];
    pins = new ToolPinService(db, (action, metadata) => actions.push({ action, metadata }));
    await pins.load();
    mcpId = (
      await createMcpEntry(db, {
        name: 'm1',
        display_name: 'm1',
        transport_type: 'stdio',
        isolation_mode: 'shared',
        origin: 'custom',
      } as never)
    ).mcp_id;
    app = Fastify();
    const audit = {
      emit: async (e: any) => void actions.push({ action: e.action, metadata: e.metadata }),
    } as any;
    await app.register(registerAdminToolPinRoutes, { db, audit, getPins: () => pins });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, payload: payload as never });

  /** A pending pin whose pending hash is already in revoked_hashes. */
  const revokedPending = async () => {
    await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [{ name: 'search', description: 'v1', inputSchema: { type: 'object' } }],
      policy: 'review',
    });
    const rec = pins.getPin(mcpId, null, 'search')!;
    const patch = { revoked_hashes: JSON.stringify([rec.pending_hash]) };
    await updateToolPin(db, rec.pin_id, patch);
    pins.index({ ...rec, ...patch });
    return rec;
  };

  it('answers 409 previously_revoked without force and changes nothing', async () => {
    const rec = await revokedPending();
    const r = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details[0]).toMatchObject({ code: 'previously_revoked' });
    expect(pins.getPin(mcpId, null, 'search')?.status).toBe('pending_review');
    expect(pins.resolveApproved(mcpId, null, 'search')).toBeUndefined();
    expect(actions.some(a => a.action === 'tool_pin_approved')).toBe(false);
  });

  it('force: true approves and the audit event records the forced approval', async () => {
    const rec = await revokedPending();
    const r = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
      force: true,
    });
    expect(r.statusCode).toBe(200);
    expect(pins.resolveApproved(mcpId, null, 'search')?.hash).toBe(rec.pending_hash);
    const a = actions.find(x => x.action === 'tool_pin_approved')!;
    expect(a.metadata).toMatchObject({ forced_previously_revoked: true });
    expect(JSON.stringify(a.metadata)).not.toContain('v1');
  });

  it('an ordinary pending pin needs no force and is not flagged', async () => {
    await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [{ name: 'other', description: 'v1', inputSchema: { type: 'object' } }],
      policy: 'review',
    });
    const rec = pins.getPin(mcpId, null, 'other')!;
    const d = await app.inject({ method: 'GET', url: `/v1/admin/tool-pins/${rec.pin_id}` });
    expect(d.json().data.previously_revoked_at).toBeNull();
    const r = await post(`/v1/admin/tool-pins/${rec.pin_id}/approve`, {
      expected_hash: rec.pending_hash,
    });
    expect(r.statusCode).toBe(200);
    const a = actions.find(x => x.action === 'tool_pin_approved')!;
    expect(a.metadata).not.toHaveProperty('forced_previously_revoked');
  });

  it('the detail carries previously_revoked_at for a revoked pending hash', async () => {
    const rec = await revokedPending();
    const d = await app.inject({ method: 'GET', url: `/v1/admin/tool-pins/${rec.pin_id}` });
    expect(typeof d.json().data.previously_revoked_at).toBe('string');
  });
});
