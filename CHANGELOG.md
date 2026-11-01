# Changelog

All notable changes to MCP Ambassador Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING
- The browser/user API (every cookie-authenticated route, incl. login, session, CSRF token and user endpoints) is served on the admin/SPA listener (9443) only. It is no longer registered on the client port (8443); browsers or scripts that called it on 8443 must use 9443. 8443 now serves only the MCP client protocol and the agent endpoint.
- `server.trust_proxy` / `MCP_AMBASSADOR_TRUST_PROXY` no longer accept hop counts (Fastify 5.12 disables them because they let direct clients spoof `X-Forwarded-*`). Use `true`, `false`, or an IP/CIDR list; a bare number in the env var is rejected at startup.

### Security
- Tool definition pinning (ADR-021): every downstream tool definition is hashed (RFC 8785 canonical JSON + SHA-256) and pinned. Agents only ever see the admin-approved definition, never the live one, on `/v1/tools`, `/mcp` tools/list, invocation and the insufficient-scope pre-check; arguments are validated against the approved `inputSchema`. A new or changed definition goes to a review queue (`pending_review`); the previously approved one keeps serving. Flags (injection-like phrases, zero-width/bidi characters, oversize, reserved or duplicate names) are shown to the reviewer and never auto-decide. Audit events carry hashes only.
- Query strings are redacted from request logs and 404 responses; admin-key failures are rate limited per IP and format-checked before argon2; OAuth `state` and raw downstream error bodies are no longer logged.
- Kill switches persist across restarts (`kill_switches` table) and are enforced in the invocation router; killed tools/clients are hidden from tool listings.
- Agent endpoint: deleting an OAuth client now disables it first, then revokes (and retains) its grants and deletes it in one transaction, closes the grants' live `/mcp` streams and audits each as `agent_grant_revoked`. Disabling a client also closes its live streams.
- Agent grants have a `kind` (`oauth` | `one_shot`); only `one_shot` grants may have no OAuth client. An `oauth` grant whose client is gone is rejected. Migration `0003_agent_grant_kind.sql` defaults existing rows to `oauth`, so a pre-existing one-shot grant is rejected until re-minted.
- Registry install persists only the schema-validated `oauth_config` (unknown keys are dropped).

### Added
- Admin API for the pin review queue: `GET /v1/admin/tool-pins` (+ `/summary`, `/:pinId`), `POST /v1/admin/tool-pins/:pinId/approve|reject|confirm-baseline`, `PATCH /v1/admin/mcps/:mcpId/pin-policy`. Decisions need the pin's current `expected_hash`; `apply_to: all_users` writes the all-users baseline pin. Five rejections in 24h hold an MCP's new pending items (approved definitions keep serving).
- Pin policy per MCP: `review` (default) or `auto` (first-seen tools auto-approved; later changes still need review). `auto` is allowed only for MCPs created by an admin (new `mcp_catalog.origin`); registry and imported MCPs always require review.
- Re-discovery: `notifications/tools/list_changed` from a stdio downstream triggers an immediate re-fetch, and all connections are re-fetched every `TOOL_PIN_REDISCOVERY_HOURS` (default 6, `0` disables the periodic run).
- `GET /v1/users/me/agent-endpoint` returns `resource_url` (the canonical MCP resource URL, `null` when the endpoint is disabled).

### Changed
- Upgrade behaviour for pinning (migration `0004_tool_pins.sql`): the first discovery after upgrade runs a one-shot baseline against each MCP's publish-time `tool_catalog` snapshot. Matching, unflagged tools are approved as `system:migration` and listed as "baseline, never human-reviewed" until an admin confirms them; everything else is `pending_review`. Until that first discovery runs, MCPs show no tools. Served descriptions remain truncated to 500 Unicode code points (SEC-M9-05); the pin hash and the admin review cover the full text, and the `truncated_on_serve` flag marks tools where the two differ. Residual risk (D6, accepted): `title`, `annotations` and `outputSchema` are not in the publish-time snapshot, so tools using them are listed as `baseline_unreviewed` and need admin confirmation anyway.
- Pin hardening: heuristics scan every string key/value in `inputSchema`, `outputSchema` and `annotations` (8 KB cap per text, linear time, no ReDoS); `observe` is serialized per (MCP, scope); oversize definitions are stored as a size marker plus the full hash and are never approvable; a name appearing twice in one `tools/list` hides both (`duplicate_name`); a corrupt stored definition hides the tool instead of failing startup.
- Migrations are tracked (TD-032): `schema_migrations(filename, sha256, applied_at)`. An existing untracked database is bootstrapped once (0000-0003 re-run idempotently, then recorded); later files run exactly once, each in its own transaction with its record, with no already-exists tolerance. Startup refuses (`MigrationIntegrityError`) if an applied migration file's hash changed. Hashes are line-ending-normalised (`.gitattributes` forces LF for `*.sql`). A new migration containing `PRAGMA foreign_keys` is refused (it is a no-op inside the transaction, so a table rebuild would cascade-delete children). The bootstrap logs the recorded filenames and hashes at warn.

