/**
 * OAuth Routes
 *
 * OAuth 2.0 authorization and token management endpoints per ADR-014.
 * Handles the full OAuth lifecycle: authorization, callback, status, and disconnect.
 *
 * @see ADR-014: OAuth Routes Implementation
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient, OAuthConfig, OAuthCredentialBlob } from '@mcpambassador/core';
import {
  users,
  user_mcp_credentials,
  compatInsert,
  compatSelect,
  compatUpdate,
  compatDelete,
} from '@mcpambassador/core';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireUserSession } from '../auth/user-session.js';
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';
import type { OAuthTokenManager } from '../services/oauth-token-manager.js';
import type { CredentialVault } from '../services/credential-vault.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';

/**
 * OAuth routes configuration
 */
export interface OAuthRoutesConfig {
  db: DatabaseClient;
  vault: CredentialVault;
  oauthManager: OAuthTokenManager;
  userPool: UserMcpPool | null;
  portalBaseUrl: string; // e.g. "https://mcpambassador.example.com:9443"
}

/**
 * Zod schema for POST /v1/users/me/oauth/authorize request body
 */
const oauthAuthorizeSchema = z.object({
  mcp_name: z.string().min(1),
}).strict();

/**
 * Register OAuth routes
 */
export async function registerOAuthRoutes(
  fastify: FastifyInstance,
  config: OAuthRoutesConfig
): Promise<void> {
  const { db, vault, oauthManager, userPool, portalBaseUrl } = config;

  // Rate limiter for callback endpoint — max 10 requests per minute per IP
  const callbackRateLimits = new Map<string, { count: number; resetAt: number }>();
  const CALLBACK_RATE_LIMIT = 10;
  const CALLBACK_RATE_WINDOW_MS = 60_000;

  function checkCallbackRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = callbackRateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      callbackRateLimits.set(ip, { count: 1, resetAt: now + CALLBACK_RATE_WINDOW_MS });
      return true;
    }
    entry.count++;
    return entry.count <= CALLBACK_RATE_LIMIT;
  }

  // ==========================================================================
  // POST /v1/users/me/oauth/authorize - Initiate OAuth flow
  // ==========================================================================
  fastify.post(
    '/v1/users/me/oauth/authorize',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      console.log('[OAuth Routes] POST /v1/users/me/oauth/authorize');
      const userId = request.session.userId!;

      // Validate body
      const bodyResult = oauthAuthorizeSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send(
          wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', bodyResult.error.issues)
        );
      }

      const { mcp_name } = bodyResult.data;

      try {
        // Look up MCP by name
        const mcpEntry = await db.query.mcp_catalog.findFirst({
          where: (m, { eq }) => eq(m.name, mcp_name),
        });

        if (!mcpEntry) {
          return reply.status(400).send(
            wrapError(ErrorCodes.NOT_FOUND, `MCP '${mcp_name}' not found in catalog`)
          );
        }

        // Verify auth_type === 'oauth2'
        if (mcpEntry.auth_type !== 'oauth2') {
          return reply.status(400).send(
            wrapError(
              ErrorCodes.BAD_REQUEST,
              `MCP '${mcp_name}' does not support OAuth 2.0 (auth_type: ${mcpEntry.auth_type})`
            )
          );
        }

        // Parse oauth_config
        if (!mcpEntry.oauth_config || mcpEntry.oauth_config === '{}') {
          return reply.status(400).send(
            wrapError(ErrorCodes.BAD_REQUEST, `MCP '${mcp_name}' has no OAuth configuration`)
          );
        }

        const oauthConfig = JSON.parse(mcpEntry.oauth_config) as OAuthConfig;

        // Generate authorization URL
        const { authorizationUrl, state } = await oauthManager.generateAuthorizationUrl(
          userId,
          mcpEntry.mcp_id,
          oauthConfig
        );

        console.log(`[OAuth Routes] Generated authorization URL with state=${state.substring(0, 8)}...`);

        return reply.status(200).send(
          wrapSuccess({
            authorization_url: authorizationUrl,
            state,
          })
        );
      } catch (error) {
        console.error('[OAuth Routes] Error generating authorization URL:', error);

        // Check if error is due to missing environment variables
        if (error instanceof Error && error.message.includes('environment variable not set')) {
          return reply.status(500).send(
            wrapError(ErrorCodes.INTERNAL_ERROR, 'OAuth configuration incomplete — required server environment variables are not set. Contact your administrator.')
          );
        }

        return reply.status(500).send(
          wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to generate authorization URL')
        );
      }
    }
  );

  // ==========================================================================
  // GET /v1/oauth/callback - OAuth provider callback (no auth required)
  // ==========================================================================
  fastify.get('/v1/oauth/callback', async (request, reply) => {
    console.log('[OAuth Routes] GET /v1/oauth/callback');

    // Rate limit check
    const clientIp = request.ip || '127.0.0.1';
    if (!checkCallbackRateLimit(clientIp)) {
      console.log(`[OAuth Routes] Rate limited callback from ${clientIp}`);
      return reply.status(429).send('Too many requests');
    }

    // Extract query parameters
    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;

    // Redirect helper
    const redirectWithError = (reason: string) => {
      console.log(`[OAuth Routes] Callback error: ${reason}`);
      return reply.redirect(`${portalBaseUrl}/connections?status=error&reason=${encodeURIComponent(reason)}`);
    };

    // Validate required parameters
    if (!code || !state) {
      return redirectWithError('invalid_request');
    }

    try {
      // Exchange code for tokens
      const { tokenSet, userId, mcpId } = await oauthManager.exchangeCodeForTokens(state, code);

      // Load user to get vault_salt
      const user = await db.query.users.findFirst({
        where: (users, { eq }) => eq(users.user_id, userId),
      });

      if (!user) {
        console.error(`[OAuth Routes] User ${userId} not found after token exchange`);
        return redirectWithError('server_error');
      }

      // Load MCP entry to get name for redirect
      const mcpEntry = await db.query.mcp_catalog.findFirst({
        where: (m, { eq }) => eq(m.mcp_id, mcpId),
      });

      if (!mcpEntry) {
        console.error(`[OAuth Routes] MCP ${mcpId} not found after token exchange`);
        return redirectWithError('server_error');
      }

      const mcpName = mcpEntry.name;

      // Compute expires_at
      const expiresIn = tokenSet.expires_in || 31536000; // Default 1 year
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      const expiresAtIso = expiresAt.toISOString();

      // Build OAuthCredentialBlob
      const blob: OAuthCredentialBlob = {
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token || '',
        token_type: tokenSet.token_type,
        scope: tokenSet.scope || '',
        expires_at: expiresAtIso,
      };

      // Ensure user has a vault_salt (generate if missing — same as credentials route)
      let vaultSalt = user.vault_salt;
      if (!vaultSalt) {
        const { CredentialVault: CV } = await import('../services/credential-vault.js');
        vaultSalt = CV.generateVaultSalt();
        await compatUpdate(db, users)
          .set({ vault_salt: vaultSalt, updated_at: new Date().toISOString() })
          .where(eq(users.user_id, userId));
        console.log(`[OAuth Routes] Generated vault_salt for user ${userId}`);
      }

      // Encrypt blob
      const encrypted = vault.encrypt(vaultSalt, JSON.stringify(blob));

      // Check if credential exists
      const [existing] = await compatSelect(db)
        .from(user_mcp_credentials)
        .where(
          and(
            eq(user_mcp_credentials.user_id, userId),
            eq(user_mcp_credentials.mcp_id, mcpId)
          )
        )
        .limit(1);

      const now = new Date().toISOString();

      if (existing) {
        // Update existing credential
        await compatUpdate(db, user_mcp_credentials)
          .set({
            encrypted_credentials: encrypted.encryptedCredentials,
            encryption_iv: encrypted.iv,
            credential_type: 'oauth2',
            oauth_status: 'active',
            expires_at: expiresAtIso,
            updated_at: now,
          })
          .where(eq(user_mcp_credentials.credential_id, existing.credential_id));

        console.log(`[OAuth Routes] Updated OAuth credential for user=${userId}, mcp=${mcpName}`);
      } else {
        // Insert new credential
        await compatInsert(db, user_mcp_credentials).values({
          credential_id: uuidv4(),
          user_id: userId,
          mcp_id: mcpId,
          encrypted_credentials: encrypted.encryptedCredentials,
          encryption_iv: encrypted.iv,
          credential_type: 'oauth2',
          oauth_status: 'active',
          expires_at: expiresAtIso,
          created_at: now,
          updated_at: now,
        });

        console.log(`[OAuth Routes] Stored new OAuth credential for user=${userId}, mcp=${mcpName}`);
      }

      // Redirect to success page
      return reply.redirect(`${portalBaseUrl}/connections?status=success&mcp=${encodeURIComponent(mcpName)}`);
    } catch (error) {
      console.error('[OAuth Routes] Error in OAuth callback:', error);

      // Determine error code
      let errorCode = 'server_error';
      if (error instanceof Error) {
        if (error.message.includes('Invalid or expired OAuth state')) {
          errorCode = 'invalid_state';
        } else if (error.message.includes('Token exchange failed')) {
          errorCode = 'token_exchange_failed';
        }
      }

      return redirectWithError(errorCode);
    }
  });

  // ==========================================================================
  // GET /v1/users/me/oauth/status/:mcpName - Get OAuth connection status
  // ==========================================================================
  fastify.get(
    '/v1/users/me/oauth/status/:mcpName',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = request.params as { mcpName: string };
      const mcpName = params.mcpName;

      console.log(`[OAuth Routes] GET /v1/users/me/oauth/status/${mcpName}`);

      try {
        // Look up MCP by name
        const mcpEntry = await db.query.mcp_catalog.findFirst({
          where: (m, { eq }) => eq(m.name, mcpName),
        });

        if (!mcpEntry) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `MCP '${mcpName}' not found in catalog`)
          );
        }

        if (mcpEntry.auth_type !== 'oauth2') {
          return reply.status(404).send(
            wrapError(
              ErrorCodes.NOT_FOUND,
              `MCP '${mcpName}' does not support OAuth 2.0 (auth_type: ${mcpEntry.auth_type})`
            )
          );
        }

        // Look up credential
        const [credential] = await compatSelect(db)
          .from(user_mcp_credentials)
          .where(
            and(
              eq(user_mcp_credentials.user_id, userId),
              eq(user_mcp_credentials.mcp_id, mcpEntry.mcp_id),
              eq(user_mcp_credentials.credential_type, 'oauth2')
            )
          )
          .limit(1);

        // No credential found
        if (!credential) {
          return reply.status(200).send(
            wrapSuccess({
              mcp_name: mcpName,
              status: 'not_connected',
              expires_at: null,
              scopes: null,
            })
          );
        }

        // Map oauth_status to response status
        let status = credential.oauth_status || 'not_connected';

        // Check if expired based on expires_at
        if (status === 'active' && credential.expires_at) {
          const expiresAt = new Date(credential.expires_at);
          const now = new Date();
          if (expiresAt < now) {
            status = 'expired';
          }
        }

        return reply.status(200).send(
          wrapSuccess({
            mcp_name: mcpName,
            status,
            expires_at: credential.expires_at || null,
            scopes: null, // Would require decrypt, returning null for now
          })
        );
      } catch (error) {
        console.error('[OAuth Routes] Error checking OAuth status:', error);
        return reply.status(500).send(
          wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to check OAuth status')
        );
      }
    }
  );

  // ==========================================================================
  // DELETE /v1/users/me/oauth/disconnect/:mcpName - Disconnect OAuth
  // ==========================================================================
  fastify.delete(
    '/v1/users/me/oauth/disconnect/:mcpName',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = request.params as { mcpName: string };
      const mcpName = params.mcpName;

      console.log(`[OAuth Routes] DELETE /v1/users/me/oauth/disconnect/${mcpName}`);

      try {
        // Look up MCP by name
        const mcpEntry = await db.query.mcp_catalog.findFirst({
          where: (m, { eq }) => eq(m.name, mcpName),
        });

        if (!mcpEntry) {
          return reply.status(404).send(
            wrapError(ErrorCodes.NOT_FOUND, `MCP '${mcpName}' not found in catalog`)
          );
        }

        if (mcpEntry.auth_type !== 'oauth2') {
          return reply.status(400).send(
            wrapError(
              ErrorCodes.BAD_REQUEST,
              `MCP '${mcpName}' does not support OAuth 2.0 (auth_type: ${mcpEntry.auth_type})`
            )
          );
        }

        // Parse oauth_config
        const oauthConfig = mcpEntry.oauth_config && mcpEntry.oauth_config !== '{}'
          ? (JSON.parse(mcpEntry.oauth_config) as OAuthConfig)
          : null;

        // Look up credential
        const [credential] = await compatSelect(db)
          .from(user_mcp_credentials)
          .where(
            and(
              eq(user_mcp_credentials.user_id, userId),
              eq(user_mcp_credentials.mcp_id, mcpEntry.mcp_id),
              eq(user_mcp_credentials.credential_type, 'oauth2')
            )
          )
          .limit(1);

        // If credential exists, revoke tokens and delete
        if (credential) {
          // Load user to get vault_salt for decryption
          const user = await db.query.users.findFirst({
            where: (users, { eq }) => eq(users.user_id, userId),
          });

          if (user && oauthConfig) {
            try {
              // Ensure user has a vault_salt (generate if missing)
              let vaultSalt = user.vault_salt;
              if (!vaultSalt) {
                const { CredentialVault: CV } = await import('../services/credential-vault.js');
                vaultSalt = CV.generateVaultSalt();
                await compatUpdate(db, users)
                  .set({ vault_salt: vaultSalt, updated_at: new Date().toISOString() })
                  .where(eq(users.user_id, userId));
                console.log(`[OAuth Routes] Generated vault_salt for user ${userId}`);
              }

              // Decrypt to get tokens for revocation
              const decrypted = vault.decrypt(
                vaultSalt,
                credential.encrypted_credentials,
                credential.encryption_iv
              );
              const blob = JSON.parse(decrypted) as OAuthCredentialBlob;

              // Best-effort token revocation
              await oauthManager.revokeTokens(
                oauthConfig,
                blob.access_token,
                blob.refresh_token
              );
            } catch (error) {
              // Log error but continue with deletion
              console.error('[OAuth Routes] Error revoking tokens (continuing with deletion):', error);
            }
          }

          // Delete credential
          await compatDelete(db, user_mcp_credentials)
            .where(eq(user_mcp_credentials.credential_id, credential.credential_id));

          console.log(`[OAuth Routes] Deleted OAuth credential for user=${userId}, mcp=${mcpName}`);
        }

        // Terminate user's MCP instances
        if (userPool) {
          try {
            await userPool.terminateForUser(userId);
            console.log(`[OAuth Routes] Terminated MCP instances for user=${userId}`);
          } catch (error) {
            console.error('[OAuth Routes] Error terminating MCP instances:', error);
          }
        }

        return reply.status(200).send(
          wrapSuccess({
            mcp_name: mcpName,
            status: 'disconnected',
          })
        );
      } catch (error) {
        console.error('[OAuth Routes] Error disconnecting OAuth:', error);
        return reply.status(500).send(
          wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to disconnect OAuth')
        );
      }
    }
  );

  console.log('[OAuth Routes] Registered OAuth routes');
}
