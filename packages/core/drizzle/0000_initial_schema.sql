-- MCP Ambassador — Phase 3 Clean-Slate Schema
-- Generated from packages/core/src/schema/index.ts (13 tables)
-- SQLite dialect · Drizzle migration conventions
-- 2026-02-19

-- ============================================================
-- 1. users
-- ============================================================
CREATE TABLE IF NOT EXISTS `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`password_hash` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`auth_source` text DEFAULT 'local' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_login_at` text,
	`vault_salt` text,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_users_username` ON `users` (`username`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_email` ON `users` (`email`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_status` ON `users` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_auth_source` ON `users` (`auth_source`);
--> statement-breakpoint

-- ============================================================
-- 2. tool_profiles
-- ============================================================
CREATE TABLE IF NOT EXISTS `tool_profiles` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`allowed_tools` text DEFAULT '[]' NOT NULL,
	`denied_tools` text DEFAULT '[]' NOT NULL,
	`rate_limits` text DEFAULT '{"requests_per_minute":60,"requests_per_hour":1000,"max_concurrent":5}' NOT NULL,
	`inherited_from` text REFERENCES `tool_profiles`(`profile_id`) ON DELETE SET NULL ON UPDATE CASCADE,
	`environment_scope` text DEFAULT '[]',
	`time_restrictions` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tool_profiles_name` ON `tool_profiles` (`name`);
--> statement-breakpoint

-- ============================================================
-- 3. clients  (formerly preshared_keys)
-- ============================================================
CREATE TABLE IF NOT EXISTS `clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`profile_id` text REFERENCES `tool_profiles`(`profile_id`),
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_clients_key_prefix` ON `clients` (`key_prefix`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_clients_user_id` ON `clients` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_clients_status` ON `clients` (`status`);
--> statement-breakpoint

-- ============================================================
-- 4. user_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS `user_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`session_token_hash` text NOT NULL,
	`token_nonce` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`profile_id` text NOT NULL REFERENCES `tool_profiles`(`profile_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`idle_timeout_seconds` integer DEFAULT 1800 NOT NULL,
	`spindown_delay_seconds` integer DEFAULT 300 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_sessions_user_status` ON `user_sessions` (`user_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_sessions_status` ON `user_sessions` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_sessions_expires_at` ON `user_sessions` (`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_user_sessions_token_hash` ON `user_sessions` (`session_token_hash`);
--> statement-breakpoint

-- ============================================================
-- 5. session_connections
-- ============================================================
CREATE TABLE IF NOT EXISTS `session_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL REFERENCES `user_sessions`(`session_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`friendly_name` text NOT NULL,
	`host_tool` text NOT NULL,
	`connected_at` text NOT NULL,
	`last_heartbeat_at` text NOT NULL,
	`disconnected_at` text,
	`status` text DEFAULT 'connected' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_connections_session_id` ON `session_connections` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_connections_status` ON `session_connections` (`status`);
--> statement-breakpoint

-- ============================================================
-- 6. admin_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS `admin_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`key_hash` text NOT NULL,
	`recovery_token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`rotated_at` text,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_admin_keys_is_active` ON `admin_keys` (`is_active`);
--> statement-breakpoint

-- ============================================================
-- 7. audit_events
-- ============================================================
CREATE TABLE IF NOT EXISTS `audit_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`event_type` text NOT NULL,
	`severity` text NOT NULL,
	`session_id` text NOT NULL,
	`client_id` text,
	`user_id` text,
	`auth_method` text NOT NULL,
	`source_ip` text NOT NULL,
	`tool_name` text,
	`downstream_mcp` text,
	`action` text NOT NULL,
	`request_summary` text DEFAULT '{}',
	`response_summary` text DEFAULT '{}',
	`authz_decision` text,
	`authz_policy` text,
	`ambassador_node` text,
	`metadata` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_events_timestamp` ON `audit_events` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_events_client_id` ON `audit_events` (`client_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_events_event_type` ON `audit_events` (`event_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_events_severity` ON `audit_events` (`severity`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_events_timestamp_client` ON `audit_events` (`timestamp`, `client_id`);
--> statement-breakpoint

-- ============================================================
-- 8. groups
-- ============================================================
CREATE TABLE IF NOT EXISTS `groups` (
	`group_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_groups_name` ON `groups` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_groups_status` ON `groups` (`status`);
--> statement-breakpoint

-- ============================================================
-- 9. user_groups
-- ============================================================
CREATE TABLE IF NOT EXISTS `user_groups` (
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`group_id` text NOT NULL REFERENCES `groups`(`group_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`assigned_at` text NOT NULL,
	`assigned_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_user_groups` ON `user_groups` (`user_id`, `group_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_groups_group_id` ON `user_groups` (`group_id`);
--> statement-breakpoint

-- ============================================================
-- 10. mcp_catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS `mcp_catalog` (
	`mcp_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon_url` text,
	`transport_type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`isolation_mode` text DEFAULT 'shared' NOT NULL,
	`requires_user_credentials` integer DEFAULT false NOT NULL,
	`credential_schema` text DEFAULT '{}' NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`oauth_config` text DEFAULT '{}' NOT NULL,
	`tool_catalog` text DEFAULT '[]' NOT NULL,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_by` text,
	`published_at` text,
	`validation_status` text DEFAULT 'pending' NOT NULL,
	`validation_result` text DEFAULT '{}' NOT NULL,
	`last_validated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_mcp_catalog_name` ON `mcp_catalog` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_catalog_status` ON `mcp_catalog` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_catalog_isolation_mode` ON `mcp_catalog` (`isolation_mode`);
--> statement-breakpoint

-- ============================================================
-- 11. mcp_group_access
-- ============================================================
CREATE TABLE IF NOT EXISTS `mcp_group_access` (
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`group_id` text NOT NULL REFERENCES `groups`(`group_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`assigned_at` text NOT NULL,
	`assigned_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_mcp_group_access` ON `mcp_group_access` (`mcp_id`, `group_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_group_access_group_id` ON `mcp_group_access` (`group_id`);
--> statement-breakpoint

-- ============================================================
-- 12. client_mcp_subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS `client_mcp_subscriptions` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL REFERENCES `clients`(`client_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`selected_tools` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`subscribed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_client_mcp_sub` ON `client_mcp_subscriptions` (`client_id`, `mcp_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_client_mcp_sub_client_id` ON `client_mcp_subscriptions` (`client_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_client_mcp_sub_mcp_id` ON `client_mcp_subscriptions` (`mcp_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_client_mcp_sub_status` ON `client_mcp_subscriptions` (`status`);
--> statement-breakpoint

-- ============================================================
-- 13. user_mcp_credentials
-- ============================================================
CREATE TABLE IF NOT EXISTS `user_mcp_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE ON UPDATE CASCADE,
	`encrypted_credentials` text NOT NULL,
	`encryption_iv` text NOT NULL,
	`credential_type` text DEFAULT 'static' NOT NULL,
	`oauth_status` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_user_mcp_cred` ON `user_mcp_credentials` (`user_id`, `mcp_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_mcp_cred_user_id` ON `user_mcp_credentials` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_mcp_cred_mcp_id` ON `user_mcp_credentials` (`mcp_id`);
