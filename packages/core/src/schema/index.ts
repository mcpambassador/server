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
    username: text('username').notNull().unique(), // Unique login identifier
    display_name: text('display_name').notNull(), // Human-readable name
    email: text('email'), // Nullable — not required for Community/local users

    // Authentication
    password_hash: text('password_hash'), // Argon2id hash, nullable (NULL for preshared-key-only users)

    // Authorization
    is_admin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),

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
    updated_at: text('updated_at').notNull(), // ISO 8601
    last_login_at: text('last_login_at'), // ISO 8601, nullable

    // Phase 4 credential vault (SEC-V2-004)
    vault_salt: text('vault_salt'), // Random per-user salt for credential vault KDF, nullable

    // Extensibility
    metadata: text('metadata').notNull().default('{}'), // JSON object serialized to TEXT
  },
  (table) => ({
    // Indexes
    usernameIdx: uniqueIndex('unique_users_username').on(table.username),
    emailIdx: index('idx_users_email').on(table.email),
    statusIdx: index('idx_users_status').on(table.status),
    authSourceIdx: index('idx_users_auth_source').on(table.auth_source),
  })
);

/**
 * clients table
 *
 * Stores preshared keys (renamed from preshared_keys) for Phase 3 ephemeral session authentication.
 * Each key is bound to a user and tool profile. Keys are provisioned by admins
 * and used by clients to establish ephemeral sessions.
 *
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 * @see SEC-V2-001 Preshared Key Format and Lookup
 */
