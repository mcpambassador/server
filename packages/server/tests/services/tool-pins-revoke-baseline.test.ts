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
import { ToolPinBaseline } from '../../src/services/tool-pins/baseline.js';

const t = (name: string, description: string): Record<string, unknown> => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
});

describe('ADR-021 D7 revoke, D6 frozen baseline, S3 (gate review)', () => {
  let dir: string;
  let db: DatabaseClient;
  let pins: ToolPinService;
  let audits: Array<{ action: string; meta: Record<string, unknown> }>;
  let raw: any;

  const mk = async (name: string, snapshot: unknown[] = []): Promise<string> => {
    const e = await createMcpEntry(db, {
      name,
      display_name: name,
      transport_type: 'stdio',
      isolation_mode: 'per_user',
    } as never);
    raw
      .prepare(`UPDATE mcp_catalog SET tool_catalog = ? WHERE mcp_id = ?`)
      .run(JSON.stringify(snapshot), e.mcp_id);
    return e.mcp_id;
  };
  const mkUser = (u: string): void => {
    const ts = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
      )
      .run(u, u, u, ts, ts);
  };
  const addCred = (u: string, mcpId: string): void => {
    const ts = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO user_mcp_credentials (credential_id, user_id, mcp_id, encrypted_credentials, encryption_iv, credential_type, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(`c-${u}-${mcpId}`, u, mcpId, 'x', 'y', 'static', ts, ts);
  };
  const approvedShared = async (mcpId: string, tool = t('a', 'A')) => {
    await pins.observe({ mcpId, scopeUserId: null, liveTools: [tool], policy: 'auto' });
    return pins.getPin(mcpId, null, tool.name as string)!;
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-rvk-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    raw = (db as any).session.client;
    for (const u of ['u1', 'u2', 'u3']) mkUser(u);
    audits = [];
    pins = new ToolPinService(db, (action, meta) => audits.push({ action, meta }));
    await pins.load();
  });
  afterEach(async () => {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('G1 revoke', () => {
    it('hides the tool at once, records the old hash as rejected, does not re-raise it, and a new hash goes pending', async () => {
      const id = await mk('m');
      const pin = await approvedShared(id);
      const old = pin.approved_hash!;
      expect(pins.resolveApproved(id, null, 'a')).toBeDefined();

      const r = await pins.revoke(pin.pin_id, { expectedHash: old, actor: 'admin:key1' });
      expect(r.ok).toBe(true);
      const after = pins.getPin(id, null, 'a')!;
      expect(after).toMatchObject({
        status: 'rejected',
        approved_hash: null,
        approved_definition: null,
        rejected_hash: old,
      });
      expect(pins.resolveApproved(id, null, 'a')).toBeUndefined();
      const ev = audits.find(a => a.action === 'tool_pin_revoked')!;
      expect(ev.meta).toMatchObject({ actor: 'admin:key1', revoked_hash: old });
      expect(JSON.stringify(ev.meta)).not.toContain('"A"');

      // same definition again: stays hidden, not pending, even under auto
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A')],
        policy: 'auto',
      });
      expect(pins.getPin(id, null, 'a')!.status).toBe('rejected');
      expect(pins.resolveApproved(id, null, 'a')).toBeUndefined();
      // a different definition goes pending
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A2')],
        policy: 'auto',
      });
      expect(pins.getPin(id, null, 'a')!.status).toBe('pending_review');
      expect(pins.resolveApproved(id, null, 'a')).toBeUndefined();
    });

    it('stale hash and unapproved pins are refused', async () => {
      const id = await mk('m');
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A')],
        policy: 'review',
      });
      const pending = pins.getPin(id, null, 'a')!;
      expect(
        await pins.revoke(pending.pin_id, { expectedHash: 'a'.repeat(64), actor: 'x' })
      ).toMatchObject({
        ok: false,
        code: 'not_approved',
      });
      const ok = await approvedShared(await mk('m2'));
      expect(
        await pins.revoke(ok.pin_id, { expectedHash: 'b'.repeat(64), actor: 'x' })
      ).toMatchObject({
        ok: false,
        code: 'stale',
      });
      expect(await pins.revoke('nope', { expectedHash: 'b'.repeat(64), actor: 'x' })).toMatchObject(
        {
          ok: false,
          code: 'not_found',
        }
      );
    });

    it('revoking the NULL-scope pin hides the tool for per-user scopes that relied on it', async () => {
      const id = await mk('m');
      const pin = await approvedShared(id);
      await pins.observe({
        mcpId: id,
        scopeUserId: 'u1',
        liveTools: [t('a', 'A')],
        policy: 'review',
      });
      expect(pins.resolveApproved(id, 'u1', 'a')).toBeDefined(); // via the shared pin
      await pins.revoke(pin.pin_id, { expectedHash: pin.approved_hash!, actor: 'x' });
      expect(pins.resolveApproved(id, 'u1', 'a')).toBeUndefined();
    });

    it('a revoked hash is never auto-approved for a new per-user scope', async () => {
      const id = await mk('m');
      const pin = await approvedShared(id);
      await pins.revoke(pin.pin_id, { expectedHash: pin.approved_hash!, actor: 'x' });
      await pins.observe({
        mcpId: id,
        scopeUserId: 'u2',
        liveTools: [t('a', 'A')],
        policy: 'auto',
      });
      expect(pins.getPin(id, 'u2', 'a')!.status).toBe('pending_review');
      expect(pins.resolveApproved(id, 'u2', 'a')).toBeUndefined();
    });

    it('revoked baseline pin no longer counts as baseline_unreviewed', async () => {
      const id = await mk('m', [t('a', 'A')]);
      const b = new ToolPinBaseline(db, pins);
      await b.init();
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A')],
        policy: 'review',
        baseline: await b.baselineFor(id, null),
      });
      const pin = pins.getPin(id, null, 'a')!;
      expect(pins.queueSummary().baseline_unreviewed_count).toBe(1);
      await pins.revoke(pin.pin_id, { expectedHash: pin.approved_hash!, actor: 'x' });
      expect(pins.queueSummary().baseline_unreviewed_count).toBe(0);
    });
  });

  describe('revokes and the auto-hold', () => {
    it('5 revokes do not auto-hold the MCP; 5 rejections of pending items do', async () => {
      const id = await mk('m');
      for (let i = 0; i < 5; i++) {
        const pin = await approvedShared(id, t(`r${i}`, 'A'));
        await pins.revoke(pin.pin_id, { expectedHash: pin.approved_hash!, actor: 'x' });
      }
      expect(pins.isMcpAutoHeld(id)).toBe(false);
      const id2 = await mk('m2');
      for (let i = 0; i < 5; i++) {
        await pins.observe({
          mcpId: id2,
          scopeUserId: null,
          liveTools: [t(`p${i}`, 'A')],
          policy: 'review',
        });
        const p = pins.getPin(id2, null, `p${i}`)!;
        await pins.reject(p.pin_id, { expectedHash: p.pending_hash!, actor: 'x' });
      }
      expect(pins.isMcpAutoHeld(id2)).toBe(true);
    });

    it('a pending item raised after a revoke and then rejected counts as a rejection', async () => {
      const id = await mk('m');
      const pin = await approvedShared(id);
      await pins.revoke(pin.pin_id, { expectedHash: pin.approved_hash!, actor: 'x' });
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A2')],
        policy: 'review',
      });
      const p = pins.getPin(id, null, 'a')!;
      await pins.reject(p.pin_id, { expectedHash: p.pending_hash!, actor: 'x' });
      expect(pins.recentRejections(id)).toBe(1);
    });
  });

  describe('G2 frozen baseline', () => {
    it('a user who appears after arming takes the normal review path; one present at arming is baselined', async () => {
      const id = await mk('m', [t('a', 'A')]);
      addCred('u1', id);
      const b = new ToolPinBaseline(db, pins);
      await b.init();
      addCred('u2', id); // after arming
      expect(await b.baselineFor(id, 'u1')).toBeInstanceOf(Map);
      expect(await b.baselineFor(id, 'u2')).toBeUndefined();
      expect(await b.baselineFor(id, null)).toBeInstanceOf(Map);
      // survives a restart
      const b2 = new ToolPinBaseline(db, pins);
      await b2.init();
      expect(await b2.baselineFor(id, 'u1')).toBeInstanceOf(Map);
      expect(await b2.baselineFor(id, 'u2')).toBeUndefined();
    });

    it('a snapshot rewritten after arming (admin discover) does not widen the baseline', async () => {
      const id = await mk('m', [t('a', 'A')]);
      const b = new ToolPinBaseline(db, pins);
      await b.init();
      raw
        .prepare(`UPDATE mcp_catalog SET tool_catalog = ? WHERE mcp_id = ?`)
        .run(JSON.stringify([t('a', 'A'), t('evil', 'EVIL')]), id);
      const b2 = new ToolPinBaseline(db, pins); // restart
      await b2.init();
      const map = (await b2.baselineFor(id, null))!;
      expect([...map.keys()]).toEqual(['a']);
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A'), t('evil', 'EVIL')],
        policy: 'review',
        baseline: map,
      });
      expect(pins.getPin(id, null, 'a')!.approved_by).toBe('system:migration');
      expect(pins.getPin(id, null, 'evil')!.status).toBe('pending_review');
    });

    it('a hash rejected in any scope is never baseline-approved', async () => {
      const id = await mk('m', [t('a', 'A')]);
      addCred('u1', id);
      const b = new ToolPinBaseline(db, pins);
      await b.init();
      // u1 observed first without a baseline (e.g. held/skipped), rejected by an admin
      await pins.observe({
        mcpId: id,
        scopeUserId: 'u1',
        liveTools: [t('a', 'A')],
        policy: 'review',
      });
      const u1pin = pins.getPin(id, 'u1', 'a')!;
      await pins.reject(u1pin.pin_id, { expectedHash: u1pin.pending_hash!, actor: 'x' });
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'A')],
        policy: 'review',
        baseline: await b.baselineFor(id, null),
      });
      const shared = pins.getPin(id, null, 'a')!;
      expect(shared.status).toBe('pending_review');
      expect(shared.approved_by).toBeNull();
    });

    it('an unreadable or missing frozen baseline disables it (fail closed)', async () => {
      const id = await mk('m', [t('a', 'A')]);
      const b = new ToolPinBaseline(db, pins);
      await b.init();
      raw.prepare(`DELETE FROM server_settings WHERE key = 'tool_pin_baseline_map'`).run();
      const b2 = new ToolPinBaseline(db, pins);
      await b2.init();
      expect(await b2.baselineFor(id, null)).toBeUndefined();
    });
  });

  describe('S3 apply_to all_users', () => {
    it('refuses with baseline_conflict when the NULL-scope pin has a different pending item, and audits', async () => {
      const id = await mk('m');
      await pins.observe({
        mcpId: id,
        scopeUserId: null,
        liveTools: [t('a', 'SHARED NEW')],
        policy: 'review',
      });
      const shared = pins.getPin(id, null, 'a')!;
      await pins.observe({
        mcpId: id,
        scopeUserId: 'u1',
        liveTools: [t('a', 'USER')],
        policy: 'review',
      });
      const user = pins.getPin(id, 'u1', 'a')!;
      const r = await pins.approve(user.pin_id, {
        expectedHash: user.pending_hash!,
        applyTo: 'all_users',
        actor: 'admin:k',
      });
      expect(r).toMatchObject({ ok: false, code: 'baseline_conflict' });
      // nothing changed
      expect(pins.getPin(id, 'u1', 'a')!.status).toBe('pending_review');
      expect(pins.getPin(id, null, 'a')!.pending_hash).toBe(shared.pending_hash);
      expect(audits.find(a => a.action === 'tool_pin_baseline_conflict')!.meta).toMatchObject({
        actor: 'admin:k',
      });
    });
  });

  describe('revoke route', () => {
    let app: FastifyInstance;
    beforeEach(async () => {
      app = Fastify();
      const audit = { emit: async () => undefined } as any;
      await app.register(registerAdminToolPinRoutes, { db, audit, getPins: () => pins });
      await app.ready();
    });
    afterEach(async () => {
      await app.close();
    });

    it('POST /revoke: 200 on match, 409 on stale/not approved, 404 unknown', async () => {
      const id = await mk('m');
      const pin = await approvedShared(id);
      const url = `/v1/admin/tool-pins/${pin.pin_id}/revoke`;
      const bad = await app.inject({
        method: 'POST',
        url,
        payload: { expected_hash: 'a'.repeat(64) },
      });
      expect(bad.statusCode).toBe(409);
      const ok = await app.inject({
        method: 'POST',
        url,
        payload: { expected_hash: pin.approved_hash },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.status).toBe('rejected');
      const again = await app.inject({
        method: 'POST',
        url,
        payload: { expected_hash: pin.approved_hash },
      });
      expect(again.statusCode).toBe(409);
      const nf = await app.inject({
        method: 'POST',
        url: '/v1/admin/tool-pins/nope/revoke',
        payload: { expected_hash: 'a'.repeat(64) },
      });
      expect(nf.statusCode).toBe(404);
    });
  });
});
