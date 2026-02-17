/**
 * API Key Authentication Provider
 * 
 * Implements AuthenticationProvider SPI for API key authentication.
 * 
 * Security requirements (per security review checklist):
 * - crypto.randomBytes() for key generation (not Math.random())
 * - Argon2id parameters: m=19456, t=2, p=1 (OWASP minimum)
 * - Timing-safe verification (argon2.verify is inherently constant-time)
 * - Lookup by client_id then verify (no timing leak on key existence)
 * 
 * @see Architecture §9.2 API Key Authentication
 * @see ADR-001 Authentication Strategy
 */

import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import type {
  AuthenticationProvider,
  AuthRequest,
  AuthResult,
  ProviderHealth,
  SessionContext,
} from '@mcpambassador/core';
import { logger } from '@mcpambassador/core';
import type { DatabaseClient } from '@mcpambassador/core';
import { hashApiKey, isValidApiKeyFormat } from './keys.js';

/**
 * Argon2id parameters (OWASP minimum per security review)
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,  // 19MB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Session TTL (1 hour for Community tier)
 */
const SESSION_TTL_SECONDS = 3600;

/**
 * API Key Authentication Provider
 */
export class ApiKeyAuthProvider implements AuthenticationProvider {
  readonly id = 'api_key';
  private dummyHash: string = '';

  constructor(private db: DatabaseClient) {}

  /**
   * Initialize provider
   * 
   * Pre-computes a dummy hash for timing-safe non-existent client lookups.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    // F-SEC-M4-001: Generate proper dummy hash for timing-safe verification
    this.dummyHash = await hashApiKey('amb_sk_' + 'x'.repeat(48));
    logger.info('[authn-apikey] Provider initialized');
  }

  /**
   * Authenticate client using X-API-Key and X-Client-Id headers
   * 
   * Timing-safe: lookup by client_id then verify with argon2 (constant-time hash comparison)
   */
  async authenticate(request: AuthRequest): Promise<AuthResult> {
    const apiKey = request.headers['x-api-key'] || request.headers['authorization']?.replace(/^Bearer\s+/, '');
    const clientId = request.headers['x-client-id'];

    if (!apiKey || !clientId) {
      return {
        success: false,
        error: {
          code: 'missing_credentials',
          message: 'Missing X-API-Key or X-Client-Id header',
          provider: this.id,
        },
      };
    }

    // F-SEC-M4-005: Validate key format before DB lookup (prevent CPU amplification)
    if (!isValidApiKeyFormat(apiKey, 'amb_sk')) {
      return {
        success: false,
        error: {
          code: 'invalid_format',
          message: 'Invalid API key format',
          provider: this.id,
        },
      };
    }

    // TODO: Validate clientId is valid UUID format

    try {
      // Lookup by client_id (no timing leak - single DB query)
      const client = await this.db.query.clients.findFirst({
        where: (clients, { eq }) => eq(clients.client_id, clientId),
      });

      if (!client) {
        // F-SEC-M4-001: Use pre-computed dummy hash for timing-safe verification
        await argon2.verify(this.dummyHash, apiKey);
        
        return {
          success: false,
          error: {
            code: 'invalid_credentials',
            message: 'Invalid client_id or API key',
            provider: this.id,
          },
        };
      }

      // Check client status
      if (client.status !== 'active') {
        return {
          success: false,
          error: {
            code: 'client_suspended',
            message: `Client status: ${client.status}`,
            provider: this.id,
            details: { status: client.status },
          },
        };
      }

      // Verify API key with Argon2id (constant-time)
      const isValid = await argon2.verify(client.api_key_hash!, apiKey, ARGON2_OPTIONS);

      if (!isValid) {
        return {
          success: false,
          error: {
            code: 'invalid_credentials',
            message: 'Invalid client_id or API key',
            provider: this.id,
          },
        };
      }

      // Update last_seen_at (background - don't block auth)
      this.db.update().set({ last_seen_at: new Date().toISOString() }).where((clients, { eq }) => eq(clients.client_id, clientId)).run().catch(err => {
        logger.warn(`[authn-apikey] Failed to update last_seen_at: ${err.message}`);
      });

      // Create session context
      const now = Math.floor(Date.now() / 1000);
      const session: SessionContext = {
        session_id: uuidv4(),
        client_id: client.client_id,
        user_id: client.owner_user_id || undefined,
        auth_method: 'api_key',
        groups: [], // Phase 2: populate from user profile
        attributes: {
          friendly_name: client.friendly_name,
          host_tool: client.host_tool,
          profile_id: client.profile_id,
        },
        issued_at: now,
        expires_at: now + SESSION_TTL_SECONDS,
      };

      return {
        success: true,
        session,
      };
    } catch (error) {
      logger.error('[authn-apikey] Authentication error:', error);
      return {
        success: false,
        error: {
          code: 'internal_error',
          message: 'Authentication service error',
          provider: this.id,
          details: error instanceof Error ? { error: error.message } : undefined,
        },
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<ProviderHealth> {
    try {
      // Quick DB connectivity check
      await this.db.query.clients.findFirst({
        where: (clients, { eq }) => eq(clients.status, 'active'),
      });
      
      return {
        status: 'healthy',
        message: 'Database accessible',
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        last_checked: new Date().toISOString(),
      };
    }
  }

  /**
   * Shutdown (no-op)
   */
  async shutdown(): Promise<void> {
    logger.info('[authn-apikey] Provider shutdown');
  }
}
