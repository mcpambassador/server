-- Grant kind: distinguishes OAuth-issued grants from one-shot grants (both may have a NULL client_id
-- once the OAuth client is deleted, because of ON DELETE SET NULL). Existing rows default to 'oauth'
-- (fail closed): a pre-existing one-shot grant is rejected until re-minted. No data backfill here:
-- migrations are re-run at every start, so an UPDATE would re-mark orphaned OAuth grants.
-- Re-runs raise "duplicate column name", which the migration runner tolerates.
ALTER TABLE `agent_grants` ADD COLUMN `kind` text NOT NULL DEFAULT 'oauth';
