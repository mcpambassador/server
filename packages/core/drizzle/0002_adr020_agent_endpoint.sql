-- ============================================================
-- ADR-020: Remote Agent Endpoint (OAuth AS + /mcp) schema
-- ============================================================
-- Idempotent (runs on every startup). Tokens/codes are stored as SHA-256 hashes only.
-- ============================================================

CREATE TABLE IF NOT EXISTS `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`registered_via` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`disabled` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_pending_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`user_id` text REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`client_id` text NOT NULL REFERENCES `oauth_clients`(`client_id`) ON DELETE CASCADE,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`requested_scopes` text NOT NULL,
	`resource` text NOT NULL,
	`state` text,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_oauth_pending_expires_at` ON `oauth_pending_requests` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_auth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`client_id` text NOT NULL REFERENCES `oauth_clients`(`client_id`) ON DELETE CASCADE,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scopes` text NOT NULL,
	`tool_allowlist` text,
	`resource` text NOT NULL,
	`bound_client_id` text NOT NULL REFERENCES `clients`(`client_id`) ON DELETE CASCADE,
	`label` text,
	`ttl_seconds` integer,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_oauth_auth_codes_expires_at` ON `oauth_auth_codes` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`client_id` text REFERENCES `oauth_clients`(`client_id`) ON DELETE SET NULL,
	`bound_client_id` text NOT NULL REFERENCES `clients`(`client_id`) ON DELETE CASCADE,
	`label` text NOT NULL,
	`scopes` text NOT NULL,
	`tool_allowlist` text,
	`resource` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_by` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_grants_bound_client_id` ON `agent_grants` (`bound_client_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_grants_user_id` ON `agent_grants` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_grants_expires_at` ON `agent_grants` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`grant_id` text NOT NULL REFERENCES `agent_grants`(`grant_id`) ON DELETE CASCADE,
	`family_id` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_tokens_grant_id` ON `agent_tokens` (`grant_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_tokens_family_id` ON `agent_tokens` (`family_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_tokens_expires_at` ON `agent_tokens` (`expires_at`);
