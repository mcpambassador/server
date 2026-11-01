/**
 * Remote agent endpoint types (ADR-020).
 * Wire types come from @mcpambassador/contracts (type-only imports, so zod stays out of the bundle).
 */
import type {
  ConsentDetails,
  ConsentClientOption,
  ConsentDecision,
  ConsentDecisionResponse,
  AgentGrantSummary,
  CreateGrantRequest,
  CreateGrantResponse,
  OAuthClientSummary,
  AgentEndpointSettings,
  UserAgentEndpointInfo,
  DisclosureMode,
} from '@mcpambassador/contracts';

export type {
  DisclosureMode,
  UserAgentEndpointInfo,
  ConsentDetails,
  ConsentClientOption,
  ConsentDecision,
  ConsentDecisionResponse,
  AgentGrantSummary,
  CreateGrantRequest,
  CreateGrantResponse,
  OAuthClientSummary,
  AgentEndpointSettings,
};

export type ConsentSubscription = ConsentClientOption['subscriptions'][number];

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

/**
 * ADR-022 disclosure modes. Typed against the contracts' DisclosureMode (type-only import keeps zod
 * out of the bundle); the Record makes a new contract mode a compile error here.
 */
const DISCLOSURE_MODE_LABELS: Record<DisclosureMode, string> = {
  full: 'Full',
  progressive: 'Progressive',
};
export const DISCLOSURE_MODE_OPTIONS: { value: DisclosureMode; label: string }[] = (
  Object.keys(DISCLOSURE_MODE_LABELS) as DisclosureMode[]
).map(value => ({ value, label: DISCLOSURE_MODE_LABELS[value] }));
export const DISCLOSURE_MODE_HELP =
  'Progressive: the agent sees 3 tools (search, describe, call) instead of the full list; same permissions.';
export function disclosureModeLabel(mode: DisclosureMode): string {
  return DISCLOSURE_MODE_LABELS[mode];
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
