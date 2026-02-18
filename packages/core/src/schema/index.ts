/**
 * MCP Ambassador - Database Schema
 *
 * Drizzle ORM schema definitions for SQLite (Community) and PostgreSQL (Pro/Enterprise).
 *
 * Design constraints:
 * - SQLite dialect as baseline (no JSONB, no advanced PG types)
 * - JSON columns stored as TEXT with JSON serialization
 * - UUIDs stored as TEXT (36 chars with hyphens)
 * - Timestamps as ISO 8601 strings
 * - Enum types as constrained TEXT columns
 *
 * @see Architecture §3.2 ClientRecord
 * @see Architecture §3.3 ToolProfile
 * @see Architecture §5.3 AuditEvent
 * @see ADR-006 Admin Authentication Model
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

/**
 * users table
 *
 * Stores user identities. Users are the primary identity entity (ADR-011).
 * A user can own multiple clients (VS Code, Claude Code, etc.).
 * In Community tier, users may be auto-created from client registrations.
 * In Pro/Enterprise, users are provisioned by admins or federated from IdPs.
 *
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 * @see Architecture §3.5 Identity Resolution Rules
 */
export const users = sqliteTable(
  'users',
  {
    // Primary key
    user_id: text('user_id').primaryKey().notNull(), // UUIDv4

    // Identity
    display_name: text('display_name').notNull(), // Human-readable name
    email: text('email'), // Nullable — not required for Community/local users

    // Lifecycle
    status: text('status', {
      enum: ['active', 'suspended', 'deactivated'],
    })
      .notNull()
      .default('active'),

    // Authentication source
    auth_source: text('auth_source', {
      enum: ['local', 'oidc', 'preshared_key'],
    })
      .notNull()
      .default('local'),

    // Timestamps
    created_at: text('created_at').notNull(), // ISO 8601
    last_login_at: text('last_login_at'), // ISO 8601, nullable

    // Phase 4 credential vault (SEC-V2-004)
    vault_salt: text('vault_salt'), // Random per-user salt for credential vault KDF, nullable

    // Extensibility
    metadata: text('metadata').notNull().default('{}'), // JSON object serialized to TEXT
  },
  table => ({
    // Indexes
    emailIdx: index('idx_users_email').on(table.email),
    statusIdx: index('idx_users_status').on(table.status),
    authSourceIdx: index('idx_users_auth_source').on(table.auth_source),
  })
);

/**
 * preshared_keys table
 *
 * Stores preshared keys for Phase 3 ephemeral session authentication.
 * Each key is bound to a user and tool profile. Keys are provisioned by admins
 * and used by clients to establish ephemeral sessions.
 *
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 * @see SEC-V2-001 Preshared Key Format and Lookup
 */
