-- ADR-022 (3b): per-grant tool list presentation. 'full' (default, today's behaviour) lists every
-- permitted tool; 'progressive' lists only the three ambassador__ meta-tools. Chosen by the user at
-- consent or one-shot creation; never by the client. Existing grants stay 'full'.
-- Applied exactly once (tracked migration); no backfill needed because of the column default.
ALTER TABLE `agent_grants` ADD COLUMN `disclosure_mode` text NOT NULL DEFAULT 'full' CHECK (`disclosure_mode` IN ('full','progressive'));
-- The consent choice rides on the auth code until the grant is minted at token exchange.
ALTER TABLE `oauth_auth_codes` ADD COLUMN `disclosure_mode` text NOT NULL DEFAULT 'full' CHECK (`disclosure_mode` IN ('full','progressive'));
