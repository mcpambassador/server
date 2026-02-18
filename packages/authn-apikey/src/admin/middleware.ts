/**
 * Admin Authentication Middleware
 *
 * Validates X-Admin-Key header against stored admin key hash.
 * Gates all /v1/admin/* and /v1/audit/* endpoints.
 *
 * @see Architecture §9.5 Admin API Authentication
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

import type { DatabaseClient } from '@mcpambassador/core';
import { logger } from '@mcpambassador/core';
import argon2 from 'argon2';
import { isValidApiKeyFormat } from '../keys.js';

/**
 * Admin authentication result
 */
export interface AdminAuthResult {
  authenticated: boolean;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Authenticate admin key from request headers
 *
 * @param db Database client
 * @param headers HTTP request headers
 * @returns Admin authentication result
 */
export async function authenticateAdmin(
  db: DatabaseClient,
  headers: Record<string, string>
): Promise<AdminAuthResult> {
  const adminKey = headers['x-admin-key'] || headers['authorization']?.replace(/^Bearer\\s+/, '');

  if (!adminKey) {
    return {
      authenticated: false,
      error: {
        code: 'missing_credentials',
        message: 'Missing X-Admin-Key header',
      },
    };
  }

  // F-SEC-M4-006: Validate full admin key format (prevent CPU amplification)
  if (!isValidApiKeyFormat(adminKey, 'amb_ak')) {
    return {
      authenticated: false,
      error: {
        code: 'invalid_format',
        message: 'Invalid admin key format',
      },
    };
  }

  try {
    // Get active admin key from database
    const adminKeyRecord = await db.query.admin_keys.findFirst({
      where: (keys, { eq }) => eq(keys.is_active, true),
    });

    if (!adminKeyRecord) {
      logger.error('[admin-auth] No active admin key found in database');
      return {
        authenticated: false,
        error: {
          code: 'no_admin_key',
          message: 'No active admin key configured',
        },
      };
    }

    // Verify admin key with Argon2id (constant-time)
    const isValid = await argon2.verify(adminKeyRecord.key_hash, adminKey);

    if (!isValid) {
      logger.warn('[admin-auth] Invalid admin key attempt');
      return {
        authenticated: false,
        error: {
          code: 'invalid_credentials',
          message: 'Invalid admin key',
        },
      };
    }

    // Admin authenticated
    return {
      authenticated: true,
    };
  } catch (error) {
    logger.error('[admin-auth] Admin authentication error:', error);
    return {
      authenticated: false,
      error: {
        code: 'internal_error',
        message: 'Authentication service error',
      },
    };
  }
}
