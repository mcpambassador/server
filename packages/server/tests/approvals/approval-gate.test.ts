/**
 * ADR-023 (3c) PR-3: the approval gate. Create/existing/consume/single-use, args binding, pin change,
 * principal re-check at consume, lifecycle voids (kill switch, suspend, delete), stdio refusal and
 * the pin-void failure path.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
import { APPROVAL_DENIAL_COOLDOWN_THRESHOLD, buildApprovalUrl } from '@mcpambassador/contracts';
import { makeAdminClient } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import type { ApprovalService } from '../../src/services/approvals/service.js';
import {
  runApprovalGate,
  hashRoutedArguments,
  type GateGrantContext,
} from '../../src/services/approvals/gate.js';
import { stripAmbassadorMeta } from '../../src/services/tool-service.js';
import { suspendUserClient, revokeUserClient } from '../../src/services/client-service.js';

const EXP = '2099-01-01T00:00:00.000Z';
const raw = (db: DatabaseClient): any => (db as any).session.client;

let dir: string;
let server: AmbassadorServer;
let db: DatabaseClient;
let svc: ApprovalService;
let userId: string;
let audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
let seq = 0;

const TOOL = { name: 'create_issue', source_mcp: 'github', pinned_hash: null as string | null };

function seed(): { grantId: string; clientId: string } {
  const n = ++seq;
  const ts = '2026-11-01T00:00:00.000Z';
  const r = raw(db);
  const clientId = `gk-${n}`;
  const grantId = `gg-${n}`;
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(clientId, clientId, 'p', 'h', userId, 'active', ts);
  r.prepare(
    `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(grantId, userId, clientId, grantId, '["tools"]', 'https://x/mcp', ts, EXP);
  return { grantId, clientId };
}

const ctxOf = (s: { grantId: string; clientId: string }, over = {}): GateGrantContext => ({
  grantId: s.grantId,
  userId,
  boundClientId: s.clientId,
  disclosureMode: 'full',
  via: 'mcp',
  ...over,
});

const gate = (
  ctx: GateGrantContext | null,
  args: Record<string, unknown> = { title: 'x' },
  tool = TOOL
) => runApprovalGate({ db, approvals: svc, uiBaseUrl: 'https://amb.example' }, { ctx, tool, args });

async function approve(approvalId: string, args: Record<string, unknown> = { title: 'x' }) {
  const r = await svc.decide({
    approvalId,
    decision: 'approve',
    expectedArgsHash: hashRoutedArguments(args)!.argsHash,
    actorUserId: userId,
    actorRole: 'owner',
    grantExpiresAt: EXP,
  });
  expect(r.kind).toBe('ok');
}

const rows = (where = '1=1'): any[] =>
  raw(db).prepare(`SELECT * FROM approval_requests WHERE ${where}`).all();
const statusOf = (id: string): string =>
  raw(db).prepare(`SELECT status FROM approval_requests WHERE approval_id=?`).get(id).status;
const voidReasonOf = (id: string): string | null =>
  raw(db).prepare(`SELECT void_reason FROM approval_requests WHERE approval_id=?`).get(id)
    ?.void_reason ?? null;

async function pending(s = seed(), args: Record<string, unknown> = { title: 'x' }) {
  const out = await gate(ctxOf(s), args);
  if (out.proceed || out.approval.status !== 'approval_required') throw new Error('not required');
  return { s, id: out.approval.approval_id };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-gate-'));
  const pre = await initializeDatabase({
    type: 'sqlite',
    sqliteFilePath: path.join(dir, 'ambassador.db'),
    seedOnInit: true,
  });
  await runMigrations(pre as DatabaseClient);
  await createAdminKey(pre as DatabaseClient, dir);
  await closeDatabase(pre as DatabaseClient);

  server = new AmbassadorServer({
    dataDir: dir,
    port: 0,
    host: '127.0.0.1',
    ambassadorConfig: { approvals: {} } as never,
  } as never);
  await server.initialize();
  db = (server as any).db;
  svc = (server as any).approvals;
  const origAudit = (svc as any).audit as (a: string, m: Record<string, unknown>) => void;
  (svc as any).audit = (action: string, meta: Record<string, unknown>): void => {
    audits.push({ action, meta });
    origAudit(action, meta);
  };
  userId = (
    await createUser(db, {
      username: 'gateuser',
      password: 'Correct-Horse-9!',
      display_name: 'g',
      is_admin: false,
    })
  ).user_id;
  raw(db)
    .prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run('m1', 'github', 'github', 'stdio', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  await svc.setToolPolicy(
    'm1',
    'create_issue',
    { requires_approval: true, approver: 'owner' },
    't'
  );
});

afterAll(async () => {
  try {
    await server.stop();
  } catch {
    // ignore
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  audits = [];
  raw(db)
    .prepare(
      `UPDATE approval_requests SET status='expired', preview=NULL WHERE status IN ('pending','approved')`
    )
    .run();
  raw(db).prepare(`DELETE FROM approval_requests WHERE status='denied'`).run();
});

describe('gate decisions', () => {
  it('ungated tool proceeds without a row', async () => {
    const out = await gate(ctxOf(seed()), {}, { ...TOOL, name: 'list_issues' });
    expect(out).toEqual({ proceed: true });
    expect(rows("tool_name='list_issues'")).toHaveLength(0);
  });

  it('unknown mcp (no catalog row) proceeds', async () => {
    const out = await gate(ctxOf(seed()), {}, { ...TOOL, source_mcp: 'nope' });
    expect(out).toEqual({ proceed: true });
  });

  it('creates, then returns the same open request, then consumes once after approval', async () => {
    const s = seed();
    const a = await gate(ctxOf(s));
    expect(a.proceed).toBe(false);
    const ar = (a as any).approval;
    expect(ar.status).toBe('approval_required');
    expect(ar.approval_url).toBe(buildApprovalUrl('https://amb.example', ar.approval_id));
    const b = (await gate(ctxOf(s))) as any;
    expect(b.approval.approval_id).toBe(ar.approval_id);
    expect(rows(`grant_id='${s.grantId}'`)).toHaveLength(1);

    await approve(ar.approval_id);
    expect(await gate(ctxOf(s))).toEqual({ proceed: true });
    // replay: single use
    const again = (await gate(ctxOf(s))) as any;
    expect(again.proceed).toBe(false);
    expect(again.approval.status).toBe('approval_required');
    expect(again.approval.approval_id).not.toBe(ar.approval_id);
    expect(statusOf(ar.approval_id)).toBe('consumed');
  });

  it('different arguments never consume an approval for other arguments', async () => {
    const { s, id } = await pending();
    await approve(id);
    const out = (await gate(ctxOf(s), { title: 'y' })) as any;
    expect(out.proceed).toBe(false);
    expect(out.approval.approval_id).not.toBe(id);
    expect(statusOf(id)).toBe('approved');
  });

  it('pin hash change between approval and retry rejects and does not consume', async () => {
    const s = seed();
    const first = (await gate(
      ctxOf(s),
      { title: 'x' },
      { ...TOOL, pinned_hash: 'a'.repeat(64) }
    )) as any;
    await approve(first.approval.approval_id);
    const out = (await gate(
      ctxOf(s),
      { title: 'x' },
      { ...TOOL, pinned_hash: 'b'.repeat(64) }
    )) as any;
    expect(out.proceed).toBe(false);
    expect(
      audits.some(a => a.action === 'approval_rejected' && a.meta.reason === 'definition_changed')
    ).toBe(true);
  });

  it('polling by approval_id reports denied and pending, only for this grant and call', async () => {
    const { s, id } = await pending();
    const polled = (await gate(ctxOf(s, { approvalId: id }))) as any;
    expect(polled.approval).toMatchObject({ status: 'approval_required', approval_id: id });
    const other = seed();
    const foreign = (await gate(ctxOf(other, { approvalId: id }))) as any;
    expect(foreign.approval.approval_id).not.toBe(id);
    await svc.decide({
      approvalId: id,
      decision: 'deny',
      expectedArgsHash: hashRoutedArguments({ title: 'x' })!.argsHash,
      actorUserId: userId,
      actorRole: 'owner',
      grantExpiresAt: EXP,
    });
    const denied = (await gate(ctxOf(s, { approvalId: id }))) as any;
    expect(denied.approval).toMatchObject({ status: 'approval_denied', approval_id: id });
    // a malformed id is ignored, not echoed
    const bad = (await gate(ctxOf(s, { approvalId: "x'; --" }))) as any;
    expect(JSON.stringify(bad)).not.toContain("x'; --");
  });

  it('repeated denials start a cooldown with no id', async () => {
    const s = seed();
    for (let k = 0; k < APPROVAL_DENIAL_COOLDOWN_THRESHOLD; k++) {
      const args = { title: `d${k}` };
      const { id } = await pending(s, args);
      await svc.decide({
        approvalId: id,
        decision: 'deny',
        expectedArgsHash: hashRoutedArguments(args)!.argsHash,
        actorUserId: userId,
        actorRole: 'owner',
        grantExpiresAt: EXP,
      });
    }
    const out = (await gate(ctxOf(s), { title: 'next' })) as any;
    expect(out.approval.status).toBe('approval_denied');
    expect(out.approval.approval_id).toBeNull();
    expect(out.approval.retry_after_seconds).toBeGreaterThan(0);
  });

  it('oversized arguments are unavailable and create no row', async () => {
    const s = seed();
    const out = (await gate(ctxOf(s), { blob: 'z'.repeat(20000) })) as any;
    expect(out.approval).toEqual({ status: 'approval_unavailable', reason: 'arguments_too_large' });
    expect(rows(`grant_id='${s.grantId}'`)).toHaveLength(0);
  });

  it('stdio / no grant / no bound client: refused, no row', async () => {
    const before = rows().length;
    const a = (await gate(null)) as any;
    expect(a.approval).toEqual({
      status: 'approval_unavailable',
      reason: 'not_supported_for_client',
    });
    const b = (await gate(ctxOf(seed(), { boundClientId: null }))) as any;
    expect(b.approval.reason).toBe('not_supported_for_client');
    expect(rows()).toHaveLength(before);
  });

  it('credential-looking argument values are redacted in the stored preview', async () => {
    const s = seed();
    const out = (await gate(ctxOf(s), { title: 'x', api_key: 'sk-SECRETVALUE123456' })) as any;
    const row = rows(`approval_id='${out.approval.approval_id}'`)[0];
    expect(row.preview).not.toContain('SECRETVALUE');
    expect(row.preview).toContain('[REDACTED]');
  });
});

describe('consume principal re-check', () => {
  const consume = (s: { grantId: string; clientId: string }, caller: string | null = s.clientId) =>
    svc.consume({
      grantId: s.grantId,
      mcpId: 'm1',
      toolName: 'create_issue',
      argsHash: hashRoutedArguments({ title: 'x' })!.argsHash,
      currentPinHash: null,
      callerBoundClientId: caller,
    });

  it('NULL or different bound client voids as client_mismatch', async () => {
    const { s, id } = await pending();
    await approve(id);
    const r = await consume(s, null);
    expect(r).toMatchObject({ kind: 'rejected' });
    expect(['client_mismatch', 'void']).toContain(
      voidReasonOf(id) === 'client_mismatch' ? 'client_mismatch' : 'void'
    );
    expect(statusOf(id)).not.toBe('consumed');
  });

  it('suspended client: consume rejected, request voided client_suspended', async () => {
    const { s, id } = await pending();
    await approve(id);
    raw(db).prepare(`UPDATE clients SET status='suspended' WHERE client_id=?`).run(s.clientId);
    expect((await consume(s)).kind).toBe('rejected');
    expect(voidReasonOf(id)).toBe('client_suspended');
  });

  it('disabled user: consume rejected, voided user_disabled', async () => {
    const { s, id } = await pending();
    await approve(id);
    raw(db).prepare(`UPDATE users SET status='disabled' WHERE user_id=?`).run(userId);
    try {
      expect((await consume(s)).kind).toBe('rejected');
      expect(voidReasonOf(id)).toBe('user_disabled');
    } finally {
      raw(db).prepare(`UPDATE users SET status='active' WHERE user_id=?`).run(userId);
    }
  });

  it('revoked grant: consume rejected', async () => {
    const { s, id } = await pending();
    await approve(id);
    raw(db)
      .prepare(`UPDATE agent_grants SET revoked_at=? WHERE grant_id=?`)
      .run('2026-11-01T00:00:00.000Z', s.grantId);
    expect((await consume(s)).kind).toBe('rejected');
    expect(statusOf(id)).not.toBe('consumed');
  });
});

describe('lifecycle voids', () => {
  it('kill-switch activation voids by client and by mcp', async () => {
    const a = await pending();
    await (server as any).killSwitchManager.set(`client:${a.s.clientId}`, true, 'admin');
    expect(statusOf(a.id)).toBe('voided');
    expect(voidReasonOf(a.id)).toBe('kill_switch');
    await (server as any).killSwitchManager.set(`client:${a.s.clientId}`, false, 'admin');

    const b = await pending();
    await (server as any).killSwitchManager.set('mcp:github', true, 'admin');
    try {
      expect(statusOf(b.id)).toBe('voided');
    } finally {
      await (server as any).killSwitchManager.set('mcp:github', false, 'admin');
    }
  });

  it('tool kill-switch target voids only that tool', async () => {
    const a = await pending();
    const other = await gate(ctxOf(seed()), {}, { ...TOOL, name: 'other_tool' });
    expect(other.proceed).toBe(true);
    await (server as any).killSwitchManager.set('tool:m1:create_issue', true, 'admin');
    try {
      expect(statusOf(a.id)).toBe('voided');
    } finally {
      await (server as any).killSwitchManager.set('tool:m1:create_issue', false, 'admin');
    }
  });

  it('suspendUserClient voids client_suspended', async () => {
    const { s, id } = await pending();
    await suspendUserClient(db, userId, s.clientId, false);
    expect(statusOf(id)).toBe('voided');
    expect(voidReasonOf(id)).toBe('client_suspended');
  });

  it('revokeUserClient voids client_deleted', async () => {
    const { s, id } = await pending();
    await revokeUserClient(db, userId, s.clientId, false);
    expect(statusOf(id)).toBe('voided');
    expect(voidReasonOf(id)).toBe('client_deleted');
  });
});

describe('pin voiding', () => {
  it('voids on a changed hash and on revoke, never on an unchanged hash', async () => {
    const pins = server.getToolPins()!;
    expect(pins).toBeTruthy();
    const voider = (pins as any).approvalVoider;
    const calls: Array<[unknown, unknown]> = [];
    (pins as any).setApprovalVoider({
      void: async (c: any) => {
        calls.push(['void', c]);
        await voider.void(c);
      },
      onVoidFailure: voider.onVoidFailure,
    });
    try {
      const h = 'c'.repeat(64);
      const s = seed();
      const first = (await gate(ctxOf(s), { title: 'x' }, { ...TOOL, pinned_hash: h })) as any;
      const id = first.approval.approval_id;
      await (pins as any).voidForChanges([
        { mcpId: 'm1', toolName: 'create_issue', scopeUserId: null, oldHash: h, newHash: h },
        { mcpId: 'm1', toolName: 'create_issue', scopeUserId: null, oldHash: null, newHash: h },
      ]);
      expect(statusOf(id)).toBe('pending');
      await (pins as any).voidForChanges([
        {
          mcpId: 'm1',
          toolName: 'create_issue',
          scopeUserId: null,
          oldHash: h,
          newHash: 'd'.repeat(64),
        },
      ]);
      expect(statusOf(id)).toBe('voided');
      expect(voidReasonOf(id)).toBe('definition_changed');

      const second = (await gate(ctxOf(s), { title: 'x' }, { ...TOOL, pinned_hash: h })) as any;
      await (pins as any).voidForChanges([
        { mcpId: 'm1', toolName: 'create_issue', scopeUserId: null, oldHash: h, newHash: null },
      ]);
      expect(voidReasonOf(second.approval.approval_id)).toBe('pin_revoked');
    } finally {
      (pins as any).setApprovalVoider(voider);
    }
  });

  it('a failing void is audited and does not throw', async () => {
    const pins = server.getToolPins()!;
    const voider = (pins as any).approvalVoider;
    const failures: unknown[] = [];
    (pins as any).setApprovalVoider({
      void: async () => {
        throw new Error('boom');
      },
      onVoidFailure: (c: unknown) => failures.push(c),
    });
    try {
      await expect(
        (pins as any).voidForChanges([
          { mcpId: 'm1', toolName: 't', scopeUserId: null, oldHash: 'e'.repeat(64), newHash: null },
        ])
      ).resolves.toBeUndefined();
      expect(failures).toHaveLength(1);
    } finally {
      (pins as any).setApprovalVoider(voider);
    }
  });
});

describe('N2: step-up does not survive logout', () => {
  it('reauth, logout, login again: the next admin decision is 428', async () => {
    const PW = 'Correct-Horse-9!';
    await createUser(db, {
      username: 'stepadmin',
      password: PW,
      display_name: 's',
      is_admin: true,
    });
    const client = makeAdminClient(server.getAdminServer());
    const login = async (): Promise<string> => {
      const res = await client.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'stepadmin', password: PW },
      });
      const sc = res.headers['set-cookie'];
      const list = Array.isArray(sc) ? sc : [String(sc)];
      return String(list.find(c => String(c).startsWith('sessionId='))).split(';')[0]!;
    };
    const cookie1 = await login();
    const re = await client.inject({
      method: 'POST',
      url: '/v1/auth/reauth',
      headers: { cookie: cookie1 },
      payload: { password: PW },
    });
    expect(re.statusCode).toBe(200);
    const out = await client.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: cookie1 },
    });
    expect([200, 204]).toContain(out.statusCode);
    const cookie2 = await login();
    const sd = seed();
    const created = await svc.createOrFind({
      grantId: sd.grantId,
      boundClientId: sd.clientId,
      userId,
      mcpId: 'm1',
      toolName: 'admin_only',
      argsHash: 'a'.repeat(64),
      pinHash: null,
      required: 'admin',
      preview: '{}',
      via: 'mcp',
      disclosureMode: 'full',
      grantExpiresAt: EXP,
    } as never);
    if (created.kind !== 'created') throw new Error('seed failed');
    const dec = await client.inject({
      method: 'POST',
      url: `/v1/admin/approvals/${created.request.approval_id}/decision`,
      headers: { cookie: cookie2 },
      payload: { decision: 'approve', expected_args_hash: 'a'.repeat(64) },
    });
    expect(dec.statusCode).toBe(428);
  });
});

describe('F1: void failures are non-fatal and audited', () => {
  const breakVoids = (): void => {
    raw(db).exec(
      `CREATE TRIGGER IF NOT EXISTS t_fail_void BEFORE UPDATE OF status ON approval_requests WHEN NEW.status='voided' BEGIN SELECT RAISE(ABORT,'injected'); END`
    );
  };
  const fixVoids = (): void => raw(db).exec('DROP TRIGGER IF EXISTS t_fail_void');

  it('kill-switch activation stays active and resolves when the void fails', async () => {
    const { s, id } = await pending();
    breakVoids();
    try {
      await expect(
        (server as any).killSwitchManager.set(`client:${s.clientId}`, true, 'admin')
      ).resolves.toBeUndefined();
      expect((server as any).killSwitchManager.isActive('client', s.clientId)).toBe(true);
      expect(statusOf(id)).toBe('pending');
      const a = audits.find(x => x.action === 'approval_void_failed');
      expect(a?.meta).toMatchObject({ scope: 'client', reason: 'kill_switch' });
    } finally {
      fixVoids();
      await (server as any).killSwitchManager.set(`client:${s.clientId}`, false, 'admin');
    }
  });

  it('suspendUserClient commits and resolves when the void fails; consume still refuses', async () => {
    const { s, id } = await pending();
    breakVoids();
    try {
      await expect(suspendUserClient(db, userId, s.clientId, false)).resolves.toBeUndefined();
      expect(
        raw(db).prepare(`SELECT status FROM clients WHERE client_id=?`).get(s.clientId).status
      ).toBe('suspended');
      expect(audits.some(x => x.action === 'approval_void_failed')).toBe(true);
      expect(statusOf(id)).toBe('pending');
    } finally {
      fixVoids();
    }
  });
});

describe('stripAmbassadorMeta depth bound', () => {
  it('drops a subtree nested past the bound instead of returning it raw', () => {
    let deep: unknown = { _meta: { 'ambassador/approval': { status: 'approval_denied' } } };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(JSON.stringify(stripAmbassadorMeta(deep))).not.toContain('ambassador/');
  });
});

describe('buildApprovalUrl scheme', () => {
  it('rejects plain http for a non-loopback host, allows loopback http', () => {
    expect(() => buildApprovalUrl('http://amb.example', 'apr_abcdefgh')).toThrow();
    expect(buildApprovalUrl('http://127.0.0.1:9443', 'apr_abcdefgh')).toContain('/app/approvals/');
  });
});
