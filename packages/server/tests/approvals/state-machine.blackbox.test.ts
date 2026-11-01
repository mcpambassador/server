/**
 * ADR-023 (3c) PR-1 black-box tests of the approval-request state machine (verifier-owned).
 * Real SQLite, real core lifecycle hooks, no mocks of the repository. Covers:
 *  - the five contested pairs, repeated, with exactly one winner and a consistent final row
 *  - preview NULL at every terminal state (and the table CHECK as a backstop)
 *  - dedup returning the existing open row (sequential and concurrent)
 *  - voids on grant revoke, client suspend and MCP delete, each with an approval_voided audit
 *  - a canary: tool arguments (preview) never reach the audit stream or process output
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  revokeAgentGrant,
  revokeGrantsForBoundClient,
  deleteMcpEntry,
  setApprovalVoidObserver,
  type DatabaseClient,
} from '@mcpambassador/core';
import { APPROVAL_PENDING_TTL_SECONDS } from '@mcpambassador/contracts';
import { ApprovalService } from '../../src/services/approvals/service.js';

const raw = (db: DatabaseClient): any => (db as any).session.client;
const HASH = (n: number | string): string => String(n).padStart(64, '0');
const CANARY = 'CANARY-ARG-9f3a1c-do-not-leak';
const TS = '2026-11-01T00:00:00.000Z';
const GRANT_EXP = '2026-12-01T00:00:00.000Z';
const T0 = new Date('2026-11-01T12:00:00.000Z');
const ITER = 25;

let dir: string;
let db: DatabaseClient;
let audits: Array<{ action: string; meta: Record<string, unknown> }>;
let svc: ApprovalService;
let seq = 0;

interface Ctx {
  user: string;
  client: string;
  grant: string;
}

/** A fresh user + client + grant so per-grant/per-user caps and the rate limit never interfere. */
function fresh(mcp = 'm1'): Ctx & { mcp: string } {
  const n = ++seq;
  const c = { user: `u${n}`, client: `k${n}`, grant: `g${n}` };
  const r = raw(db);
  r.prepare(
    `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
  ).run(c.user, c.user, c.user, TS, TS);
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(c.client, c.client, 'p', 'h', c.user, 'active', TS);
  r.prepare(
    `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(c.grant, c.user, c.client, c.grant, '["tools"]', 'https://x/mcp', TS, GRANT_EXP);
  return { ...c, mcp };
}

const input = (c: Ctx & { mcp: string }, over: Record<string, unknown> = {}): any => ({
  grantId: c.grant,
  boundClientId: c.client,
  userId: c.user,
  mcpId: c.mcp,
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
async function create(
  s: ApprovalService,
  c: Ctx & { mcp: string },
  over: Record<string, unknown> = {}
): Promise<string> {
  const r = await s.createOrFind(input(c, over));
  if (r.kind !== 'created' && r.kind !== 'existing') throw new Error(`create: ${r.kind}`);
  return r.request.approval_id;
}
const decideArgs = (c: Ctx, id: string, over: Record<string, unknown> = {}): any => ({
  approvalId: id,
  decision: 'approve',
  expectedArgsHash: HASH(1),
  actorUserId: c.user,
  actorRole: 'owner',
  grantExpiresAt: GRANT_EXP,
  ...over,
});
const row = (id: string): any =>
  raw(db).prepare('SELECT * FROM approval_requests WHERE approval_id=?').get(id);
const voidedAudits = (): Array<Record<string, unknown>> =>
  audits.filter(a => a.action === 'approval_voided').map(a => a.meta);
const at =
  (secs: number): (() => Date) =>
  () =>
    new Date(T0.getTime() + secs * 1000);

let written: string[];
let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-appr-bb-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  const r = raw(db);
  for (const m of ['m1', 'm2']) {
    r.prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run(m, m, m, 'stdio', TS, TS);
  }
  audits = [];
  seq = 0;
  svc = new ApprovalService(db, (action, meta) => audits.push({ action, meta }), {
    clock: at(0),
    approvedUseTtlSeconds: 3600,
  });
  setApprovalVoidObserver((rows, reason) => svc.auditVoidedRows(rows, reason));
  written = [];
  spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      written.push(String(c));
      return true;
    }) as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
      written.push(String(c));
      return true;
    }) as never),
  ];
});
afterEach(async () => {
  spies.forEach(s => s.mockRestore());
  setApprovalVoidObserver(null);
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('race pairs: exactly one winner', () => {
  it('approve vs deny', async () => {
    for (let i = 0; i < ITER; i++) {
      const c = fresh();
      const id = await create(svc, c);
      const [a, b] = await Promise.all([
        svc.decide(decideArgs(c, id, { decision: 'approve' })),
        svc.decide(decideArgs(c, id, { decision: 'deny' })),
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['conflict', 'ok']);
      const winner = a.kind === 'ok' ? 'approved' : 'denied';
      expect(row(id).status).toBe(winner);
      expect(
        audits.filter(x => x.meta.approval_id === id && /approval_(approved|denied)/.test(x.action))
      ).toHaveLength(1);
    }
  });

  it('approve vs approve', async () => {
    for (let i = 0; i < ITER; i++) {
      const c = fresh();
      const id = await create(svc, c);
      const rs = await Promise.all([svc.decide(decideArgs(c, id)), svc.decide(decideArgs(c, id))]);
      expect(rs.map(r => r.kind).sort()).toEqual(['conflict', 'ok']);
      expect(row(id).status).toBe('approved');
      expect(
        audits.filter(x => x.meta.approval_id === id && x.action === 'approval_approved')
      ).toHaveLength(1);
    }
  });

  it('approve vs expire (reaper)', async () => {
    const late = new ApprovalService(db, (action, meta) => audits.push({ action, meta }), {
      clock: at(APPROVAL_PENDING_TTL_SECONDS + 1),
      approvedUseTtlSeconds: 3600,
    });
    for (let i = 0; i < ITER; i++) {
      const c = fresh();
      const id = await create(svc, c);
      const [d, reaped] = await Promise.all([svc.decide(decideArgs(c, id)), late.reap()]);
      // the reaper can only have expired this row if the decision lost, and vice versa
      const decideWon = d.kind === 'ok';
      const final = row(id).status;
      if (decideWon) expect(final).toBe('approved');
      else {
        expect(d.kind).toBe('conflict');
        expect(final).toBe('expired');
      }
      expect(reaped).toBeGreaterThanOrEqual(decideWon ? 0 : 1);
      if (final === 'expired') expect(row(id).preview).toBeNull();
    }
    // nothing decided after expiry: a late approve on an expired row is a conflict
    const c = fresh();
    const id = await create(svc, c);
    await late.reap();
    expect(row(id).status).toBe('expired');
    expect((await late.decide(decideArgs(c, id))).kind).toBe('conflict');
  });

  it('approve vs void: a voided request never ends approved and never consumes', async () => {
    for (let i = 0; i < ITER; i++) {
      const c = fresh();
      const id = await create(svc, c);
      const [d, v] = await Promise.all([
        svc.decide(decideArgs(c, id)),
        svc.voidScope({ grantId: c.grant }, 'grant_revoked'),
      ]);
      expect(v).toBe(1); // void matches pending AND approved: it always lands
      expect(row(id).status).toBe('voided');
      expect(row(id).preview).toBeNull();
      expect(['ok', 'conflict']).toContain(d.kind);
      const cons = await svc.consume({
        grantId: c.grant,
        mcpId: c.mcp,
        toolName: 'create_issue',
        argsHash: HASH(1),
        currentPinHash: 'pin-a',
        callerBoundClientId: c.client,
      });
      expect(cons.kind).toBe('rejected');
      expect(row(id).consumed_at).toBeNull();
    }
  });

  it('consume vs consume', async () => {
    for (let i = 0; i < ITER; i++) {
      const c = fresh();
      const id = await create(svc, c);
      expect((await svc.decide(decideArgs(c, id))).kind).toBe('ok');
      const call = (): ReturnType<ApprovalService['consume']> =>
        svc.consume({
          grantId: c.grant,
          mcpId: c.mcp,
          toolName: 'create_issue',
          argsHash: HASH(1),
          currentPinHash: 'pin-a',
          callerBoundClientId: c.client,
        });
      const rs = await Promise.all([call(), call(), call()]);
      expect(rs.filter(r => r.kind === 'consumed')).toHaveLength(1);
      expect(rs.filter(r => r.kind === 'rejected')).toHaveLength(2);
      expect(row(id).status).toBe('consumed');
      expect(
        audits.filter(x => x.meta.approval_id === id && x.action === 'approval_consumed')
      ).toHaveLength(1);
    }
  });
});

describe('preview is NULL at every terminal state', () => {
  it('open states keep it; denied, expired, voided and consumed clear it', async () => {
    const late = new ApprovalService(db, (a, m) => audits.push({ action: a, meta: m }), {
      clock: at(APPROVAL_PENDING_TTL_SECONDS + 1),
      approvedUseTtlSeconds: 3600,
    });
    const c = fresh();
    const pending = await create(svc, c, { argsHash: HASH(1) });
    expect(row(pending).preview).toContain(CANARY);

    const approved = await create(svc, c, { argsHash: HASH(2) });
    await svc.decide(decideArgs(c, approved, { expectedArgsHash: HASH(2) }));
    expect(row(approved).status).toBe('approved');
    expect(row(approved).preview).toContain(CANARY); // still open

    const dctx = fresh();
    const denied = await create(svc, dctx, { argsHash: HASH(3) });
    await svc.decide(decideArgs(dctx, denied, { decision: 'deny', expectedArgsHash: HASH(3) }));
    expect(row(denied).status).toBe('denied');

    const expired = await create(svc, fresh(), { argsHash: HASH(4) });
    await late.reap();
    expect(row(expired).status).toBe('expired');

    const voided = await create(svc, fresh(), { argsHash: HASH(5) });
    await svc.voidScope({ grantId: row(voided).grant_id }, 'kill_switch');
    expect(row(voided).status).toBe('voided');

    const cc = fresh();
    const consumed = await create(svc, cc, { argsHash: HASH(6) });
    await svc.decide(decideArgs(cc, consumed, { expectedArgsHash: HASH(6) }));
    await svc.consume({
      grantId: cc.grant,
      mcpId: cc.mcp,
      toolName: 'create_issue',
      argsHash: HASH(6),
      currentPinHash: 'pin-a',
      callerBoundClientId: cc.client,
    });
    expect(row(consumed).status).toBe('consumed');

    for (const id of [denied, expired, voided, consumed]) {
      expect(row(id).preview, `${row(id).status} must have NULL preview`).toBeNull();
    }
    // approved was reaped? it has a 1h use TTL, so `late` (+901s) must NOT have touched it
    expect(row(approved).status).toBe('approved');
  });

  it('the table refuses a terminal row that still carries a preview', () => {
    const c = fresh();
    const r = raw(db);
    const insert = (status: string, preview: string | null): void => {
      r.prepare(
        `INSERT INTO approval_requests (approval_id, grant_id, bound_client_id, user_id, mcp_id, tool_name, args_hash, pin_hash, required_approver, status, preview, via, disclosure_mode, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `chk-${status}-${preview ? 1 : 0}`,
        c.grant,
        c.client,
        c.user,
        c.mcp,
        't',
        HASH(status.length),
        null,
        'owner',
        status,
        preview,
        null,
        'full',
        TS,
        GRANT_EXP
      );
    };
    for (const s of ['denied', 'expired', 'voided', 'consumed']) {
      expect(() => insert(s, 'leftover')).toThrow(/CHECK|constraint/i);
    }
    expect(() => insert('pending', 'ok')).not.toThrow();
  });
});

describe('dedup', () => {
  it('returns the existing open row and creates exactly one', async () => {
    const c = fresh();
    const a = await svc.createOrFind(input(c));
    const b = await svc.createOrFind(input(c, { preview: 'different preview text' }));
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('existing');
    expect((b as any).request.approval_id).toBe((a as any).request.approval_id);
    // the stored preview is the first one: a retry cannot rewrite what the approver will see
    expect(row((a as any).request.approval_id).preview).toContain(CANARY);
    expect(raw(db).prepare('SELECT COUNT(*) n FROM approval_requests').get().n).toBe(1);
  });

  it('collapses concurrent identical creates to one row', async () => {
    const c = fresh();
    const rs = await Promise.all(Array.from({ length: 10 }, () => svc.createOrFind(input(c))));
    expect(rs.filter(r => r.kind === 'created')).toHaveLength(1);
    expect(rs.filter(r => r.kind === 'existing')).toHaveLength(9);
    expect(new Set(rs.map(r => (r as any).request.approval_id)).size).toBe(1);
    expect(raw(db).prepare('SELECT COUNT(*) n FROM approval_requests').get().n).toBe(1);
    expect(audits.filter(a => a.action === 'approval_requested')).toHaveLength(1);
  });

  it('different args, tool or grant are separate requests; a closed request is not reused', async () => {
    const c = fresh();
    const a = await create(svc, c);
    expect(await create(svc, c, { argsHash: HASH(2) })).not.toBe(a);
    expect(await create(svc, c, { toolName: 'other' })).not.toBe(a);
    const c2 = fresh();
    expect(await create(svc, c2)).not.toBe(a);
    await svc.decide(decideArgs(c, a, { decision: 'deny' }));
    const again = await svc.createOrFind(input(c));
    expect(again.kind).toBe('created');
    expect((again as any).request.approval_id).not.toBe(a);
  });

  it('an approved request is returned by dedup (not duplicated) until consumed', async () => {
    const c = fresh();
    const id = await create(svc, c);
    await svc.decide(decideArgs(c, id));
    const r = await svc.createOrFind(input(c));
    expect(r.kind).toBe('existing');
    expect((r as any).request.status).toBe('approved');
  });
});

describe('voids on lifecycle events, each audited', () => {
  async function two(c: Ctx & { mcp: string }): Promise<[string, string]> {
    const p = await create(svc, c, { argsHash: HASH(1) });
    const a = await create(svc, c, { argsHash: HASH(2) });
    await svc.decide(decideArgs(c, a, { expectedArgsHash: HASH(2) }));
    return [p, a];
  }
  function expectVoided(ids: string[], reason: string): void {
    for (const id of ids) {
      const r = row(id);
      expect(r.status).toBe('voided');
      expect(r.void_reason).toBe(reason);
      expect(r.preview).toBeNull();
    }
    const metas = voidedAudits().filter(m => ids.includes(m.approval_id as string));
    expect(metas.map(m => m.approval_id).sort()).toEqual([...ids].sort());
    expect(metas.every(m => m.reason === reason)).toBe(true);
  }

  it('grant revoke voids pending and approved of that grant only', async () => {
    const c = fresh();
    const other = fresh();
    const ids = await two(c);
    const [otherId] = await two(other);
    await revokeAgentGrant(db, c.grant, c.user);
    expectVoided(ids, 'grant_revoked');
    expect(row(otherId).status).toBe('pending');
  });

  it('client suspend (grants revoked for the bound client) voids that client only', async () => {
    const c = fresh();
    const other = fresh();
    const ids = await two(c);
    const [otherId] = await two(other);
    await revokeGrantsForBoundClient(db, c.client, c.user);
    expectVoided(ids, 'client_suspended');
    expect(row(otherId).status).toBe('pending');
  });

  it('MCP delete voids and audits before the cascade removes the rows', async () => {
    const c = fresh('m1');
    const keep = fresh('m2');
    const ids = await two(c);
    const [keepId] = await two(keep);
    await deleteMcpEntry(db, 'm1');
    const metas = voidedAudits().filter(m => ids.includes(m.approval_id as string));
    expect(metas.map(m => m.approval_id).sort()).toEqual([...ids].sort());
    expect(metas.every(m => typeof m.reason === 'string' && m.reason.length > 0)).toBe(true);
    for (const id of ids) {
      const r = row(id);
      if (r) {
        expect(r.status).toBe('voided');
        expect(r.preview).toBeNull();
      }
    }
    expect(row(keepId).status).toBe('pending');
  });

  it('a voided request cannot be decided or consumed afterwards', async () => {
    const c = fresh();
    const [p, a] = await two(c);
    await revokeAgentGrant(db, c.grant, c.user);
    expect((await svc.decide(decideArgs(c, p))).kind).toBe('conflict');
    const cons = await svc.consume({
      grantId: c.grant,
      mcpId: c.mcp,
      toolName: 'create_issue',
      argsHash: HASH(2),
      currentPinHash: 'pin-a',
      callerBoundClientId: c.client,
    });
    expect(cons.kind).toBe('rejected');
    expect(row(a).consumed_at).toBeNull();
  });
});

describe('arguments canary', () => {
  it('the preview/arguments never reach audit events or process output', async () => {
    const c = fresh();
    const ids = [
      await create(svc, c, { argsHash: HASH(1) }),
      await create(svc, c, { argsHash: HASH(2) }),
      await create(svc, c, { argsHash: HASH(3) }),
    ];
    await svc.decide(decideArgs(c, ids[1]!, { expectedArgsHash: HASH(2) }));
    await svc.decide(decideArgs(c, ids[2]!, { decision: 'deny', expectedArgsHash: HASH(3) }));
    await svc.consume({
      grantId: c.grant,
      mcpId: c.mcp,
      toolName: 'create_issue',
      argsHash: HASH(2),
      currentPinHash: 'pin-a',
      callerBoundClientId: c.client,
    });
    await create(svc, c, { argsHash: HASH(4) });
    await revokeAgentGrant(db, c.grant, c.user);
    await svc.reap();
    expect(audits.length).toBeGreaterThan(5);
    expect(JSON.stringify(audits)).not.toContain(CANARY);
    expect(JSON.stringify(audits)).not.toContain('title');
    expect(written.join('')).not.toContain(CANARY);
    // and at rest only open rows carry it
    const withCanary = raw(db)
      .prepare(`SELECT status FROM approval_requests WHERE preview LIKE ?`)
      .all(`%${CANARY}%`) as Array<{ status: string }>;
    expect(withCanary.every(r => r.status === 'pending' || r.status === 'approved')).toBe(true);
  });
});
