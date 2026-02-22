/**
 * MCP Catalog Hot Reload Service
 *
 * ADR-013: Implements manual catalog reload (Phase 1 MVP).
 * Diffs database state against running MCP connections and reconciles.
 *
 * @see mcpambassador_docs/adr/013-hot-catalog-reload.md
 */

/**
 * N3 fix: Custom error class for reload conflicts
 */
export class CatalogReloadConflictError extends Error {
  readonly code = 'RELOAD_CONFLICT';
  constructor() {
    super('Catalog reload already in progress');
    this.name = 'CatalogReloadConflictError';
  }
}

import type { DatabaseClient, McpCatalogEntry } from '@mcpambassador/core';
import type { SharedMcpManager } from '../downstream/manager.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import type { DownstreamMcpConfig } from '../downstream/types.js';
import { listMcpCatalogEntries } from './mcp-catalog-service.js';
import { computeConfigFingerprint } from '../downstream/manager.js';

/**
 * Pending changes preview structure
 */
export interface PendingChanges {
  shared: {
    to_add: Array<{ name: string; transport_type: string }>;
    to_remove: Array<{ name: string; reason: string }>;
    to_update: Array<{ name: string; changed_fields: string[] }>;
    unchanged: string[];
  };
  per_user: {
    to_add: Array<{ name: string }>;
    to_remove: Array<{ name: string }>;
    to_update: Array<{ name: string }>;
  };
  has_changes: boolean;
}

/**
 * Reload execution result
 */
export interface ReloadResult {
  timestamp: string;
  shared: {
    added: string[];
    removed: string[];
    updated: string[];
    unchanged: string[];
    errors: Array<{ name: string; action: string; error: string }>;
  };
  per_user: {
    configs_added: string[];
    configs_removed: string[];
    configs_updated: string[];
    active_users_affected: number;
    note: string;
  };
  summary: {
    total_changes: number;
    successful: number;
    failed: number;
  };
}

/**
 * B1 fix: Use canonical fingerprint function from manager.ts
 * Wrapper for backward compatibility in this file
 */
function computeFingerprint(entry: McpCatalogEntry): string {
  return computeConfigFingerprint(entry.transport_type, entry.config, entry.isolation_mode);
}

/**
 * Convert catalog entry to DownstreamMcpConfig format
 * (Same logic as server.ts startup and manager.ts initializeFromCatalog)
 */
function catalogEntryToConfig(entry: McpCatalogEntry): DownstreamMcpConfig {
  const config = JSON.parse(entry.config) as Record<string, unknown>;

  const mcpConfig: DownstreamMcpConfig = {
    name: entry.name,
    transport: entry.transport_type as 'stdio' | 'http' | 'sse',
  };

  if (entry.transport_type === 'stdio') {
    const command = config.command;
    if (Array.isArray(command)) {
      mcpConfig.command = command as string[];
    } else {
      mcpConfig.command = [config.command as string];
    }
    if (config.env) mcpConfig.env = config.env as Record<string, string>;
    if (config.cwd) mcpConfig.cwd = config.cwd as string;
  } else if (entry.transport_type === 'http' || entry.transport_type === 'sse') {
    mcpConfig.url = config.url as string;
    if (config.headers) mcpConfig.headers = config.headers as Record<string, string>;
    if (config.timeout_ms) mcpConfig.timeout_ms = config.timeout_ms as number;
  }

  return mcpConfig;
}

/**
 * Catalog Reloader
 *
 * Handles hot reload of MCP catalog changes without full restart.
 */
export class CatalogReloader {
  private reloading = false; // Simple mutex to prevent concurrent reloads

  constructor(
    private db: DatabaseClient,
    private mcpManager: SharedMcpManager,
    private userPool: UserMcpPool
  ) {}

