/**
 * Remote agent endpoint types (ADR-020).
 * Mirrors packages/contracts/src/agent-endpoint.ts (the SPA does not depend on the contracts package).
 */

export interface ConsentSubscription {
  name: string;
  scope: string;
  description?: string;
}

export interface ConsentDetails {
  client_name: string;
  client_verified: boolean;
  requested_scopes: string[];
  available_subscriptions: ConsentSubscription[];
  default_ttl_seconds: number;
  max_ttl_seconds: number;
}

export interface ConsentDecision {
  decision: 'approve' | 'deny';
  scopes: string[];
  tool_allowlist?: string[];
  ttl_seconds: number;
  label?: string;
}

export interface ConsentDecisionResponse {
  redirect_url: string;
}

export interface AgentGrantSummary {
  grant_id: string;
  label: string;
  client_id: string | null;
  client_name: string | null;
  scopes: string[];
  tool_allowlist: string[] | null;
  resource: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  has_refresh_token: boolean;
}

export interface CreateGrantRequest {
  label: string;
  scopes: string[];
  tool_allowlist?: string[];
  ttl_seconds?: number;
}

export interface CreateGrantResponse {
  grant_id: string;
  access_token: string;
  token_type: 'Bearer';
  expires_at: string;
  resource: string;
  scopes: string[];
}

export interface OAuthClientSummary {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  registered_via: 'admin' | 'dcr';
  created_at: string;
  last_used_at: string | null;
  disabled: boolean;
}

export interface AgentEndpointSettings {
  enabled: boolean;
  dynamic_client_registration: boolean;
}

export type GrantStatus = 'active' | 'expired' | 'revoked';

export function grantStatus(
  g: Pick<AgentGrantSummary, 'revoked_at' | 'expires_at'>,
  now = Date.now()
): GrantStatus {
  if (g.revoked_at) return 'revoked';
  return new Date(g.expires_at).getTime() <= now ? 'expired' : 'active';
}

/** Parse a newline/comma separated tool allowlist; returns undefined when empty. */
export function parseToolAllowlist(text: string): string[] | undefined {
  const tools = Array.from(
    new Set(
      text
        .split(/[\n,]/)
        .map(t => t.trim())
        .filter(Boolean)
    )
  );
  return tools.length > 0 ? tools : undefined;
}

export const TTL_PRESETS: { seconds: number; label: string }[] = [
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 4 * 3600, label: '4 hours' },
  { seconds: 12 * 3600, label: '12 hours' },
  { seconds: 24 * 3600, label: '24 hours' },
  { seconds: 7 * 24 * 3600, label: '7 days' },
];

/** TTL options ≤ max, always including the default (and the max itself). */
export function ttlOptions(defaultSeconds: number, maxSeconds: number) {
  const opts = new Map<number, string>();
  for (const p of TTL_PRESETS) if (p.seconds <= maxSeconds) opts.set(p.seconds, p.label);
  for (const s of [defaultSeconds, maxSeconds]) {
    if (s >= 60 && s <= maxSeconds && !opts.has(s)) opts.set(s, formatDuration(s));
  }
  return Array.from(opts, ([seconds, label]) => ({ seconds, label })).sort(
    (a, b) => a.seconds - b.seconds
  );
}

export function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}
