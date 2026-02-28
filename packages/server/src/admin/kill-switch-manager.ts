/**
 * Kill Switch Manager
 *
 * Shared kill switch state manager used by both REST API routes and htmx UI routes.
 * Prevents state duplication and ensures consistency across admin endpoints.
 *
 * Phase 2/3 will persist to database for cross-instance coordination.
 *
 * @see CR-M10-001 Kill switch state duplication remediation
 * @see M8.8 Admin API Kill Switch Implementation
 */

/**
 * Manages kill switch state for clients and downstream MCPs
 *
 * Key format: `type:target` (e.g., "client:cli_123", "mcp:github")
 * Active switches are stored in Map; inactive switches are absent.
 */
export class KillSwitchManager {
  private state = new Map<string, boolean>();

  /**
   * Toggle kill switch state (used by htmx UI)
   *
   * @param type - Kill switch type (client, mcp, etc.)
   * @param target - Target identifier
   * @returns New state (true = enabled, false = disabled)
   */
  toggle(type: string, target: string): boolean {
    const key = `${type}:${target}`;
    const current = this.state.get(key) || false;
    const newState = !current;

    if (newState) {
      this.state.set(key, true);
    } else {
      this.state.delete(key);
    }

    return newState;
  }

  /**
   * Set kill switch state explicitly (used by REST API)
   *
   * @param target - Target identifier (key without type prefix)
   * @param enabled - Whether kill switch is enabled
   */
  set(target: string, enabled: boolean): void {
    if (enabled) {
      this.state.set(target, true);
    } else {
      this.state.delete(target);
    }
  }

  /**
   * Check if kill switch is active
   *
   * @param type - Kill switch type
   * @param target - Target identifier
   * @returns True if kill switch is enabled
   */
  isActive(type: string, target: string): boolean {
    return this.state.get(`${type}:${target}`) || false;
  }

  /**
   * Get all active kill switches
   *
   * @returns Array of kill switch entries
   */
  getAll(): Array<{ key: string; active: boolean }> {
    return [...this.state.entries()].map(([key, active]) => ({ key, active }));
  }
}
