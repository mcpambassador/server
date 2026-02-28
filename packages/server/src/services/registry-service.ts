/**
 * Community Registry Service
 *
 * Fetches, caches, and serves MCP definitions from a community registry (YAML file).
 * Provides "install from registry" functionality for one-click MCP installation.
 *
 * @see mcpambassador_docs/community-registry-spec.md
 */

import * as yaml from 'yaml';
import type { DatabaseClient } from '@mcpambassador/core';
import {
  getMcpEntryByName,
  createMcpEntry,
  getGroupByName,
  grantGroupAccess,
} from '@mcpambassador/core';

export interface RegistryConfig {
  url: string;
  refreshIntervalHours: number;
  enabled: boolean;
  token?: string; // Auth token for private registries (GitHub PAT, etc.)
}

export interface RegistryMcpEntry {
  // Catalog-compatible fields (imported on install)
  name: string;
  display_name: string;
  description: string;
  icon_url?: string;
  transport_type: 'stdio' | 'http' | 'sse';
  config: Record<string, unknown>;
  auth_type?: 'none' | 'static' | 'oauth2';
  oauth_config?: Record<string, unknown>;
  isolation_mode?: 'shared' | 'per_user';
  requires_user_credentials?: boolean;
  credential_schema?: Record<string, unknown>;

  // Registry-only metadata
  tags?: string[];
  category?: string;
  repository_url?: string;
  documentation_url?: string;
  version?: string;
  maintainer?: string;
  verified?: boolean;
}

export interface RegistryData {
  schema_version: string;
  registry: {
    name: string;
    description?: string;
    maintainer: string;
    url?: string;
    updated_at: string;
  };
  mcps: RegistryMcpEntry[];
}

export interface RegistryMcpWithStatus extends RegistryMcpEntry {
  installed: boolean;
  installed_mcp_id?: string;
}

/**
 * Community Registry Service
 *
 * Manages community MCP registry: fetch, cache, and install MCPs from registry.
 */
export class RegistryService {
  private config: RegistryConfig;
  private db: DatabaseClient;
  private cachedRegistry: RegistryData | null = null;
  private lastFetchedAt: Date | null = null;

  constructor(config: RegistryConfig, db: DatabaseClient) {
    this.config = config;
    this.db = db;
  }

  /**
   * Fetch registry from configured URL and cache it
   */
  async fetchRegistry(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[RegistryService] Registry is disabled, skipping fetch');
      return;
    }