  /**
   * Preview pending changes without applying them
   * Reads DB, diffs against running state, returns preview
   */
  async previewChanges(): Promise<PendingChanges> {
    // Fetch published MCPs from catalog (N2 fix: bumped limit to 1000)
    const sharedResult = await listMcpCatalogEntries(
      this.db,
      { status: 'published', isolation_mode: 'shared' },
      { limit: 1000 }
    );
    const perUserResult = await listMcpCatalogEntries(
      this.db,
      { status: 'published', isolation_mode: 'per_user' },
      { limit: 1000 }
    );

    // N2 fix: Warn if catalog is truncated
    if (sharedResult.has_more) {
      console.warn(`[CatalogReloader] Catalog truncated at 1000 shared MCPs (has_more=true)`);
    }
    if (perUserResult.has_more) {
      console.warn(`[CatalogReloader] Catalog truncated at 1000 per-user MCPs (has_more=true)`);
    }

    // --- DIFF SHARED MCPs ---
    const runningFingerprints = this.mcpManager.getRunningFingerprints();
    const desiredShared = new Map(
      sharedResult.entries.map(e => [e.name, computeFingerprint(e)])
    );

    const sharedToAdd: Array<{ name: string; transport_type: string }> = [];
    const sharedToUpdate: Array<{ name: string; changed_fields: string[] }> = [];
    const sharedUnchanged: string[] = [];

    for (const entry of sharedResult.entries) {
      const name = entry.name;
      const desiredFp = desiredShared.get(name)!;

      if (!runningFingerprints.has(name)) {
        sharedToAdd.push({ name, transport_type: entry.transport_type });
      } else {
        const runningFp = runningFingerprints.get(name)!;
        if (runningFp !== desiredFp) {
          sharedToUpdate.push({ name, changed_fields: ['config'] });
        } else {
          sharedUnchanged.push(name);
        }
      }
    }

    const sharedToRemove: Array<{ name: string; reason: string }> = [];
    for (const runningName of runningFingerprints.keys()) {
      if (!desiredShared.has(runningName)) {
        sharedToRemove.push({ name: runningName, reason: 'unpublished or deleted' });
      }
    }

    // --- DIFF PER-USER MCPs ---
    // N1 fix: Use public getter instead of bracket notation
    const currentPerUserNames = this.userPool.getMcpConfigNames();
    const currentPerUserNamesSet = new Set(currentPerUserNames);
    const desiredPerUserNames = new Set(perUserResult.entries.map(e => e.name));

    // B3 fix: Get current per-user fingerprints for accurate diff
    const currentPerUserFingerprints = this.userPool.getMcpConfigFingerprints();
    const desiredPerUserFingerprints = new Map(
      perUserResult.entries.map(e => [e.name, computeFingerprint(e)])
    );

    const perUserToAdd = perUserResult.entries
      .filter(e => !currentPerUserNamesSet.has(e.name))
      .map(e => ({ name: e.name }));
    const perUserToRemove = [...currentPerUserNamesSet]
      .filter(n => !desiredPerUserNames.has(n))
      .map(n => ({ name: n }));
    // B3 fix: Only mark as updated if fingerprint actually differs
    const perUserToUpdate = perUserResult.entries
      .filter(e => {
        if (!currentPerUserNamesSet.has(e.name)) return false;
        const currentFp = currentPerUserFingerprints.get(e.name);
        const desiredFp = desiredPerUserFingerprints.get(e.name);
        return currentFp !== desiredFp;
      })
      .map(e => ({ name: e.name }));

    const hasChanges =
      sharedToAdd.length > 0 ||
      sharedToRemove.length > 0 ||
      sharedToUpdate.length > 0 ||
      perUserToAdd.length > 0 ||
      perUserToRemove.length > 0 ||
      perUserToUpdate.length > 0;

    return {
      shared: {
        to_add: sharedToAdd,
        to_remove: sharedToRemove,
        to_update: sharedToUpdate,
        unchanged: sharedUnchanged,
      },
      per_user: {
        to_add: perUserToAdd,
        to_remove: perUserToRemove,
        to_update: perUserToUpdate,
      },
      has_changes: hasChanges,
    };
  }

