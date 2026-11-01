/** OAuth flow helpers for ADR-020 tests (PKCE, client registration, authorize→consent→token). */
import { createHash, randomBytes } from 'crypto';
import {
  OAUTH_AUTHORIZE_ROUTE,
  OAUTH_TOKEN_ROUTE,
  OAUTH_REVOKE_ROUTE,
  ADMIN_OAUTH_CLIENTS_ROUTE,
} from '@mcpambassador/contracts';
import type { AgentTestServer, UserSession } from './helpers.js';
import { TEST_RESOURCE } from './helpers.js';

export const REDIRECT_URI = 'https://agent.test.example/callback';

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const form = (o: Record<string, string | undefined>): string =>
  new URLSearchParams(
    Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]
  ).toString();

const boundCache = new WeakMap<UserSession, string>();

/** Create one of the user's own Ambassador clients (the thing a grant binds to). */
export async function createAmbClient(sess: UserSession, name = 'bound-client'): Promise<string> {
  const res = await sess.request({
    method: 'POST',
    url: '/v1/users/me/clients',
    payload: { client_name: name },
  });
  if (res.statusCode !== 201) throw new Error(`createAmbClient: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).data.client.id as string;
}

/** The user's default Ambassador client used for bound_client_id (created lazily, cached). */
export async function boundClientId(sess: UserSession): Promise<string> {
  const hit = boundCache.get(sess);
  if (hit) return hit;
  const id = await createAmbClient(sess, 'default-bound');
  boundCache.set(sess, id);
  return id;
}

/** Admin pre-registers a public OAuth client; returns client_id. */
export async function registerAdminClient(
  s: AgentTestServer,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await s.admin.inject({
    method: 'POST',
    url: ADMIN_OAUTH_CLIENTS_ROUTE,
    headers: { 'X-Admin-Key': s.adminKey },
    payload: { client_name: 'verifier-agent', redirect_uris: [REDIRECT_URI], ...overrides },
  });
  if (res.statusCode >= 300) throw new Error(`registerAdminClient: ${res.statusCode} ${res.body}`);
  return (JSON.parse(res.body).data ?? JSON.parse(res.body)).client_id as string;
}

export interface AuthorizeParams {
  client_id: string;
  redirect_uri?: string;
  code_challenge: string;
  code_challenge_method?: string;
  resource?: string;
  scope?: string;
  state?: string;
  response_type?: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  return `${OAUTH_AUTHORIZE_ROUTE}?${form({
    response_type: p.response_type ?? 'code',
    client_id: p.client_id,
    redirect_uri: p.redirect_uri ?? REDIRECT_URI,
    code_challenge: p.code_challenge,
    code_challenge_method: p.code_challenge_method ?? 'S256',
    resource: p.resource ?? TEST_RESOURCE,
    scope: p.scope ?? 'mcp:*',
    state: p.state ?? 'st-' + randomBytes(4).toString('hex'),
  })}`;
}

/** GET /oauth/authorize with the user's session; returns request_id from the 302 Location. */
export async function startAuthorize(
  s: AgentTestServer,
  sess: UserSession,
  p: AuthorizeParams
): Promise<{ requestId: string; location: string }> {
  const res = await s.admin.inject({
    method: 'GET',
    url: authorizeUrl(p),
    headers: sess.headers(),
  });
  const location = String(res.headers['location'] ?? '');
  const requestId = new URL(location, 'https://x.invalid').searchParams.get('request_id') ?? '';
  if (res.statusCode !== 302 || !requestId) {
    throw new Error(`startAuthorize: ${res.statusCode} ${res.body}`);
  }
  return { requestId, location };
}

export function decide(
  sess: UserSession,
  requestId: string,
  body: Record<string, unknown>
): ReturnType<UserSession['request']> {
  return sess.request({ method: 'POST', url: `/v1/oauth/consent/${requestId}`, payload: body });
}

/** Approve and return the authorization code parsed from redirect_url. */
export async function approveAndGetCode(
  sess: UserSession,
  requestId: string,
  body: Record<string, unknown> = {}
): Promise<{ code: string; state: string | null; redirectUrl: string }> {
  const res = await decide(sess, requestId, {
    decision: 'approve',
    bound_client_id: body['bound_client_id'] ?? (await boundClientId(sess)),
    scopes: ['mcp:*'],
    ttl_seconds: 3600,
    ...body,
  });
  if (res.statusCode !== 200) throw new Error(`approve: ${res.statusCode} ${res.body}`);
  const redirectUrl = JSON.parse(res.body).data.redirect_url as string;
  const u = new URL(redirectUrl);
  return {
    code: u.searchParams.get('code') ?? '',
    state: u.searchParams.get('state'),
    redirectUrl,
  };
}

export function tokenRequest(
  s: AgentTestServer,
  body: Record<string, string | undefined>
): ReturnType<AgentTestServer['admin']['inject']> {
  return s.admin.inject({
    method: 'POST',
    url: OAUTH_TOKEN_ROUTE,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(body),
  });
}

export function exchangeCode(
  s: AgentTestServer,
  o: { client_id: string; code: string; verifier: string; redirect_uri?: string; resource?: string }
): ReturnType<typeof tokenRequest> {
  return tokenRequest(s, {
    grant_type: 'authorization_code',
    code: o.code,
    client_id: o.client_id,
    redirect_uri: o.redirect_uri ?? REDIRECT_URI,
    code_verifier: o.verifier,
    resource: o.resource ?? TEST_RESOURCE,
  });
}

export function refresh(
  s: AgentTestServer,
  o: { client_id: string; refresh_token: string; resource?: string }
): ReturnType<typeof tokenRequest> {
  return tokenRequest(s, { grant_type: 'refresh_token', ...o });
}

export function revoke(
  s: AgentTestServer,
  o: { client_id: string; token: string; hint?: 'access_token' | 'refresh_token' }
): ReturnType<AgentTestServer['admin']['inject']> {
  return s.admin.inject({
    method: 'POST',
    url: OAUTH_REVOKE_ROUTE,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ token: o.token, client_id: o.client_id, token_type_hint: o.hint }),
  });
}

/** Full happy path: returns tokens + ids. */
export async function fullFlow(
  s: AgentTestServer,
  sess: UserSession,
  clientId: string,
  opts: { scope?: string; scopes?: string[]; ttl_seconds?: number } = {}
): Promise<{
  access_token: string;
  refresh_token?: string;
  scope: string;
  code: string;
  verifier: string;
}> {
  const { verifier, challenge } = pkce();
  const { requestId } = await startAuthorize(s, sess, {
    client_id: clientId,
    code_challenge: challenge,
    scope: opts.scope,
  });
  const { code } = await approveAndGetCode(sess, requestId, {
    scopes: opts.scopes ?? ['mcp:*'],
    ttl_seconds: opts.ttl_seconds ?? 3600,
  });
  const res = await exchangeCode(s, { client_id: clientId, code, verifier });
  if (res.statusCode !== 200) throw new Error(`fullFlow token: ${res.statusCode} ${res.body}`);
  return { ...JSON.parse(res.body), code, verifier };
}
