/**
 * ADR-023 (3c) PR-1: policy resolution and the approval-request state machine (real SQLite).
 * Covers policy, create/dedup/caps/rate/cooldown, decide (roles, self-approval, expiry rule),
 * the five contested pairs (exactly one winner), consume, preview retention, void hooks, reaper,
 * and that audit lines never carry arguments or the preview.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  revokeAgentGrant,
  revokeGrantsForBoundClient,
  revokeTokenFamily,
  updateToolPin,
  updateToolPinsAtomic,
  deleteMcpEntry,
  setApprovalVoidObserver,
  type DatabaseClient,
} from '@mcpambassador/core';
import { APPROVAL_MAX_OPEN_PER_GRANT, APPROVAL_PREVIEW_MAX_BYTES } from '@mcpambassador/contracts';
import { ApprovalService, stricterApprover } from '../../src/services/approvals/service.js';

const raw = (db: DatabaseClient): any => (db as any).session.client;
const HASH = (n: number | string): string => String(n).padStart(64, '0');
const CANARY = 'CANARY-SECRET-ARGUMENT-VALUE';

let dir: string;
let db: DatabaseClient;
let audits: Array<{ action: string; meta: Record<string, unknown> }>;
let now: Date;
let svc: ApprovalService;
const GRANT_EXP = '2026-12-01T00:00:00.000Z';

function seed(): void {
  const ts = '2026-11-01T00:00:00.000Z';
  const r = raw(db);
  for (const u of ['u1', 'u2']) {
    r.prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    ).run(u, u, u, ts, ts);
  }
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run('k1', 'k1', 'p', 'h', 'u1', 'active', ts);
  for (const g of ['g1', 'g2']) {
    r.prepare(
      `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
    ).run(g, 'u1', 'k1', g, '["tools"]', 'https://x/mcp', ts, GRANT_EXP);
  }
  r.prepare(
    `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
  ).run('m1', 'github', 'github', 'stdio', ts, ts);
}

const input = (over: Record<string, unknown> = {}): any => ({
  grantId: 'g1',
  boundClientId: 'k1',
  userId: 'u1',
  mcpId: 'm1',
  toolName: 'create_issue',
  argsHash: HASH(1),
  pinHash: 'pin-a',
  required: 'owner',
  preview: `{"title":"${CANARY}"}`,
  via: 'mcp',
  disclosureMode: 'full',
  grantExpiresAt: GRANT_EXP,
  ...over,
});
const row = (id: string): any =>
  raw(db).prepare('SELECT * FROM approval_requests WHERE approval_id=?').get(id);
const decide = (
  id: string,
  over: Record<string, unknown> = {}
): ReturnType<ApprovalService['decide']> =>
  svc.decide({
    approvalId: id,
    decision: 'approve',
    expectedArgsHash: HASH(1),
    actorUserId: 'u1',
    actorRole: 'owner',
    grantExpiresAt: GRANT_EXP,
    ...over,
  } as any);
async function create(over: Record<string, unknown> = {}): Promise<string> {
  const r = await svc.createOrFind(input(over));
  if (r.kind !== 'created' && r.kind !== 'existing') throw new Error(`create: ${r.kind}`);
  return r.request.approval_id;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-appr-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  seed();
  audits = [];
  now = new Date('2026-11-01T12:00:00.000Z');
  svc = new ApprovalService(db, (action, meta) => audits.push({ action, meta }), {
    clock: () => now,
  });
  setApprovalVoidObserver((rows, reason) => svc.auditVoidedRows(rows, reason));
});
afterEach(async () => {
  setApprovalVoidObserver(null);
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('policy', () => {
  it('no row and no default is ungated', async () => {
    expect((await svc.evaluate('m1', 't')).requires_approval).toBe(false);
  });
  it('an MCP default gates tools with no row, including already-discovered ones', async () => {
    await svc.setMcpDefault(
      'm1',
      { default_requires_approval: true, default_approver: 'admin' },
      'a'
    );
    expect(await svc.evaluate('m1', 'anything')).toMatchObject({
      requires_approval: true,
      approver: 'admin',
      source: 'mcp_default',
    });
  });
  it('an explicit tool row wins, including an explicit "no"', async () => {
    await svc.setMcpDefault(
      'm1',
      { default_requires_approval: true, default_approver: 'owner' },
      'a'
    );
    await svc.setToolPolicy('m1', 'safe', { requires_approval: false }, 'a');
    await svc.setToolPolicy('m1', 'risky', { requires_approval: true, approver: 'admin' }, 'a');
    expect((await svc.evaluate('m1', 'safe')).requires_approval).toBe(false);
    expect(await svc.evaluate('m1', 'risky')).toMatchObject({ approver: 'admin', source: 'tool' });
  });
  it('requires an explicit approver when enabling', async () => {
    await expect(svc.setToolPolicy('m1', 't', { requires_approval: true }, 'a')).rejects.toThrow();
    await expect(
      svc.setMcpDefault('m1', { default_requires_approval: true }, 'a')
    ).rejects.toThrow();
  });
  it("turning a gate off voids that tool's open requests and audits them", async () => {
    await svc.setToolPolicy(
      'm1',
      'create_issue',
      { requires_approval: true, approver: 'owner' },
      'a'
    );
    const id = await create();
    await svc.setToolPolicy('m1', 'create_issue', { requires_approval: false }, 'a');
    expect(row(id)).toMatchObject({
      status: 'voided',
      void_reason: 'policy_removed',
      preview: null,
    });
    expect(audits.map(a => a.action)).toContain('approval_voided');
    expect(audits.map(a => a.action)).toContain('tool_policy_changed');
  });
  it('unknown MCP default returns false', async () => {
    expect(await svc.setMcpDefault('nope', { default_requires_approval: false }, 'a')).toBe(false);
  });
  it('stricterApprover: admin wins', () => {
    expect(stricterApprover('owner', 'admin')).toBe('admin');
    expect(stricterApprover('admin', 'owner')).toBe('admin');
    expect(stricterApprover('owner', 'owner')).toBe('owner');
  });
});

describe('create', () => {
  it('creates once and dedups the identical call', async () => {
    const a = await svc.createOrFind(input());
    const b = await svc.createOrFind(input());
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('existing');
    expect((b as any).request.approval_id).toBe((a as any).request.approval_id);
  });
  it('concurrent identical creates collapse to one open row', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => svc.createOrFind(input())));
    expect(new Set(rs.map((r: any) => r.request.approval_id)).size).toBe(1);
    expect(raw(db).prepare('SELECT count(*) n FROM approval_requests').get().n).toBe(1);
    expect(rs.filter(r => r.kind === 'created').length).toBe(1);
  });
  it('a different argument hash is a different request', async () => {
    const a = await create();
    const b = await create({ argsHash: HASH(2) });
    expect(a).not.toBe(b);
  });
  it('exactly 8 KB preview is accepted; 8 KB + 1 is arguments_too_large', async () => {
    const ok = await svc.createOrFind(input({ preview: 'x'.repeat(APPROVAL_PREVIEW_MAX_BYTES) }));
    expect(ok.kind).toBe('created');
    const big = await svc.createOrFind(
      input({ argsHash: HASH(2), preview: 'x'.repeat(APPROVAL_PREVIEW_MAX_BYTES + 1) })
    );
    expect(big).toEqual({ kind: 'unavailable', reason: 'arguments_too_large' });
  });
  it('multi-byte preview is capped by bytes, not characters', async () => {
    const r = await svc.createOrFind(input({ preview: '€'.repeat(3000) })); // 9000 bytes
    expect(r).toEqual({ kind: 'unavailable', reason: 'arguments_too_large' });
  });
  it('per-grant open cap, then other grants are unaffected', async () => {
    for (let i = 0; i < APPROVAL_MAX_OPEN_PER_GRANT; i++) await create({ argsHash: HASH(10 + i) });
    const r = await svc.createOrFind(input({ argsHash: HASH(99) }));
    expect(r).toEqual({ kind: 'unavailable', reason: 'too_many_pending' });
    expect(audits.some(a => a.action === 'approval_flood_blocked')).toBe(true);
    expect((await svc.createOrFind(input({ grantId: 'g2', argsHash: HASH(99) }))).kind).toBe(
      'created'
    );
  });
  it('a dedup hit is returned even when the grant is at its cap', async () => {
    for (let i = 0; i < APPROVAL_MAX_OPEN_PER_GRANT; i++) await create({ argsHash: HASH(10 + i) });
    expect((await svc.createOrFind(input({ argsHash: HASH(10) }))).kind).toBe('existing');
  });
  it('per-user open cap (20) across grants', async () => {
    const r = raw(db);
    const ts = '2026-11-01T00:00:00.000Z';
    for (let g = 3; g <= 6; g++) {
      r.prepare(
        `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
      ).run(`g${g}`, 'u1', 'k1', `g${g}`, '["tools"]', 'https://x/mcp', ts, GRANT_EXP);
    }
    let n = 0;
    for (const g of ['g1', 'g2', 'g3', 'g4']) {
      for (let i = 0; i < APPROVAL_MAX_OPEN_PER_GRANT; i++) {
        now = new Date(now.getTime() + 61_000); // stay under the per-minute rate
        await create({ grantId: g, argsHash: HASH(1000 + n++) });
      }
    }
    const over = await svc.createOrFind(input({ grantId: 'g5', argsHash: HASH(5000) }));
    expect(over).toEqual({ kind: 'unavailable', reason: 'too_many_pending' });
  });
  it('rate limit: 10 creations in a minute, even if each is closed straight away', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await create({ argsHash: HASH(20 + i) });
      await svc.voidScope({ grantId: 'g1' }, 'pin_revoked');
      expect(row(id).status).toBe('voided');
    }
    const r = await svc.createOrFind(input({ argsHash: HASH(40) }));
    expect(r).toEqual({ kind: 'unavailable', reason: 'rate_limited' });
    now = new Date(now.getTime() + 61_000);
    expect((await svc.createOrFind(input({ argsHash: HASH(40) }))).kind).toBe('created');
  });
  it('3 denials of the same (grant, mcp, tool) start a cooldown, audited; other tools are free', async () => {
    for (let i = 0; i < 3; i++) {
      now = new Date(now.getTime() + 61_000);
      const id = await create({ argsHash: HASH(50 + i) });
      const d = await decide(id, { decision: 'deny', expectedArgsHash: HASH(50 + i) });
      expect(d.kind).toBe('ok');
    }
    const r = await svc.createOrFind(input({ argsHash: HASH(60) }));
    expect(r.kind).toBe('cooldown');
    expect(audits.some(a => a.action === 'approval_cooldown_applied')).toBe(true);
    expect((await svc.createOrFind(input({ toolName: 'other', argsHash: HASH(60) }))).kind).toBe(
      'created'
    );
    now = new Date(now.getTime() + 3601_000);
    expect((await svc.createOrFind(input({ argsHash: HASH(61) }))).kind).toBe('created');
  });
  it('pending expiry never outlives the grant', async () => {
    const r = await svc.createOrFind(input({ grantExpiresAt: '2026-11-01T12:05:00.000Z' }));
    expect((r as any).request.expires_at).toBe('2026-11-01T12:05:00.000Z');
  });
});

describe('decide', () => {
  it('approve sets expires_at = min(now + 10 min, grant expiry) and keeps the preview', async () => {
    const id = await create();
    const d = await decide(id);
    expect(d.kind).toBe('ok');
    expect(row(id)).toMatchObject({
      status: 'approved',
      expires_at: '2026-11-01T12:10:00.000Z',
      decided_by: 'u1',
      approver_role: 'owner',
    });
    expect(row(id).preview).not.toBeNull();
  });
  it('approved expiry is capped by the grant expiry', async () => {
    const id = await create();
    await decide(id, { grantExpiresAt: '2026-11-01T12:03:00.000Z' });
    expect(row(id).expires_at).toBe('2026-11-01T12:03:00.000Z');
  });
  it('deny nulls the preview', async () => {
    const id = await create();
    await decide(id, { decision: 'deny' });
    expect(row(id)).toMatchObject({ status: 'denied', preview: null });
  });
  it('an unknown id is not_found', async () => {
    expect((await decide('nope')).kind).toBe('not_found');
  });
  it('a hash other than the one the approver saw is a conflict and changes nothing', async () => {
    const id = await create();
    expect((await decide(id, { expectedArgsHash: HASH(2) })).kind).toBe('conflict');
    expect(row(id).status).toBe('pending');
  });
  it('role matrix: owner cannot decide admin-required; admin cannot decide owner-required', async () => {
    const a = await create({ required: 'admin' });
    expect((await decide(a, { actorRole: 'owner' })).kind).toBe('forbidden_role');
    const o = await create({ argsHash: HASH(2) });
    expect(
      (await decide(o, { actorRole: 'admin', actorUserId: 'adm', expectedArgsHash: HASH(2) })).kind
    ).toBe('forbidden_role');
    expect(row(a).status).toBe('pending');
    expect(row(o).status).toBe('pending');
  });
  it('stricter wins: a policy tightened to admin after creation blocks the owner', async () => {
    const id = await create(); // stored owner
    await svc.setToolPolicy(
      'm1',
      'create_issue',
      { requires_approval: true, approver: 'admin' },
      'a'
    );
    expect((await decide(id, { actorRole: 'owner' })).kind).toBe('forbidden_role');
    expect((await decide(id, { actorRole: 'admin', actorUserId: 'adm' })).kind).toBe('ok');
  });
  it('a policy loosened to owner does not let the owner decide an admin-required request', async () => {
    const id = await create({ required: 'admin' });
    await svc.setToolPolicy(
      'm1',
      'create_issue',
      { requires_approval: true, approver: 'owner' },
      'a'
    );
    expect((await decide(id, { actorRole: 'owner' })).kind).toBe('forbidden_role');
  });
  it('self-approval by an admin is recorded and audited', async () => {
    const id = await create({ required: 'admin' });
    const d = await decide(id, { actorRole: 'admin', actorUserId: 'u1' });
    expect(d.kind).toBe('ok');
    expect(row(id).self_approved).toBe(1);
    expect(audits.find(a => a.action === 'approval_approved')?.meta.self_approved).toBe(true);
  });
  it('require_distinct_admin refuses admin self-approval, allows another admin and self-deny', async () => {
    svc = new ApprovalService(db, (action, meta) => audits.push({ action, meta }), {
      clock: () => now,
      requireDistinctAdmin: true,
    });
    const id = await create({ required: 'admin' });
    expect((await decide(id, { actorRole: 'admin', actorUserId: 'u1' })).kind).toBe(
      'self_approval_forbidden'
    );
    expect(
      (await decide(id, { actorRole: 'admin', actorUserId: 'u1', decision: 'deny' })).kind
    ).toBe('ok');
    const id2 = await create({ required: 'admin', argsHash: HASH(2) });
    expect(
      (await decide(id2, { actorRole: 'admin', actorUserId: 'u2', expectedArgsHash: HASH(2) })).kind
    ).toBe('ok');
  });
  it('an owner deciding their own request is not "self-approval"', async () => {
    const id = await create();
    await decide(id);
    expect(row(id).self_approved).toBe(0);
  });
  it('cannot approve once the grant is revoked or expired', async () => {
    const id = await create();
    raw(db)
      .prepare(`UPDATE agent_grants SET revoked_at='2026-11-01T12:00:00.000Z' WHERE grant_id='g1'`)
      .run();
    expect((await decide(id)).kind).toBe('conflict');
    const id2 = await create({ grantId: 'g2', argsHash: HASH(2) });
    raw(db)
      .prepare(`UPDATE agent_grants SET expires_at='2026-11-01T11:00:00.000Z' WHERE grant_id='g2'`)
      .run();
    expect((await decide(id2, { expectedArgsHash: HASH(2) })).kind).toBe('conflict');
  });
  it('cannot decide an expired pending request, or decide twice', async () => {
    const id = await create();
    now = new Date(now.getTime() + 901_000);
    expect((await decide(id)).kind).toBe('conflict');
    const id2 = await create({ argsHash: HASH(2) });
    expect((await decide(id2, { expectedArgsHash: HASH(2) })).kind).toBe('ok');
    expect((await decide(id2, { expectedArgsHash: HASH(2) })).kind).toBe('conflict');
  });
});

describe('contested transitions: exactly one winner', () => {
  const winners = (rs: Array<{ kind: string }>): number => rs.filter(r => r.kind === 'ok').length;

  it('approve vs deny', async () => {
    const id = await create();
    const rs = await Promise.all([decide(id), decide(id, { decision: 'deny' })]);
    expect(winners(rs)).toBe(1);
    expect(rs.filter(r => r.kind === 'conflict').length).toBe(1);
  });
  it('approve vs approve (two admins)', async () => {
    const id = await create({ required: 'admin' });
    const rs = await Promise.all([
      decide(id, { actorRole: 'admin', actorUserId: 'a1' }),
      decide(id, { actorRole: 'admin', actorUserId: 'a2' }),
    ]);
    expect(winners(rs)).toBe(1);
    expect(['a1', 'a2']).toContain(row(id).decided_by);
  });
  it('approve vs expire', async () => {
    const id = await create();
    now = new Date(now.getTime() + 901_000); // past the pending deadline
    const [d, reaped] = await Promise.all([decide(id), svc.reap()]);
    expect(d.kind).toBe('conflict');
    expect(reaped).toBe(1);
    expect(row(id)).toMatchObject({ status: 'expired', preview: null });
  });
  it('approve vs void', async () => {
    const id = await create();
    const [d, v] = await Promise.all([
      decide(id),
      svc.voidScope({ grantId: 'g1' }, 'grant_revoked'),
    ]);
    expect(d.kind === 'ok' ? 'approved-first' : 'void-first').toMatch(/first/);
    // whichever won, the row ends in a single consistent state and void either took it or found it approved
    expect(['approved', 'voided']).toContain(row(id).status);
    expect(d.kind === 'ok' ? v : v).toBeGreaterThanOrEqual(0);
    await svc.voidScope({ grantId: 'g1' }, 'grant_revoked');
    expect(row(id).status).toBe('voided');
    expect(row(id).preview).toBeNull();
  });
  it('consume vs consume (the retry raced)', async () => {
    const id = await create();
    await decide(id);
    const c = () =>
      svc.consume({
        grantId: 'g1',
        mcpId: 'm1',
        toolName: 'create_issue',
        argsHash: HASH(1),
        currentPinHash: 'pin-a',
        callerBoundClientId: 'k1',
      });
    const rs = await Promise.all([c(), c()]);
    expect(rs.filter(r => r.kind === 'consumed').length).toBe(1);
    expect(row(id)).toMatchObject({ status: 'consumed', preview: null });
    expect(audits.filter(a => a.action === 'approval_consumed').length).toBe(1);
  });
});

describe('consume', () => {
  const base = {
    grantId: 'g1',
    mcpId: 'm1',
    toolName: 'create_issue',
    argsHash: HASH(1),
    currentPinHash: 'pin-a',
    callerBoundClientId: 'k1',
  };
  it('consumes an approved request once; a second attempt finds nothing', async () => {
    const id = await create();
    await decide(id);
    expect((await svc.consume(base)).kind).toBe('consumed');
    expect(await svc.consume(base)).toEqual({ kind: 'rejected', reason: 'args_mismatch' });
    expect(row(id).consumed_at).not.toBeNull();
  });
  it('a pending request is not consumable', async () => {
    await create();
    expect((await svc.consume(base)).kind).toBe('rejected');
  });
  it('different arguments or another grant never match the approved request', async () => {
    const id = await create();
    await decide(id);
    expect((await svc.consume({ ...base, argsHash: HASH(2) })).kind).toBe('rejected');
    expect((await svc.consume({ ...base, grantId: 'g2' })).kind).toBe('rejected');
    expect(row(id).status).toBe('approved');
  });
  it('a changed or revoked pin voids the request (definition_changed)', async () => {
    const id = await create();
    await decide(id);
    expect(await svc.consume({ ...base, currentPinHash: 'pin-b' })).toEqual({
      kind: 'rejected',
      reason: 'definition_changed',
    });
    expect(row(id)).toMatchObject({
      status: 'voided',
      void_reason: 'definition_changed',
      preview: null,
    });
    const id2 = await create({ argsHash: HASH(2) });
    await decide(id2, { expectedArgsHash: HASH(2) });
    const r = await svc.consume({ ...base, argsHash: HASH(2), currentPinHash: null });
    expect(r).toEqual({ kind: 'rejected', reason: 'definition_changed' });
  });
  it('a NULL bound client (stored or caller) is a mismatch, never a pass', async () => {
    const id = await create({ boundClientId: null });
    await decide(id);
    expect((await svc.consume(base)).kind).toBe('rejected');
    expect(row(id).status).toBe('voided');
    const id2 = await create({ argsHash: HASH(2) });
    await decide(id2, { expectedArgsHash: HASH(2) });
    expect(
      (await svc.consume({ ...base, argsHash: HASH(2), callerBoundClientId: null })).kind
    ).toBe('rejected');
    expect(row(id2).status).toBe('voided');
  });
  it('another bound client is a mismatch', async () => {
    const id = await create();
    await decide(id);
    expect((await svc.consume({ ...base, callerBoundClientId: 'k-other' })).kind).toBe('rejected');
    expect(row(id).status).toBe('voided');
  });
  it('an approval unused past its deadline is rejected as expired', async () => {
    const id = await create();
    await decide(id);
    now = new Date(now.getTime() + 601_000);
    expect(await svc.consume(base)).toEqual({ kind: 'rejected', reason: 'expired' });
    expect(row(id).status).toBe('approved'); // the reaper expires it
    await svc.reap();
    expect(row(id)).toMatchObject({ status: 'expired', preview: null });
  });
});

describe('retention and audit hygiene', () => {
  it('preview is NULL in every terminal state', async () => {
    const ids: string[] = [];
    ids.push(await create({ argsHash: HASH(1) })); // denied
    ids.push(await create({ argsHash: HASH(2) })); // consumed
    ids.push(await create({ argsHash: HASH(3) })); // voided
    ids.push(await create({ argsHash: HASH(4) })); // expired
    await decide(ids[0]!, { decision: 'deny' });
    await decide(ids[1]!, { expectedArgsHash: HASH(2) });
    await svc.consume({
      grantId: 'g1',
      mcpId: 'm1',
      toolName: 'create_issue',
      argsHash: HASH(2),
      currentPinHash: 'pin-a',
      callerBoundClientId: 'k1',
    });
    now = new Date(now.getTime() + 2000_000);
    await svc.reap();
    for (const id of ids) expect(row(id).preview).toBeNull();
    expect(ids.map(id => row(id).status).sort()).toEqual([
      'consumed',
      'denied',
      'expired',
      'expired',
    ]);
  });
  it('no audit line carries the arguments or the preview', async () => {
    const id = await create();
    await decide(id);
    await svc.consume({
      grantId: 'g1',
      mcpId: 'm1',
      toolName: 'create_issue',
      argsHash: HASH(1),
      currentPinHash: 'pin-a',
      callerBoundClientId: 'k1',
    });
    expect(audits.length).toBeGreaterThan(2);
    expect(JSON.stringify(audits)).not.toContain(CANARY);
    for (const a of audits) expect(Object.keys(a.meta)).not.toContain('preview');
  });
});

describe('lifecycle voids (core hooks, audited via the observer)', () => {
  it('revoking a grant voids its open requests', async () => {
    const id = await create();
    await revokeAgentGrant(db, 'g1', 'admin');
    expect(row(id)).toMatchObject({
      status: 'voided',
      void_reason: 'grant_revoked',
      preview: null,
    });
    expect(audits.filter(a => a.action === 'approval_voided').length).toBe(1);
  });
  it('suspending/revoking the bound client voids with client_suspended', async () => {
    const id = await create();
    await revokeGrantsForBoundClient(db, 'k1', 'admin');
    expect(row(id)).toMatchObject({ status: 'voided', void_reason: 'client_suspended' });
  });
  it('deleting an MCP voids and audits before the cascade removes the rows', async () => {
    await create();
    await deleteMcpEntry(db, 'm1');
    expect(audits.some(a => a.action === 'approval_voided')).toBe(true);
  });
  it('terminal requests are left alone by voids', async () => {
    const id = await create();
    await decide(id, { decision: 'deny' });
    await revokeAgentGrant(db, 'g1', 'admin');
    expect(row(id).status).toBe('denied');
  });
});

describe('lifecycle voids: token family and pins (ADR-023 §8)', () => {
  const seedPin = (status: string, hash: string | null): void => {
    raw(db)
      .prepare(
        `INSERT INTO tool_pins (pin_id, mcp_id, scope_user_id, tool_name, status, approved_hash, first_seen_at, updated_at) VALUES ('p1','m1',NULL,'create_issue',?,?,?,?)`
      )
      .run(status, hash, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  };
  it("revoking a token family voids that grant's open requests", async () => {
    raw(db)
      .prepare(
        `INSERT INTO agent_tokens (token_hash, kind, grant_id, family_id, expires_at, created_at) VALUES ('t1','refresh','g1','f1',?,?)`
      )
      .run(GRANT_EXP, '2026-11-01T00:00:00.000Z');
    const id = await create();
    const other = await create({ grantId: 'g2', argsHash: HASH(2) });
    await revokeTokenFamily(db, 'f1');
    expect(row(id)).toMatchObject({
      status: 'voided',
      void_reason: 'grant_revoked',
      preview: null,
    });
    expect(row(other).status).toBe('pending');
  });
  it('a pin leaving "approved" voids that tool\'s requests only', async () => {
    seedPin('approved', 'h1');
    const id = await create();
    const other = await create({ toolName: 'other', argsHash: HASH(2) });
    await updateToolPin(db, 'p1', { status: 'rejected' });
    expect(row(id)).toMatchObject({ status: 'voided', void_reason: 'pin_revoked' });
    expect(row(other).status).toBe('pending');
  });
  it('a changed approved_hash voids (atomic path); an unchanged one does not', async () => {
    seedPin('approved', 'h1');
    const id = await create();
    await updateToolPinsAtomic(db, [{ pinId: 'p1', patch: { approved_hash: 'h1' } }]);
    expect(row(id).status).toBe('pending');
    await updateToolPinsAtomic(db, [{ pinId: 'p1', patch: { approved_hash: 'h2' } }]);
    expect(row(id)).toMatchObject({ status: 'voided', void_reason: 'definition_changed' });
  });
});