export const preshared_keys = sqliteTable(
  'preshared_keys',
  {
    // Primary key
    key_id: text('key_id').primaryKey().notNull(), // UUIDv4

    // Key material
    key_prefix: text('key_prefix').notNull(), // First 8 chars of raw key for O(1) lookup
    key_hash: text('key_hash').notNull(), // Argon2id output string

    // Identity
    label: text('label').notNull(), // Human-readable label, e.g., "Alice - Developer"
    user_id: text('user_id')
      .notNull()
      .references(() => users.user_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    // Authorization
    profile_id: text('profile_id')
      .notNull()
      .references(() => tool_profiles.profile_id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    // Lifecycle
    status: text('status', {
      enum: ['active', 'suspended', 'revoked'],
    })
      .notNull()
      .default('active'),
    created_by: text('created_by').notNull(), // Admin user_id who provisioned this key
    created_at: text('created_at').notNull(), // ISO 8601
    expires_at: text('expires_at'), // Optional key-level expiry, ISO 8601
    last_used_at: text('last_used_at'), // ISO 8601, nullable

    // Extensibility
    metadata: text('metadata').notNull().default('{}'), // JSON object serialized to TEXT
  },
  table => ({
    // Indexes
    keyPrefixIdx: index('idx_preshared_keys_key_prefix').on(table.key_prefix),
    userIdIdx: index('idx_preshared_keys_user_id').on(table.user_id),
    statusIdx: index('idx_preshared_keys_status').on(table.status),
    keyHashUnique: uniqueIndex('unique_preshared_keys_key_hash').on(table.key_hash),
  })
);

/**
 * user_sessions table
 *
 * Stores ephemeral user sessions for Phase 3 shared-identity model.
 * A session is established via preshared key authentication and represents
 * the user's active "work context" for a defined time period.
 *
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 * @see SEC-V2-003 Session Token Format
 */
export const user_sessions = sqliteTable(
  'user_sessions',
  {
    // Primary key
    session_id: text('session_id').primaryKey().notNull(), // UUIDv4

    // Identity
    user_id: text('user_id')
      .notNull()
      .references(() => users.user_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    // Session token
    session_token_hash: text('session_token_hash').notNull(), // HMAC-SHA256 hex string
    token_nonce: text('token_nonce').notNull(), // 32-byte hex-encoded nonce for HMAC input

    // Lifecycle
    status: text('status', {
      enum: ['active', 'idle', 'spinning_down', 'suspended', 'expired'],
    })
      .notNull()
      .default('active'),

    // Authorization
    profile_id: text('profile_id')
      .notNull()
      .references(() => tool_profiles.profile_id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    // Timestamps
    created_at: text('created_at').notNull(), // ISO 8601
    last_activity_at: text('last_activity_at').notNull(), // ISO 8601
    expires_at: text('expires_at').notNull(), // ISO 8601

    // Timeouts
    idle_timeout_seconds: integer('idle_timeout_seconds').notNull().default(1800), // 30 minutes
    spindown_delay_seconds: integer('spindown_delay_seconds').notNull().default(300), // 5 minutes

    // Extensibility
    metadata: text('metadata').notNull().default('{}'), // JSON object serialized to TEXT
  },
  table => ({
    // Indexes
    userStatusIdx: index('idx_user_sessions_user_status').on(table.user_id, table.status),
    statusIdx: index('idx_user_sessions_status').on(table.status),
    expiresAtIdx: index('idx_user_sessions_expires_at').on(table.expires_at),
    tokenHashIdx: uniqueIndex('unique_user_sessions_token_hash').on(table.session_token_hash),
  })
);

/**
 * session_connections table
 *
 * Tracks individual client connections to an ephemeral session.
 * A session can have multiple concurrent connections (VS Code + Claude Desktop).
 *
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 */
export const session_connections = sqliteTable(
  'session_connections',
  {
    // Primary key
    connection_id: text('connection_id').primaryKey().notNull(), // UUIDv4

    // Session reference
    session_id: text('session_id')
      .notNull()
      .references(() => user_sessions.session_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    // Connection identity
    friendly_name: text('friendly_name').notNull(), // "VS Code - Dev Laptop"
    host_tool: text('host_tool', {
      enum: [
        'vscode',
        'claude-desktop',
        'claude-code',
        'opencode',
        'gemini-cli',
        'chatgpt',
        'jetbrains',
        'cli',
        'custom',
      ],
    }).notNull(),

    // Timestamps
    connected_at: text('connected_at').notNull(), // ISO 8601
    last_heartbeat_at: text('last_heartbeat_at').notNull(), // ISO 8601
    disconnected_at: text('disconnected_at'), // ISO 8601, nullable

    // Lifecycle
    status: text('status', {
      enum: ['connected', 'disconnected'],
    })
      .notNull()
      .default('connected'),
  },
  table => ({
    // Indexes
    sessionIdIdx: index('idx_session_connections_session_id').on(table.session_id),
    statusIdx: index('idx_session_connections_status').on(table.status),
  })
);

/**
 * clients table
 *
 * Stores registered Ambassador Clients. Each client represents an installation
 * on a developer workstation (VS Code, Claude Desktop, etc.).
 *
 * @see Architecture §3.2 ClientRecord
 */
export const clients = sqliteTable(
  'clients',
  {
    // Primary key
    client_id: text('client_id').primaryKey().notNull(), // UUIDv4

    // Identity
    friendly_name: text('friendly_name').notNull(), // max 128 chars, sanitized [a-zA-Z0-9 _.-]
    host_tool: text('host_tool', {
      enum: [
        'vscode',
        'claude-desktop',
        'claude-code',
        'opencode',
        'gemini-cli',
        'chatgpt',
        'custom',
      ],
    }).notNull(),
    machine_fingerprint: text('machine_fingerprint'), // SHA-256 hex, nullable
    owner_user_id: text('owner_user_id').references(() => users.user_id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }), // FK to users table, null in Community

    // Authentication
    auth_method: text('auth_method', {
      enum: ['api_key', 'jwt', 'oidc', 'saml', 'mtls'],
    }).notNull(),
    api_key_hash: text('api_key_hash'), // argon2id hash, only for api_key auth_method

    // Authorization
    profile_id: text('profile_id')
      .notNull()
      .references(() => tool_profiles.profile_id, {
        onDelete: 'restrict', // Cannot delete a profile if clients reference it
        onUpdate: 'cascade',
      }),

    // Lifecycle
    status: text('status', {
      enum: ['active', 'suspended', 'revoked'],
    })
      .notNull()
      .default('active'),
    created_at: text('created_at').notNull(), // ISO 8601
    last_seen_at: text('last_seen_at').notNull(), // ISO 8601, updated on every auth

    // Extensibility
    metadata: text('metadata').notNull().default('{}'), // JSON object serialized to TEXT
  },
  table => ({
    // Indexes for common query patterns (dashboard list views)
    statusIdx: index('idx_clients_status').on(table.status),
    profileIdx: index('idx_clients_profile_id').on(table.profile_id),
    lastSeenIdx: index('idx_clients_last_seen_at').on(table.last_seen_at),
    hostToolIdx: index('idx_clients_host_tool').on(table.host_tool),
  })
);

/**
 * tool_profiles table
 *
 * Defines authorization profiles (allow/deny rules for tool access).
 * Supports inheritance up to depth 5 with cycle detection.
 *
 * @see Architecture §3.3 ToolProfile
 * @see Architecture §10.2 Profile Inheritance
 */
export const tool_profiles = sqliteTable(
  'tool_profiles',
  {
    // Primary key
    profile_id: text('profile_id').primaryKey().notNull(), // UUIDv4

    // Identity
    name: text('name').notNull().unique(), // Human-readable, e.g., "database-engineer"
    description: text('description').notNull(),

    // Authorization rules
    allowed_tools: text('allowed_tools').notNull().default('[]'), // JSON array of glob patterns
    denied_tools: text('denied_tools').notNull().default('[]'), // JSON array of glob patterns

    // Rate limiting
    rate_limits: text('rate_limits')
      .notNull()
      .default('{"requests_per_minute":60,"requests_per_hour":1000,"max_concurrent":5}'), // JSON object

    // Inheritance (max depth 5, cycles rejected at save time)
    inherited_from: text('inherited_from').references((): any => tool_profiles.profile_id, {
      onDelete: 'set null', // If parent deleted, child loses inheritance (doesn't cascade delete)
      onUpdate: 'cascade',
    }),

    // Conditional access
    environment_scope: text('environment_scope').default('[]'), // JSON array: ["dev","staging"], empty = all
    time_restrictions: text('time_restrictions').default('[]'), // JSON array of TimeWindow objects

    // Timestamps
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => ({
    // Index for dashboard list view
    nameIdx: index('idx_tool_profiles_name').on(table.name),
  })
);

/**
 * admin_keys table
 *
 * Stores admin API key hashes and recovery tokens for Community tier.
 * Only one active admin key per instance (single-admin in Phase 1).
 *
 * @see ADR-006 Admin Authentication Model
 * @see Architecture §9.5 Admin API Authentication
 */
export const admin_keys = sqliteTable(
  'admin_keys',
  {
    // Primary key (integer for SQLite auto-increment)
    id: integer('id').primaryKey({ autoIncrement: true }),

    // Admin key (hashed with argon2id)
    key_hash: text('key_hash').notNull().unique(), // argon2id output

    // Recovery token (hashed with argon2id, single-use)
    recovery_token_hash: text('recovery_token_hash').notNull(), // argon2id output

    // Lifecycle
    created_at: text('created_at').notNull(),
    rotated_at: text('rotated_at'), // Timestamp of last rotation, null if never rotated
    is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true), // Only one active key
  },
  table => ({
    // Index for active key lookup
    activeIdx: index('idx_admin_keys_is_active').on(table.is_active),
  })
);

/**
 * audit_events table
 *
 * Stores audit events for database-backed audit provider (Phase 2).
 * In Phase 1, the file audit provider writes JSONL directly (not via this table).
 * Schema designed now to ensure forward compatibility.
 *
 * @see Architecture §5.3 AuditEvent
 * @see Architecture §11 Audit Deep Dive
 */
export const audit_events = sqliteTable(
  'audit_events',
  {
    // Primary key
    event_id: text('event_id').primaryKey().notNull(), // UUIDv4

    // Temporal
    timestamp: text('timestamp').notNull(), // ISO 8601

    // Event classification
    event_type: text('event_type', {
      enum: [
        'client_register',
        'auth_success',
        'auth_failure',
        'token_refresh',
        'token_revoke',
        'authz_permit',
        'authz_deny',
        'tool_invocation',
        'tool_error',
        'kill_switch_activated',
        'config_change',
        'admin_action',
        'admin_recovery_attempt',
        'admin_key_rotated',
        'provider_loaded',
        'provider_blocked',
      ],
    }).notNull(),
    severity: text('severity', {
      enum: ['info', 'warn', 'error', 'critical'],
    }).notNull(),

    // Identity context
    session_id: text('session_id').notNull(), // Links to session
    client_id: text('client_id'), // nullable for admin actions in Community (anonymous admin)
    user_id: text('user_id'), // nullable in Community tier
    auth_method: text('auth_method').notNull(),
    source_ip: text('source_ip').notNull(),

    // Action context
    tool_name: text('tool_name'), // Fully qualified, e.g., "github.search_code"
    downstream_mcp: text('downstream_mcp'), // Name of downstream MCP
    action: text('action').notNull(), // Event-specific action string

    // Request/response (summarized, not raw)
    request_summary: text('request_summary').default('{}'), // JSON object
    response_summary: text('response_summary').default('{}'), // JSON object

    // Authorization context
    authz_decision: text('authz_decision', {
      enum: ['permit', 'deny', 'conditional'],
    }),
    authz_policy: text('authz_policy'), // Policy ID that made the decision

    // Metadata
    ambassador_node: text('ambassador_node'), // Server hostname for multi-node deployments
    metadata: text('metadata').default('{}'), // JSON object for extensibility
  },
  table => ({
    // Indexes for common query patterns (audit log viewer)
    timestampIdx: index('idx_audit_events_timestamp').on(table.timestamp),
    clientIdIdx: index('idx_audit_events_client_id').on(table.client_id),
    eventTypeIdx: index('idx_audit_events_event_type').on(table.event_type),
    severityIdx: index('idx_audit_events_severity').on(table.severity),
    // Composite index for time-range + client queries (common dashboard pattern)
    timestampClientIdx: index('idx_audit_events_timestamp_client').on(
      table.timestamp,
      table.client_id
    ),
  })
);

/**
 * Drizzle relations (for ORM query joins)
 */
export const usersRelations = relations(users, ({ many }: { many: any }) => ({
  clients: many(clients),
  presharedKeys: many(preshared_keys),
  sessions: many(user_sessions),
}));

export const presharedKeysRelations = relations(preshared_keys, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [preshared_keys.user_id],
    references: [users.user_id],
  }),
  profile: one(tool_profiles, {
    fields: [preshared_keys.profile_id],
    references: [tool_profiles.profile_id],
  }),
}));

