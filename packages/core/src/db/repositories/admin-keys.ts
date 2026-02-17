/**
 * Admin Key Repository
 * 
 * Data access layer for admin API key management (Community tier).
 * Handles key generation, rotation, recovery.
 * 
 * @see ADR-006 Admin Authentication Model
 * @see Architecture §9.5 Admin API Authentication
 * @see schema/index.ts admin_keys table
 */

import { eq, and } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { admin_keys, type AdminKey, type NewAdminKey } from '../../schema/index.js';
import argon2 from 'argon2';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Argon2id parameters (same as client API keys)
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Admin key prefix (ADR-006)
 */
const ADMIN_KEY_PREFIX = 'amb_ak_';

/**
 * Recovery token prefix (ADR-006)
 */
const RECOVERY_TOKEN_PREFIX = 'amb_rt_';

/**
 * Generate cryptographically secure admin key
 */
export function generateAdminKey(): string {
  const bytes = crypto.randomBytes(36); // 48 chars base64url
  return ADMIN_KEY_PREFIX + bytes.toString('base64url');
}

/**
 * Generate cryptographically secure recovery token
 */
export function generateRecoveryToken(): string {
  const bytes = crypto.randomBytes(36); // 48 chars base64url
  return RECOVERY_TOKEN_PREFIX + bytes.toString('base64url');
}

/**
 * Create admin key (first boot or factory reset)
 * 
 * @param db Database client
 * @param dataDir Data directory for recovery token file
 * @returns Plaintext admin key and recovery token (MUST be printed to stdout)
 */
export async function createAdminKey(
  db: DatabaseClient,
  dataDir: string
): Promise<{ admin_key: string; recovery_token: string }> {
  const admin_key = generateAdminKey();
  const recovery_token = generateRecoveryToken();
  
  const key_hash = await argon2.hash(admin_key, ARGON2_OPTIONS);
  const recovery_token_hash = await argon2.hash(recovery_token, ARGON2_OPTIONS);
  
  const now = new Date().toISOString();
  
  const newAdminKey: NewAdminKey = {
    key_hash,
    recovery_token_hash,
    created_at: now,
    rotated_at: null,
    is_active: true,
  };
  
  await db.insert(admin_keys).values(newAdminKey);
  
  // Write recovery token to file (0400 permissions - owner read-only)
  await writeRecoveryTokenFile(dataDir, recovery_token);
  
  console.log('[db:admin-keys] Admin key created');
  
  return { admin_key, recovery_token };
}

/**
 * Authenticate admin key
 * 
 * @param db Database client
 * @param adminKey Plaintext admin key
 * @returns true if authenticated, false otherwise
 */
export async function authenticateAdminKey(
  db: DatabaseClient,
  adminKey: string
): Promise<boolean> {
  // Fetch active admin key
  const [activeKey] = await db
    .select()
    .from(admin_keys)
    .where(eq(admin_keys.is_active, true))
    .limit(1);
  
  if (!activeKey) {
    console.warn('[db:admin-keys] No active admin key found');
    return false;
  }
  
  // Timing-safe verification
  try {
    const match = await argon2.verify(activeKey.key_hash, adminKey);
    return match;
  } catch (err) {
    console.error('[db:admin-keys] Argon2 verification error:', err);
    return false;
  }
}

/**
 * Rotate admin key (requires both admin key + recovery token for dual verification)
 * 
 * @param db Database client
 * @param currentAdminKey Current plaintext admin key
 * @param recoveryToken Current plaintext recovery token
 * @param dataDir Data directory for new recovery token file
 * @returns New plaintext admin key and recovery token
 * @throws Error if verification fails
 */
export async function rotateAdminKey(
  db: DatabaseClient,
  currentAdminKey: string,
  recoveryToken: string,
  dataDir: string
): Promise<{ admin_key: string; recovery_token: string }> {
  // Fetch current active key
  const [currentKey] = await db
    .select()
    .from(admin_keys)
    .where(eq(admin_keys.is_active, true))
    .limit(1);
  
  if (!currentKey) {
    throw new Error('No active admin key found');
  }
  
  // Dual verification: admin key + recovery token (ADR-006 compromise mitigation)
  const adminKeyMatch = await argon2.verify(currentKey.key_hash, currentAdminKey);
  const recoveryTokenMatch = await argon2.verify(currentKey.recovery_token_hash, recoveryToken);
  
  if (!adminKeyMatch || !recoveryTokenMatch) {
    throw new Error('Admin key rotation failed: invalid credentials (dual verification required)');
  }
  
  // Generate new key + token
  const new_admin_key = generateAdminKey();
  const new_recovery_token = generateRecoveryToken();
  
  const new_key_hash = await argon2.hash(new_admin_key, ARGON2_OPTIONS);
  const new_recovery_token_hash = await argon2.hash(new_recovery_token, ARGON2_OPTIONS);
  
  const now = new Date().toISOString();
  
  // Deactivate old key
  await db
    .update(admin_keys)
    .set({ is_active: false })
    .where(eq(admin_keys.id, currentKey.id));
  
  // Insert new key
  const newAdminKey: NewAdminKey = {
    key_hash: new_key_hash,
    recovery_token_hash: new_recovery_token_hash,
    created_at: now,
    rotated_at: now,
    is_active: true,
  };
  
  await db.insert(admin_keys).values(newAdminKey);
  
  // Write new recovery token to file
  await writeRecoveryTokenFile(dataDir, new_recovery_token);
  
  console.log('[db:admin-keys] Admin key rotated (dual verification successful)');
  
  return { admin_key: new_admin_key, recovery_token: new_recovery_token };
}

