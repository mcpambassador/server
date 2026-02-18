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
}
