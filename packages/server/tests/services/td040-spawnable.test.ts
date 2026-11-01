/**
 * TD-040: the per-user pool spawns only MCPs the user is granted (active group) AND subscribed to.
 * Ungranted, unsubscribed, paused-subscription and suspended-group MCPs are never started.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  type DatabaseClient,
} from '@mcpambassador/core';
import { spawnableMcpIdsForUser } from '../../src/services/mcp-access.js';
import { grantExistingUser } from '../helpers/grants.js';

const raw = (db: DatabaseClient): any => (db as any).session.client;

let dir: string;
let db: DatabaseClient;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-td40-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  const ts = new Date().toISOString();
  const r = raw(db);
  for (const u of ['u1', 'u2']) {
    r.prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    ).run(u, u, u, ts, ts);
  }
  for (const [c, u] of [
    ['c1', 'u1'],
    ['c1b', 'u1'],
    ['c2', 'u2'],
  ]) {
    r.prepare(
      `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
    ).run(c, c, 'p', 'h', u, 'active', ts);
  }
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    r.prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run(id, id, id, 'stdio', ts, ts);
  }
});
afterEach(async () => {
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

function subscribe(sub: string, client: string, mcp: string, status = 'active'): void {
  const ts = new Date().toISOString();
  raw(db)
    .prepare(
      `INSERT INTO client_mcp_subscriptions (subscription_id, client_id, mcp_id, status, subscribed_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run(sub, client, mcp, status, ts, ts);
}

describe('spawnableMcpIdsForUser', () => {
  it('is empty without any grant, even when subscribed (g144b: procs=0)', async () => {
    subscribe('s1', 'c1', 'm1');
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))]).toEqual([]);
  });

  it('is empty when granted but not subscribed', async () => {
    await grantExistingUser(db, 'u1', ['m1', 'm2']);
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))]).toEqual([]);
  });

  it('is the intersection of granted and actively subscribed, across the user clients', async () => {
    await grantExistingUser(db, 'u1', ['m1', 'm2', 'm3']);
    subscribe('s1', 'c1', 'm1');
    subscribe('s2', 'c1b', 'm2'); // second client of the same user
    subscribe('s3', 'c1', 'm3', 'paused'); // paused: not spawned
    subscribe('s4', 'c1', 'm4'); // subscribed but never granted: not spawned
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))].sort()).toEqual(['m1', 'm2']);
  });

  it("does not use another user's subscriptions or grants", async () => {
    await grantExistingUser(db, 'u1', ['m1']);
    subscribe('s1', 'c2', 'm1'); // u2 subscribed, u2 not granted
    expect([...(await spawnableMcpIdsForUser(db, 'u2'))]).toEqual([]);
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))]).toEqual([]);
  });

  it('drops an MCP when the granting group is suspended, and restores it on re-activation', async () => {
    const { groupId } = await grantExistingUser(db, 'u1', ['m1']);
    subscribe('s1', 'c1', 'm1');
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))]).toEqual(['m1']);
    raw(db).prepare(`UPDATE groups SET status='suspended' WHERE group_id=?`).run(groupId);
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))]).toEqual([]);
    raw(db).prepare(`UPDATE groups SET status='active' WHERE group_id=?`).run(groupId);
    expect([...(await spawnableMcpIdsForUser(db, 'u1'))]).toEqual(['m1']);
  });
});
