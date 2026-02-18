-- Phase 3: Ephemeral Sessions & Preshared Keys (M13)
-- ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
-- Adds: users, preshared_keys, user_sessions, session_connections

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`auth_source` text DEFAULT 'preshared_key' NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`vault_salt` text,
	`metadata` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_status` ON `users` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_email` ON `users` (`email`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_auth_source` ON `users` (`auth_source`);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `preshared_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`label` text NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`metadata` text DEFAULT '{}',
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `tool_profiles`(`profile_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_preshared_keys_key_prefix` ON `preshared_keys` (`key_prefix`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_preshared_keys_user_id` ON `preshared_keys` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_preshared_keys_status` ON `preshared_keys` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_preshared_keys_key_hash` ON `preshared_keys` (`key_hash`);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`token_nonce` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`profile_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`idle_timeout_seconds` integer NOT NULL,
	`spindown_delay_seconds` integer NOT NULL,
	`metadata` text DEFAULT '{}',
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `tool_profiles`(`profile_id`) ON UPDATE cascade ON DELETE restrict
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
CREATE TABLE IF NOT EXISTS `session_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`friendly_name` text NOT NULL,
	`host_tool` text NOT NULL,
	`connected_at` text NOT NULL,
	`last_heartbeat_at` text NOT NULL,
	`disconnected_at` text,
	`status` text DEFAULT 'connected' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `user_sessions`(`session_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_connections_session_id` ON `session_connections` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_connections_status` ON `session_connections` (`status`);
