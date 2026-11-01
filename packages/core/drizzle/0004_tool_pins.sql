-- ADR-021 tool definition pinning. Runs exactly once (tracked migrations, TD-032).
-- pin_policy defaults to 'review' (fail closed). Existing MCPs keep serving through the one-shot
-- baseline (D6), which compares live definitions to the publish-time snapshot.
CREATE TABLE `tool_pins` (
	`pin_id` text PRIMARY KEY NOT NULL,
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE,
	`scope_user_id` text REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`tool_name` text NOT NULL,
	`status` text NOT NULL,
	`approved_hash` text,
	`approved_definition` text,
	`pending_hash` text,
	`pending_definition` text,
	`rejected_hash` text,
	`revoked_hashes` text,
	`flags` text,
	`absent` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`approved_at` text,
	`approved_by` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_tool_pin_scope` ON `tool_pins` (`mcp_id`, COALESCE(`scope_user_id`, ''), `tool_name`);
--> statement-breakpoint
CREATE INDEX `idx_tool_pins_status` ON `tool_pins` (`status`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog` ADD COLUMN `pin_policy` text NOT NULL DEFAULT 'review';
--> statement-breakpoint
-- origin: 'custom' = created by an admin through the catalog flow (only these may use pin_policy=auto).
-- Existing rows are 'unknown' and treated like registry/imported (review forced).
ALTER TABLE `mcp_catalog` ADD COLUMN `origin` text NOT NULL DEFAULT 'unknown';