  /**
   * Apply catalog changes (main reload execution)
   * Diffs DB against running state and reconciles
   */
  async applyChanges(): Promise<ReloadResult> {
    if (this.reloading) {
      // N3 fix: Use custom error class
      throw new CatalogReloadConflictError();
    }

    this.reloading = true;
    try {
      return await this._doReload();
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Internal reload implementation
   */
  private async _doReload(): Promise<ReloadResult> {
    const startTime = new Date().toISOString();

    // Fetch published MCPs from catalog (N2 fix: bumped limit to 1000)
    const sharedResult = await listMcpCatalogEntries(
      this.db,
      { status: 'published', isolation_mode: 'shared' },
      { limit: 1000 }
    );
    const perUserResult = await listMcpCatalogEntries(
      this.db,
      { status: 'published', isolation_mode: 'per_user' },
      { limit: 1000 }
    );

    // N2 fix: Warn if catalog is truncated
    if (sharedResult.has_more) {
      console.warn(`[CatalogReloader] Catalog truncated at 1000 shared MCPs (has_more=true), only processing first batch`);
    }
    if (perUserResult.has_more) {
      console.warn(`[CatalogReloader] Catalog truncated at 1000 per-user MCPs (has_more=true), only processing first batch`);
    }

    // --- DIFF SHARED MCPs ---
    const runningFingerprints = this.mcpManager.getRunningFingerprints();
    const desiredShared = new Map<string, { entry: McpCatalogEntry; fingerprint: string }>();

    for (const entry of sharedResult.entries) {
      desiredShared.set(entry.name, {
        entry,
        fingerprint: computeFingerprint(entry),
      });
    }

    const toAdd: McpCatalogEntry[] = [];
    const toUpdate: McpCatalogEntry[] = [];
    const unchanged: string[] = [];

    for (const entry of sharedResult.entries) {
      const name = entry.name;
      const desired = desiredShared.get(name)!;

      if (!runningFingerprints.has(name)) {
        toAdd.push(entry);
      } else {
        const runningFp = runningFingerprints.get(name)!;
        if (runningFp !== desired.fingerprint) {
          toUpdate.push(entry);
        } else {
          unchanged.push(name);
        }
      }
    }

    const toRemove: string[] = [];
    for (const runningName of runningFingerprints.keys()) {
      if (!desiredShared.has(runningName)) {
        toRemove.push(runningName);
      }
    }

    // --- RECONCILE SHARED MCPs ---
    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];
    const errors: Array<{ name: string; action: string; error: string }> = [];

    // 1. ADD new MCPs (parallel)
    // B1 fix: Pass pre-computed fingerprint to addMcp
    const addPromises = toAdd.map(async entry => {
      try {
        const config = catalogEntryToConfig(entry);
        const fingerprint = computeFingerprint(entry);
        await this.mcpManager.addMcp(config, fingerprint);
        added.push(entry.name);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ name: entry.name, action: 'add', error: errorMsg });
      }
    });
    await Promise.allSettled(addPromises);

    // 2. UPDATE changed MCPs (sequential, stop → start per MCP)
    // B1 fix: Pass pre-computed fingerprint to updateMcp
    for (const entry of toUpdate) {
      try {
        const config = catalogEntryToConfig(entry);
        const fingerprint = computeFingerprint(entry);
        await this.mcpManager.updateMcp(entry.name, config, fingerprint);
        updated.push(entry.name);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ name: entry.name, action: 'update', error: errorMsg });
      }
    }

    // 3. REMOVE stale MCPs (parallel)
    const removePromises = toRemove.map(async name => {
      try {
        await this.mcpManager.removeMcp(name);
        removed.push(name);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ name, action: 'remove', error: errorMsg });
      }
    });
    await Promise.allSettled(removePromises);

    // 4. Re-aggregate tools (single pass after all changes)
    await this.mcpManager.aggregateTools();

    // --- UPDATE PER-USER MCP POOL CONFIGS ---
    const newPerUserConfigs = perUserResult.entries.map(catalogEntryToConfig);
    // B1 fix: Pass catalog-derived fingerprints so UserMcpPool stores canonical hashes
    const newPerUserFingerprints = new Map<string, string>();
    for (const entry of perUserResult.entries) {
      newPerUserFingerprints.set(entry.name, computeFingerprint(entry));
    }
    const perUserChanges = this.userPool.updateMcpConfigs(newPerUserConfigs, newPerUserFingerprints);

    // Get count of active users (all user instances with status 'ready')
    const activeUsersAffected = this.userPool.getStatus().userCount;

    // --- SUMMARY ---
    // B2 fix: Correct math - count attempts, not successes
    const attempted = toAdd.length + toUpdate.length + toRemove.length;
    const failed = errors.length;
    const successful = attempted - failed;

    return {
      timestamp: startTime,
      shared: {
        added,
        removed,
        updated,
        unchanged,
        errors,
      },
      per_user: {
        configs_added: perUserChanges.added,
        configs_removed: perUserChanges.removed,
        configs_updated: perUserChanges.updated,
        active_users_affected: activeUsersAffected,
        note: 'Per-user changes take effect on next session connect. Active sessions retain current config.',
      },
      summary: {
        // N4: Note for future - response shape could be improved with clearer field names
        total_changes: attempted,
        successful,
        failed,
      },
    };
  }
}
