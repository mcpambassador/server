/**
 * Admin Key Management
 * 
 * Handles admin key generation, recovery, and rotation per ADR-006.
 * 
 * First boot: generates amb_ak_ admin key + amb_rt_ recovery token
 * Admin key printed to stdout only once (never logged, never in config)
 * Recovery token written to .recovery-token file with 0400 permissions
 * 
 * @see ADR-006 Admin Authentication Model
 * @see Architecture §9.5 Admin API Authentication
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { DatabaseClient } from '@mcpambassador/core';
import { logger, AmbassadorError } from '@mcpambassador/core';
import { generateApiKey, hashApiKey } from '../keys.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { hashIp, redactIp } from '../utils/privacy.js';

/**
 * Admin key record (admin_keys table)
 */
export interface AdminKeyRecord {
  key_id: string;
  key_hash: string; // Argon2id hash of amb_ak_
  recovery_token_hash: string; // Argon2id hash of amb_rt_
  created_at: string;
  last_rotated_at: string;
  status: 'active' | 'revoked';
}

/**
 * Admin key generation result (first boot)
 */
export interface AdminKeyGeneration {
  admin_key: string; // Plain amb_ak_ key
  recovery_token: string; // Plain amb_rt_ token
  recovery_token_path: string;
  message: string;
}

/**
 * Generate admin key and recovery token (first boot)
 * 
 * This should be called during server initialization if no admin key exists.
 * 
 * @param db Database client
 * @param dataDir Data directory for recovery token file (default: ./data)
 * @returns Admin key and recovery token (plain text)
 */
export async function generateAdminKey(
  db: DatabaseClient,
  dataDir: string = './data'
): Promise<AdminKeyGeneration> {
  // Check if admin key already exists
  const existingKey = await db.query.admin_keys.findFirst({
    where: (keys, { eq }) => eq(keys.status, 'active'),
  });

  if (existingKey) {
    throw new AmbassadorError(
      'Admin key already exists - use rotation endpoint to change it',
      'admin_key_exists',
      400
    );
  }

  // Generate admin key and recovery token
  const adminKey = generateApiKey('amb_ak');
  const recoveryToken = generateApiKey('amb_rt');

  // Hash both
  const adminKeyHash = await hashApiKey(adminKey);
  const recoveryTokenHash = await hashApiKey(recoveryToken);

  // Insert into database
  // F-SEC-M4-004: Use ESM import instead of require()
  const keyId = randomUUID();
  const now = new Date().toISOString();
  
  await db.insert().into('admin_keys').values({
    key_id: keyId,
    key_hash: adminKeyHash,
    recovery_token_hash: recoveryTokenHash,
    created_at: now,
    last_rotated_at: now,
    status: 'active',
  }).run();

  // Write recovery token to file with 0400 permissions
  await fs.mkdir(dataDir, { recursive: true });
  const recoveryTokenPath = path.join(dataDir, '.recovery-token');
  await fs.writeFile(recoveryTokenPath, recoveryToken, { mode: 0o400 });

  logger.info(`[admin-key] Admin key generated (key_id: ${keyId})`);
  logger.info(`[admin-key] Recovery token written to ${recoveryTokenPath} (mode 0400)`);

  return {
    admin_key: adminKey,
    recovery_token: recoveryToken,
    recovery_token_path: recoveryTokenPath,
    message: `
=============================================================================
  MCP AMBASSADOR ADMIN KEY (save this securely!)
=============================================================================

  Admin Key: ${adminKey}

  This key grants full administrative access. Store it securely (password
  manager, vault, etc.). It will NOT be shown again.

  Recovery token saved to: ${recoveryTokenPath}

  Use the admin key in X-Admin-Key header for all /v1/admin/* endpoints.

=============================================================================
`,
  };
}

// F-SEC-M4-002: Rate limiter for admin recovery (3 attempts per hour per IP)
const recoveryRateLimiter = new RateLimiter();

// Cleanup expired entries every 5 minutes
setInterval(() => recoveryRateLimiter.cleanup(), 5 * 60 * 1000);

/**
 * Recover admin access using recovery token
 * 
 * Validates recovery token and generates a new admin key.
 * Recovery token remains valid (one recovery token per admin key).
 * 
 * Rate limited: 3 attempts per hour per IP.
 * 
 * @param db Database client
 * @param recoveryToken Recovery token from .recovery-token file
 * @param sourceIp Source IP for rate limiting
 * @returns New admin key
 */
export async function recoverAdminKey(
  db: DatabaseClient,
  recoveryToken: string,
  sourceIp: string
): Promise<{ admin_key: string; message: string }> {
  // F-SEC-M4-002: Enforce rate limiting (3 attempts per hour per IP)
  if (!recoveryRateLimiter.check(sourceIp, 3, 60 * 60 * 1000)) {
    throw new AmbassadorError(
      'Recovery rate limit exceeded - try again in 1 hour',
      'rate_limit_exceeded',
      429
    );
  }

  // Find active admin key record
  const adminKeyRecord = await db.query.admin_keys.findFirst({
    where: (keys, { eq }) => eq(keys.status, 'active'),
  });

  if (!adminKeyRecord) {
    throw new AmbassadorError(
      'No active admin key found - use initial setup',
      'not_found',
      404
    );
  }

  // Verify recovery token
  const argon2 = await import('argon2');
  const isValid = await argon2.verify(adminKeyRecord.recovery_token_hash, recoveryToken);

  if (!isValid) {
    // F-SEC-M4-008: Hash IP for privacy (PII in logs)
    logger.warn(`[admin-key] Failed recovery attempt from IP hash ${hashIp(sourceIp)}`);
    throw new AmbassadorError(
      'Invalid recovery token',
      'invalid_credentials',
      401
    );
  }

  // Generate new admin key
  const newAdminKey = generateApiKey('amb_ak');
  const newAdminKeyHash = await hashApiKey(newAdminKey);

  // Update database (keep same recovery token hash)
  const now = new Date().toISOString();
  await db.update()
    .table('admin_keys')
    .set({
      key_hash: newAdminKeyHash,
      last_rotated_at: now,
    })
    .where((keys, { eq }) => eq(keys.key_id, adminKeyRecord.key_id))
    .run();

  // F-SEC-M4-008: Hash IP for privacy (PII in logs)
  logger.info(`[admin-key] Admin key recovered from IP hash ${hashIp(sourceIp)}`);

  return {
    admin_key: newAdminKey,
    message: `Admin key recovered. Use this new key in X-Admin-Key header. Old admin key is now invalid.`,
  };
}

