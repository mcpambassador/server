/**
 * ADR-020 P4: built-in authorization server service tests (real SQLite).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  AgentEndpointConfigSchema,
  revokeGrantsForBoundClient,
  type DatabaseClient,
} from '@mcpambassador/core';
import {
  createAgentEndpointDeps,
  resolveAgentEndpointConfig,
  startAuthorization,
  getConsentDetails,
  decideConsent,
  exchangeToken,
  verifyAccessToken,
  validateAgentToken,
  updateSettings,
  loadPersistedSettings,
  registerClient,
  revokeToken,
  createGrant,
  listGrants,
  revokeGrant,
  revokeClientGrantsWithAudit,
  adminCreateClient,
  adminListGrants,
  isAcceptableRedirectUri,
  OAuthError,
  AgentApiError,
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

describe('authorize + consent', () => {
  it('rejects unknown client, unregistered redirect_uri and wrong resource without a request', async () => {
    const id = await newClient();
    const base = {
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    } as const;
    await expect(startAuthorization(deps, { ...base, client_id: 'nope' })).rejects.toMatchObject({
      error: 'invalid_client',
    });
    await expect(
      startAuthorization(deps, { ...base, redirect_uri: 'http://localhost:1/other' })
    ).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(
      startAuthorization(deps, { ...base, resource: 'https://evil.test/mcp' })
    ).rejects.toMatchObject({ error: 'invalid_target' });
    await expect(startAuthorization(deps, { ...base, scope: 'bogus' })).rejects.toMatchObject({
      error: 'invalid_scope',
    });
  });

  it('binds the request to the first user; others get 403; shows only own active clients', async () => {
    const id = await newClient();
    const { requestId } = await startAuthorization(deps, {
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const d = await getConsentDetails(deps, 'u1', requestId);
    expect(d.client_verified).toBe(true);
    expect(d.clients.map(c => c.client_id).sort()).toEqual(['k1', 'k1b']);
    expect(d.clients.find(c => c.client_id === 'k1')!.subscriptions[0]!.scope).toBe('mcp:github');
    await expect(getConsentDetails(deps, 'u2', requestId)).rejects.toMatchObject({ status: 403 });
    await expect(getConsentDetails(deps, 'u1', 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects another user’s client and unsubscribed/unrequested scopes; request stays usable', async () => {
    const id = await newClient();
    const { requestId } = await startAuthorization(deps, {
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'mcp:github',
    });
    const base = { decision: 'approve', scopes: ['mcp:github'], ttl_seconds: 600 } as const;
    await expect(
      decideConsent(deps, 'u1', requestId, { ...base, bound_client_id: 'k2' })
    ).rejects.toBeInstanceOf(AgentApiError);
    await expect(
      decideConsent(deps, 'u1', requestId, {
        ...base,
        bound_client_id: 'k1',
        scopes: ['mcp:slack'],
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      decideConsent(deps, 'u1', requestId, { ...base, bound_client_id: 'k1', scopes: ['mcp:*'] })
    ).rejects.toMatchObject({ status: 400 });
    // still usable after fixable mistakes
    const ok = await decideConsent(deps, 'u1', requestId, { ...base, bound_client_id: 'k1' });
    expect(new URL(ok.redirect_url).searchParams.get('code')).toBeTruthy();
    // single use
    await expect(
      decideConsent(deps, 'u1', requestId, { ...base, bound_client_id: 'k1' })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('deny redirects with access_denied and state', async () => {
    const id = await newClient();
    const { requestId } = await startAuthorization(deps, {
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'xyz',
    });
    const r = await decideConsent(deps, 'u1', requestId, {
      decision: 'deny',
      scopes: [],
      ttl_seconds: 60,
    });
    const u = new URL(r.redirect_url);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe('xyz');
  });
});

describe('token endpoint', () => {
  it('full code flow: PKCE, access token verifies, bound client recorded in audit', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(id, challenge);
    const tok = await exchangeToken(deps, tokenReq(id, code, verifier), '2.2.2.2');
    expect(tok.token_type).toBe('Bearer');
    expect(tok.access_token.startsWith('amb_at_')).toBe(true);
    expect(tok.refresh_token!.startsWith('amb_rt_')).toBe(true);
    expect(tok.scope).toBe('mcp:github');
    const v = await verifyAccessToken(deps, tok.access_token);
    expect(v).toMatchObject({
      ok: true,
      principal: { user_id: 'u1', bound_client_id: 'k1', oauth_client_id: id },
    });
    const created = events.find(e => e.action === 'agent_grant_created');
    expect(created.client_id).toBe('k1');
    expect(created.metadata.bound_client_id).toBe('k1');
    // raw secrets never in audit
    expect(JSON.stringify(events)).not.toContain(tok.access_token);
    expect(JSON.stringify(events)).not.toContain(tok.refresh_token!);
    // raw secrets never in the DB
    const dump = JSON.stringify([
      raw(db).prepare('SELECT * FROM agent_tokens').all(),
      raw(db).prepare('SELECT * FROM oauth_auth_codes').all(),
    ]);
    expect(dump).not.toContain(tok.access_token);
    expect(dump).not.toContain(tok.refresh_token!);
    expect(dump).not.toContain(code);
  });

  it('rejects wrong verifier, replayed code, wrong redirect_uri, wrong resource', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(id, challenge);
    await expect(
      exchangeToken(deps, tokenReq(id, code, pkce().verifier), '3.3.3.3')
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    // code is burned by the failed attempt
    await expect(
      exchangeToken(deps, tokenReq(id, code, verifier), '3.3.3.3')
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    const c2 = await authorize(id, challenge);
    await expect(
      exchangeToken(
        deps,
        { ...tokenReq(id, c2, verifier), redirect_uri: 'http://localhost:7777/other' },
        '3.3.3.3'
      )
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    const c3 = await authorize(id, challenge);
    await expect(
      exchangeToken(
        deps,
        { ...tokenReq(id, c3, verifier), resource: 'https://evil.test/mcp' },
        '3.3.3.3'
      )
    ).rejects.toMatchObject({ error: 'invalid_target' });
  });

  it('code is bound to its client', async () => {
    const a = await newClient();
    const b = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(a, challenge);
    await expect(exchangeToken(deps, tokenReq(b, code, verifier), '4.4.4.4')).rejects.toMatchObject(
      { error: 'invalid_grant' }
    );
  });

  it('rotates refresh tokens; reuse of an old one revokes the family', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const t1 = await exchangeToken(
      deps,
      tokenReq(id, await authorize(id, challenge), verifier),
      '5.5.5.5'
    );
    const refresh = (rt: string) =>
      exchangeToken(
        deps,
        { grant_type: 'refresh_token', refresh_token: rt, client_id: id },
        '5.5.5.5'
      );
    const t2 = await refresh(t1.refresh_token!);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await verifyAccessToken(deps, t2.access_token)).ok).toBe(true);
    // attacker replays the old refresh token
    await expect(refresh(t1.refresh_token!)).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(events.some(e => e.action === 'agent_refresh_reuse_detected')).toBe(true);
    // legitimate holder's newest token and access token are now dead too
    await expect(refresh(t2.refresh_token!)).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(await verifyAccessToken(deps, t2.access_token)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('refresh lifetime never exceeds the grant expiry', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    await exchangeToken(deps, tokenReq(id, await authorize(id, challenge), verifier), '6.6.6.6');
    const g = raw(db).prepare('SELECT expires_at FROM agent_grants').get();
    const rt = raw(db).prepare(`SELECT expires_at FROM agent_tokens WHERE kind='refresh'`).get();
    expect(rt.expires_at).toBe(g.expires_at);
  });

  it('refresh tokens disabled → no refresh_token issued', async () => {
    deps.config.refresh_tokens_enabled = false;
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const t = await exchangeToken(
      deps,
      tokenReq(id, await authorize(id, challenge), verifier),
      '7.7.7.7'
    );
    expect(t.refresh_token).toBeUndefined();
  });

  it('rate limits per IP+client', async () => {
    const id = await newClient();
    const limit = deps.config.rate_limits.token_per_minute;
    let last: unknown;
    for (let i = 0; i <= limit; i++) {
      last = await exchangeToken(deps, tokenReq(id, 'bogus', pkce().verifier), '8.8.8.8').catch(
        e => e
      );
    }
    expect(last).toBeInstanceOf(OAuthError);
    expect((last as OAuthError).status).toBe(429);
  });
});

describe('bound-client model', () => {
  async function liveToken() {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const t = await exchangeToken(
      deps,
      tokenReq(id, await authorize(id, challenge), verifier),
      '9.9.9.9'
    );
    return { id, t };
  }

  it('suspending the bound client kills access and refresh on the next call', async () => {
    const { id, t } = await liveToken();
    raw(db).prepare(`UPDATE clients SET status='suspended' WHERE client_id='k1'`).run();
    expect(await verifyAccessToken(deps, t.access_token)).toEqual({ ok: false, reason: 'revoked' });
    await expect(
      exchangeToken(
        deps,
        { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: id },
        '9.9.9.9'
      )
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('suspending the user kills the grant', async () => {
    const { t } = await liveToken();
    raw(db).prepare(`UPDATE users SET status='suspended' WHERE user_id='u1'`).run();
    expect((await verifyAccessToken(deps, t.access_token)).ok).toBe(false);
  });

  it('revoking the user’s other client does not affect the grant', async () => {
    const { t } = await liveToken();
    raw(db).prepare(`UPDATE clients SET status='suspended' WHERE client_id='k1b'`).run();
    expect((await verifyAccessToken(deps, t.access_token)).ok).toBe(true);
  });

  it('disabling the OAuth client kills its grants', async () => {
    const { id, t } = await liveToken();
    raw(db).prepare(`UPDATE oauth_clients SET disabled=1 WHERE client_id=?`).run(id);
    expect((await verifyAccessToken(deps, t.access_token)).ok).toBe(false);
  });

  it('rejects tokens that are unknown, malformed or expired', async () => {
    expect(await verifyAccessToken(deps, 'garbage')).toEqual({ ok: false, reason: 'bad_token' });
    expect(await verifyAccessToken(deps, 'amb_at_nope')).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    const { t } = await liveToken();
    raw(db)
      .prepare(`UPDATE agent_tokens SET expires_at=?`)
      .run(new Date(Date.now() - 1000).toISOString());
    expect(await verifyAccessToken(deps, t.access_token)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('one-shot grants', () => {
  it('creates a no-refresh grant bound to the chosen client; scopes checked against that client', async () => {
    const g = await createGrant(deps, 'u1', {
      bound_client_id: 'k1b',
      label: 'ci',
      scopes: ['mcp:slack'],
      ttl_seconds: 600,
    });
    expect(g.resource).toBe(RESOURCE);
    expect((await verifyAccessToken(deps, g.access_token)).ok).toBe(true);
    const list = await listGrants(deps, 'u1');
    expect(list[0]).toMatchObject({
      client_id: null,
      bound_client_id: 'k1b',
      bound_client_name: 'name-k1b',
      has_refresh_token: false,
    });
    await expect(
      createGrant(deps, 'u1', { bound_client_id: 'k1b', label: 'x', scopes: ['mcp:github'] })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createGrant(deps, 'u1', { bound_client_id: 'k2', label: 'x', scopes: ['mcp:github'] })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('TTL is clamped to max_grant_ttl_seconds', async () => {
    const g = await createGrant(deps, 'u1', {
      bound_client_id: 'k1',
      label: 'long',
      scopes: ['mcp:github'],
      ttl_seconds: 10 * 86400,
    });
    const max = deps.config.max_grant_ttl_seconds * 1000;
    expect(new Date(g.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(max + 1000);
  });

  it('users revoke their own grants only; admins can revoke any (audited as admin)', async () => {
    const g = await createGrant(deps, 'u1', {
      bound_client_id: 'k1',
      label: 'a',
      scopes: ['mcp:github'],
    });
    await expect(
      revokeGrant(deps, { user_id: 'u2', admin: false }, g.grant_id)
    ).rejects.toMatchObject({ status: 404 });
    await revokeGrant(deps, { user_id: 'admin', admin: true }, g.grant_id, '1.2.3.4');
    expect(await verifyAccessToken(deps, g.access_token)).toEqual({ ok: false, reason: 'revoked' });
    const ev = events.find(e => e.action === 'agent_grant_revoked');
    expect(ev.user_id).toBe('admin');
    expect(ev.metadata).toMatchObject({ target_user_id: 'u1', by_admin: true });
    const all = await adminListGrants(deps, { include_inactive: true, limit: 10 });
    expect(all.items[0]).toMatchObject({ username: 'u1', revoked_by: 'admin' });
  });
});

describe('registration + revocation', () => {
  it('DCR is refused when disabled, accepted when enabled, rate limited, capped', async () => {
    deps.runtime.dynamic_client_registration = false;
    await expect(
      registerClient(deps, { client_name: 'x', redirect_uris: [REDIRECT] }, '1.1.1.1')
    ).rejects.toMatchObject({ error: 'access_denied', status: 403 });
    deps.runtime.dynamic_client_registration = true;
    const r = await registerClient(
      deps,
      { client_name: 'x', redirect_uris: [REDIRECT] },
      '1.1.1.1'
    );
    expect(r.token_endpoint_auth_method).toBe('none');
    // DCR clients are flagged unverified on the consent screen
    const { requestId } = await startAuthorization(deps, {
      response_type: 'code',
      client_id: r.client_id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect((await getConsentDetails(deps, 'u1', requestId)).client_verified).toBe(false);
    deps.config.max_oauth_clients = 2;
    await expect(
      registerClient(deps, { client_name: 'y', redirect_uris: [REDIRECT] }, '1.1.1.2')
    ).resolves.toBeTruthy();
    await expect(
      registerClient(deps, { client_name: 'z', redirect_uris: [REDIRECT] }, '1.1.1.3')
    ).rejects.toMatchObject({ status: 503 });
    for (let i = 0; i < deps.config.rate_limits.register_per_hour; i++) {
      await registerClient(deps, { client_name: 'q', redirect_uris: [REDIRECT] }, '9.9.9.1').catch(
        () => undefined
      );
    }
    await expect(
      registerClient(deps, { client_name: 'q', redirect_uris: [REDIRECT] }, '9.9.9.1')
    ).rejects.toMatchObject({ status: 429 });
  });

  it('redirect URI policy', () => {
    expect(isAcceptableRedirectUri('https://app.example/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://127.0.0.1:1/cb')).toBe(true);
    expect(isAcceptableRedirectUri('cursor://anysphere.cursor/cb')).toBe(false); // private-use schemes rejected in v1
    expect(isAcceptableRedirectUri('http://[::1]:1/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isAcceptableRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAcceptableRedirectUri('https://app.example/cb#frag')).toBe(false);
    expect(isAcceptableRedirectUri('https://u:p@app.example/cb')).toBe(false);
    expect(isAcceptableRedirectUri('not a url')).toBe(false);
  });

  it('revocation: only the owning client, refresh revokes family, unknown tokens are a no-op', async () => {
    const a = await newClient();
    const b = await newClient();
    const { verifier, challenge } = pkce();
    const t = await exchangeToken(
      deps,
      tokenReq(a, await authorize(a, challenge), verifier),
      '1.1.1.1'
    );
    await revokeToken(deps, { token: 'amb_rt_unknown', client_id: a });
    await revokeToken(deps, { token: t.refresh_token!, client_id: b }); // wrong client: ignored
    expect((await verifyAccessToken(deps, t.access_token)).ok).toBe(true);
    await revokeToken(deps, { token: t.refresh_token!, client_id: a });
    expect((await verifyAccessToken(deps, t.access_token)).ok).toBe(false);
    expect(JSON.stringify(events)).not.toContain(t.refresh_token!);
  });
});

describe('R2: bound client lifecycle + persisted settings', () => {
  it('validateAgentToken rejects once the bound client is deleted (revoke-and-retain, null binding)', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(id, challenge);
    const tok = await exchangeToken(deps, tokenReq(id, code, verifier), '2.2.2.2');
    expect((await validateAgentToken(deps, tok.access_token)).ok).toBe(true);

    // same ordering as client-service.revokeUserClient: revoke first, then delete (FK -> SET NULL)
    const revoked = await revokeGrantsForBoundClient(db, 'k1', 'u1');
    expect(revoked).toHaveLength(1);
    raw(db).prepare(`DELETE FROM clients WHERE client_id='k1'`).run();
    const v = await validateAgentToken(deps, tok.access_token);
    expect(v.ok).toBe(false);

    // grant is retained, unbound, still listed
    const row = raw(db).prepare(`SELECT bound_client_id, revoked_at FROM agent_grants`).get();
    expect(row.bound_client_id).toBeNull();
    expect(row.revoked_at).toBeTruthy();
    expect((await listGrants(deps, 'u1')).length).toBe(1);
  });

  it('validateAgentToken rejects when the bound client is disabled, even for an unrevoked grant', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(id, challenge);
    const tok = await exchangeToken(deps, tokenReq(id, code, verifier), '2.2.2.2');
    raw(db).prepare(`UPDATE clients SET status='suspended' WHERE client_id='k1'`).run();
    expect((await validateAgentToken(deps, tok.access_token)).ok).toBe(false);
  });

  it('DCR toggle persists, is audited with previous/value, and wins over config on reload', async () => {
    expect(deps.runtime.dynamic_client_registration).toBe(true); // fixture config default
    await updateSettings(deps, 'admin', { dynamic_client_registration: false }, '1.1.1.1');
    const ev = events.filter(e => e.metadata && 'previous' in e.metadata).pop();
    expect(ev.metadata).toMatchObject({ previous: true, value: false });
    deps.runtime.dynamic_client_registration = true; // simulate restart with config default
    await loadPersistedSettings(deps);
    expect(deps.runtime.dynamic_client_registration).toBe(false);
  });

  it('consent details expose redirect_uri_host', async () => {
    const id = await newClient();
    const { requestId } = await startAuthorization(deps, {
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const d = await getConsentDetails(deps, 'u1', requestId);
    expect(d.redirect_uri_host).toBe('localhost:7777');
  });
});

describe('S5 revoke grants on client suspend/revoke', () => {
  it("revokes only that client's grants, retains rows, closes streams, audits each", async () => {
    const g1 = await createGrant(deps, 'u1', {
      bound_client_id: 'k1',
      label: 'a',
      scopes: ['mcp:github'],
    });
    const g2 = await createGrant(deps, 'u1', {
      bound_client_id: 'k1b',
      label: 'b',
      scopes: ['mcp:slack'],
    });
    events.length = 0;
    const closed: string[] = [];
    const n = await revokeClientGrantsWithAudit(
      { db, audit: deps.audit, onGrantsRevoked: ids => closed.push(...ids) },
      'k1',
      'admin-key:ak1',
      '9.9.9.9',
      'bound_client_suspended'
    );
    expect(n).toBe(1);
    expect(closed).toEqual([g1.grant_id]);
    expect(await verifyAccessToken(deps, g1.access_token)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect((await verifyAccessToken(deps, g2.access_token)).ok).toBe(true);
    const ev = events.filter(e => e.action === 'agent_grant_revoked');
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toMatchObject({
      agent_grant_id: g1.grant_id,
      revoked_by: 'admin-key:ak1',
      reason: 'bound_client_suspended',
    });
    const all = await adminListGrants(deps, { include_inactive: true, limit: 10 });
    expect(all.items.find((i: any) => i.grant_id === g1.grant_id)).toMatchObject({
      revoked_by: 'admin-key:ak1',
    });
    // idempotent
    expect(
      await revokeClientGrantsWithAudit({ db, audit: deps.audit }, 'k1', 'x', '1.1.1.1', 'r')
    ).toBe(0);
  });
});

describe('auth code replay + DCR cap scope', () => {
  it('replaying a used code revokes the grant it produced', async () => {
    const id = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(id, challenge);
    const tok = await exchangeToken(deps, tokenReq(id, code, verifier), '2.2.2.2');
    expect((await verifyAccessToken(deps, tok.access_token)).ok).toBe(true);
    events.length = 0;
    await expect(
      exchangeToken(deps, tokenReq(id, code, verifier), '6.6.6.6')
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(await verifyAccessToken(deps, tok.access_token)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    const ev = events.find(e => e.action === 'agent_grant_revoked');
    expect(ev.metadata).toMatchObject({
      reason: 'auth_code_reuse',
      revoked_by: 'system:auth_code_reuse',
    });
  });

  it('a different client replaying the code does not revoke the grant', async () => {
    const id = await newClient();
    const other = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(id, challenge);
    const tok = await exchangeToken(deps, tokenReq(id, code, verifier), '2.2.2.2');
    await expect(
      exchangeToken(deps, tokenReq(other, code, verifier), '6.6.6.6')
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    expect((await verifyAccessToken(deps, tok.access_token)).ok).toBe(true);
  });

  it('max_oauth_clients counts DCR clients only (admin-registered do not consume the cap)', async () => {
    deps.config.max_oauth_clients = 1;
    await newClient();
    await newClient();
    await expect(
      registerClient(deps, { client_name: 'd1', redirect_uris: [REDIRECT] }, '3.3.3.1')
    ).resolves.toBeTruthy();
    await expect(
      registerClient(deps, { client_name: 'd2', redirect_uris: [REDIRECT] }, '3.3.3.2')
    ).rejects.toMatchObject({ status: 503 });
    await expect(newClient()).resolves.toBeTruthy();
  });
});