/**
 * Recover admin key using recovery token (single-use)
 * 
 * @param db Database client
 * @param recoveryToken Plaintext recovery token
 * @param dataDir Data directory for new recovery token file
 * @returns New plaintext admin key and recovery token
 * @throws Error if recovery token invalid
 */
export async function recoverAdminKey(
  db: DatabaseClient,
  recoveryToken: string,
  dataDir: string
): Promise<{ admin_key: string; recovery_token: string }> {
  // Fetch current active key
  const [currentKey] = await db
    .select()
    .from(admin_keys)
    .where(eq(admin_keys.is_active, true))
    .limit(1);
  
  if (!currentKey) {
    throw new Error('No active admin key found');
  }
  
  // Verify recovery token
  const match = await argon2.verify(currentKey.recovery_token_hash, recoveryToken);
  if (!match) {
    throw new Error('Admin key recovery failed: invalid recovery token');
  }
  
  // Generate new key + token (single-use: recovery token is consumed)
  const new_admin_key = generateAdminKey();
  const new_recovery_token = generateRecoveryToken();
  
  const new_key_hash = await argon2.hash(new_admin_key, ARGON2_OPTIONS);
  const new_recovery_token_hash = await argon2.hash(new_recovery_token, ARGON2_OPTIONS);
  
  const now = new Date().toISOString();
  
  // Deactivate old key
  await db
    .update(admin_keys)
    .set({ is_active: false })
    .where(eq(admin_keys.id, currentKey.id));
  
  // Insert new key
  const newAdminKey: NewAdminKey = {
    key_hash: new_key_hash,
    recovery_token_hash: new_recovery_token_hash,
    created_at: now,
    rotated_at: now,
    is_active: true,
  };
  
  await db.insert(admin_keys).values(newAdminKey);
  
  // Write new recovery token to file
  await writeRecoveryTokenFile(dataDir, new_recovery_token);
  
  console.log('[db:admin-keys] Admin key recovered (recovery token consumed)');
  
  return { admin_key: new_admin_key, recovery_token: new_recovery_token };
}

/**
 * Factory reset admin key (deletes all admin keys, next boot creates new)
 * 
 * @param db Database client
 */
export async function factoryResetAdminKey(db: DatabaseClient): Promise<void> {
  await db.delete(admin_keys);
  console.log('[db:admin-keys] Factory reset: all admin keys deleted');
}

/**
 * Get admin key hash prefix (for audit log attribution in Community tier)
 * 
 * Returns first 8 chars of key hash for audit attribution.
 */
export async function getAdminKeyHashPrefix(db: DatabaseClient): Promise<string | null> {
  const [activeKey] = await db
    .select()
    .from(admin_keys)
    .where(eq(admin_keys.is_active, true))
    .limit(1);
  
  if (!activeKey) {
    return null;
  }
  
  return activeKey.key_hash.slice(0, 8);
}

/**
 * Write recovery token to file (0400 permissions)
 * 
 * File location: <dataDir>/.recovery-token
 */
async function writeRecoveryTokenFile(dataDir: string, recoveryToken: string): Promise<void> {
  const filePath = path.join(dataDir, '.recovery-token');
  
  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  
  // Write file
  fs.writeFileSync(filePath, recoveryToken, { mode: 0o400 }); // Owner read-only
  
  console.log(`[db:admin-keys] Recovery token written to ${filePath} (permissions: 0400)`);
}

/**
 * Read recovery token from file
 * 
 * Used by CLI reset-admin-key command.
 */
export function readRecoveryTokenFile(dataDir: string): string {
  const filePath = path.join(dataDir, '.recovery-token');
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recovery token file not found: ${filePath}`);
  }
  
  return fs.readFileSync(filePath, 'utf-8').trim();
}
