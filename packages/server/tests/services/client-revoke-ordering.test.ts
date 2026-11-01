/**
 * Client delete/disable ordering, stream closing, per-grant audit, and the grant-kind check
 * (follow-up to ADR-020 P4/FB-031).
 */
import { grantExistingUser } from '../helpers/grants.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  AgentEndpointConfigSchema,
  getAgentGrant,
  type DatabaseClient,
} from '@mcpambassador/core';
import {
  createAgentEndpointDeps,
  resolveAgentEndpointConfig,
  startAuthorization,
  decideConsent,
  exchangeToken,
  validateAgentToken,
  createGrant,
  adminCreateClient,
  adminDeleteClient,
  adminSetClientDisabled,
  type AgentEndpointDeps,
} from '../../src/services/agent-endpoint/index.js';

const RESOURCE = 'https://amb.test:8443/mcp';
const REDIRECT = 'http://localhost:7777/cb';
const raw = (db: DatabaseClient): any => (db as any).session.client;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

let dir: string;
let db: DatabaseClient;
let deps: AgentEndpointDeps;
let events: any[];

function seed(): void {
  const ts = new Date().toISOString();
  const r = raw(db);
  for (const u of ['u1', 'u2']) {
    r.prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    ).run(u, u, u, ts, ts);
  }
  for (const [c, u] of [
    ['k1', 'u1'],
    ['k1b', 'u1'],
    ['k2', 'u2'],
  ]) {
    r.prepare(
      `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
    ).run(c, `name-${c}`, 'p', 'h', u, 'active', ts);
  }
  for (const [id, name] of [
    ['m1', 'github'],
    ['m2', 'slack'],
  ]) {
    r.prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run(id, name, name, 'stdio', ts, ts);
  }
  // k1 subscribes to github only; k1b to slack
  r.prepare(
    `INSERT INTO client_mcp_subscriptions (subscription_id, client_id, mcp_id, status, subscribed_at, updated_at) VALUES (?,?,?,?,?,?)`
  ).run('s1', 'k1', 'm1', 'active', ts, ts);
  r.prepare(
    `INSERT INTO client_mcp_subscriptions (subscription_id, client_id, mcp_id, status, subscribed_at, updated_at) VALUES (?,?,?,?,?,?)`
  ).run('s2', 'k1b', 'm2', 'active', ts, ts);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-p4-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  seed();
  await grantExistingUser(db, 'u1', ['m1', 'm2']);
  events = [];
  const cfg = resolveAgentEndpointConfig(
    AgentEndpointConfigSchema.parse({ enabled: true, dynamic_client_registration: true }),
    { issuer: 'https://amb.test:9443', agentBaseUrl: 'https://amb.test:8443' }
  );
  deps = createAgentEndpointDeps(db, cfg, {
    emit: (e: any) => {
      events.push(e);
      return Promise.resolve();
    },
  } as any);
});
afterEach(async () => {
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function newClient(): Promise<string> {
  const c = await adminCreateClient(
    deps,
    'admin',
    { client_name: 'Agent', redirect_uris: [REDIRECT] },
    '1.1.1.1'
  );
  return c.client_id;
}

/** Runs authorize → consent → returns the auth code */
async function authorize(
  clientId: string,
  challenge: string,
  opts: { user?: string; bound?: string; scopes?: string[]; scope?: string } = {}
): Promise<string> {
  const { requestId } = await startAuthorization(deps, {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: opts.scope ?? 'mcp:*',
    state: 'st',
  });
  const res = await decideConsent(deps, opts.user ?? 'u1', requestId, {
    decision: 'approve',
    bound_client_id: opts.bound ?? 'k1',
    scopes: opts.scopes ?? ['mcp:github'],
    ttl_seconds: 3600,
  });
  const u = new URL(res.redirect_url);
  expect(u.searchParams.get('state')).toBe('st');
  return u.searchParams.get('code')!;
}

const tokenReq = (clientId: string, code: string, verifier: string) =>
  ({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  }) as const;

async function oauthGrant(): Promise<{ clientId: string; token: string; grantId: string }> {
  const clientId = await newClient();
  const p = pkce();
  const code = await authorize(clientId, p.challenge);
  const t = (await exchangeToken(deps, tokenReq(clientId, code, p.verifier), '1.1.1.1')) as any;
  const row = raw(db)
    .prepare(`SELECT grant_id, kind FROM agent_grants WHERE client_id=?`)
    .get(clientId);
  expect(row.kind).toBe('oauth');
  return { clientId, token: t.access_token, grantId: row.grant_id };
}

describe('grant kind', () => {
  it('an oauth grant whose client_id is NULL is dead; a one-shot grant with NULL client_id is valid', async () => {
    const { token, grantId } = await oauthGrant();
    expect((await validateAgentToken(deps, token)).ok).toBe(true);
    raw(db).prepare(`UPDATE agent_grants SET client_id=NULL WHERE grant_id=?`).run(grantId);
    expect(await validateAgentToken(deps, token)).toEqual({ ok: false, reason: 'revoked' });

    const one = await createGrant(deps, 'u1', {
      bound_client_id: 'k1',
      label: 'ci',
      scopes: ['mcp:github'],
    });
    expect((await getAgentGrant(db, one.grant_id))!.kind).toBe('one_shot');
    expect((await validateAgentToken(deps, one.access_token)).ok).toBe(true);
  });

  it('migration 0003 is re-runnable (duplicate column tolerated)', async () => {
    await expect(runMigrations(db)).resolves.toBeUndefined();
    const cols = raw(db).prepare(`PRAGMA table_info(agent_grants)`).all();
    expect(cols.filter((c: any) => c.name === 'kind')).toHaveLength(1);
  });
});

describe('client disable / delete', () => {
  it('disable closes the client streams and keeps the grants (re-enable restores)', async () => {
    const { clientId, token, grantId } = await oauthGrant();
    const spy = vi.spyOn(deps.streams, 'closeGrant');
    await adminSetClientDisabled(deps, 'admin', clientId, true, '1.1.1.1');
    expect(spy).toHaveBeenCalledWith(grantId);
    expect(await validateAgentToken(deps, token)).toEqual({ ok: false, reason: 'revoked' });
    await adminSetClientDisabled(deps, 'admin', clientId, false, '1.1.1.1');
    expect((await validateAgentToken(deps, token)).ok).toBe(true);
  });

  it('delete: disables first, revokes + retains grants, closes streams, audits each grant', async () => {
    const { clientId, token, grantId } = await oauthGrant();
    const spy = vi.spyOn(deps.streams, 'closeGrant');
    events.length = 0;
    await adminDeleteClient(deps, 'admin', clientId, '1.1.1.1');
    expect(spy).toHaveBeenCalledWith(grantId);
    const g = (await getAgentGrant(db, grantId))!;
    expect(g.revoked_at).toBeTruthy();
    expect(g.revoked_by).toBe('admin');
    expect(g.client_id).toBeNull();
    expect(await validateAgentToken(deps, token)).toEqual({ ok: false, reason: 'revoked' });
    const revoked = events.filter(e => e.action === 'agent_grant_revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0].metadata).toMatchObject({
      agent_grant_id: grantId,
      reason: 'oauth_client_deleted',
    });
    const del = events.find(e => e.action === 'oauth_client_deleted');
    expect(del.metadata).toMatchObject({ grants_revoked: 1 });
    expect(events.findIndex(e => e.action === 'agent_grant_revoked')).toBeLessThan(
      events.findIndex(e => e.action === 'oauth_client_deleted')
    );
  });
});