export const userSessionsRelations = relations(
  user_sessions,
  ({ one, many }: { one: any; many: any }) => ({
    user: one(users, {
      fields: [user_sessions.user_id],
      references: [users.user_id],
    }),
    profile: one(tool_profiles, {
      fields: [user_sessions.profile_id],
      references: [tool_profiles.profile_id],
    }),
    connections: many(session_connections),
  })
);

export const sessionConnectionsRelations = relations(
  session_connections,
  ({ one }: { one: any }) => ({
    session: one(user_sessions, {
      fields: [session_connections.session_id],
      references: [user_sessions.session_id],
    }),
  })
);

export const clientsRelations = relations(clients, ({ one }: { one: any }) => ({
  profile: one(tool_profiles, {
    fields: [clients.profile_id],
    references: [tool_profiles.profile_id],
  }),
  owner: one(users, {
    fields: [clients.owner_user_id],
    references: [users.user_id],
  }),
}));

export const toolProfilesRelations = relations(
  tool_profiles,
  ({ one, many }: { one: any; many: any }) => ({
    parent: one(tool_profiles, {
      fields: [tool_profiles.inherited_from],
      references: [tool_profiles.profile_id],
      relationName: 'inheritance',
    }),
    children: many(tool_profiles, {
      relationName: 'inheritance',
    }),
    clients: many(clients),
    presharedKeys: many(preshared_keys),
    sessions: many(user_sessions),
  })
);

