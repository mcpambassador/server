-- ADR-023 (3c) human approval gates. Runs exactly once (tracked migrations, TD-032). Additive only:
-- no existing row changes meaning (every tool stays ungated until an admin sets a policy).
-- No PRAGMA: migrations run inside a transaction where it would be a silent no-op.
CREATE TABLE `tool_policies` (
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE,
	`tool_name` text NOT NULL CHECK (length(`tool_name`) BETWEEN 1 AND 256),
	`requires_approval` integer NOT NULL DEFAULT 0 CHECK (`requires_approval` IN (0,1)),
	`approver` text NOT NULL DEFAULT 'owner' CHECK (`approver` IN ('owner','admin')),
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`mcp_id`, `tool_name`)
);
--> statement-breakpoint
-- One row per gated call awaiting or having had a human decision. Raw arguments are never stored:
-- `args_hash` is SHA-256 of the JCS form of the routed arguments; `preview` is a sanitized, redacted
-- excerpt, capped at 8 KB and kept only while the request is open (pending/approved).
-- `expires_at` is the pending expiry, reset to the approved-use deadline when approved.
CREATE TABLE `approval_requests` (
	`approval_id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL REFERENCES `agent_grants`(`grant_id`) ON DELETE CASCADE,
	`bound_client_id` text REFERENCES `clients`(`client_id`) ON DELETE SET NULL,
	`user_id` text NOT NULL REFERENCES `users`(`user_id`) ON DELETE CASCADE,
	`mcp_id` text NOT NULL REFERENCES `mcp_catalog`(`mcp_id`) ON DELETE CASCADE,
	`tool_name` text NOT NULL CHECK (length(`tool_name`) BETWEEN 1 AND 256),
	`args_hash` text NOT NULL CHECK (length(`args_hash`) = 64),
	`pin_hash` text,
	`required_approver` text NOT NULL CHECK (`required_approver` IN ('owner','admin')),
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','approved','denied','expired','voided','consumed')),
	`preview` text CHECK (`preview` IS NULL OR (`status` IN ('pending','approved') AND length(CAST(`preview` AS BLOB)) <= 8192)),
	`via` text,
	`disclosure_mode` text NOT NULL DEFAULT 'full' CHECK (`disclosure_mode` IN ('full','progressive')),
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`approver_role` text CHECK (`approver_role` IS NULL OR `approver_role` IN ('owner','admin')),
	`self_approved` integer NOT NULL DEFAULT 0 CHECK (`self_approved` IN (0,1)),
	`decision_reason` text,
	`consumed_at` text,
	`void_reason` text
);
--> statement-breakpoint
-- Reaper and consume lookups.
CREATE INDEX `idx_approval_requests_status_expires` ON `approval_requests` (`status`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_approval_requests_user_status` ON `approval_requests` (`user_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_approval_requests_grant_status` ON `approval_requests` (`grant_id`, `status`);
--> statement-breakpoint
-- Denial cooldown: recent denials per (grant, mcp, tool).
CREATE INDEX `idx_approval_requests_cooldown` ON `approval_requests` (`grant_id`, `mcp_id`, `tool_name`, `status`, `decided_at`);
--> statement-breakpoint
-- Dedup: at most one open request per identical call, enforced by the database so concurrent retries cannot multiply rows.
CREATE UNIQUE INDEX `unique_open_approval_call` ON `approval_requests` (`grant_id`, `mcp_id`, `tool_name`, `args_hash`) WHERE `status` IN ('pending','approved');
--> statement-breakpoint
-- MCP-wide default for tools first seen after it is set; evaluated at call time.
ALTER TABLE `mcp_catalog` ADD COLUMN `default_requires_approval` integer NOT NULL DEFAULT 0 CHECK (`default_requires_approval` IN (0,1));
--> statement-breakpoint
ALTER TABLE `mcp_catalog` ADD COLUMN `default_approver` text NOT NULL DEFAULT 'owner' CHECK (`default_approver` IN ('owner','admin'));
