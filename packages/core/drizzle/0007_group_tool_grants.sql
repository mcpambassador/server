-- ADR-025 (FB-032) per-tool group policy. Runs exactly once (tracked migrations, TD-032). Additive only:
-- every existing grant keeps tool_mode='all', so no user gains or loses a tool.
-- No PRAGMA: migrations run inside a transaction where it would be a silent no-op.
ALTER TABLE `mcp_group_access` ADD COLUMN `tool_mode` text NOT NULL DEFAULT 'all' CHECK (`tool_mode` IN ('all','allow','deny'));
--> statement-breakpoint
-- Exact tool names (no globs) for an 'allow' or 'deny' grant. Rows die with the grant (composite FK
-- onto the unique (mcp_id, group_id) index of mcp_group_access).
CREATE TABLE `mcp_group_access_tools` (
	`mcp_id` text NOT NULL,
	`group_id` text NOT NULL,
	`tool_name` text NOT NULL CHECK (length(`tool_name`) BETWEEN 1 AND 256),
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	PRIMARY KEY (`mcp_id`, `group_id`, `tool_name`),
	FOREIGN KEY (`mcp_id`, `group_id`) REFERENCES `mcp_group_access`(`mcp_id`, `group_id`) ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_group_access_tools_group` ON `mcp_group_access_tools` (`group_id`);