/**
 * Rotate admin key with dual verification
 * 
 * Requires both current admin key AND recovery token (dual factor).
 * Generates new admin key AND new recovery token.
 * 
 * @param db Database client
 * @param currentAdminKey Current admin key
 * @param recoveryToken Current recovery token
 * @param dataDir Data directory for new recovery token file
 * @returns New admin key and recovery token
 */
export async function rotateAdminKey(
  db: DatabaseClient,
  currentAdminKey: string,
  recoveryToken: string,
  dataDir: string = './data'
): Promise<AdminKeyGeneration> {
  // Find active admin key record
  const adminKeyRecord = await db.query.admin_keys.findFirst({
    where: (keys, { eq }) => eq(keys.status, 'active'),
  });

  if (!adminKeyRecord) {
    throw new AmbassadorError(
      'No active admin key found',
      'not_found',
      404
    );
  }

  // Verify both admin key AND recovery token (dual verification)
  const argon2 = await import('argon2');
  const [isAdminKeyValid, isRecoveryTokenValid] = await Promise.all([
    argon2.verify(adminKeyRecord.key_hash, currentAdminKey),
    argon2.verify(adminKeyRecord.recovery_token_hash, recoveryToken),
  ]);

  if (!isAdminKeyValid || !isRecoveryTokenValid) {
    logger.warn('[admin-key] Failed admin key rotation - invalid credentials');
    throw new AmbassadorError(
      'Invalid admin key or recovery token',
      'invalid_credentials',
      401
    );
  }

  // Generate new admin key and new recovery token
  const newAdminKey = generateApiKey('amb_ak');
  const newRecoveryToken = generateApiKey('amb_rt');

  // Hash both
  const newAdminKeyHash = await hashApiKey(newAdminKey);
  const newRecoveryTokenHash = await hashApiKey(newRecoveryToken);

  // Update database
  const now = new Date().toISOString();
  await db.update()
    .table('admin_keys')
    .set({
      key_hash: newAdminKeyHash,
      recovery_token_hash: newRecoveryTokenHash,
      last_rotated_at: now,
    })
    .where((keys, { eq }) => eq(keys.key_id, adminKeyRecord.key_id))
    .run();

  // Write new recovery token to file
  const recoveryTokenPath = path.join(dataDir, '.recovery-token');
  await fs.writeFile(recoveryTokenPath, newRecoveryToken, { mode: 0o400 });

  logger.info('[admin-key] Admin key rotated (both admin key and recovery token changed)');

  return {
    admin_key: newAdminKey,
    recovery_token: newRecoveryToken,
    recovery_token_path: recoveryTokenPath,
    message: `Admin key and recovery token rotated successfully. Old credentials are now invalid.`,
  };
}

/**
 * Factory reset admin key (CLI command)
 * 
 * Revokes current admin key and generates a new one.
 * Requires filesystem access (reads recovery token from file).
 * 
 * This is a CLI-only operation, not exposed via HTTP API.
 * 
 * @param db Database client
 * @param dataDir Data directory containing .recovery-token file
 * @returns New admin key
 */
export async function factoryResetAdminKey(
  db: DatabaseClient,
  dataDir: string = './data'
): Promise<AdminKeyGeneration> {
  // Read recovery token from file
  const recoveryTokenPath = path.join(dataDir, '.recovery-token');
  let recoveryToken: string;
  
  try {
    recoveryToken = (await fs.readFile(recoveryTokenPath, 'utf-8')).trim();
  } catch (error) {
    throw new AmbassadorError(
      `Cannot read recovery token from ${recoveryTokenPath}`,
      'file_not_found',
      500
    );
  }

  // F-SEC-M4-009: Verify recovery token before revoking (defense in depth)
  const adminKeyRecord = await db.query.admin_keys.findFirst({
    where: (keys, { eq }) => eq(keys.status, 'active'),
  });

  if (adminKeyRecord) {
    const argon2 = await import('argon2');
    const isValid = await argon2.verify(adminKeyRecord.recovery_token_hash, recoveryToken);
    
    if (!isValid) {
      throw new AmbassadorError(
        'Invalid recovery token in file - cannot perform factory reset',
        'invalid_credentials',
        401
      );
    }
  }

  // Revoke all existing admin keys
  await db.update()
    .table('admin_keys')
    .set({ status: 'revoked' })
    .where((keys, { eq }) => eq(keys.status, 'active'))
    .run();

  // Generate new admin key
  return await generateAdminKey(db, dataDir);
}
