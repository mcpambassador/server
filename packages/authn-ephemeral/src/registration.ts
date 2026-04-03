/**
 * Session Registration Endpoint
 *
 * Handles POST /v1/sessions/register for ephemeral session establishment.
 *
 * Flow:
 * 1. Rate limit (10/min per IP, exponential backoff after 3 failures)
 * 2. Validate preshared key
 * 3. Check for existing active session (session reuse)
 * 4. Generate session token
 * 5. Insert session and connection records
 * 6. Return session info
 *
 * @see M14.5 Session Registration
 * @see SEC-V2-006 Rate Limiting
 * @see SEC-V2-007 Profile Mismatch Handling
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable no-console, @typescript-eslint/require-await */

import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@mcpambassador/core';
import {
  logger,
  AmbassadorError,
  user_sessions,
  session_connections,
  compatUpdate,
  compatInsert,
} from '@mcpambassador/core';
import { validateClientKey, generateSessionToken } from './token.js';
import type { RegistrationRequest, RegistrationResponse } from './types.js';

function extractSessionClientId(metadata: unknown): string | null {
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    if (parsed && typeof parsed === 'object' && typeof parsed.client_id === 'string') {
      return parsed.client_id;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Rate limiter state (in-memory)
 * Maps IP address -> { count, window_start, failures, timestamp }
 */
const rateLimitState = new Map<
  string,
  {
    count: number;
    windowStart: number;
    consecutiveFailures: number;
    timestamp: number; // Track when entry was added for eviction
  }
>();

/**
 * Rate limit configuration
 */
const RATE_LIMIT_CONFIG = {
  maxRequests: 10,
  windowMs: 60_000, // 1 minute
  maxFailures: 3,
  backoffBase: 2, // Exponential backoff multiplier
  maxEntries: 10_000, // Hard cap on rate limit map size
  cleanupIntervalMs: 60_000, // Run cleanup every 60 seconds
};

/**
 * Session configuration interface (M15)
 */
export interface SessionRegConfig {
  ttlSeconds?: number;
  idleTimeoutSeconds?: number;
  spindownDelaySeconds?: number;
}

/**
 * Default session configuration (used if not overridden)
 */
const DEFAULT_SESSION_CONFIG: Required<SessionRegConfig> = {
  ttlSeconds: 28800, // 8 hours
  idleTimeoutSeconds: 1800, // 30 minutes
  spindownDelaySeconds: 300, // 5 minutes
};

/**
 * Register new session or reuse existing session
 *
 * @param db Database client
 * @param hmacSecret HMAC secret for token generation
 * @param body Registration request
 * @param sourceIp Source IP address (for rate limiting)
 * @param sessionConfig Optional session configuration overrides
 * @returns Registration response
 */
export async function registerSession(
  db: DatabaseClient,
  hmacSecret: Buffer,
  body: RegistrationRequest,
  sourceIp: string,
  sessionConfig?: SessionRegConfig
): Promise<RegistrationResponse> {
  // Merge provided config with defaults
  const config: Required<SessionRegConfig> = {
    ttlSeconds: sessionConfig?.ttlSeconds ?? DEFAULT_SESSION_CONFIG.ttlSeconds,
    idleTimeoutSeconds:
      sessionConfig?.idleTimeoutSeconds ?? DEFAULT_SESSION_CONFIG.idleTimeoutSeconds,
    spindownDelaySeconds:
      sessionConfig?.spindownDelaySeconds ?? DEFAULT_SESSION_CONFIG.spindownDelaySeconds,
  };

  // 1. Rate limit check
  await checkRateLimit(sourceIp);

  // Validate input
  if (!body.preshared_key || !body.friendly_name || !body.host_tool) {
    recordFailure(sourceIp);
    throw new AmbassadorError('Missing required fields', 'validation_error', 400);
  }

  // Validate host_tool enum
  const validHostTools = [
    'vscode',
    'claude-desktop',
    'claude-code',
    'opencode',
    'gemini-cli',
    'chatgpt',
    'jetbrains',
    'cli',
    'custom',
  ];
  if (!validHostTools.includes(body.host_tool)) {
    recordFailure(sourceIp);
    throw new AmbassadorError('Invalid host_tool value', 'validation_error', 400);
  }

  try {
    // 2. Validate preshared key
    const validatedKey = await validateClientKey(db, body.preshared_key);

    // 3. Check for existing active sessions for this user
    const existingSessions = await db.query.user_sessions.findMany({
      where: (sessions, { eq, and, or }) =>
        and(
          eq(sessions.user_id, validatedKey.user_id),
          or(
            eq(sessions.status, 'active'),
            eq(sessions.status, 'idle'),
            eq(sessions.status, 'spinning_down')
          )
        ),
      orderBy: (sessions, { desc }) => [desc(sessions.last_activity_at)],
    });

    // Reuse is only allowed for the same client_id binding.
    // This prevents cross-client session reuse causing stale/wrong tool catalogs.
    const reusableSession = existingSessions.find(session => {
      const sessionClientId = extractSessionClientId(session.metadata);
      return sessionClientId === validatedKey.client_id;
    });

    if (reusableSession) {
      // Session reuse: verify profile_id matches (SEC-V2-007)
      if (reusableSession.profile_id !== validatedKey.profile_id) {
        // M-001 fix: Don't call recordFailure here — the catch block handles it uniformly
        // L-001 fix: Don't expose internal profile IDs in error response
        throw new AmbassadorError(
          'Profile mismatch: preshared key is bound to a different profile than the active session. Contact your administrator.',
          'profile_mismatch',
          409
        );
      }

      logger.info(
        `[authn-ephemeral] Reusing existing session ${reusableSession.session_id} for user ${validatedKey.user_id}`
      );

      // Generate fresh session token for reused session
      const { token, tokenHash, nonce } = generateSessionToken(
        hmacSecret,
        reusableSession.session_id
      );

      // Update session with new token
      const now = new Date().toISOString();
      await compatUpdate(db, user_sessions)
        .set({
          session_token_hash: tokenHash,
          token_nonce: nonce,
          last_activity_at: now,
          status: 'active', // Reactivate if idle/spinning_down
          metadata: JSON.stringify({ client_id: validatedKey.client_id }),
        })
        .where(eq(user_sessions.session_id, reusableSession.session_id));

      // Insert new connection record
      const connectionId = uuidv4();
      await compatInsert(db, session_connections).values({
        connection_id: connectionId,
        session_id: reusableSession.session_id,
        friendly_name: body.friendly_name,
        host_tool: body.host_tool,
        connected_at: now,
        last_heartbeat_at: now,
        status: 'connected',
      });

      // Clear rate limit failures on success
      clearFailures(sourceIp);

      return {
        session_id: reusableSession.session_id,
        session_token: token,
        expires_at: reusableSession.expires_at,
        profile_id: reusableSession.profile_id,
        connection_id: connectionId,
      };
    }

    // 4. Create new session
    const sessionId = uuidv4();
    const { token, tokenHash, nonce } = generateSessionToken(hmacSecret, sessionId);

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000).toISOString();

    // Insert session record
    await compatInsert(db, user_sessions).values({
      session_id: sessionId,
      user_id: validatedKey.user_id,
      session_token_hash: tokenHash,
      token_nonce: nonce,
      status: 'active',
      profile_id: validatedKey.profile_id,
      created_at: now,
      last_activity_at: now,
      expires_at: expiresAt,
      idle_timeout_seconds: config.idleTimeoutSeconds,
      spindown_delay_seconds: config.spindownDelaySeconds,
      metadata: JSON.stringify({ client_id: validatedKey.client_id }),
    });

    // Insert connection record
    const connectionId = uuidv4();
    await compatInsert(db, session_connections).values({
      connection_id: connectionId,
      session_id: sessionId,
      friendly_name: body.friendly_name,
      host_tool: body.host_tool,
      connected_at: now,
      last_heartbeat_at: now,
      status: 'connected',
    });

    logger.info(
      `[authn-ephemeral] Created new session ${sessionId} for user ${validatedKey.user_id}`
    );

    // Clear rate limit failures on success
    clearFailures(sourceIp);

    return {
      session_id: sessionId,
      session_token: token,
      expires_at: expiresAt,
      profile_id: validatedKey.profile_id,
      connection_id: connectionId,
    };
  } catch (err) {
    recordFailure(sourceIp);
    throw err;
  }
}

/**
 * Enforce hard cap on rate limit state map size
 *
 * When map exceeds maxEntries, evicts oldest entries (by timestamp)
 * until size is at the cap. This prevents unbounded memory growth.
 */
function enforceRateLimitMapSizeCap(): void {
  if (rateLimitState.size < RATE_LIMIT_CONFIG.maxEntries) {
    return; // Still under cap
  }

  // Find entries to evict (oldest first)
  const entries = Array.from(rateLimitState.entries());
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

  // Evict oldest 10% of entries to make room
  const entriesToEvict = Math.ceil(RATE_LIMIT_CONFIG.maxEntries * 0.1);
  for (
    let i = 0;
    i < entriesToEvict && i < entries.length && rateLimitState.size >= RATE_LIMIT_CONFIG.maxEntries;
    i++
  ) {
    const entry = entries[i];
    if (entry) {
      rateLimitState.delete(entry[0]);
    }
  }
}

/**
 * Check rate limit for IP address
 *
 * Implements:
 * - 10 requests/minute per IP
 * - Exponential backoff after 3 consecutive failures
 *
 * @param sourceIp Source IP address
 * @throws AmbassadorError if rate limit exceeded
 */
async function checkRateLimit(sourceIp: string): Promise<void> {
  const now = Date.now();
  const state = rateLimitState.get(sourceIp);

  if (!state) {
    // First request from this IP
    // Check hard cap before adding new entry
    enforceRateLimitMapSizeCap();

    rateLimitState.set(sourceIp, {
      count: 1,
      windowStart: now,
      consecutiveFailures: 0,
      timestamp: now,
    });
    return;
  }

  // Check if window expired
  if (now - state.windowStart >= RATE_LIMIT_CONFIG.windowMs) {
    // Reset window
    state.count = 1;
    state.windowStart = now;
    state.timestamp = now; // Update timestamp on reset
    return;
  }

  // Check if exponential backoff applies
  if (state.consecutiveFailures >= RATE_LIMIT_CONFIG.maxFailures) {
    const backoffDuration =
      RATE_LIMIT_CONFIG.windowMs *
      Math.pow(
        RATE_LIMIT_CONFIG.backoffBase,
        state.consecutiveFailures - RATE_LIMIT_CONFIG.maxFailures
      );
    const backoffExpires = state.windowStart + backoffDuration;

    if (now < backoffExpires) {
      const remainingMs = backoffExpires - now;
      logger.warn(
        `[authn-ephemeral] Rate limit backoff for ${sourceIp}: ${state.consecutiveFailures} failures, ${Math.ceil(remainingMs / 1000)}s remaining`
      );
      throw new AmbassadorError(
        `Too many failed attempts. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`,
        'rate_limit_exceeded',
        429
      );
    }

    // Backoff expired, reset
    state.count = 1;
    state.windowStart = now;
    state.consecutiveFailures = 0;
    return;
  }

  // Check regular rate limit
  if (state.count >= RATE_LIMIT_CONFIG.maxRequests) {
    const remainingMs = RATE_LIMIT_CONFIG.windowMs - (now - state.windowStart);
    logger.warn(
      `[authn-ephemeral] Rate limit exceeded for ${sourceIp}: ${state.count} requests in window`
    );
    throw new AmbassadorError(
      `Rate limit exceeded. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`,
      'rate_limit_exceeded',
      429
    );
  }

  // Increment count
  state.count++;
}

/**
 * Record failed registration attempt
 */
function recordFailure(sourceIp: string): void {
  const state = rateLimitState.get(sourceIp);
  if (state) {
    state.consecutiveFailures++;
  }
}

/**
 * Clear failure count on successful registration
 */
function clearFailures(sourceIp: string): void {
  const state = rateLimitState.get(sourceIp);
  if (state) {
    state.consecutiveFailures = 0;
  }
}

/**
 * Cleanup timer reference (for graceful shutdown)
 */
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Cleanup expired rate limit entries (periodic maintenance)
 * Call this periodically via setInterval in production
 */
export function cleanupRateLimitState(): void {
  const now = Date.now();
  const maxAge = RATE_LIMIT_CONFIG.windowMs * 10; // Keep for 10 minutes

  for (const [ip, state] of rateLimitState.entries()) {
    if (now - state.windowStart > maxAge) {
      rateLimitState.delete(ip);
    }
  }
}

/**
 * Start periodic cleanup timer for rate limit state
 *
 * Initializes a timer to cleanup expired entries every 60 seconds.
 * Call this during server startup.
 *
 * @see server.ts initialize() method
 */
export function startRateLimitCleanup(): void {
  if (cleanupTimer) {
    return; // Already running
  }

  cleanupTimer = setInterval(() => {
    cleanupRateLimitState();
  }, RATE_LIMIT_CONFIG.cleanupIntervalMs);

  // Prevent the timer from keeping the process alive
  cleanupTimer.unref();
}

/**
 * Stop periodic cleanup timer and clear all rate limit state
 *
 * Call this during server shutdown for graceful cleanup.
 *
 * @see server.ts stop() method
 */
export function stopRateLimitCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  // Clear all rate limit state on shutdown
  rateLimitState.clear();
}
