/**
 * HMAC Secret Management
 *
 * Loads or generates SESSION_HMAC_SECRET for session token generation.
 *
 * Security requirements:
 * - 64 bytes of entropy from crypto.randomBytes()
 * - Persisted to {dataDir}/session_hmac_secret with mode 0600
 * - NEVER logged or exposed in API responses
 *
 * @see SEC-V2-003 Session Token Format
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions */

import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '@mcpambassador/core';

const HMAC_SECRET_BYTES = 64;
const HMAC_SECRET_FILENAME = 'session_hmac_secret';

/**
 * Get or create HMAC secret for session token generation
 *
 * Priority:
 * 1. Environment variable SESSION_HMAC_SECRET (if set)
 * 2. File at {dataDir}/session_hmac_secret (if exists)
 * 3. Generate new secret, write to file with mode 0600
 *
 * @param dataDir Data directory path
 * @returns HMAC secret as Buffer (64 bytes)
 */
export function getOrCreateHmacSecret(dataDir: string): Buffer {
  // 1. Check environment variable (optional override)
  if (process.env.SESSION_HMAC_SECRET) {
    const envSecret = Buffer.from(process.env.SESSION_HMAC_SECRET, 'hex');
    if (envSecret.length === HMAC_SECRET_BYTES) {
      logger.debug('[authn-ephemeral] Using HMAC secret from SESSION_HMAC_SECRET env var');
      return envSecret;
    } else {
      logger.warn(
        `[authn-ephemeral] SESSION_HMAC_SECRET env var is not ${HMAC_SECRET_BYTES} bytes, ignoring`
      );
    }
  }

  const secretPath = join(dataDir, HMAC_SECRET_FILENAME);

  // 2. Check if file exists
  if (existsSync(secretPath)) {
    const fileSecret = readFileSync(secretPath);
    if (fileSecret.length === HMAC_SECRET_BYTES) {
      logger.debug('[authn-ephemeral] Loaded HMAC secret from file');
      return fileSecret;
    } else {
      logger.warn(
        `[authn-ephemeral] Existing HMAC secret file is not ${HMAC_SECRET_BYTES} bytes, regenerating`
      );
    }
  }

  // 3. Generate new secret
  logger.info('[authn-ephemeral] Generating new HMAC secret');
  const newSecret = randomBytes(HMAC_SECRET_BYTES);

  // Ensure data directory exists
  mkdirSync(dirname(secretPath), { recursive: true });

  // Write to file with mode 0600 (owner read/write only)
  writeFileSync(secretPath, newSecret, { mode: 0o600 });

  logger.info('[authn-ephemeral] HMAC secret written to file');
  return newSecret;
}

/**
 * Persist an HMAC secret to the data directory.
 * Used by HMAC rotation to ensure the new secret survives server restarts.
 *
 * SEC-M19-001: Rotation must persist to disk, not just update in-memory.
 *
 * @param dataDir Data directory path
 * @param secret HMAC secret as Buffer (64 bytes)
 */
export function persistHmacSecret(dataDir: string, secret: Buffer): void {
  if (secret.length !== HMAC_SECRET_BYTES) {
    throw new Error(`HMAC secret must be ${HMAC_SECRET_BYTES} bytes, got ${secret.length}`);
  }
  const secretPath = join(dataDir, HMAC_SECRET_FILENAME);
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, secret, { mode: 0o600 });
  logger.info('[authn-ephemeral] HMAC secret persisted to file after rotation');
}
