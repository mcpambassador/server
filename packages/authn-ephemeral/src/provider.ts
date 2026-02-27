/**
 * Ephemeral Session Authentication Provider
 *
 * Implements AuthenticationProvider SPI for ephemeral session authentication.
 * Uses preshared keys (amb_pk_*) to establish sessions, then session tokens (amb_st_*)
 * for subsequent requests.
 *
 * Security features:
 * - HMAC-SHA256 session tokens with 64-byte secret
 * - Argon2id preshared key hashing
 * - Timing-safe token verification (~0.01ms per request)
 * - Per-user rate limiting
 *
 * @see Architecture §5.1 AuthenticationProvider
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions */

import type {
  AuthenticationProvider,
  AuthRequest,
  AuthResult,
  ProviderHealth,
  SessionContext,
  DatabaseClient,
} from '@mcpambassador/core';
import { logger } from '@mcpambassador/core';
import { verifySessionToken } from './token.js';

/**
 * Ephemeral Session Authentication Provider
 */
export class EphemeralAuthProvider implements AuthenticationProvider {
  readonly id = 'ephemeral';

  constructor(
    private db: DatabaseClient,
    private hmacSecret: Buffer
  ) {}

  /**
   * Initialize provider
   */
  async initialize(_config: Record<string, unknown>): Promise<void> {
    logger.info('[authn-ephemeral] Provider initialized');
  }

  /**
   * Authenticate request using X-Session-Token header
   *
   * Steps:
   * 1. Extract X-Session-Token header
   * 2. Verify token (HMAC validation + DB lookup)
   * 3. Build SessionContext
   * 4. Return AuthResult
   *
   * Performance: ~0.01ms per request (HMAC-SHA256, no Argon2id)
   */
  async authenticate(request: AuthRequest): Promise<AuthResult> {
    // 1. Extract X-Session-Token header
    const sessionToken = request.headers['x-session-token'];

    if (!sessionToken) {
      return {
        success: false,
        error: {
          code: 'missing_credentials',
          message: 'Missing X-Session-Token header',
          provider: this.id,
        },
      };
    }

    try {
      // 2. Verify token
      const verified = await verifySessionToken(this.db, this.hmacSecret, sessionToken);

      // 3. Build SessionContext
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = Math.floor(new Date(verified.expires_at).getTime() / 1000);

      const session: SessionContext = {
        session_id: verified.session_id,
        client_id: verified.client_id,
        user_id: verified.user_id,
        auth_method: this.id,
        groups: [], // Groups will be populated from user table in future milestones
        attributes: {
          profile_id: verified.profile_id,
        },
        issued_at: now,
        expires_at: expiresAt,
        profile_id: verified.profile_id,
      };

      return {
        success: true,
        session,
      };
    } catch (err) {
      // SEC-M19-012: Don't leak error details (timing safety)
      logger.debug(`[authn-ephemeral] Authentication failed: ${String(err)}`);
      return {
        success: false,
        error: {
          code: 'invalid_token',
          message: 'Invalid session token',
          provider: this.id,
        },
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<ProviderHealth> {
    try {
      // Simple DB connectivity check
      await this.db.query.user_sessions.findFirst();
      return {
        status: 'healthy',
        last_checked: new Date().toISOString(),
      };
    } catch (err) {
      // SEC-M19-012: Don't leak database connection errors
      logger.error({ err }, '[authn-ephemeral] Health check failed');
      return {
        status: 'unhealthy',
        message: 'Health check failed',
        last_checked: new Date().toISOString(),
      };
    }
  }

  /**
   * Shutdown provider
   */
  async shutdown(): Promise<void> {
    logger.info('[authn-ephemeral] Provider shutdown');
  }

  /**
   * Update HMAC secret (for rotation)
   * 
   * This method replaces the current HMAC secret with a new one.
   * All tokens signed with the old secret will become invalid.
   * 
   * @param newSecret New HMAC secret (64 bytes)
   */
  updateHmacSecret(newSecret: Buffer): void {
    if (newSecret.length !== 64) {
      throw new Error('HMAC secret must be exactly 64 bytes');
    }
    this.hmacSecret = newSecret;
    logger.info('[authn-ephemeral] HMAC secret updated');
  }
}
