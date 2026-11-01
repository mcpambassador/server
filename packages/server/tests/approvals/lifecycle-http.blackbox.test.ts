/**
 * ADR-023 (3c) PR-1 black-box: lifecycle voids through the REAL HTTP routes of a real server
 * (user delete, client suspend, MCP delete), each audited as approval_voided in the audit file,
 * and no tool argument (CANARY) anywhere in the audit stream. Verifier-owned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AmbassadorServer } from '@mcpambassador/server';
import {
  initializeDatabase,
  closeDatabase,
  runMigrations,
  createAdminKey,
  type DatabaseClient,
} from '@mcpambassador/core';
import { createUser } from '../../src/auth/user-auth.js';
import { makeAdminClient, type AdminClient } from '../admin-api/helpers.js';
import type { ApprovalService } from '../../src/services/approvals/service.js';

const CANARY = 'CANARY-ARG-http-7be2-do-not-leak';
const TS = '2026-11-01T00:00:00.000Z';
const FAR = '2099-01-01T00:00:00.000Z';
const HASH = (n: number): string => String(n).padStart(64, '0');

let tmp: string;
let server: AmbassadorServer;
let admin: AdminClient;
let adminKey: string;
let db: DatabaseClient;
let svc: ApprovalService;
let n = 0;
const raw = (): any => (db as any).session.client;
const row = (id: string): any =>
  raw().prepare('SELECT * FROM approval_requests WHERE approval_id=?').get(id);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-appr-http-'));
  const seedDb = await initializeDatabase({
    type: 'sqlite',
    sqliteFilePath: path.join(tmp, 'ambassador.db'),
    seedOnInit: true,
  });
  await runMigrations(seedDb);
  adminKey = (await createAdminKey(seedDb, tmp)).admin_key;
  await closeDatabase(seedDb);
  server = new AmbassadorServer({ dataDir: tmp, port: 0, host: '127.0.0.1' } as never);
  await server.initialize();
  admin = makeAdminClient(server.getAdminServer());
  db = (server as any).db;
  svc = (server as any).approvals;
  if (!svc) throw new Error('approval service not initialised');
});
afterAll(async () => {
  try {
    await server.stop();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface World {
  userId: string;
  username: string;
  clientId: string;
  grantId: string;
  mcpId: string;
  ids: string[];
}
async function world(): Promise<World> {
  const k = ++n;
  const username = `appr${k}`;
  const u = await createUser(db, { username, password: 'pass1234', display_name: username });
  const clientId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const mcpId = crypto.randomUUID();
  const r = raw();
  r.prepare(
    `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
  ).run(mcpId, mcpId, mcpId, 'stdio', TS, TS);
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(clientId, clientId, 'p', `h${k}`, u.user_id, 'active', TS);
  r.prepare(
    `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(grantId, u.user_id, clientId, grantId, '["tools"]', 'https://x/mcp', TS, FAR);
  const ids: string[] = [];
  for (const [i, approve] of [
    [1, false],
    [2, true],
  ] as const) {
    const res = await svc.createOrFind({
      grantId,
      boundClientId: clientId,
      userId: u.user_id,
      mcpId,
      toolName: 'create_issue',
      argsHash: HASH(i),
      pinHash: 'pin',
      required: 'owner',
      preview: `{"title":"${CANARY}"}`,
      via: 'mcp',
      disclosureMode: 'full',
      grantExpiresAt: FAR,
    });
    if (res.kind !== 'created') throw new Error(`create ${res.kind}`);
    ids.push(res.request.approval_id);
    if (approve) {
      const d = await svc.decide({
        approvalId: res.request.approval_id,
        decision: 'approve',
        expectedArgsHash: HASH(i),
        actorUserId: u.user_id,
        actorRole: 'owner',
        grantExpiresAt: FAR,
      });
      if (d.kind !== 'ok') throw new Error(`decide ${d.kind}`);
    }
  }
  return { userId: u.user_id, username, clientId, grantId, mcpId, ids };
}
const expectVoidedClean = (w: World, reason?: string): void => {
  for (const id of w.ids) {
    const r = row(id);
    expect(r?.status).toBe('voided');
    expect(r.preview).toBeNull();
    if (reason) expect(r.void_reason).toBe(reason);
  }
};

describe('lifecycle voids through real routes', () => {
  it("DELETE /v1/admin/users/:id voids the user's open requests", async () => {
    const w = await world();
    const res = await admin.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${w.userId}`,
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.statusCode).toBeLessThan(300);
    expectVoidedClean(w, 'user_disabled');
  });

  it("PATCH /v1/admin/users/:id status=suspended voids the user's open requests", async () => {
    const w = await world();
    const res = await admin.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${w.userId}`,
      headers: { 'X-Admin-Key': adminKey },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    expectVoidedClean(w, 'user_disabled');
  });

  it('PATCH /v1/users/me/clients/:id status=suspended voids requests bound to that client', async () => {
    const w = await world();
    const login = await admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: w.username, password: 'pass1234' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    const res = await admin.inject({
      method: 'PATCH',
      url: `/v1/users/me/clients/${w.clientId}`,
      headers: { cookie },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    expectVoidedClean(w, 'client_suspended');
  });

  it('DELETE /v1/admin/mcps/:id voids requests for that MCP before the cascade', async () => {
    const w = await world();
    const res = await admin.inject({
      method: 'DELETE',
      url: `/v1/admin/mcps/${w.mcpId}`,
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.statusCode).toBeLessThan(300);
    for (const id of w.ids) {
      const r = row(id);
      if (r) expect(r.status).toBe('voided'); // cascade may already have removed it
    }
  });

  it('every voided request has an approval_voided audit line and no argument reaches the audit file', async () => {
    await server.stop(); // flushes the audit buffer
    const auditDir = path.join(tmp, 'audit');
    const lines = fs
      .readdirSync(auditDir)
      .flatMap(f => fs.readFileSync(path.join(auditDir, f), 'utf8').split('\n'))
      .filter(Boolean);
    const voided = lines.filter(l => l.includes('"approval_voided"'));
    // 4 worlds x 2 requests each
    expect(voided.length).toBe(8);
    const approvalLines = lines.filter(l => /"approval_/.test(l));
    expect(approvalLines.length).toBeGreaterThanOrEqual(8 + 8); // requested x8 + voided x8 (+ approved x4)
    expect(lines.join('\n')).not.toContain(CANARY);
    expect(lines.join('\n')).not.toContain('"title"');
    for (const l of voided) {
      const ev = JSON.parse(l) as { metadata?: Record<string, unknown> };
      expect(Object.keys(ev.metadata ?? {}).sort()).toEqual(
        ['approval_id', 'args_hash', 'grant_id', 'mcp_id', 'reason', 'tool_name'].sort()
      );
    }
  });
});
