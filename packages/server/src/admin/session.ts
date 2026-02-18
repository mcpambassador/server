/**
 * Admin UI Session Management
 *
 * Implements secure session handling for admin UI with:
 * - Bounded in-memory session store (max 100 entries)
 * - Login rate limiting (5 attempts per 15 minutes)
 * - HttpOnly, Secure, SameSite=Strict cookies
 *
 * @see ADR-007 Admin UI Technology Selection (EJS + htmx)
 * @see M10: Admin UI Implementation
 */

import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Augment Fastify's Session interface with our admin fields
declare module 'fastify' {
  interface Session {
    isAdmin?: boolean;
    flash?: {
      type: 'error' | 'success' | 'info';
      message: string;
    };
  }
}

/**
 * Bounded session store - prevents memory exhaustion
 *
 * SEC-M10-06: Limits session storage to max 100 entries (oldest discarded)
 */
export class BoundedSessionStore implements SessionStore {
  private store = new Map<string, Session>();
  private maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    try {
      if (this.store.size >= this.maxEntries) {
        const firstKey = this.store.keys().next().value;
        if (firstKey) {
          this.store.delete(firstKey);
        }
      }
      this.store.set(sessionId, session);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  get(sessionId: string, callback: (err: unknown, session?: Session | null) => void): void {
    try {
      const session = this.store.get(sessionId) ?? null;
      callback(null, session);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    try {
      this.store.delete(sessionId);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Clear all sessions (F-SEC-M10-005)
   * Used when rotating admin credentials
   */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Login rate limiter - prevents brute force attacks
 *
 * SEC-M10-03: 5 attempts per IP per 15-minute window
 */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; firstAttempt: number }>();
  private maxAttempts = 5;
  private windowMs = 15 * 60 * 1000; // 15 minutes

  /**
   * Check if IP is rate limited
   */
  isRateLimited(ip: string): boolean {
    const record = this.attempts.get(ip);
    if (!record) return false;

    const now = Date.now();
    const elapsed = now - record.firstAttempt;

    // If window expired, clear record
    if (elapsed > this.windowMs) {
      this.attempts.delete(ip);
      return false;
    }

    return record.count >= this.maxAttempts;
  }

  /**
   * Record failed login attempt
   */
  recordFailure(ip: string): void {
    const now = Date.now();
    const record = this.attempts.get(ip);

    if (!record) {
      this.attempts.set(ip, { count: 1, firstAttempt: now });
      return;
    }

    const elapsed = now - record.firstAttempt;

    // If window expired, reset
    if (elapsed > this.windowMs) {
      this.attempts.set(ip, { count: 1, firstAttempt: now });
    } else {
      record.count += 1;
    }
  }

  /**
   * Reset rate limit for IP (after successful login)
   */
  reset(ip: string): void {
    this.attempts.delete(ip);
  }

  /**
   * Get remaining time until rate limit expires (seconds)
   */
  getRetryAfter(ip: string): number {
    const record = this.attempts.get(ip);
    if (!record) return 0;

    const now = Date.now();
    const elapsed = now - record.firstAttempt;
    const remaining = this.windowMs - elapsed;

    return Math.ceil(remaining / 1000);
  }

  /**
   * Get failure count for IP (F-SEC-M10-004)
   * Used for brute force detection alerts
   */
  getFailureCount(ip: string): number {
    const record = this.attempts.get(ip);
    if (!record) return 0;

    const now = Date.now();
    const elapsed = now - record.firstAttempt;

    // If window expired, return 0
    if (elapsed > this.windowMs) {
      return 0;
    }

    return record.count;
  }

  /**
   * Get progressive delay for failed attempts (F-SEC-M10-006)
   * Returns delay in milliseconds (exponential backoff: 1s, 2s, 4s, 8s, 15s max)
   */
  getDelayMs(ip: string): number {
    const record = this.attempts.get(ip);
    if (!record) return 0;

    // Exponential backoff: 2^(count-1) seconds, capped at 15 seconds
    return Math.min(1000 * Math.pow(2, record.count - 1), 15000);
  }
}

/**
 * Get or create session secret (F-SEC-M10-001)
 *
 * Priority: 1) ADMIN_SESSION_SECRET env var, 2) Persisted file, 3) Generate new
 * Persists to `.session-secret` in dataDir with 0600 permissions
 *
 * @param dataDir - Data directory path
 * @returns Cryptographically secure session secret (≥32 chars)
 */
export function getOrCreateSessionSecret(dataDir: string): string {
  // Environment variable takes priority
  const envSecret = process.env['ADMIN_SESSION_SECRET'];
  if (envSecret && envSecret.length >= 32) {
    return envSecret;
  }

  // Try to read existing secret from file
  const secretPath = join(dataDir, '.session-secret');

  try {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // File doesn't exist or unreadable, generate new secret
  }

  // Generate new cryptographically random secret
  const secret = randomBytes(32).toString('hex'); // 64 hex chars

  // Persist to file with restrictive permissions
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, secret, { mode: 0o600 });

  return secret;
}
