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
  /** Creation time per session id; the TTL is absolute (never extended by activity) */
  private createdAt = new Map<string, number>();
  private maxEntries: number;
  private ttlMs: number | null;
  private clock: () => number;

  /**
   * @param maxEntries - max live sessions (oldest evicted)
   * @param ttlSeconds - absolute session lifetime; null/undefined = no server-side expiry
   * @param clock - injectable time source (defaults to Date.now)
   */
  constructor(maxEntries = 100, ttlSeconds?: number | null, clock: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlSeconds ? ttlSeconds * 1000 : null;
    this.clock = clock;
  }

  private expired(sessionId: string): boolean {
    if (this.ttlMs === null) return false;
    const created = this.createdAt.get(sessionId);
    return created === undefined || this.clock() - created >= this.ttlMs;
  }

  private remove(sessionId: string): void {
    this.store.delete(sessionId);
    this.createdAt.delete(sessionId);
  }

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    try {
      if (!this.store.has(sessionId)) {
        this.sweep();
        if (this.store.size >= this.maxEntries) {
          const firstKey = this.store.keys().next().value;
          if (firstKey) this.remove(firstKey);
        }
        this.createdAt.set(sessionId, this.clock());
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
      if (session && this.expired(sessionId)) {
        this.remove(sessionId);
        callback(null, null);
        return;
      }
      if (session) {
        // AUTH-001: LRU eviction - re-insert to move to end of Map iteration order
        this.store.delete(sessionId);
        this.store.set(sessionId, session);
      }
      callback(null, session);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    try {
      this.remove(sessionId);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  /** Drop all sessions past their absolute TTL */
  sweep(): void {
    if (this.ttlMs === null) return;
    for (const id of [...this.store.keys()]) {
      if (this.expired(id)) this.remove(id);
    }
  }

  /**
   * Clear all sessions (F-SEC-M10-005)
   * Used when rotating admin credentials
   */
  clear(): void {
    this.store.clear();
    this.createdAt.clear();
  }
}

/**
 * @fastify/session emits `Expires` but no `Max-Age`. Add Max-Age (remaining seconds, derived from
 * Expires) to the session cookie so clients that prefer it get the same absolute lifetime.
 */
export function addSessionMaxAge(headers: unknown, now: number = Date.now()): string[] | undefined {
  const raw = headers as string | string[] | number | undefined;
  if (raw === undefined || typeof raw === 'number') return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  let changed = false;
  const out = list.map(c => {
    if (!c.startsWith('sessionId=') || /;\s*max-age=/i.test(c)) return c;
    const m = /;\s*expires=([^;]+)/i.exec(c);
    if (!m) return c;
    const expires = new Date(m[1]!).getTime();
    if (Number.isNaN(expires)) return c;
    changed = true;
    return `${c}; Max-Age=${Math.max(0, Math.round((expires - now) / 1000))}`;
  });
  return changed ? out : undefined;
}

/**
 * Login rate limiter - prevents brute force attacks
 *
 * SEC-M10-03: 5 attempts per IP per 15-minute window
 */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; firstAttempt: number }>();
  private maxAttempts: number;
  private windowMs: number;

  constructor(opts: { maxAttempts?: number; windowMs?: number } = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000; // 15 minutes
  }

  /** Drop all records (tests) */
  clear(): void {
    this.attempts.clear();
  }

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
    // Bound memory: drop expired records once the map grows large
    if (this.attempts.size >= 10_000) {
      for (const [k, v] of this.attempts) {
        if (now - v.firstAttempt > this.windowMs) this.attempts.delete(k);
      }
      if (this.attempts.size >= 10_000) this.attempts.clear();
    }
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
