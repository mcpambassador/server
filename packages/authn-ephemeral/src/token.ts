/**
 * Session Token Generation and Verification
 *
 * Generates and verifies HMAC-based session tokens for ephemeral sessions.
 *
 * Token format: amb_st_{base64url(HMAC-SHA256(session_id || nonce))}
 * Storage: HMAC output stored as hex in user_sessions.session_token_hash
 *
 * Security requirements:
 * - HMAC-SHA256 with 64-byte server secret
 * - 32-byte random nonce from crypto.randomBytes()
 * - Timing-safe comparison (crypto.timingSafeEqual())
 * - Nonce NEVER exposed in API responses or logs
 * - Argon2id for preshared key verification
 * - Random delay on failed key lookup (0-200ms uniform)
 *
 * @see SEC-V2-003 Session Token Format
 * @see SR-M13-003 Preshared Key Prefix Lookup
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@mcpambassador/core';
import { logger, clients, compatUpdate, AmbassadorError } from '@mcpambassador/core';
import type {
  ValidatedClient,
  GeneratedSessionToken,
  VerifiedSession,
} from './types.js';

/**
 * Nonce size for session tokens (32 bytes = 256 bits)
 */
const TOKEN_NONCE_BYTES = 32;

/**
 * Random delay range for failed key lookups (timing normalization)
 */
const FAILED_LOOKUP_DELAY_MS = { min: 0, max: 200 };

/**
 * Validate client preshared key format and authenticate
 *
 * Steps:
 * 1. Validate format: amb_pk_{48 base64url chars}
 * 2. Extract prefix: first 8 chars AFTER "amb_pk_" (SR-M13-003)
 * 3. Query clients WHERE key_prefix = ? AND status = 'active'
 * 4. Argon2.verify() against matched records (early exit on first match)
 * 5. On no match: add random delay to normalize timing
 * 6. Update last_used_at on successful match
 *
 * @param db Database client
 * @param rawKey Raw preshared key from request
 * @returns Validated key info { client_id, user_id, profile_id }
 * @throws Error if key invalid or not found
 */