export const clients = sqliteTable(
  'clients',
  {
    // Primary key
    client_id: text('client_id').primaryKey().notNull(), // UUIDv4

    // Identity
    client_name: text('client_name').notNull(), // Human-readable name, formerly "label"

    // Key material
    key_prefix: text('key_prefix').notNull(), // First 8 chars of raw key for O(1) lookup
    key_hash: text('key_hash').notNull(), // Argon2id output string

    // User reference
    user_id: text('user_id')
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),

    // Authorization
    profile_id: text('profile_id').references(() => tool_profiles.profile_id),

    // Lifecycle
    status: text('status', {
      enum: ['active', 'suspended', 'revoked'],
    })
      .notNull()
      .default('active'),
    created_by: text('created_by'), // Admin user_id who created it
    created_at: text('created_at').notNull(), // ISO 8601
    expires_at: text('expires_at'), // Optional key-level expiry, ISO 8601
    last_used_at: text('last_used_at'), // ISO 8601, nullable

    // Extensibility
    metadata: text('metadata').notNull().default('{}'), // JSON object serialized to TEXT
  },
  (table) => ({
    // Indexes
    keyPrefixIdx: index('idx_clients_key_prefix').on(table.key_prefix),
    userIdIdx: index('idx_clients_user_id').on(table.user_id),
    statusIdx: index('idx_clients_status').on(table.status),
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
  (table) => ({
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
  (table) => ({
    // Indexes
    sessionIdIdx: index('idx_session_connections_session_id').on(table.session_id),
    statusIdx: index('idx_session_connections_status').on(table.status),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  (table) => ({
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
  (table) => ({
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
  (table) => ({
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
 * groups table
 *
 * Stores user groups for Phase 4 group-based access control.
 * Groups are used to simplify MCP access management by assigning users to groups
 * and granting MCP access at the group level.
 */
export const groups = sqliteTable(
  'groups',
  {
    group_id: text('group_id').primaryKey().notNull(),
    name: text('name').notNull().unique(),
    description: text('description').notNull().default(''),
    status: text('status', {
      enum: ['active', 'suspended'],
    })
      .notNull()
      .default('active'),
    created_by: text('created_by').notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    nameIdx: uniqueIndex('unique_groups_name').on(table.name),
    statusIdx: index('idx_groups_status').on(table.status),
  })
);

/**
 * user_groups table
 *
 * Many-to-many join table for users and groups.
 * Tracks which users belong to which groups.
 */
export const user_groups = sqliteTable(
  'user_groups',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    group_id: text('group_id')
      .notNull()
      .references(() => groups.group_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    assigned_at: text('assigned_at').notNull(),
    assigned_by: text('assigned_by').notNull(),
  },
  (table) => ({
    pk: uniqueIndex('unique_user_groups').on(table.user_id, table.group_id),
    groupIdx: index('idx_user_groups_group_id').on(table.group_id),
  })
);

/**
 * mcp_catalog table
 *
 * Stores the central catalog of MCPs available in the Ambassador instance.
 * Each entry represents a configured MCP server that can be made available
 * to users based on group membership and access control policies.
 */
export const mcp_catalog = sqliteTable(
  'mcp_catalog',
  {
    mcp_id: text('mcp_id').primaryKey().notNull(),
    name: text('name').notNull().unique(),
    display_name: text('display_name').notNull(),
    description: text('description').notNull().default(''),
    icon_url: text('icon_url'),
    transport_type: text('transport_type', {
      enum: ['stdio', 'http', 'sse'],
    }).notNull(),
    config: text('config').notNull().default('{}'),
    isolation_mode: text('isolation_mode', {
      enum: ['shared', 'per_user'],
    })
      .notNull()
      .default('shared'),
    requires_user_credentials: integer('requires_user_credentials', { mode: 'boolean' })
      .notNull()
      .default(false),
    credential_schema: text('credential_schema').notNull().default('{}'),
    // ADR-014: OAuth 2.0 authentication support
    auth_type: text('auth_type', {
      enum: ['none', 'static', 'oauth2'],
    })
      .notNull()
      .default('none'),
    oauth_config: text('oauth_config').notNull().default('{}'), // JSON: OAuthConfig
    tool_catalog: text('tool_catalog').notNull().default('[]'),
    tool_count: integer('tool_count').notNull().default(0),
    status: text('status', {
      enum: ['draft', 'published', 'archived'],
    })
      .notNull()
      .default('draft'),
    published_by: text('published_by'),
    published_at: text('published_at'),
    validation_status: text('validation_status', {
      enum: ['pending', 'valid', 'invalid'],
    })
      .notNull()
      .default('pending'),
    validation_result: text('validation_result').notNull().default('{}'),
    last_validated_at: text('last_validated_at'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    nameIdx: uniqueIndex('unique_mcp_catalog_name').on(table.name),
    statusIdx: index('idx_mcp_catalog_status').on(table.status),
    isolationIdx: index('idx_mcp_catalog_isolation_mode').on(table.isolation_mode),
  })
);

/**
 * mcp_group_access table
 *
 * Many-to-many join table for MCPs and groups.
 * Defines which groups have access to which MCPs.
 */
export const mcp_group_access = sqliteTable(
  'mcp_group_access',
  {
    mcp_id: text('mcp_id')
      .notNull()
      .references(() => mcp_catalog.mcp_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    group_id: text('group_id')
      .notNull()
      .references(() => groups.group_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    assigned_at: text('assigned_at').notNull(),
    assigned_by: text('assigned_by').notNull(),
  },
  (table) => ({
    pk: uniqueIndex('unique_mcp_group_access').on(table.mcp_id, table.group_id),
    groupIdx: index('idx_mcp_group_access_group_id').on(table.group_id),
  })
);

/**
 * client_mcp_subscriptions table
 *
 * Tracks which MCPs each client (preshared key) subscribes to.
 * Clients can selectively enable/disable MCPs and choose specific tools from each MCP.
 */
export const client_mcp_subscriptions = sqliteTable(
  'client_mcp_subscriptions',
  {
    subscription_id: text('subscription_id').primaryKey().notNull(),
    client_id: text('client_id')
      .notNull()
      .references(() => clients.client_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    mcp_id: text('mcp_id')
      .notNull()
      .references(() => mcp_catalog.mcp_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    selected_tools: text('selected_tools').notNull().default('[]'),
    status: text('status', {
      enum: ['active', 'paused', 'removed'],
    })
      .notNull()
      .default('active'),
    subscribed_at: text('subscribed_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    keyMcpIdx: uniqueIndex('unique_client_mcp_sub').on(table.client_id, table.mcp_id),
    clientIdx: index('idx_client_mcp_sub_client_id').on(table.client_id),
    mcpIdx: index('idx_client_mcp_sub_mcp_id').on(table.mcp_id),
    statusIdx: index('idx_client_mcp_sub_status').on(table.status),
  })
);

/**
 * user_mcp_credentials table
 *
 * Stores encrypted per-user credentials for MCPs that require user-specific authentication.
 * Used with per-user isolation mode MCPs (GitHub, Jira, etc.).
 */
export const user_mcp_credentials = sqliteTable(
  'user_mcp_credentials',
  {
    credential_id: text('credential_id').primaryKey().notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    mcp_id: text('mcp_id')
      .notNull()
      .references(() => mcp_catalog.mcp_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    encryption_iv: text('encryption_iv').notNull(),
    // ADR-014: OAuth 2.0 credential type discriminator
    credential_type: text('credential_type', {
      enum: ['static', 'oauth2'],
    })
      .notNull()
      .default('static'),
    oauth_status: text('oauth_status', {
      enum: ['active', 'expired', 'revoked'],
    }), // nullable — only for OAuth credentials
    expires_at: text('expires_at'), // ISO 8601, nullable — token expiry for OAuth
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    userMcpIdx: uniqueIndex('unique_user_mcp_cred').on(table.user_id, table.mcp_id),
    userIdx: index('idx_user_mcp_cred_user_id').on(table.user_id),
    mcpIdx: index('idx_user_mcp_cred_mcp_id').on(table.mcp_id),
  })
);

/**
 * oauth_states table
 *
 * Transient storage for OAuth 2.0 authorization flow state.
 * Each row represents an in-progress OAuth flow.
 * Rows expire after 10 minutes and are cleaned up by a periodic job.
 *
 * @see ADR-014: Generic OAuth 2.0 Downstream Credentials
 */
export const oauth_states = sqliteTable(
  'oauth_states',
  {
    /** Random UUID v4 — sent as the `state` parameter to the OAuth provider */
    state: text('state').primaryKey().notNull(),

    /** User who initiated the flow */
    user_id: text('user_id')
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),

    /** MCP catalog entry being connected */
    mcp_id: text('mcp_id')
      .notNull()
      .references(() => mcp_catalog.mcp_id, { onDelete: 'cascade' }),

    /** PKCE code_verifier (43–128 char random string, stored server-side only) */
    code_verifier: text('code_verifier').notNull(),

    /** The redirect_uri used in the authorization request (must match callback exactly) */
    redirect_uri: text('redirect_uri').notNull(),

    /** When this state was created (ISO 8601) */
    created_at: text('created_at').notNull(),

    /** When this state expires (ISO 8601, created_at + 10 minutes) */
    expires_at: text('expires_at').notNull(),
  },
  (table) => ({
    userIdx: index('idx_oauth_states_user_id').on(table.user_id),
    expiresIdx: index('idx_oauth_states_expires_at').on(table.expires_at),
  })
);

/**
 * Drizzle relations (for ORM query joins)
 */
export const usersRelations = relations(users, ({ many }) => ({
  clients: many(clients),
  user_sessions: many(user_sessions),
  user_groups: many(user_groups),
  user_mcp_credentials: many(user_mcp_credentials),
  oauth_states: many(oauth_states),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  user: one(users, { fields: [clients.user_id], references: [users.user_id] }),
  profile: one(tool_profiles, { fields: [clients.profile_id], references: [tool_profiles.profile_id] }),
  subscriptions: many(client_mcp_subscriptions),
}));

export const userSessionsRelations = relations(user_sessions, ({ one, many }) => ({
  user: one(users, { fields: [user_sessions.user_id], references: [users.user_id] }),
  profile: one(tool_profiles, { fields: [user_sessions.profile_id], references: [tool_profiles.profile_id] }),
  connections: many(session_connections),
}));

export const sessionConnectionsRelations = relations(session_connections, ({ one }) => ({
  session: one(user_sessions, { fields: [session_connections.session_id], references: [user_sessions.session_id] }),
}));

export const toolProfilesRelations = relations(tool_profiles, ({ one, many }) => ({
  parent: one(tool_profiles, { fields: [tool_profiles.inherited_from], references: [tool_profiles.profile_id], relationName: 'profile_inheritance' }),
  children: many(tool_profiles, { relationName: 'profile_inheritance' }),
  clients: many(clients),
  user_sessions: many(user_sessions),
}));

export const groupsRelations = relations(groups, ({ many }) => ({
  user_groups: many(user_groups),
  mcp_group_access: many(mcp_group_access),
}));

export const userGroupsRelations = relations(user_groups, ({ one }) => ({
  user: one(users, { fields: [user_groups.user_id], references: [users.user_id] }),
  group: one(groups, { fields: [user_groups.group_id], references: [groups.group_id] }),
}));

export const mcpCatalogRelations = relations(mcp_catalog, ({ many }) => ({
  mcp_group_access: many(mcp_group_access),
  subscriptions: many(client_mcp_subscriptions),
  user_credentials: many(user_mcp_credentials),
  oauth_states: many(oauth_states),
}));

export const mcpGroupAccessRelations = relations(mcp_group_access, ({ one }) => ({
  mcp: one(mcp_catalog, { fields: [mcp_group_access.mcp_id], references: [mcp_catalog.mcp_id] }),
  group: one(groups, { fields: [mcp_group_access.group_id], references: [groups.group_id] }),
}));

export const clientMcpSubscriptionsRelations = relations(client_mcp_subscriptions, ({ one }) => ({
  client: one(clients, { fields: [client_mcp_subscriptions.client_id], references: [clients.client_id] }),
  mcp: one(mcp_catalog, { fields: [client_mcp_subscriptions.mcp_id], references: [mcp_catalog.mcp_id] }),
}));

export const userMcpCredentialsRelations = relations(user_mcp_credentials, ({ one }) => ({
  user: one(users, { fields: [user_mcp_credentials.user_id], references: [users.user_id] }),
  mcp: one(mcp_catalog, { fields: [user_mcp_credentials.mcp_id], references: [mcp_catalog.mcp_id] }),
}));

export const oauthStatesRelations = relations(oauth_states, ({ one }) => ({
  user: one(users, { fields: [oauth_states.user_id], references: [users.user_id] }),
  mcp: one(mcp_catalog, { fields: [oauth_states.mcp_id], references: [mcp_catalog.mcp_id] }),
}));

/**
 * TypeScript types derived from schema (for application code)
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type UserSession = typeof user_sessions.$inferSelect;
export type NewUserSession = typeof user_sessions.$inferInsert;
export type SessionConnection = typeof session_connections.$inferSelect;
export type NewSessionConnection = typeof session_connections.$inferInsert;
export type ToolProfile = typeof tool_profiles.$inferSelect;
export type NewToolProfile = typeof tool_profiles.$inferInsert;
export type AdminKey = typeof admin_keys.$inferSelect;
export type NewAdminKey = typeof admin_keys.$inferInsert;
export type AuditEvent = typeof audit_events.$inferSelect;
export type NewAuditEvent = typeof audit_events.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type UserGroup = typeof user_groups.$inferSelect;
export type NewUserGroup = typeof user_groups.$inferInsert;
export type McpCatalogEntry = typeof mcp_catalog.$inferSelect;
export type NewMcpCatalogEntry = typeof mcp_catalog.$inferInsert;
export type McpGroupAccess = typeof mcp_group_access.$inferSelect;
export type NewMcpGroupAccess = typeof mcp_group_access.$inferInsert;
export type ClientMcpSubscription = typeof client_mcp_subscriptions.$inferSelect;
export type NewClientMcpSubscription = typeof client_mcp_subscriptions.$inferInsert;
export type UserMcpCredential = typeof user_mcp_credentials.$inferSelect;
export type NewUserMcpCredential = typeof user_mcp_credentials.$inferInsert;
export type OAuthState = typeof oauth_states.$inferSelect;
export type NewOAuthState = typeof oauth_states.$inferInsert;

/**
 * JSON-typed interfaces for metadata fields
 */

/**
 * ADR-014: OAuth 2.0 configuration stored as JSON in mcp_catalog.oauth_config
 */
export interface OAuthConfig {
  /** Authorization endpoint URL (e.g., "https://accounts.google.com/o/oauth2/v2/auth") */
  auth_url: string;

  /** Token endpoint URL (e.g., "https://oauth2.googleapis.com/token") */
  token_url: string;

  /** Space-delimited OAuth scopes */
  scopes: string;

  /**
   * Environment variable name containing the OAuth client ID.
   * Resolved at runtime from process.env. NOT a literal client_id.
   * Example: "GOOGLE_OAUTH_CLIENT_ID"
   */
  client_id_env: string;

  /**
   * Environment variable name containing the OAuth client secret.
   * Resolved at runtime from process.env. NOT a literal secret.
   * Example: "GOOGLE_OAUTH_CLIENT_SECRET"
   */
  client_secret_env: string;

  /**
   * Optional revocation endpoint URL.
   * If absent, token revocation is skipped on disconnect.
   */
  revocation_url?: string;

  /**
   * Extra query parameters to include on the authorization request.
   * Handles provider-specific requirements without code changes.
   * Example: { "access_type": "offline", "prompt": "consent" } for Google.
   */
  extra_params?: Record<string, string>;

  /**
   * The env var name used to inject the access_token into the MCP child process.
   * Maps the OAuth access_token to the env var the MCP server expects.
   * Example: "GOOGLE_ACCESS_TOKEN" or "SALESFORCE_ACCESS_TOKEN"
   */
  access_token_env_var: string;
}

/**
 * OAuth 2.0 token set returned by providers
 */
export interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

/**
 * Encrypted blob structure for OAuth credentials in user_mcp_credentials.encrypted_credentials
 */
export interface OAuthCredentialBlob {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_at: string; // ISO 8601
}
export interface ClientMetadata {
  os?: string;
  ide_version?: string;
  extension_version?: string;
  [key: string]: unknown;
}

export interface RateLimits {
  requests_per_minute: number;
  requests_per_hour: number;
  max_concurrent: number;
}

export interface TimeWindow {
  days: string[];
  start_utc: string;
  end_utc: string;
}

export interface AuditRequestSummary {
  method: string;
  tool_name?: string;
  arguments_hash?: string;
}

export interface AuditResponseSummary {
  status: string;
  duration_ms?: number;
  error?: string;
}

// Re-export seed functions
export { seedDatabase, seedDevData } from './seed.js';
