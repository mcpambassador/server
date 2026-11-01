/**
 * TD-027: private store for server-held OAuth client secrets, captured at startup BEFORE the env
 * scrub. A secret is bound to the token_url hosts it may be sent to. Never reads process.env.
 */

/**
 * The only server-held OAuth client secrets this server knows how to bind, and the token hosts
 * each may be sent to. bin/server.ts captures env values ONLY for these names, and the registry
 * importer treats any other client_secret_env as INVALID (no presence oracle for other names).
 */
export const SUPPORTED_OAUTH_CLIENT_SECRETS: Readonly<
  Record<string, { allowedTokenHosts: readonly string[] }>
> = Object.freeze({
  GITHUB_OAUTH_CLIENT_SECRET: { allowedTokenHosts: ['github.com'] },
});

/**
 * Static check, independent of whether the secret is configured: `name` is a supported secret and
 * every given URL is https on a host it may be sent to.
 */
export function isSupportedSecretBinding(name: string, urls: Array<string | undefined>): boolean {
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_OAUTH_CLIENT_SECRETS, name)) return false;
  const hosts = SUPPORTED_OAUTH_CLIENT_SECRETS[name]!.allowedTokenHosts;
  for (const url of urls) {
    if (url === undefined) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !hosts.includes(u.hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

export interface SecretEntry {
  value: string;
  allowedTokenHosts: string[];
}

export class SecretStore {
  private readonly entries: Map<string, SecretEntry>;

  constructor(entries: Record<string, SecretEntry> = {}) {
    this.entries = new Map(
      Object.entries(entries).map(([k, v]) => [
        k,
        { value: v.value, allowedTokenHosts: v.allowedTokenHosts.map(h => h.toLowerCase()) },
      ])
    );
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Throws OAuthConfigError unless `name` is a store secret permitted for tokenUrl's host. */
  assertBinding(name: string, tokenUrl: string): void {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new OAuthConfigError(`client_secret_env ${name} is not an available secret`);
    }
    let host: string;
    try {
      const u = new URL(tokenUrl);
      if (u.protocol !== 'https:') {
        throw new OAuthConfigError('client_secret_env requires an https URL');
      }
      host = u.hostname.toLowerCase();
    } catch (e) {
      if (e instanceof OAuthConfigError) throw e;
      throw new OAuthConfigError('token_url is not a valid URL');
    }
    if (!entry.allowedTokenHosts.includes(host)) {
      throw new OAuthConfigError('client_secret_env not permitted for this token_url');
    }
  }

  /** Re-checks the host binding, then returns the secret value. */
  resolve(name: string, tokenUrl: string): string {
    this.assertBinding(name, tokenUrl);
    return this.entries.get(name)!.value;
  }

  /**
   * Save/import-time check of an MCP's oauth_config: https auth_url, and the client secret
   * must be a store secret permitted for token_url AND revocation_url (both receive it).
   */
  assertOAuthConfig(oauth: {
    client_secret_env: string;
    client_id_env?: string;
    token_url: string;
    auth_url?: string;
    revocation_url?: string;
  }): void {
    if (oauth.auth_url !== undefined && !/^https:\/\//i.test(oauth.auth_url)) {
      throw new OAuthConfigError('auth_url must use https');
    }
    if (
      oauth.client_id_env !== undefined &&
      !/^[A-Z][A-Z0-9_]*_CLIENT_ID$/.test(oauth.client_id_env)
    ) {
      throw new OAuthConfigError('client_id_env must end with _CLIENT_ID');
    }
    this.assertBinding(oauth.client_secret_env, oauth.token_url);
    if (oauth.revocation_url) this.assertBinding(oauth.client_secret_env, oauth.revocation_url);
  }
}
