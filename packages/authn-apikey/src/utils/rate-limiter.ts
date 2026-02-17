/**
 * Rate Limiter Utility
 *
 * In-memory rate limiter for Community tier.
 * Enterprise tier will use Redis for distributed rate limiting.
 *
 * @see F-SEC-M4-010: Extracted for reuse across registration, admin recovery, etc.
 */

/**
 * In-memory rate limiter with sliding window
 */
export class RateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  /**
   * Check if the key has exceeded the rate limit
   *
   * @param key Rate limit key (e.g., IP address, client_id)
   * @param limit Maximum attempts allowed
   * @param windowMs Time window in milliseconds
   * @returns true if under limit, false if limit exceeded
   */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now > record.resetAt) {
      // New window or expired - reset counter
      this.attempts.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (record.count >= limit) {
      // Rate limit exceeded
      return false;
    }

    // Increment counter
    record.count++;
    return true;
  }

  /**
   * Clean up expired entries
   *
   * Call periodically to prevent memory growth.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.attempts.entries()) {
      if (now > record.resetAt) {
        this.attempts.delete(key);
      }
    }
  }

  /**
   * Get current attempt count for a key
   *
   * @param key Rate limit key
   * @returns Current attempt count (0 if not found or expired)
   */
  getCount(key: string): number {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now > record.resetAt) {
      return 0;
    }

    return record.count;
  }

  /**
   * Reset rate limit for a key
   *
   * @param key Rate limit key to reset
   */
  reset(key: string): void {
    this.attempts.delete(key);
  }
}