/**
 * TypeScript types derived from schema (for application code)
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;

export type ToolProfile = typeof tool_profiles.$inferSelect;
export type NewToolProfile = typeof tool_profiles.$inferInsert;

export type AdminKey = typeof admin_keys.$inferSelect;
export type NewAdminKey = typeof admin_keys.$inferInsert;

export type AuditEvent = typeof audit_events.$inferSelect;
export type NewAuditEvent = typeof audit_events.$inferInsert;

export type PresharedKey = typeof preshared_keys.$inferSelect;
export type NewPresharedKey = typeof preshared_keys.$inferInsert;

export type UserSession = typeof user_sessions.$inferSelect;
export type NewUserSession = typeof user_sessions.$inferInsert;

export type SessionConnection = typeof session_connections.$inferSelect;
export type NewSessionConnection = typeof session_connections.$inferInsert;

/**
 * JSON-typed interfaces for metadata fields
 */
export interface ClientMetadata {
  [key: string]: string | number | boolean;
}

export interface RateLimits {
  requests_per_minute: number;
  requests_per_hour: number;
  max_concurrent: number;
}

export interface TimeWindow {
  days: string[]; // ["mon","tue","wed","thu","fri"]
  start_utc: string; // "08:00"
  end_utc: string; // "18:00"
}

export interface AuditRequestSummary {
  [key: string]: unknown;
}

export interface AuditResponseSummary {
  status: 'success' | 'error';
  duration_ms: number;
  result_size?: number;
  error_code?: string;
}
