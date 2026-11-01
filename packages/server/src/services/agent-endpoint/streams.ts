/**
 * In-flight /mcp request registry (per process). Bounds concurrent requests per grant
 * (agent_endpoint.max_streams_per_grant) and lets revocation abort them.
 */

export class AgentStreamRegistry {
  private byGrant = new Map<string, Set<() => void>>();

  /** Returns a release function, or null if the grant is at its concurrency cap */
  acquire(grantId: string, max: number, abort: () => void): (() => void) | null {
    let set = this.byGrant.get(grantId);
    if (!set) {
      set = new Set();
      this.byGrant.set(grantId, set);
    }
    if (set.size >= max) return null;
    set.add(abort);
    return () => {
      const s = this.byGrant.get(grantId);
      if (!s) return;
      s.delete(abort);
      if (s.size === 0) this.byGrant.delete(grantId);
    };
  }

  count(grantId: string): number {
    return this.byGrant.get(grantId)?.size ?? 0;
  }

  /** Abort every in-flight request of a grant (revoked / bound client gone) */
  closeGrant(grantId: string): number {
    const set = this.byGrant.get(grantId);
    if (!set) return 0;
    const fns = [...set];
    this.byGrant.delete(grantId);
    for (const f of fns) {
      try {
        f();
      } catch {
        /* ignore */
      }
    }
    return fns.length;
  }
}
