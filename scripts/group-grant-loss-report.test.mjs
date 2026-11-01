import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, format, run } from './group-grant-loss-report.mjs';

test('summarize groups rows by user/MCP pair', () => {
  const s = summarize([
    { username: 'a', client_name: 'c1', mcp_name: 'x' },
    { username: 'a', client_name: 'c2', mcp_name: 'x' },
    { username: 'b', client_name: 'c3', mcp_name: 'y' },
  ]);
  assert.equal(s.subscriptions, 3);
  assert.equal(s.users, 2);
  assert.deepEqual(s.pairs[0].clients, ['c1', 'c2']);
  assert.match(format(s), /a -> x \[no_grant\] \(clients: c1, c2\)/);
});

test('run finds only active subscriptions without a granting group and never writes', () => {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const dir = mkdtempSync(join(tmpdir(), 'amb-loss-'));
  const file = join(dir, 't.db');
  try {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users(user_id TEXT, username TEXT);
      CREATE TABLE clients(client_id TEXT, user_id TEXT, client_name TEXT);
      CREATE TABLE mcp_catalog(mcp_id TEXT, name TEXT);
      CREATE TABLE client_mcp_subscriptions(client_id TEXT, mcp_id TEXT, status TEXT);
      CREATE TABLE groups(group_id TEXT, status TEXT);
      CREATE TABLE user_groups(user_id TEXT, group_id TEXT);
      CREATE TABLE mcp_group_access(mcp_id TEXT, group_id TEXT);
      INSERT INTO users VALUES('u1','alice');
      INSERT INTO clients VALUES('c1','u1','laptop');
      INSERT INTO mcp_catalog VALUES('m1','granted'),('m2','outlived'),('m3','paused'),('m4','susp');
      INSERT INTO client_mcp_subscriptions VALUES('c1','m1','active'),('c1','m2','active'),('c1','m3','paused'),('c1','m4','active');
      INSERT INTO groups VALUES('g1','active'),('g2','suspended');
      INSERT INTO user_groups VALUES('u1','g1'),('u1','g2');
      INSERT INTO mcp_group_access VALUES('m1','g1'),('m4','g2');
    `);
    db.close();
    const s = run(file);
    assert.equal(s.subscriptions, 2);
    assert.deepEqual(
      s.pairs.map(p => [p.mcp, p.reason]),
      [
        ['outlived', 'no_grant'],
        ['susp', 'only_suspended'],
      ]
    );
    const ro = new Database(file, { readonly: true });
    assert.throws(() => ro.exec('DELETE FROM users'));
    ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
