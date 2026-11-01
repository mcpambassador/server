/**
 * Step-up reauthentication state for approval decisions (ADR-023, PR-2).
 *
 * In memory and fail-closed: an unknown session, an expired window or any lookup problem all mean
 * "reauthenticate". There is no migration. This assumes a SINGLE server instance, and a restart
 * clears every window, so every admin must reauthenticate once after a restart. That is the safe
 * direction. Entries are keyed by session id (a new login issues a new id, so a reauth never carries
 * over) and the map is bounded.
 */

import { APPROVAL_REAUTH_WINDOW_SECONDS } from '@mcpambassador/contracts';

const MAX_ENTRIES = 10_000;

export class StepUpStore {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly windowSeconds: number = APPROVAL_REAUTH_WINDOW_SECONDS,
    private readonly clock: () => number = Date.now
  ) {}

  get window(): number {
    return this.windowSeconds;
  }

  /** Record a successful reauth for a session; returns when the window ends (epoch ms). */
  mark(sessionId: string): number {
    const now = this.clock();
    if (this.until.size >= MAX_ENTRIES) {
      for (const [k, v] of this.until) if (v <= now) this.until.delete(k);
      if (this.until.size >= MAX_ENTRIES) this.until.clear();
    }
    const end = now + this.windowSeconds * 1000;
    this.until.set(sessionId, end);
    return end;
  }

  /** True only while a window recorded for exactly this session id is open. */
  isFresh(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const end = this.until.get(sessionId);
    if (end === undefined) return false;
    if (end <= this.clock()) {
      this.until.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Forget a session (logout, destroy). */
  clear(sessionId: string): void {
    this.until.delete(sessionId);
  }
}