    try {
      console.log(`[RegistryService] Fetching registry from: ${this.config.url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.raw, text/yaml, text/plain, */*',
        'User-Agent': 'MCPAmbassador-Registry/1.0',
      };
      if (this.config.token) {
        headers['Authorization'] = `token ${this.config.token}`;
      }

      const response = await fetch(this.config.url, {
        signal: controller.signal,
        headers,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const yamlText = await response.text();
      const parsed = yaml.parse(yamlText) as RegistryData;

      // Validate schema
      if (!parsed.schema_version) {
        throw new Error('Invalid registry: missing schema_version');
      }
      if (!parsed.registry) {
        throw new Error('Invalid registry: missing registry metadata');
      }
      if (!Array.isArray(parsed.mcps)) {
        throw new Error('Invalid registry: mcps must be an array');
      }

      this.cachedRegistry = parsed;
      this.lastFetchedAt = new Date();

      console.log(
        `[RegistryService] Registry cached: ${parsed.mcps.length} entries from ${parsed.registry.name}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[RegistryService] Failed to fetch registry: ${message}`);

      // Keep serving stale cache if available
      if (this.cachedRegistry) {
        console.log('[RegistryService] Continuing with stale cache');
      }

      throw error;
    }
  }

  /**
   * Get all registry entries with installed status
   */
  async getEntries(options?: {
    search?: string;
    tags?: string[];
    category?: string;
  }): Promise<RegistryMcpWithStatus[]> {
    if (!this.config.enabled) {
      return [];
    }

    if (!this.cachedRegistry) {
      throw new Error('Registry not loaded. Call fetchRegistry() first.');
    }

    let entries = this.cachedRegistry.mcps;

    // Filter by search query (name or description)
    if (options?.search) {
      const searchLower = options.search.toLowerCase();
      entries = entries.filter(
        entry =>
          entry.name.toLowerCase().includes(searchLower) ||
          entry.display_name.toLowerCase().includes(searchLower) ||
          entry.description.toLowerCase().includes(searchLower)
      );
    }

    // Filter by tags
    if (options?.tags && options.tags.length > 0) {
      entries = entries.filter(entry => entry.tags?.some(tag => options.tags!.includes(tag)));
    }

    // Filter by category
    if (options?.category) {
      entries = entries.filter(entry => entry.category === options.category);
    }

    // Query database for installed status (batch query)
    const names = entries.map(e => e.name);
    const installed = new Map<string, string>(); // name -> mcp_id

    for (const name of names) {
      const existing = await getMcpEntryByName(this.db, name);
      if (existing) {
        installed.set(name, existing.mcp_id);
      }
    }

    // Augment entries with installed status
    return entries.map(entry => ({
      ...entry,
      installed: installed.has(entry.name),
      installed_mcp_id: installed.get(entry.name),
    }));
  }

  /**
   * Get single registry entry with installed status
   */
  async getEntry(name: string): Promise<RegistryMcpWithStatus | null> {
    if (!this.config.enabled) {
      return null;
    }

    if (!this.cachedRegistry) {
      throw new Error('Registry not loaded. Call fetchRegistry() first.');
    }

    const entry = this.cachedRegistry.mcps.find(e => e.name === name);
    if (!entry) {
      return null;
    }

    // Check if installed
    const existing = await getMcpEntryByName(this.db, name);

    return {
      ...entry,
      installed: !!existing,
      installed_mcp_id: existing?.mcp_id,
    };
  }

  /**
   * Install MCP from registry into local catalog
   *
   * Extracts catalog-compatible fields and creates a draft entry.
   * Grants access to 'all-users' group by default.
   */
  async installEntry(
    name: string
  ): Promise<{ success: boolean; mcp_id?: string; message: string }> {
    if (!this.config.enabled) {
      return {
        success: false,
        message: 'Registry is disabled',
      };
    }

    if (!this.cachedRegistry) {
      throw new Error('Registry not loaded. Call fetchRegistry() first.');
    }

    // Find entry in registry
    const registryEntry = this.cachedRegistry.mcps.find(e => e.name === name);
    if (!registryEntry) {
      return {
        success: false,
        message: `MCP '${name}' not found in registry`,
      };
    }

    // Check if already installed
    const existing = await getMcpEntryByName(this.db, name);
    if (existing) {
      return {
        success: false,
        message: `MCP '${name}' is already installed (mcp_id: ${existing.mcp_id})`,
      };
    }

    try {
      // Extract catalog-compatible fields only
      const catalogData = {
        name: registryEntry.name,
        display_name: registryEntry.display_name,
        description: registryEntry.description || '',
        icon_url: registryEntry.icon_url || null,
        transport_type: registryEntry.transport_type,
        config: JSON.stringify(registryEntry.config),
        auth_type: registryEntry.auth_type || 'none',
        oauth_config: JSON.stringify(registryEntry.oauth_config || {}),
        isolation_mode: registryEntry.isolation_mode || 'shared',
        requires_user_credentials: registryEntry.requires_user_credentials ?? false,
        credential_schema: JSON.stringify(registryEntry.credential_schema || {}),
        status: 'draft' as const,
        validation_status: 'pending' as const,
      };

      // Create catalog entry
      const entry = await createMcpEntry(this.db, catalogData);

      console.log(
        `[RegistryService] Installed MCP '${name}' from registry (mcp_id: ${entry.mcp_id})`
      );

      // Grant access to 'all-users' group so the MCP can appear in the marketplace once published
      let groupAccessGranted = true;
      try {
        const allUsersGroup = await getGroupByName(this.db, 'all-users');
        if (allUsersGroup) {
          await grantGroupAccess(this.db, {
            mcp_id: entry.mcp_id,
            group_id: allUsersGroup.group_id,
            assigned_by: 'system',
          });
          console.log(
            `[RegistryService] Granted 'all-users' group access to MCP (mcp_id: ${entry.mcp_id})`
          );
        } else {
          groupAccessGranted = false;
          console.warn(
            "[RegistryService] 'all-users' group not found; skipping grant of group access"
          );
        }
      } catch (err) {
        groupAccessGranted = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[RegistryService] Failed to grant 'all-users' group access: ${msg}`);
      }

      let message = `MCP '${name}' installed from registry. Status: draft.`;
      if (!groupAccessGranted) {
        message +=
          ' Warning: group access could not be granted — MCP may not appear in marketplace after publishing.';
      }
      if (registryEntry.auth_type === 'oauth2') {
        message += ' Configure OAuth credentials to activate.';
      } else if (registryEntry.auth_type === 'static') {
        message += ' Configure static credentials to activate.';
      } else {
        message += ' Review and publish to make available.';
      }

      return {
        success: true,
        mcp_id: entry.mcp_id,
        message,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[RegistryService] Failed to install MCP '${name}':`, errorMessage);

      return {
        success: false,
        message: `Failed to install: ${errorMessage}`,
      };
    }
  }

  /**
   * Get registry status info
   */
  getStatus(): {
    lastFetchedAt: Date | null;
    entryCount: number;
    url: string;
    enabled: boolean;
  } {
    return {
      lastFetchedAt: this.lastFetchedAt,
      entryCount: this.cachedRegistry?.mcps.length ?? 0,
      url: this.config.url,
      enabled: this.config.enabled,
    };
  }

  /**
   * Check if cache needs refresh based on TTL
   */
  isCacheStale(): boolean {
    if (!this.lastFetchedAt || !this.config.enabled) {
      return false;
    }

    const ageHours = (Date.now() - this.lastFetchedAt.getTime()) / (1000 * 60 * 60);
    return ageHours >= this.config.refreshIntervalHours;
  }
}