export async function validateClientKey(
  db: DatabaseClient,
  rawKey: string
): Promise<ValidatedClient> {
  const startTime = Date.now();

  // 1. Validate format
  if (!rawKey.startsWith('amb_pk_')) {
    await randomDelay();
    throw new AmbassadorError('Invalid preshared key format', 'invalid_credentials', 401);
  }

  const keyBody = rawKey.slice(7); // Remove "amb_pk_" prefix
  if (keyBody.length !== 48 || !/^[A-Za-z0-9_-]+$/.test(keyBody)) {
    await randomDelay();
    throw new AmbassadorError('Invalid preshared key format', 'invalid_credentials', 401);
  }

  // 2. Extract prefix (first 8 chars of random portion after amb_pk_)
  const keyPrefix = keyBody.slice(0, 8);

  // 3. Query active, non-expired keys with matching prefix
  const candidates = await db.query.clients.findMany({
    where: (keys, { eq, and }) =>
      and(eq(keys.key_prefix, keyPrefix), eq(keys.status, 'active')),
  });

  // M-002 fix: Filter out expired keys (expires_at is nullable — null means no expiry)
  const now = new Date().toISOString();
  const validCandidates = candidates.filter(
    c => !c.expires_at || c.expires_at > now
  );

  if (validCandidates.length === 0) {
    logger.warn('[authn-ephemeral] No active keys found for prefix');
    await randomDelay();
    throw new AmbassadorError('Invalid preshared key', 'invalid_credentials', 401);
  }

  // 4. Verify against each candidate (early exit on first match)
  for (const candidate of validCandidates) {
    try {
      const isValid = await argon2.verify(candidate.key_hash, rawKey);
      if (isValid) {
        // Reject clients without a profile
        if (!candidate.profile_id) {
          logger.warn(`[authn-ephemeral] Client ${candidate.client_id} has no profile_id assigned`);
          throw new AmbassadorError('Client has no assigned profile', 'invalid_credentials', 401);
        }

        // Update last_used_at
        const now = new Date().toISOString();
        await compatUpdate(db, clients)
          .set({ last_used_at: now })
          .where(eq(clients.client_id, candidate.client_id));

        const elapsed = Date.now() - startTime;
        logger.debug(`[authn-ephemeral] Client key validated in ${elapsed}ms`);

        return {
          client_id: candidate.client_id,
          user_id: candidate.user_id,
          profile_id: candidate.profile_id,
        };
      }
    } catch (err) {
      // Verification error, continue to next candidate
      logger.debug(`[authn-ephemeral] Argon2 verification error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // 5. No match found - add random delay
  logger.warn('[authn-ephemeral] Preshared key verification failed');
  await randomDelay();
  throw new AmbassadorError('Invalid preshared key', 'invalid_credentials', 401);
}

/**
 * Generate session token
 *
 * Steps:
 * 1. Generate 32-byte random nonce
 * 2. Compute HMAC-SHA256(session_id || nonce)
 * 3. Encode token: "amb_st_" + base64url(hmac)
 * 4. Return token, hash (hex), and nonce (hex) for storage
 *
 * @param hmacSecret HMAC secret (64 bytes)
 * @param sessionId Session ID (UUIDv4)
 * @returns Generated token info
 */
export function generateSessionToken(
  hmacSecret: Buffer,
  sessionId: string
): GeneratedSessionToken {
  // 1. Generate random nonce
  const nonce = randomBytes(TOKEN_NONCE_BYTES);

  // 2. Compute HMAC-SHA256(session_id || nonce)
  const hmacInput = sessionId + nonce.toString('hex');
  const hmac = createHmac('sha256', hmacSecret).update(hmacInput).digest();

  // 3. Encode token as base64url
  const base64url = hmac
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const token = `amb_st_${base64url}`;

  // 4. Return token, hash, and nonce
  return {
    token,
    tokenHash: hmac.toString('hex'),
    nonce: nonce.toString('hex'),
  };
}

/**
 * Verify session token
 *
 * Steps:
 * 1. Validate token format
 * 2. Decode HMAC from token
 * 3. Look up session by token hash
 * 4. Recompute HMAC and compare (timing-safe)
 * 5. Check expiration
 * 6. Return session context
 *
 * @param db Database client
 * @param hmacSecret HMAC secret (64 bytes)
 * @param rawToken Raw session token from request
 * @returns Verified session info
 * @throws Error if token invalid or not found
 */
export async function verifySessionToken(
  db: DatabaseClient,
  hmacSecret: Buffer,
  rawToken: string
): Promise<VerifiedSession> {
  const startTime = Date.now();

  // 1. Validate format
  if (!rawToken.startsWith('amb_st_')) {
    throw new Error('Invalid session token format');
  }

  // 2. Decode token
  const tokenBody = rawToken.slice(7); // Remove "amb_st_" prefix
  let hmacBytes: Buffer;
  try {
    // Convert base64url to standard base64
    const base64 = tokenBody.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    hmacBytes = Buffer.from(padded, 'base64');
  } catch (err) {
    throw new Error('Invalid session token encoding');
  }

  const tokenHash = hmacBytes.toString('hex');

  // 3. Look up session by token hash
  const session = await db.query.user_sessions.findFirst({
    where: (sessions, { eq, and, or }) =>
      and(
        eq(sessions.session_token_hash, tokenHash),
        or(eq(sessions.status, 'active'), eq(sessions.status, 'idle'))
      ),
  });

  if (!session) {
    throw new Error('Session not found or inactive');
  }

  // 4. Recompute HMAC and verify (timing-safe comparison)
  const hmacInput = session.session_id + session.token_nonce;
  const expectedHmac = createHmac('sha256', hmacSecret).update(hmacInput).digest();

  if (!timingSafeEqual(hmacBytes, expectedHmac)) {
    logger.warn('[authn-ephemeral] Session token HMAC mismatch');
    throw new Error('Invalid session token');
  }

  // 5. Check expiration
  const now = new Date();
  const expiresAt = new Date(session.expires_at);
  if (now > expiresAt) {
    logger.warn('[authn-ephemeral] Session expired');
    throw new Error('Session expired');
  }

  // 6. Resolve client_id from session metadata
  let clientId: string | null = null;
  try {
    const metadata = typeof session.metadata === 'string'
      ? JSON.parse(session.metadata)
      : session.metadata;
    if (metadata && typeof metadata === 'object' && typeof metadata.client_id === 'string') {
      clientId = metadata.client_id;
    }
  } catch {
    // Ignore metadata parse errors and handle as missing client binding below
  }

  if (!clientId) {
    throw new Error('Session missing client binding');
  }

  const latestConnection = await db.query.session_connections.findFirst({
    where: (conns, { eq, and }) =>
      and(eq(conns.session_id, session.session_id), eq(conns.status, 'connected')),
    orderBy: (conns, { desc }) => [desc(conns.last_heartbeat_at)],
  });

  const elapsed = Date.now() - startTime;
  logger.debug(`[authn-ephemeral] Session token verified in ${elapsed}ms`);

  return {
    session_id: session.session_id,
    client_id: clientId,
    user_id: session.user_id,
    profile_id: session.profile_id,
    connection_id: latestConnection?.connection_id,
    expires_at: session.expires_at,
  };
}

/**
 * Add random delay for timing normalization (0-200ms uniform)
 */
async function randomDelay(): Promise<void> {
  const delay =
    FAILED_LOOKUP_DELAY_MS.min +
    Math.random() * (FAILED_LOOKUP_DELAY_MS.max - FAILED_LOOKUP_DELAY_MS.min);
  await new Promise(resolve => setTimeout(resolve, delay));
}
