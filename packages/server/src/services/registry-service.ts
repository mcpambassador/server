/**
 * TD-031: every registry entry must satisfy the admin create schema. oauth_config is the one
 * relaxation (partial, e.g. Supabase has no client_id/secret), as in install (TD-027). Unknown
 * registry-only keys (tags, category, ...) are ignored by the parse.
 */
const registryEntrySchema = createMcpSchema.extend({
  description: createMcpSchema.shape.description.unwrap().default(''),
  oauth_config: oauthConfigSchema.partial().optional(),
});

/**
 * Registry-import only: an empty or whitespace `scopes` means "none declared" (e.g. Supabase ships
 * `scopes: ''`). Drop it so the partial oauth parse accepts it; createMcpSchema itself is unchanged.
 */
function normalizeRegistryOauth(oc: unknown): unknown {
  if (oc && typeof oc === 'object' && typeof (oc as { scopes?: unknown }).scopes === 'string') {
    const { scopes, ...rest } = oc as Record<string, unknown> & { scopes: string };
    return scopes.trim() === '' ? rest : oc;
  }
  return oc;
}

/** TD-035: fixed text; must never name env vars or hosts. */
export const REGISTRY_UNAVAILABLE_REASON =
  'requires a server-side OAuth client secret for this provider';

type EntryCheck =
  | { status: 'ok' }
  | { status: 'invalid'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface SkippedRegistryEntry {
  name: string;
  reason: string;
}

/**
 * Deliberate 4-line copy of safeIssueMessage in admin/routes.ts (importing it from here would create
 * an import cycle: routes.ts -> registry-service.ts). Keep the two in sync: zod enum/literal
 * messages echo the received value, so they are replaced.
 */
function safeIssueMessage(i: { code: string; message: string }): string {
  return i.code === 'invalid_enum_value' || i.code === 'invalid_literal'
    ? 'Invalid value'
    : i.message;
}

/** Entry names and reasons come from remote input: strip control chars and bound the length. */
function cleanForLog(v: unknown, max: number): string {
  return (
    String(v)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '?')
      .slice(0, max)
  );
}

/**
 * Community Registry Service
 *
 * Fetches, caches, and serves MCP definitions from a community registry (YAML file).
 * Provides "install from registry" functionality for one-click MCP installation.
 *
 * @see mcpambassador_docs/community-registry-spec.md
 */

