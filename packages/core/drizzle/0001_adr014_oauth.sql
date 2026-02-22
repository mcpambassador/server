-- ============================================================
-- ADR-014: OAuth 2.0 Schema Extensions
-- ============================================================
-- This migration adds the oauth_states table for OAuth 2.0 flow state management.
-- For fresh installs, this is applied after 0000_initial_schema.sql.
--
-- The oauth_states table stores transient OAuth flow state (10-minute expiry).
-- ============================================================

-- ============================================================
-- oauth_states table
-- ============================================================
CREATE TABLE IF NOT EXISTS `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_oauth_states_user_id` ON `oauth_states` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_oauth_states_expires_at` ON `oauth_states` (`expires_at`);
