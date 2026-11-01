/**
 * TD-040 S1/S2: every change to what a user may run (subscribe/unsubscribe, group grant add/revoke,
 * membership, group status/delete, client status) asks the server to re-sync that user's per-user
 * instances, and a suspended/revoked client contributes nothing to the spawnable set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  type DatabaseClient,
} from '@mcpambassador/core';
import { registerAdminGroupRoutes } from '../../src/admin/group-routes.js';
import { registerAdminClientRoutes } from '../../src/admin/client-routes.js';
import { registerSubscriptionRoutes } from '../../src/routes/subscriptions.js';
import { spawnableMcpIdsForUser } from '../../src/services/mcp-access.js';
import { grantExistingUser } from '../helpers/grants.js';

const raw = (db: DatabaseClient): any => (db as any).session.client;
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const M1 = '44444444-4444-4444-8444-444444444444';
const M2 = '55555555-5555-4555-8555-555555555555';
const C1 = '33333333-3333-4333-8333-333333333333';
const audit = { emit: async () => undefined } as any;

let dir: string;
let db: DatabaseClient;
let app: FastifyInstance;
let calls: Array<{ ids: string[]; reason: string }>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-td40r-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  const ts = new Date().toISOString();
  const r = raw(db);
  for (const u of [U1, U2]) {
    r.prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    ).run(u, u, u, ts, ts);
  }
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(C1, 'c1', 'p', 'h', U1, 'active', ts);
  for (const id of [M1, M2]) {
    r.prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
    ).run(id, id, id, 'stdio', 'published', ts, ts);
  }
  calls = [];
  app = Fastify();
  const onUserAccessChanged = async (ids: string[], reason: string) => {
    calls.push({ ids, reason });
  };
  app.decorateRequest('session', null as never);
  app.addHook('onRequest', async req => {
    (req as any).session = { userId: U1 };
  });
  await app.register(registerAdminGroupRoutes, { db, audit, onUserAccessChanged });
  await app.register(registerAdminClientRoutes, {
    db,
    audit,
    userPool: null,
    onUserAccessChanged,
  });
  await registerSubscriptionRoutes(app, { db, onUserAccessChanged });
  await app.ready();
});
afterEach(async () => {
  await app?.close();
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const reasons = (): string[] => calls.map(c => c.reason);

describe('S2: client status', () => {
  it('a suspended or revoked client contributes no spawnable MCP', async () => {
    await grantExistingUser(db, U1, [M1]);
    const ts = new Date().toISOString();
    raw(db)
      .prepare(
        `INSERT INTO client_mcp_subscriptions (subscription_id, client_id, mcp_id, status, subscribed_at, updated_at) VALUES (?,?,?,?,?,?)`
      )
      .run('s1', C1, M1, 'active', ts, ts);
    expect([...(await spawnableMcpIdsForUser(db, U1))]).toEqual([M1]);
    for (const st of ['suspended', 'revoked']) {
      raw(db).prepare(`UPDATE clients SET status=? WHERE client_id=?`).run(st, C1);
      expect([...(await spawnableMcpIdsForUser(db, U1))]).toEqual([]);
    }
    raw(db).prepare(`UPDATE clients SET status='active' WHERE client_id=?`).run(C1);
    expect([...(await spawnableMcpIdsForUser(db, U1))]).toEqual([M1]);
  });
});

describe('S1: re-sync hook', () => {
  it('fires for the member on add/remove and for all members on grant add/revoke, suspend, delete', async () => {
    const g = await app.inject({
      method: 'POST',
      url: '/v1/admin/groups',
      payload: { name: 'g-resync', status: 'active' },
    });
    const groupId = JSON.parse(g.body).data.group_id as string;

    await app.inject({
      method: 'POST',
      url: `/v1/admin/groups/${groupId}/members`,
      payload: { user_id: U1 },
    });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'group_member_added' });

    await app.inject({
      method: 'POST',
      url: `/v1/admin/groups/${groupId}/mcps`,
      payload: { mcp_id: M1 },
    });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'group_mcp_assigned' });

    await app.inject({
      method: 'PATCH',
      url: `/v1/admin/groups/${groupId}`,
      payload: { status: 'suspended' },
    });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'group_status_changed' });

    await app.inject({
      method: 'PATCH',
      url: `/v1/admin/groups/${groupId}`,
      payload: { status: 'active' },
    });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'group_status_changed' });

    await app.inject({ method: 'DELETE', url: `/v1/admin/groups/${groupId}/mcps/${M1}` });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'group_mcp_removed' });

    await app.inject({ method: 'DELETE', url: `/v1/admin/groups/${groupId}/members/${U1}` });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'group_member_removed' });

    await app.inject({
      method: 'POST',
      url: `/v1/admin/groups/${groupId}/members`,
      payload: { user_id: U2 },
    });
    await app.inject({ method: 'DELETE', url: `/v1/admin/groups/${groupId}` });
    expect(calls.at(-1)).toEqual({ ids: [U2], reason: 'group_deleted' });
  });

  it('client suspend fires the hook for the owner; a no-op patch does not', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/v1/admin/clients/${C1}`,
      payload: { status: 'suspended' },
    });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'client_status_changed' });
    const n = calls.length;
    await app.inject({
      method: 'PATCH',
      url: `/v1/admin/clients/${C1}`,
      payload: { status: 'suspended' },
    });
    expect(calls.length).toBe(n);
  });

  it('subscribe / update / unsubscribe fire the hook for the subscriber', async () => {
    await grantExistingUser(db, U1, [M1]);
    const sub = await app.inject({
      method: 'POST',
      url: `/v1/users/me/clients/${C1}/subscriptions`,
      payload: { mcp_id: M1 },
    });
    expect(sub.statusCode).toBe(201);
    const subId = JSON.parse(sub.body).data.id as string;
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'subscription_created' });

    await app.inject({
      method: 'PATCH',
      url: `/v1/users/me/clients/${C1}/subscriptions/${subId}`,
      payload: { status: 'paused' },
    });
    expect(calls.at(-1)).toEqual({ ids: [U1], reason: 'subscription_updated' });

    await app.inject({
      method: 'DELETE',
      url: `/v1/users/me/clients/${C1}/subscriptions/${subId}`,
    });
    expect(reasons().at(-1)).toBe('subscription_removed');
  });

  it('a failing hook never fails the admin request', async () => {
    const bad = Fastify();
    await bad.register(registerAdminGroupRoutes, {
      db,
      audit,
      onUserAccessChanged: async () => {
        throw new Error('boom');
      },
    });
    const g = await bad.inject({
      method: 'POST',
      url: '/v1/admin/groups',
      payload: { name: 'g-fail', status: 'active' },
    });
    const groupId = JSON.parse(g.body).data.group_id as string;
    const r = await bad.inject({
      method: 'POST',
      url: `/v1/admin/groups/${groupId}/members`,
      payload: { user_id: U1 },
    });
    expect(r.statusCode).toBe(201);
    await bad.close();
  });
});