import { SecretStore, OAuthConfigError } from './secret-store.js';
import { createMcpSchema, oauthConfigSchema } from '../admin/mcp-schemas.js';
import * as yaml from 'yaml';
import type { DatabaseClient } from '@mcpambassador/core';
import {
  logger,
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
  /** TD-035: false when this server cannot install the entry (see unavailable_reason). */
  installable: boolean;
  /** Generic, fixed-text reason (never env var names) when installable is false. */
  unavailable_reason?: string;
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
  private skippedEntries: SkippedRegistryEntry[] = [];
  /** TD-035: valid entries this server cannot install yet (secret not configured), name -> reason */
  private unavailableEntries = new Map<string, string>();

  private secretStore: SecretStore;

  constructor(config: RegistryConfig, db: DatabaseClient, secretStore?: SecretStore) {
    this.secretStore = secretStore ?? new SecretStore();
    this.config = config;
    this.db = db;
  }

  /**
   * Fetch registry from configured URL and cache it
   */
  async fetchRegistry(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('[RegistryService] Registry is disabled, skipping fetch');
      return;
    }

    try {
      logger.info(`[RegistryService] Fetching registry from: ${this.config.url}`);

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

      // TD-031: validate each entry like the admin create path; skip (and record) the bad ones
      const valid: RegistryMcpEntry[] = [];
      const skipped: SkippedRegistryEntry[] = [];
      const unavailable = new Map<string, string>();
      for (const entry of parsed.mcps) {
        const check = this.checkEntry(entry);
        if (check.status === 'ok') {
          valid.push(entry);
        } else if (check.status === 'unavailable') {
          // Valid entry, but only the server-side secret is missing: list it, install disabled
          valid.push(entry);
          unavailable.set(entry.name, check.reason);
          logger.info(
            `[RegistryService] Registry entry '${cleanForLog(entry.name, 100)}' not installable on this server: ${check.reason}`
          );
        } else {
          const name = cleanForLog((entry as { name?: unknown } | null)?.name ?? '(unnamed)', 100);
          skipped.push({ name, reason: check.reason });
          logger.warn(`[RegistryService] Skipping registry entry '${name}': ${check.reason}`);
        }
      }
      parsed.mcps = valid;
      this.skippedEntries = skipped;
      this.unavailableEntries = unavailable;

      this.cachedRegistry = parsed;
      this.lastFetchedAt = new Date();

      logger.info(
        `[RegistryService] Registry cached: ${valid.length} entries from ${cleanForLog(parsed.registry.name, 100)}` +
          (skipped.length ? ` (${skipped.length} skipped as invalid)` : '') +
          (unavailable.size ? ` (${unavailable.size} not installable on this server)` : '')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[RegistryService] Failed to fetch registry: ${message}`);

      // Keep serving stale cache if available
      if (this.cachedRegistry) {
        logger.info('[RegistryService] Continuing with stale cache');
      }

      throw error;
    }
  }

  private installability(name: string): { installable: boolean; unavailable_reason?: string } {
    const reason = this.unavailableEntries.get(name);
    return reason ? { installable: false, unavailable_reason: reason } : { installable: true };
  }

  /** TD-035: valid entries this server cannot install (name and fixed generic reason). */
  getUnavailableEntries(): SkippedRegistryEntry[] {
    return Array.from(this.unavailableEntries, ([name, reason]) => ({ name, reason }));
  }

  /** INVALID entries dropped by the last fetch (name and reason only; no entry contents). */
  getSkippedEntries(): SkippedRegistryEntry[] {
    return [...this.skippedEntries];
  }

  /**
   * TD-031: schema + oauth binding check for one registry entry.
   * Returns null when acceptable, else a short reason (never entry values beyond field paths).
   */
  private checkEntry(entry: unknown): EntryCheck {
    if (!entry || typeof entry !== 'object') {
      return { status: 'invalid', reason: 'entry is not an object' };
    }
    const e = entry as Record<string, unknown>;
    const r = registryEntrySchema.safeParse(
      e.oauth_config === undefined
        ? e
        : { ...e, oauth_config: normalizeRegistryOauth(e.oauth_config) }
    );
    if (!r.success) {
      const issue = r.error.issues[0];
      return {
        status: 'invalid',
        reason: cleanForLog(
          `${issue?.path.join('.') || 'entry'}: ${issue ? safeIssueMessage(issue) : 'invalid'}`,
          200
        ),
      };
    }
    const oc = r.data.oauth_config;
    if (oc?.client_secret_env && oc.token_url) {
      // UNAVAILABLE (TD-035): the entry is well-formed (https URLs and *_CLIENT_ID were enforced by
      // the schema above) and only the server-side secret is not configured. A secret that exists
      // but is not bound to this token_url host stays INVALID.
      if (!this.secretStore.has(oc.client_secret_env)) {
        return { status: 'unavailable', reason: REGISTRY_UNAVAILABLE_REASON };
      }
      try {
        this.secretStore.assertOAuthConfig({
          client_secret_env: oc.client_secret_env,
          client_id_env: oc.client_id_env,
          token_url: oc.token_url,
          auth_url: oc.auth_url,
          revocation_url: oc.revocation_url,
        });
      } catch (e) {
        // No env var names or hosts in the reason (OAuthConfigError messages can name them)
        return {
          status: 'invalid',
          reason:
            e instanceof OAuthConfigError
              ? 'oauth_config: secret binding rejected'
              : 'oauth_config: rejected',
        };
      }
    }
    return { status: 'ok' };
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
      ...this.installability(entry.name),
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
      ...this.installability(entry.name),
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

    const unavailableReason = this.unavailableEntries.get(name);
    if (unavailableReason) {
      return {
        success: false,
        message: `MCP '${name}' is not installable on this server: ${unavailableReason}`,
      };
    }

    // Only the schema-parsed oauth_config is persisted (unknown registry keys never reach the DB)
    let safeOauthConfig: Record<string, unknown> | undefined;
    // TD-027: registry-supplied oauth_config gets the same schema and secret-binding checks as admin saves
    if (registryEntry.auth_type === 'oauth2' || registryEntry.oauth_config) {
      try {
        // partial: registry entries may omit fields (e.g. Supabase has no client_id/secret), but any
        // field present must satisfy the admin rules (https URLs, *_CLIENT_ID).
        const parsed = oauthConfigSchema
          .partial()
          .safeParse(normalizeRegistryOauth(registryEntry.oauth_config ?? {}));
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new OAuthConfigError(
            `${issue?.path.join('.') || 'oauth_config'}: ${issue?.message ?? 'invalid'}`
          );
        }
        const oc = parsed.data;
        safeOauthConfig = oc;
        if (oc.client_secret_env && oc.token_url) {
          this.secretStore.assertOAuthConfig({
            client_secret_env: oc.client_secret_env,
            client_id_env: oc.client_id_env,
            token_url: oc.token_url,
            auth_url: oc.auth_url,
            revocation_url: oc.revocation_url,
          });
        }
      } catch (e) {
        return {
          success: false,
          message: `MCP '${name}' has an invalid oauth_config: ${e instanceof Error ? e.message : 'rejected'}`,
        };
      }
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
        oauth_config: JSON.stringify(safeOauthConfig ?? {}),
        isolation_mode: registryEntry.isolation_mode || 'shared',
        origin: 'registry' as const,
        requires_user_credentials: registryEntry.requires_user_credentials ?? false,
        credential_schema: JSON.stringify(registryEntry.credential_schema || {}),
        status: 'draft' as const,
        validation_status: 'pending' as const,
      };

      // Create catalog entry
      const entry = await createMcpEntry(this.db, catalogData);

      logger.info(
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
          logger.info(
            `[RegistryService] Granted 'all-users' group access to MCP (mcp_id: ${entry.mcp_id})`
          );
        } else {
          groupAccessGranted = false;
          logger.warn(
            "[RegistryService] 'all-users' group not found; skipping grant of group access"
          );
        }
      } catch (err) {
        groupAccessGranted = false;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[RegistryService] Failed to grant 'all-users' group access: ${msg}`);
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
      logger.error({ err: error }, `[RegistryService] Failed to install MCP '${name}'`);

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