## [0.9.1] - 2026-04-19

Hardening release.

### Security
- CORS policy (`origin: false`) on the admin server
- CSRF protection (`@fastify/csrf-protection`) on cookie-authenticated endpoints of the admin/SPA listener (9443)
- Dev client key bootstrap requires explicit `NODE_ENV=development|test`
- Password policy requires 2 of 4 character classes

### Added
- Daily audit log rotation with configurable retention (default 90 days)

### Changed
- All `console.*` replaced by the pino structured logger in production code
- Browser session cookie `maxAge` (9443 SPA/admin session) and an absolute server-side TTL now derive from new `session.ui_ttl_seconds` (default 28800); the 8443 client-session `session.ttl_seconds` is unchanged (TD-014)
- `@mcpambassador/protocol` now documents the client-port (8443) wire format: registration types match `POST /v1/sessions/register` (`preshared_key` request; `session_id`/`session_token`/`expires_at`/`profile_id`/`connection_id` response), `ErrorResponse` is the flat `{ error, message }`, added `HeartbeatResponse` and `DisconnectResponse`; `ClientStatus` deprecated. `@mcpambassador/contracts` documents the 9443 admin envelope.

### Fixed
- Checklist step 2 auto-completes on active subscriptions
- Subscription listing tolerates Drizzle join shape differences
- SPA test mocks include `/v1/csrf-token`; lint and formatting errors that blocked CI

### UX
- MCP wizard decomposed into step components; unsubscribe action on Subscriptions page; real server URL in onboarding snippets; zero-state CTA on MCP detail; accessibility and responsive table fixes

## [0.9.0-beta.1] - 2026-04-03

Codename: **Homelab Edition**

### Added
- Getting started onboarding checklist on user dashboard with auto-completing steps and copy-paste config snippets for VS Code and Claude Desktop
- Import from Registry button in MCP wizard pre-fills all fields from community registry entries
- Marketplace icons rendered from `icon_url` with fallback, dynamic category filter pills with URL-persisted state
- Tool preview on marketplace cards (expandable top 5) and full tool list with descriptions on detail page
- Catalog preview dialog showing pending changes before applying (replaces disabled placeholder)
- Client connection health on user Clients page: status badges (Active/Idle/Expired), last-seen timestamps, tool counts, reconnect instructions
- Admin dashboard usage sparklines (7-day invocation trend, pure SVG) and sortable MCP usage table with zero-usage flagging
- Command argument validation: all elements of MCP command array checked, configurable base command allowlist via `MCP_ALLOWED_COMMANDS`, dangerous eval pattern detection
- Audit buffer size limit (default 1000 events) with oldest-first drop on overflow
- Rate limit state cleanup timer (60s interval) and map size hard cap (10,000 entries)
- Master key file hex format validation matching environment variable validation
- Unit tests for command validation, master key validation, audit buffer overflow, rate limit cleanup

### Changed
- Initial credentials (admin key, recovery token, dev client key) written to file with 0600 permissions instead of logged to stdout
- Core packages (audit-file, authz-local, core/db) use pino structured logger instead of console.*

### Security
- All MCP command array elements validated for shell metacharacters (previously only command[0])
- Base command allowlist prevents execution of arbitrary binaries
- Eval/exec argument patterns detected and rejected
- Credentials no longer exposed in container log aggregators

## [0.8.0-beta.2] - 2026-03-15

Initial public beta release. See [README.md](README.md) for feature overview.
