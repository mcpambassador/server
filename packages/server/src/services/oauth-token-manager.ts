import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseClient } from '@mcpambassador/core';
import {
  createOAuthState,
  consumeOAuthState,
  cleanupExpiredStates as coreCleanupExpiredStates,
  getMcpEntryById,
  type OAuthConfig,
  type OAuthTokenSet,
} from '@mcpambassador/core';
import type { CredentialVault } from './credential-vault.js';

export interface OAuthTokenManagerConfig {
  db: DatabaseClient;
  vault: CredentialVault;
  callbackBaseUrl: string; // e.g. "https://mcpambassador.example.com:9443"
}

/**
 * OAuthTokenManager implements the OAuth 2.0 token lifecycle per ADR-014.
 * Handles authorization URL construction, code-for-token exchange, token refresh,
 * and token revocation using RFC 6749 / RFC 7636 (PKCE).
 */
export class OAuthTokenManager {
  private db: DatabaseClient;
  // @ts-expect-error - vault available for future use; credential storage handled by routes
  private _vault: CredentialVault;
  private callbackBaseUrl: string;

  constructor(config: OAuthTokenManagerConfig) {
    this.db = config.db;
    this._vault = config.vault;
    this.callbackBaseUrl = config.callbackBaseUrl;
  }

  /**
   * Generate the OAuth authorization URL and store state + PKCE verifier.
   *
   * Steps:
   * 1. Generate state (UUID v4).
   * 2. Generate code_verifier: 64 bytes random → base64url (86 chars).
   * 3. Compute code_challenge = BASE64URL(SHA256(code_verifier)).
   * 4. Store in oauth_states table via createOAuthState from @mcpambassador/core.
   * 5. Build authorization_url from oauthConfig fields.
   * 6. Return { authorizationUrl, state }.
   */
  async generateAuthorizationUrl(
    userId: string,
    mcpId: string,
    oauthConfig: OAuthConfig
  ): Promise<{ authorizationUrl: string; state: string }> {
    console.log(
      `[OAuthTokenManager] Generating authorization URL for user=${userId}, mcp=${mcpId}`
    );

    // 1. Generate state (UUID v4)
    const state = uuidv4();

    // 2. Generate code_verifier: 64 bytes → base64url (no padding)
    const codeVerifier = crypto.randomBytes(64).toString('base64url');

    // 3. Compute code_challenge: SHA256(code_verifier) → base64url (no padding)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // Prepare redirect URI
    const redirectUri = `${this.callbackBaseUrl}/v1/oauth/callback`;

    // State expires after 10 minutes
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    // 4. Store in oauth_states table
    await createOAuthState(this.db, {
      state,
      user_id: userId,
      mcp_id: mcpId,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    // 5. Build authorization URL
    const authUrl = new URL(oauthConfig.auth_url);
    const clientId = this.resolveEnvVar(oauthConfig.client_id_env);

    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Add scopes if present (space-delimited string)
    if (oauthConfig.scopes && oauthConfig.scopes.trim()) {
      authUrl.searchParams.set('scope', oauthConfig.scopes);
    }

    // Add extra params if present (with security blocklist)
    if (oauthConfig.extra_params) {
      const blocklist = new Set([
        'client_id',
        'response_type',
        'redirect_uri',
        'state',
        'code_challenge',
        'code_challenge_method',
        'scope',
      ]);
      for (const [key, value] of Object.entries(oauthConfig.extra_params)) {
        if (!blocklist.has(key.toLowerCase())) {
          authUrl.searchParams.set(key, String(value));
        } else {
          console.warn(
            `[OAuthTokenManager] Blocked extra_param '${key}' — reserved OAuth parameter`
          );
        }
      }
    }

    const authorizationUrl = authUrl.toString();

    console.log(
      `[OAuthTokenManager] Generated authorization URL with state=${state.substring(0, 8)}...`
    );

    // 6. Return
    return { authorizationUrl, state };
  }

  /**
   * Exchange authorization code for tokens.
   *
   * Steps:
   * 1. consumeOAuthState(db, state) — atomic get+delete. If null, throw.
   * 2. Load MCP catalog entry by mcp_id from the consumed state.
   * 3. Parse oauth_config from the MCP entry.
   * 4. Resolve client_id from process.env[oauth_config.client_id_env].
   * 5. Resolve client_secret from process.env[oauth_config.client_secret_env].
   * 6. POST to oauth_config.token_url with grant_type=authorization_code...
   * 7. Parse response → OAuthTokenSet.
   * 8. Return { tokenSet, userId: state.user_id, mcpId: state.mcp_id }.
   */
  async exchangeCodeForTokens(
    state: string,
    code: string
  ): Promise<{ tokenSet: OAuthTokenSet; userId: string; mcpId: string }> {
    console.log(
      `[OAuthTokenManager] Exchanging code for tokens with state=${state.substring(0, 8)}...`
    );

    // 1. consumeOAuthState — atomic get+delete
    const oauthState = await consumeOAuthState(this.db, state);
    if (!oauthState) {
      throw new Error('Invalid or expired OAuth state');
    }

    // 2. Load MCP catalog entry
    const mcpEntry = await getMcpEntryById(this.db, oauthState.mcp_id);
    if (!mcpEntry) {
      throw new Error(`MCP entry not found: ${oauthState.mcp_id}`);
    }

    // 3. Parse oauth_config (stored as JSON string)
    if (!mcpEntry.oauth_config || mcpEntry.oauth_config === '{}') {
      throw new Error(`MCP entry ${oauthState.mcp_id} has no OAuth configuration`);
    }
    const oauthConfig = JSON.parse(mcpEntry.oauth_config) as OAuthConfig;

    // 4 & 5. Resolve client_id and client_secret
    const clientId = this.resolveEnvVar(oauthConfig.client_id_env);
    const clientSecret = this.resolveEnvVar(oauthConfig.client_secret_env);

    // 6. POST to token_url
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', oauthState.redirect_uri);
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
    params.set('code_verifier', oauthState.code_verifier);

    const response = await fetch(oauthConfig.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OAuthTokenManager] Token exchange failed: ${response.status} ${errorText}`);
      throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
    }

    // 7. Parse response → OAuthTokenSet
    const data = (await response.json()) as {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    const tokenSet: OAuthTokenSet = {
      access_token: data.access_token,
      token_type: data.token_type || 'Bearer',
      expires_in: data.expires_in || 31536000, // Default 1 year for providers that don't expire tokens
      refresh_token: data.refresh_token,
      scope: data.scope,
    };

    console.log(`[OAuthTokenManager] Successfully exchanged code for tokens`);

    // 8. Return
    return {
      tokenSet,
      userId: oauthState.user_id,
      mcpId: oauthState.mcp_id,
    };
  }

  /**
   * Refresh an expired access token using the refresh token.
   *
   * Steps:
   * 1. Resolve client_id and client_secret from env vars.
   * 2. POST to oauth_config.token_url with grant_type=refresh_token...
   * 3. Parse response → OAuthTokenSet.
   * 4. Return the token set.
   */
  async refreshAccessToken(oauthConfig: OAuthConfig, refreshToken: string): Promise<OAuthTokenSet> {
    console.log(`[OAuthTokenManager] Refreshing access token`);

    // 1. Resolve client_id and client_secret
    const clientId = this.resolveEnvVar(oauthConfig.client_id_env);
    const clientSecret = this.resolveEnvVar(oauthConfig.client_secret_env);

    // 2. POST to token_url
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);

    const response = await fetch(oauthConfig.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OAuthTokenManager] Token refresh failed: ${response.status} ${errorText}`);
      throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
    }

    // 3. Parse response → OAuthTokenSet
    const data = (await response.json()) as {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    const tokenSet: OAuthTokenSet = {
      access_token: data.access_token,
      token_type: data.token_type || 'Bearer',
      expires_in: data.expires_in || 31536000, // Default 1 year for providers that don't expire tokens
      refresh_token: data.refresh_token, // Some providers rotate refresh tokens
      scope: data.scope,
    };

    console.log(`[OAuthTokenManager] Successfully refreshed access token`);

    // 4. Return
    return tokenSet;
  }

  /**
   * Revoke tokens at the provider's revocation endpoint. Best-effort.
   *
   * Steps:
   * 1. If oauthConfig.revocation_url is absent, return immediately.
   * 2. Resolve client_id/secret.
   * 3. POST to revocation_url with token= and token_type_hint=.
   * 4. Try refresh_token first, then access_token.
   * 5. Catch errors and log — never throw.
   */
  async revokeTokens(
    oauthConfig: OAuthConfig,
    accessToken?: string,
    refreshToken?: string
  ): Promise<void> {
    // 1. If no revocation_url, return immediately
    if (!oauthConfig.revocation_url) {
      console.log(`[OAuthTokenManager] No revocation URL configured, skipping token revocation`);
      return;
    }

    console.log(`[OAuthTokenManager] Revoking tokens`);

    try {
      // 2. Resolve client_id/secret
      const clientId = this.resolveEnvVar(oauthConfig.client_id_env);
      const clientSecret = this.resolveEnvVar(oauthConfig.client_secret_env);

      // 4. Try refresh_token first, then access_token
      const tokensToRevoke: Array<{ token: string; hint: string }> = [];
      if (refreshToken) {
        tokensToRevoke.push({ token: refreshToken, hint: 'refresh_token' });
      }
      if (accessToken) {
        tokensToRevoke.push({ token: accessToken, hint: 'access_token' });
      }

      for (const { token, hint } of tokensToRevoke) {
        try {
          // 3. POST to revocation_url
          const params = new URLSearchParams();
          params.set('token', token);
          params.set('token_type_hint', hint);
          params.set('client_id', clientId);
          params.set('client_secret', clientSecret);

          const response = await fetch(oauthConfig.revocation_url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          });

          if (!response.ok) {
            console.log(
              `[OAuthTokenManager] Token revocation returned ${response.status} for ${hint}`
            );
          } else {
            console.log(`[OAuthTokenManager] Successfully revoked ${hint}`);
          }
        } catch (err) {
          // 5. Catch errors and log — never throw
          console.error(`[OAuthTokenManager] Error revoking ${hint}:`, err);
        }
      }
    } catch (err) {
      // 5. Catch errors and log — never throw
      console.error(`[OAuthTokenManager] Error in revokeTokens:`, err);
    }
  }

  /**
   * Cleanup expired oauth_states rows. Call periodically (every 5 min).
   */
  async cleanupExpiredStates(): Promise<number> {
    console.log(`[OAuthTokenManager] Cleaning up expired OAuth states`);
    const count = await coreCleanupExpiredStates(this.db);
    console.log(`[OAuthTokenManager] Cleaned up ${count} expired OAuth states`);
    return count;
  }

  /**
   * Resolve an environment variable by name.
   *
   * @throws Error if the environment variable is not set
   */
  private resolveEnvVar(envVarName: string): string {
    const value = process.env[envVarName];
    if (!value) {
      throw new Error(`OAuth environment variable not set: ${envVarName}`);
    }
    return value;
  }
}
