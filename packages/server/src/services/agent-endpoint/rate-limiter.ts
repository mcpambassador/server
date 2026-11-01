/**
 * Fixed-window in-memory rate limiter for the agent endpoint (limits come from
 * agent_endpoint.rate_limits). Keys are bounded by periodic pruning.
 *
 * NOTE: state is in memory PER PROCESS — it resets on restart and is not shared across replicas.
 * Acceptable for the single-instance deployment; move to the DB/Redis before running multiple replicas.
 */

interface Window {
  start: number;
  count: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private static readonly MAX_KEYS = 50_000;

  /** Returns true if the call is allowed (and counts it) */
  allow(key: string, limit: number, windowMs: number, nowMs: number = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || nowMs - w.start >= windowMs) {
      if (this.windows.size >= RateLimiter.MAX_KEYS) this.prune(nowMs, windowMs);
      this.windows.set(key, { start: nowMs, count: 1 });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  }

  /** Drop expired windows; if still full, drop oldest half (fail-safe against key flooding) */
  private prune(nowMs: number, windowMs: number): void {
    for (const [k, w] of this.windows) {
      if (nowMs - w.start >= windowMs) this.windows.delete(k);
    }
    if (this.windows.size >= RateLimiter.MAX_KEYS) {
      const keys = [...this.windows.keys()];
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.windows.delete(k);
    }
  }

  clear(): void {
    this.windows.clear();
  }
}
