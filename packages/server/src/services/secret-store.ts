/**
 * TD-027: private store for server-held OAuth client secrets, captured at startup BEFORE the env
 * scrub. A secret is bound to the token_url hosts it may be sent to. Never reads process.env.
 */

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
    token_url: string;
    auth_url?: string;
    revocation_url?: string;
  }): void {
    if (oauth.auth_url !== undefined && !/^https:\/\//i.test(oauth.auth_url)) {
      throw new OAuthConfigError('auth_url must use https');
    }
    this.assertBinding(oauth.client_secret_env, oauth.token_url);
    if (oauth.revocation_url) this.assertBinding(oauth.client_secret_env, oauth.revocation_url);
  }
}
