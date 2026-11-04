# Changelog

All notable changes to MCP Ambassador Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.4] - 2026-11-03

Highlights: **a stricter runner guard** (docker/podman arguments, container runtimes, and git/URL/archive/local package sources are refused), **revoked clients are immutable**, **unverified OAuth clients get a shorter grant cap**, and **suspending or deactivating a user cuts their live agent streams**. Several behaviour changes need attention on upgrade (see Upgrade notes). `protocol` wire types are unchanged.

### Security

- Docker/podman MCP commands go through a default-deny parser: only `run`, with a short list of confinement-preserving options (`--rm -i -q --init --read-only --pull --network none|bridge --memory --cpus --pids-limit --cap-drop=ALL --security-opt=no-new-privileges --name --workdir`) and a numeric non-zero `--user` (names are refused because the image's `/etc/passwd` decides what they map to). Mounts, `--privileged`, host namespaces, `--cap-add`, devices, `--entrypoint`, `-e`/`--env-file`, tmpfs and global `-H/--host/--context` are rejected. nerdctl, finch and podman-remote get the same check; ctr, crictl, kubectl, buildah, runc, crun, nsenter, unshare, systemd-nspawn, bwrap, lxc-execute and chroot are refused outright. `docker` stays out of the default command allowlist, and enabling it needs the Docker socket (host-root equivalent), so it is unsupported for untrusted MCPs (TD-042).
- The env-name denylist now also blocks `DOCKER_*`, `PODMAN_*`, `CONTAINER_*` and `CONTAINERS_*` (e.g. `CONTAINERS_CONF`, `CONTAINERS_REGISTRIES_CONF`) plus `REGISTRY_AUTH_FILE`, `STORAGE_DRIVER` and `STORAGE_OPTS` (TD-042).
- Runner commands (npx, npm exec, pnpm dlx, bunx, uvx/uv, pip, deno, bun) refuse non-registry sources. Per runner: git, `github:`/`file:`/`ssh:`, http(s) and other URL specs are rejected for all of these runners; archives (`.tgz .tar .tar.gz .zip .whl`) for the npm family (npx, npm, pnpm, yarn, bunx, pnpx), uv and pip only (not deno or bun); npm's `owner/repo` shorthand for the npm family only; local paths for pip only. Rejected sources are caught including after `--`, after value-less flags such as `deno --allow-net`, and for every positional of install-style subcommands (`add`, `install`, `uv pip install`). Error text is generic and never echoes the value (TD-042).
- Agent OAuth: dynamically registered (unverified) clients are capped at `agent_endpoint.max_dcr_grant_ttl_seconds` (default 7 days, 60 s to 1 year) instead of `max_grant_ttl_seconds`; the effective cap is the smaller of the two. It is enforced at consent and again at code exchange; the consent screen shows the cap. Admin-registered clients, one-shot grants and existing grants are unchanged (TD-080).
- Credential placeholders embedded in an MCP's fixed env values (e.g. Notion `OPENAPI_MCP_HEADERS`) are filled from the user's credentials under a strict allowlist. Only auth/header-style variables are eligible (key ends in HEADER(S), AUTH, AUTHORIZATION, TOKEN, SECRET, CREDENTIAL(S) or API_KEY), URL/host/endpoint/proxy-shaped templates are never filled, the value must match `^[A-Za-z0-9._~+/=:-]{1,4096}$`, expansion is single-pass, and anything that cannot be filled is removed with only its key logged (TD-050).
- GitHub Actions are pinned to commit SHAs (TD-079).

### Changed

- **Revoked clients are terminal.** Any mutation of a revoked client (status change, rename, config) now returns 409; only DELETE is allowed. The check is part of the UPDATE (`status != 'revoked'`), so a concurrent revoke cannot be overwritten, and side effects run only when a row changed. Applies to the admin and user client routes.
- Suspending or deactivating a user (PATCH status or DELETE) now aborts that user's in-flight `/mcp` agent streams immediately and writes an `agent_streams_closed` audit event (reason, stream count, grant count). Grants are kept, so reactivation restores access (TD-025).
- Archiving an MCP and pausing its subscriptions is now one transaction (TD-001). `compatTransaction` no longer lets a failing ROLLBACK mask the original error, and its internals are typed (TD-003).
- `GET /v1/admin/users/:userId/groups` uses one joined query instead of one lookup per group; the response is unchanged (TD-009, TD-010).
- Consent details: `max_ttl_seconds` is now the client's effective cap, with an optional `unverified_ttl_limited`. The SPA shows "Unverified clients are limited to N" and filters the picker (older servers omit the field, so the SPA stays compatible).
- `POST`/`PATCH /v1/users/me/clients` 400 `VALIDATION_ERROR` details are now `[{path, message}]` instead of raw zod issues.
- Docker/podman images without a `@sha256` digest log a warning at spawn, MCP create/update and registry install.
- Dependencies and tooling: vitest 3 to 4.1.12 (TD-016), `drizzle-orm` and `drizzle-kit` pinned to exact versions (TD-004), 30 stale ESLint disable comments removed and unused disable directives are now a lint error (TD-002), server vitest timeouts raised to 30 s (TD-047), the legacy `amb_sk_` prefix dropped from the config test fixture (TD-006).

### Added

- `server.body_limit_bytes` (default 1048576), used by both listeners.
- `session.heartbeat_min_interval_seconds` (default 10) replaces the hard-coded heartbeat limiter and its 429 message. Keep it below the shortest client `heartbeat_interval_seconds` (clients allow 15 to 300 s), or that client gets 429s.
- `agent_endpoint.max_dcr_grant_ttl_seconds` (default 7 days), see Security. `GET /v1/users/me/agent-endpoint` returns it as an optional field (the effective cap for unverified clients).
- One shared `ARGON2_OPTIONS` in core (argon2id, 19456 KiB, 2 passes, 1 lane) replaces 6 copies. The values are identical, so existing and new hashes do not change.
- README: a "Session heartbeat" table and a note that lowering `max_grant_ttl_seconds` or `max_dcr_grant_ttl_seconds` only affects grants created afterwards.

### Fixed

- `PATCH` of a user client with an invalid `status` returned 500 (uncaught ZodError); it is now 400 (TD-013).
- Hashed SPA assets under `/app/assets/` are cacheable again (`public, max-age=31536000, immutable`); a global `no-store` hook was overriding it. API, auth and HTML responses stay uncached (TD-021).
- A per-user credential that fills an env placeholder slot (`KEY: '${KEY}'`) now lands under the slot's key, not the credential's casing, and a second case-variant credential for a filled slot is dropped (TD-051).
- Tests: the group-tool-policy audit-event test selects the event by its metadata instead of racing other events (TD-047).

### Upgrade notes

- **Composite env values:** an MCP env value that contains an embedded `${X}` that cannot be filled is now removed instead of being passed with the literal `${X}`. Check entries whose fixed env contains `${...}` text that is not a credential. Composite templates are limited to auth/header-style keys (see Security).
- **Runner package sources:** MCPs whose command points at a git URL, http(s) URL, archive, `github:`/`file:` spec, GitHub shorthand or (for pip) a local path are now rejected at create, update, install and spawn. Existing entries that use them fail to start until they are changed to a registry package (e.g. `pkg@1.2.3`, `pkg==1.0`). The 73 entries in the community registry are unaffected.
- **Docker/podman MCPs:** commands outside the allowlist above are rejected, and `--user` must be a numeric non-zero uid. The community registry's vendored runner-guard needs a re-sync.
- **Revoked clients:** integrations that edited a revoked client now get 409; delete it instead.
- **Heartbeat and body limit:** `session.heartbeat_min_interval_seconds` above 60, or at or above `heartbeat_expected_interval_seconds`, now fails config validation at startup, and `server.body_limit_bytes` outside 1 KiB to 64 MiB fails to load. Keep the heartbeat minimum below your shortest client `heartbeat_interval_seconds`.
- **Dynamically registered OAuth clients:** they previously got grants up to `max_grant_ttl_seconds` (30 days by default); they are now capped at 7 days. Set `agent_endpoint.max_dcr_grant_ttl_seconds` to keep the old cap. Existing grants are unchanged.

## [0.10.3] - 2026-11-03

Highlights: **agent grants can last up to a year** (1 week, 1 month, 1 year), with short access tokens, a lower cap for one-shot grants and an idle limit on refresh tokens. **The default maximum grant lifetime rises from 24h to 30 days on upgrade** (see Changed). Also: the build moves to pnpm 10 and the child uid cleanup on archive/deactivate is fixed. `protocol` wire types are unchanged; `contracts` only gains optional fields.

### Added

- Agent grants can now last up to a year. `agent_endpoint.max_grant_ttl_seconds` and `default_grant_ttl_seconds` accept up to 31536000 (1 year), and the SPA offers "1 week", "1 month" and "1 year" next to the shorter presets (up to the configured max). Access tokens stay short (`access_token_ttl_seconds`, max 1h, default 15 min): only the grant, i.e. the rotating refresh family, lives longer, so users re-authorize far less often. Users still see and revoke their grants on the Agent access page, and revoking kills the whole refresh family.
- `agent_endpoint.max_one_shot_grant_ttl_seconds` (default 24h, ceiling 7 days): cap for one-shot grants (`POST /v1/users/me/agent-grants`). They have no refresh token, so their bearer token lives as long as the grant; a long OAuth grant limit does not lengthen it. `GET /v1/users/me/agent-endpoint` returns it as an optional field.
- `agent_endpoint.refresh_token_idle_ttl_seconds` (default 30 days, min 1h): a refresh token not used for this long expires (each rotation slides the window; it never outlives the grant), so a long grant on an abandoned machine dies on its own.
- Startup now fails with a clear message when `default_grant_ttl_seconds` is larger than `max_grant_ttl_seconds`.
- Consent details gain optional `refresh_tokens_enabled` and `refresh_token_idle_ttl_seconds`; the `agent_token_refreshed` audit event adds `refresh_token_expires_at`.

### Changed

- **Default `agent_endpoint.max_grant_ttl_seconds` rises from 24h to 30 days on upgrade** (unset configs get the new default). To keep the old limit, set `max_grant_ttl_seconds: 86400` explicitly. One-shot grants are unaffected (their default cap stays 24h).
- Build tooling: pnpm 8.15.0 -> 10.34.7, pinned with its sha512 integrity in `packageManager` (CI via `pnpm/action-setup` reading `packageManager`, Dockerfile via corepack; `pnpm-lock.yaml` is now lockfile v9 with the same resolved versions). pnpm 10 skips dependency build scripts by default, so `pnpm.onlyBuiltDependencies` lists `argon2`, `better-sqlite3`, `esbuild` and `re2` (TD-078). Contributors need pnpm 10 (`corepack enable`).

### Fixed

- When an MCP is archived or a user is deactivated, its child uid is now reaped and its home wiped right away (as that uid, inside the allocator queue, the same path as a wipe on reassignment) instead of staying on disk until the uid is reused (TD-077). The cache GC log no longer says "became busy" when the instance simply no longer owns the uid.

## [0.10.2] - 2026-11-03

Highlights: **the server and the MCP child processes it launches now run on Node 22** (the container base image changed), **the per-instance MCP cache cleanup is enabled by default (`enforce`)** and empties idle instances' `.cache` (see Added), dependency advisories are cleared with a stricter audit gate, and admin errors return proper 401/403/400 codes. `protocol` and `contracts` wire types are unchanged.

### Changed

- **Node 22 runtime (TD-075).** The Docker builder and runtime images are now `node:22-bookworm-slim` (pinned by digest, same Debian 12 as before). Downstream MCP children that run `node`/`npx` therefore run on Node 22 instead of Node 20; rebuild the image (`docker compose build`) and re-test MCPs that depend on Node 20 behavior. CI tests on Node 22 and 24 (Node 20 is end of life), `engines.node` is `>=22.0.0`, and `@types/node` is 22. Container user, `setpriv`/`prlimit`/`tini` paths, setuid stripping and NoNewPrivs for children are unchanged.
- Dependency Audit now runs on every pull request, and the audit gate blocks on **moderate** as well as high and critical advisories (TD-069).

### Added

- **Enabled by default (`enforce`):** size cap and LRU purge for the per-instance MCP caches (TD-062). Caveat: an idle instance's `.cache` is emptied, and some tools keep login state there (for example `~/.cache/huggingface/token`); set `MCP_AMBASSADOR_CHILD_CACHE_GC=off` or `dry-run`, or raise the caps, if you rely on that. Each downstream instance's home (`/tmp/mcp-homes/<uid>`) could grow without bound (npm/uv/XDG caches and `TMPDIR`; the bind-mounted `./cache` also keeps them across restarts). The server now measures homes as the instance's own uid and, for an **idle** instance (no running process, not being started), empties only `.npm-cache`, `.uv-cache`, `.cache` and `tmp` in its home when the home exceeds `MCP_AMBASSADOR_CHILD_HOME_MAX_MB` (default `1024`), and, when all homes together exceed `MCP_AMBASSADOR_CHILD_HOMES_TOTAL_MAX_MB` (default `10240`), purges idle instances least recently used first. Triggers: an instance stopping, and a sweep every `MCP_AMBASSADOR_CHILD_CACHE_GC_INTERVAL_MIN` minutes (default `360`; first one 10 minutes after boot). A running instance is never touched (an over-cap one only logs a warning); a start of an instance waits for a purge of its own home instead of racing it; anything else in a home (config, tokens, state) is never auto-deleted (a home that stays over the cap because of such data logs a warning). `MCP_AMBASSADOR_CHILD_CACHE_GC=dry-run` only logs what would be purged, `off` disables it, `0` disables a cap; invalid numbers fall back to the defaults; an unrecognised mode falls back to dry-run. Every purge is logged with a hash of the instance key (no user id), the bytes freed and the reason. Active only with per-instance uids (`MCP_AMBASSADOR_CHILD_UID_RANGE`, the default in the image). Instances re-download their caches on next use, so the first start after a purge can be slower.

### Fixed

- Admin API errors (TD-067): a request with no session gets 401, a valid non-admin session gets 403, and CSRF failures get 403 and malformed or empty JSON bodies get 400, instead of 500. Only trusted errors (`AmbassadorError`, Fastify `FST_*`) keep their 4xx status; the CSRF pre-check matches the routed path, so percent-encoded admin paths also get the 401. For API clients: a logged-in non-admin on `/v1/admin/*` now gets 403 (was 401); unauthenticated requests still get 401; approvals are unchanged.
- Tool pins (TD-070): revoking a pin now takes an mcp-wide lock before the per-scope locks, so a concurrent discovery cannot insert a pin for a new scope while a revoke runs. Discoveries of different scopes of the same MCP now serialize (about +30-50 ms with 20 concurrent users); a shared/exclusive lock is tracked as TD-076.
- All production dependency advisories are cleared (TD-069): unused `pino-pretty` and `@fastify/view` removed, `re2` 1.27.0, and the `minimatch` override is scoped to `glob@14`.
- Test flakes: the group tool policy audit test no longer races the 5 s audit flush, and tests no longer fetch the community registry from GitHub (a global test stub answers it), which had caused `HTTP 403: rate limit exceeded` failures.

## [0.10.1] - 2026-11-02

### Changed

- Reference `docker-compose.yml` now defaults `NODE_ENV=production`: no dev preshared key on first boot, a config file that fails to load aborts startup, and MCP children inherit `NODE_ENV=production`. Set `NODE_ENV=development` for a local trial.

### Fixed

- An empty `PUBLIC_URL` (the reference `docker-compose.yml` passes `PUBLIC_URL: ${PUBLIC_URL:-}`, which is an empty string when unset) was treated as set, so the approval UI base URL became empty, startup logged an invalid-URL error and gated tool calls failed closed. Empty or whitespace `PUBLIC_URL` now counts as unset and falls back to `https://<server name or localhost>:<admin port>`.
- With `agent_endpoint` enabled and no `issuer_url`, the OAuth issuer was also empty (`issuer: ""`, relative endpoints, `authorization_servers: [""]`); it now falls back the same way. Empty `issuer_url` and `resource_base_url` count as unset.

## [0.10.0] - 2026-11-01

Highlights: downstream MCP children are isolated from `/data` and from each other (TD-052, TD-059), the image ships `uv`/`uvx` and Python for uvx-based registry entries (#156), and Tool Review gains bulk approve (FB-033). **This release changes the container's run requirements; read BREAKING before upgrading.** `protocol` and `contracts` wire types are unchanged apart from the additive bulk-approve route.

### BREAKING

- Compose requirements (TD-052/TD-059, #158/#159). `docker-compose.yml` in this repo is the reference; a deployment's compose must match it:
  - `user: "0:0"` (the entrypoint needs root to prepare per-instance homes, then drops to uid 1000)
  - `cap_drop: [ALL]` and `cap_add: [SETUID, SETGID, KILL, CHOWN, SETPCAP]`
  - `security_opt: [no-new-privileges:true]`
  - `read_only: true` (with the `/data` and `/tmp` bind mounts)
  - `deploy.resources.limits.pids` (the reference uses 4096), the container-wide process/thread cap that sits above the per-instance cap below
  - Without the capabilities, MCP children fail closed (SETUID/SETGID/KILL missing) or the container refuses to start (SETPCAP missing); see the TD-052 entry below.
- New environment variables (TD-059):
  - `MCP_AMBASSADOR_CHILD_UID_RANGE` (image default `20000-20999`, 10000 ids at most, must not contain the server uid/gid). Every downstream instance (`shared:<mcp>`, `user:<id>:<mcp>`, `discovery:<mcp>`) gets its own uid/gid and 0700 home under `/tmp/mcp-homes/<uid>`. Assignments persist in `/data/child-uids.json` (0600). When the range is full, the least recently used idle uid is reclaimed and its home wiped, so widen the range if the startup log reports 80%+ assigned. The legacy single `MCP_AMBASSADOR_CHILD_UID` still works when the range is unset; setting both is an error.
  - `MCP_AMBASSADOR_CHILD_NPROC` (default `256`, `0` disables): `RLIMIT_NPROC` per instance. **It counts threads, not only processes**, of every process running under that instance's uid. Browser MCPs (Playwright, Puppeteer/Chromium) and some runtimes with large thread pools can exceed 256: raise it (for example `1024`) if such an MCP fails with `EAGAIN`/"Resource temporarily unavailable" or Chromium crashes at launch. Keep it well under the container `pids` limit. Requires `prlimit` (util-linux, in the image).
- TD-052/TD-059: downstream stdio MCP children no longer run as the server and cannot read `/data`. The image defaults `MCP_AMBASSADOR_CHILD_UID_RANGE=20000-20999`, so every instance gets its own uid/gid and 0700 home under `/tmp/mcp-homes/<uid>` (assignments in `/data/child-uids.json`); the legacy single uid (`MCP_AMBASSADOR_CHILD_UID`, children share uid 1001 and `/tmp/mcp-home`) is used only when the range is set empty and `CHILD_UID` is set. The container starts as root only to run `docker/entrypoint.sh`, then execs the server as uid 1000 holding CAP_SETUID/SETGID/KILL. A compose without `cap_drop`/`cap_add` still starts (the image runs the entrypoint as root with Docker's default caps, which include SETPCAP, so the bounding set is still reduced to SETUID/SETGID/KILL), but it is less hardened: the server warns when it runs without `no-new-privileges`, and children get `--no-new-privs` regardless (see Security). If SETUID/SETGID/KILL are missing entirely, MCP children refuse to start (fail closed); if SETPCAP is missing the container refuses to start. With `MCP_AMBASSADOR_CHILD_UID_RANGE` set to empty and `MCP_AMBASSADOR_CHILD_UID` unset isolation is off (children run as the server uid with no capabilities, as before 0.10.0) and the server logs a warning at startup. Child HOME/npm/uv caches moved under `/tmp/mcp-homes` (legacy: `/tmp/mcp-home`); the old `/tmp/.npm-cache` is no longer used and can be deleted. After a rollback, empty the `/tmp` cache volume again before rolling forward.
- The browser/user API (every cookie-authenticated route, incl. login, session, CSRF token and user endpoints) is served on the admin/SPA listener (9443) only. It is no longer registered on the client port (8443); browsers or scripts that called it on 8443 must use 9443. 8443 now serves only the MCP client protocol and the agent endpoint.
- `server.trust_proxy` / `MCP_AMBASSADOR_TRUST_PROXY` no longer accept hop counts (Fastify 5.12 disables them because they let direct clients spoof `X-Forwarded-*`). Use `true`, `false`, or an IP/CIDR list; a bare number in the env var is rejected at startup.

### Added

- Tool Review bulk approve (FB-033): `POST /v1/admin/mcps/:mcpId/tool-pins/approve` takes `{items: [{pin_id, expected_hash}], apply_to?, reason?, include_flagged?}` (1-200 items) and approves each pin only if its pending hash still equals `expected_hash`; mismatches and every other per-pin refusal are skipped and reported (`skipped[].reason`: `stale`, `flagged`, `blocked`, `not_pending`, `not_found`, `wrong_mcp`, `duplicate`, `baseline_conflict`, `corrupt`, `previously_revoked`) instead of failing the request. Pins carrying any flag other than the informational length flags are skipped unless `include_flagged` is true; never-approvable flags stay blocked, and previously revoked hashes are never force-approved in bulk. Each approval is audited as `tool_pin_approved` with a shared `bulk_id`, plus one `tool_pin_bulk_approved` summary event. Admin auth only. The SPA adds "Approve all (N)" per MCP group, row checkboxes with "Approve selected", and a confirmation dialog with the counts; flagged tools are excluded by default and need an explicit checkbox plus a second confirmation. Additive to `contracts` (new route, schemas and audit action); the client does not use it.
- The runtime image ships `uv`/`uvx` (pinned by digest) and system `python3`, so uvx-based registry entries (for example Alpaca) can start (#156). `UV_PYTHON_DOWNLOADS=never`; caches live under `/tmp`.
- `scripts/group-grant-loss-report.mjs`: read-only pre-upgrade report of active subscriptions that will stop being served once grants are checked at call time (run it on a copy of the DB).
- Tool kill switch (ADR-025 M1): `POST /v1/admin/kill-switch/tool:<mcp_id>:<tool_name>` disables one tool of one MCP without touching the rest of that MCP or a same-named tool on another MCP. The key uses the catalog entry's `mcp_id` (a UUID, never the MCP name) and the byte-exact tool name (URL-encode the target when the name contains `/`, `?`, `#` or `%`). A killed tool is absent from the stdio-client list, the agent list, `ambassador__search_tools` and `describe_tool`, and a direct call fails with the existing kill-switch error. Tool names are 1-128 code points; control, bidi, zero-width characters and unpaired surrogates are rejected (400). The contract's switch `type` gains `tool` (additive); no schema migration (the `kill_switches.type` column is free text) and `client`/`mcp` switches are unchanged.
- Per-tool group policy (FB-032, ADR-025): a group's MCP grant can be `all` (default, unchanged), `allow` (only the listed tools) or `deny` (all but the listed tools). `POST /v1/admin/groups/:groupId/mcps` takes optional `tool_mode` and `tools`; `PUT /v1/admin/groups/:groupId/mcps/:mcpId/tools` replaces the policy of an existing grant (audited as `group.mcp_tool_policy.set` with added/removed names); `GET /v1/admin/groups/:groupId/mcps` returns `tool_mode` and `tools` per grant; `GET /v1/admin/mcps/:mcpId/tools` lists known tool names (catalog, approved pins and orphaned rule names) for a picker. Tool names are matched byte-exactly (1-256 chars, max 500 per policy). The admin API rejects `tool_mode: 'deny'` with an empty `tools` list (400, "use tool_mode 'all' to grant every tool") on both `POST` and `PUT`, since an empty deny list is exactly `all`; existing `deny` grants with no tools keep resolving as `all`. Migration `0007_group_tool_grants.sql` adds `mcp_group_access.tool_mode` (default `all`, so existing grants are unchanged) and the `mcp_group_access_tools` table.
- Progressive tool disclosure (ADR-022): a remote agent grant has a `disclosure_mode` (`full`, the default, or `progressive`) chosen by the user at consent or one-shot creation. In `progressive` mode `/mcp` `tools/list` returns only `ambassador__search_tools`, `ambassador__describe_tool` and `ambassador__call_tool`; they run through the same scope, allowlist, pin, authorization, kill-switch and audit path as a direct call, and a hidden, pending, revoked, reserved-name or out-of-scope tool answers "Unknown tool" like a nonexistent one. Same-named tools of different MCPs are told apart by an optional `mcp` argument (ambiguous names are refused with the candidates). Calls made through `call_tool` are audited with `via` and `disclosure_mode`; discovery is audited as `agent_tool_discovery` with query length and hash only. Search/describe draw from their own rate bucket at twice the per-grant call limit. Migration `0005_agent_grant_disclosure_mode.sql` adds the column to `agent_grants` and `oauth_auth_codes`; existing grants stay `full`.
- Admin API for the pin review queue: `GET /v1/admin/tool-pins` (+ `/summary`, `/:pinId`), `POST /v1/admin/tool-pins/:pinId/approve|reject|confirm-baseline`, `PATCH /v1/admin/mcps/:mcpId/pin-policy`. Decisions need the pin's current `expected_hash`; `apply_to: all_users` writes the all-users baseline pin. Five rejections in 24h hold an MCP's new pending items (approved definitions keep serving).
- Pin policy per MCP: `review` (default) or `auto` (first-seen tools auto-approved; later changes still need review). `auto` is allowed only for MCPs created by an admin (new `mcp_catalog.origin`); registry and imported MCPs always require review.
- Re-discovery: `notifications/tools/list_changed` from a stdio downstream triggers an immediate re-fetch, and all connections are re-fetched every `TOOL_PIN_REDISCOVERY_HOURS` (default 6, `0` disables the periodic run).
- `GET /v1/users/me/agent-endpoint` returns `resource_url` (the canonical MCP resource URL, `null` when the endpoint is disabled).

### Changed

- Creating or updating an MCP (admin API) or installing one from the registry now returns a 400 ("command not permitted on this server; see MCP_ALLOWED_COMMANDS") when `command[0]` is not on the same allowlist spawn enforces (TD-044). Before, e.g. a `docker` draft returned 201 but could never run. The check uses the same `getAllowedCommands()` as spawn, so it is never stricter; the reason does not echo the value.
- Admin API, registry install, catalog reload and tool-discovery error responses no longer echo raw `err.message` for database errors (TD-036): they pass through `publicErrorMessage`, so on Postgres a failed query answers "Database error" instead of the SQL and bound parameters. A regression test fails on any new raw `err instanceof Error ? err.message` in `admin/`, `routes/`, `services/` or `downstream/` unless it carries a `td036-allow` reason. A registry install rejected for its `oauth_config` now says "secret binding rejected" instead of the validator text.
- zod 3.25 → 4.6 in core, contracts and server (TD-020, clears GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections). Wire contracts are unchanged (pinned by a before/after accept/reject + output snapshot of every exported contracts schema). Visible differences: zod's own validation message text changed (e.g. `Required` → `Invalid input: expected string, received undefined`) in admin 400 `details`, config errors and registry-skip log lines; the config error for an invalid enum value now names the issue code `invalid_value` instead of `invalid_enum_value`. Enum/literal values are still never echoed (all three redaction copies handle zod 4's `invalid_value`).
- drizzle-orm 0.29.5 → 0.45.4 and drizzle-kit 0.20 → 0.31 (TD-019, clears GHSA-gpj5-g38j-94v9, SQL-identifier injection). Hand-written SQL migrations and the schema are unchanged; `db:generate`/`db:push` use the new `drizzle-kit generate`/`push` commands and `drizzle.config.ts` now sets `dialect: 'sqlite'`. A test pins that `db.session.client` (the raw driver handle used by health check, migrations and close) still resolves for SQLite and Postgres.
- Dev tooling: vitest 1.x → 3.2.7 (TD-016) with `pnpm.overrides` `vite >=6.4.4 <7` and `tinypool >=2.1.2`, clearing the tinypool criticals and the vite highs. Test config only (`deps.external` → `server.deps.external`); no runtime change. Two moderate vitest/@vitest/mocker advisories (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8) remain: the fix is vitest 4.1.12, which needs Node 22+ (CI is Node 20).
- Tool descriptions are no longer cut to 500 UTF-16 units when a downstream MCP is discovered; the full text is stored and the 500 code-point cut (never splitting a surrogate pair) happens only when a definition is served. Admin MCP views therefore show full descriptions.
- The `/mcp` insufficient-scope pre-check resolves a tool against the full catalog (same-named tools of different MCPs kept apart) and looks through one level of `ambassador__call_tool`.
- Community-registry entries are reduced to the fields the server reads (name, display, transport, config, auth, isolation, credentials, tags, category, URLs, version, maintainer, verified) when the registry is cached. Any other key (including the ADR-024 sync provenance fields such as `source`, `official_name`, `package_integrity`, `flags`) is dropped: never persisted into the catalog and no longer echoed by the admin registry API. Install behaviour is unchanged.
- Per-tool group policy is enforced at list and call time with union semantics across a user's active groups: a tool is available if any active group permits it (an unrestricted grant permits all). Order per MCP: kill switch, group policy, the subscription's `selected_tools`. A denied tool answers exactly like a nonexistent one ("Tool not subscribed for this client"). The marketplace list and detail show only the tools the user's groups permit. Changing a policy does not void existing tool approvals: the use-time recheck is what enforces it.
- Upgrade behaviour for pinning (migration `0004_tool_pins.sql`): the first discovery after upgrade runs a one-shot baseline against each MCP's publish-time `tool_catalog` snapshot. Matching, unflagged tools are approved as `system:migration` and listed as "baseline, never human-reviewed" until an admin confirms them; everything else is `pending_review`. Until that first discovery runs, MCPs show no tools. Served descriptions remain truncated to 500 Unicode code points (SEC-M9-05); the pin hash and the admin review cover the full text, and the `truncated_on_serve` flag marks tools where the two differ. Residual risk (D6, accepted): `title`, `annotations` and `outputSchema` are not in the publish-time snapshot, so tools using them are listed as `baseline_unreviewed` and need admin confirmation anyway.
- Pin hardening: heuristics scan every string key/value in `inputSchema`, `outputSchema` and `annotations` (8 KB cap per text, linear time, no ReDoS); `observe` is serialized per (MCP, scope); oversize definitions are stored as a size marker plus the full hash and are never approvable; a name appearing twice in one `tools/list` hides both (`duplicate_name`); a corrupt stored definition hides the tool instead of failing startup.
- Migrations are tracked (TD-032): `schema_migrations(filename, sha256, applied_at)`. An existing untracked database is bootstrapped once (0000-0003 re-run idempotently, then recorded); later files run exactly once, each in its own transaction with its record, with no already-exists tolerance. Startup refuses (`MigrationIntegrityError`) if an applied migration file's hash changed. Hashes are line-ending-normalised (`.gitattributes` forces LF for `*.sql`). A new migration containing `PRAGMA foreign_keys` is refused (it is a no-op inside the transaction, so a table rebuild would cascade-delete children). The bootstrap logs the recorded filenames and hashes at warn.

### Fixed

- Approving a tool pin is now serialized with discovery for the same MCP and scope (and the all-users scope for `apply_to: all_users`). Before, a discovery that landed while an approval was being written could leave the in-memory pin state (what agents are served) out of step with the database, losing the new pending definition.
- A uid reclaimed from an idle instance stays marked `preparing` until the victim's key is removed and the new lease is taken, instead of only until its home is wiped (TD-064). Previously the uid was released as soon as the wipe finished, and only microtask ordering kept the fast path from leasing it before the victim key was dropped.
- A downstream MCP response over the message limit (1MB) no longer hangs the call for 30 seconds, and a response over 10MB no longer kills the MCP process (TD-045). The oversize line is discarded as it streams (memory stays bounded) and only the request it answers fails, quickly, with "Response too large"; an unterminated flood (64MB without a newline) fails the in-flight requests once and the process is left alone. Pending requests are also failed immediately when the process exits, and a write to a dead child (EPIPE on stdin) no longer raises an unhandled error that could crash the server. A stdio MCP process that exits unexpectedly (shared MCPs and per-user instances) is respawned with exponential backoff (1s doubling to 30s) and keeps retrying at that cap; an MCP stopped, removed, updated, restarted or terminated on purpose is not respawned, and a respawn that is superseded mid-start stops the process it started. Exits and respawns are audited (`mcp_process_exited`, `mcp_respawned`, `mcp_respawn_failed`, `mcp_respawn_failing` after 5 failed attempts), and the shared-MCP health check reports `degraded` while respawning and `unhealthy` once past 5 attempts.
- A downstream tool result containing an embedded `resource`, `resource_link` or `audio` content block no longer breaks `/mcp` (-32602 "Invalid tools/call result") or is rejected (TD-041). The response schema now models every MCP content block type and keeps each block's payload plus its `annotations` and non-`ambassador/*` `_meta`; unknown fields are still dropped and each block is size-bounded (10MB payload, ~10.25MB per block).
- **TD-037 / ADR-025 M2+M4:** group grants are now evaluated at call time for every MCP (list, search, describe and invoke), via one shared helper also used at subscribe. A user whose group no longer grants an MCP stops being served it even if the subscription row still exists; the row is kept (filter, never mutate), so re-granting restores access. A suspended group grants nothing (ADR-025 §3.5), and the loss-report script labels each affected subscription `no_grant` or `only_suspended`. The subscription list endpoints gain `access: 'granted' | 'revoked'`.
- `POST /v1/admin/users` now adds the new user to `all-users` like every other creation path (without it the user got 403 on subscribe).
- Publishing or archiving an MCP now hot-applies the catalog, so a published shared MCP serves tools without a manual `POST /v1/admin/catalog/apply` or a restart. Failures stay pending and the SPA banner still offers Apply. Behaviour change: publish now goes live immediately; the review pause returns with ADR-021 tool-definition pinning. One `CatalogReloader` now serves both listeners, so concurrent applies conflict (409) instead of running in parallel.
- Removing a user from their only group (`all-users`) returns 409 CONFLICT instead of 403 FORBIDDEN.

### Security

- Child hardening (TD-052/TD-059): MCP children are now started with `setpriv --no-new-privs`, so a child that execs a setuid-root binary cannot gain capabilities from the inherited bounding set `{setuid, setgid, kill}` even when the container runs without `security_opt: no-new-privileges`. The image strips setuid/setgid bits from all files in the runtime stage. The server logs a warning (once) when it runs without NoNewPrivs; keep `security_opt: [no-new-privileges:true]` in compose. With child isolation disabled (`MCP_AMBASSADOR_CHILD_UID_RANGE` empty and `MCP_AMBASSADOR_CHILD_UID` unset) the server logs at startup: "child isolation disabled: MCP children run as the server uid and can read /data".
- Bulk approve (FB-033): each pin's hash and state check and its approval are applied with no await in between, so a pin changed after the admin's list is skipped as `stale` rather than approved. Flagged pins are never approved unless the request sets `include_flagged` (the UI only sends it after a second confirmation).
- Approving a tool definition whose exact hash was revoked earlier now needs `force: true` (TD-034): `POST /v1/admin/tool-pins/:pinId/approve` answers 409 `previously_revoked` otherwise, and a forced approval is audited (`forced_previously_revoked`). The review dialog says the definition was previously revoked and offers "Approve anyway".
- Per-user MCP pool spawns only what the user may use (TD-040): `spawnForUser` now takes the set of MCP ids the user is granted through an active group AND actively subscribed to (any of the user's clients), and starts nothing else, at all three callers (session register, reactivation, agent-endpoint `ensureUserMcps`). Before, every published per-user MCP was started for every user, so an ungranted MCP ran a process (and received that user's stored credentials if one existed) even though calls to it were refused. A user with no grants now has zero per-user processes. Subscriptions are never mutated; re-granting or re-subscribing restores the MCP on the next spawn. The spawnable set also requires the subscribing client to be `active`. Because the pool keeps a user's instances once started, every change to what a user may run (subscribe, update or unsubscribe, group grant add/revoke, membership add/remove, group suspend/reactivate/delete, client status change) now terminates that user's per-user instances and, if the user has a live session, respawns the current set; agent-endpoint users re-ensure on connect. A revoked MCP therefore stops (and its loaded credentials with it) instead of running until the next restart. The hook also fires on the user-facing client suspend/reactivate/delete routes. It runs detached and serialized, so admin and user requests never wait on MCP spawns, and it is skipped for a user whose spawnable set is unchanged since the last spawn. It is non-fatal: failures are logged and audited as `user_mcp_resync_failed`.
- Runner guard (TD-039): one shared validator (`services/runner-guard.ts`, dependency-free so community-registry CI can vendor it) rejects runner-changing options in both `--flag value` and `--flag=value` forms (and inside short-flag clusters) for npx/npm/pnpm/yarn/bunx (`--registry`, `--@scope:registry`, `--call`, `-c`, `-p`/`--package`, `--userconfig`, `--prefix`, `--cache`, ...), uvx/uv (`--from`, `--index-url`, `--extra-index-url`, `--find-links`, `--with*`, `--python`, ...), node (`-p`/`--print`, `-e`/`--eval`, `-r`/`--require`, `--import`, `--loader`, `--env-file`, ...), python (`-c`), pip, deno (incl. `eval`/`repl`) and bun. Only the runner's own option region is inspected: options after the package or script belong to it and are allowed. Applied at MCP create, update, registry install, YAML import and at spawn; a violation is a 400 / rejected install with a generic reason that never echoes a value.
- Reserved environment variable names are matched case-insensitively by prefix (`npm_config_*`, `PIP_*`, `UV_*`, `PYTHON*`, `NODE_*`, `LD_*`, `DYLD_*`, `YARN_*`, `PNPM_*`, `BUN_*`, `DENO_*`, `GIT_*`, `XDG_*`) plus exact `PATH`, `PATHEXT`, `HOME`, `USERPROFILE`, `SHELL`, `IFS`, `ENV`, `BASH_ENV`. They are refused in `config.env`, in `credential_schema` property keys and `env_var` values, and in `oauth_config.access_token_env_var`. `NODE_ENV` is the one allowed exception. `GITHUB_*` is not affected.
- Default-deny for npx/npm/pnpm/yarn/bunx and uvx/uv: before the package only a short list of boolean options is accepted (`-y`, `--yes`, `--no`, `-q`, `--quiet`, `--prefer-offline`, `--prefer-online`, `--offline`, `--no-fund`, `--no-audit`, `--no-update-notifier`, `--ignore-existing`; for uv `--quiet`, `--offline`, `--no-cache`, `--isolated`, `--no-progress`, `--no-config`), never with `=value`. This also closes npm option abbreviations (`--reg=`), `--git`, `--cafile`, `--https-proxy`. Scanning continues past subcommands (`npm exec`, `pnpm dlx`, `uv tool run`, `uv pip install`, `deno run`, `bun run`, `python -m pip`) up to the package or script.
- Also reserved env names: any `*_PROXY` (case-insensitive, incl. `NO_PROXY`), `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `JAVA_*`, `_JAVA_OPTIONS`, `PERL5*`, `RUBY*`, `GCONV_PATH`, `CLASSPATH`.
- `docker` is removed from the default allowed commands (it can mount host paths and run arbitrary images). It is now opt-in via `MCP_ALLOWED_COMMANDS`, and its arguments are NOT guarded (hardening tracked as TD-042). pip is default-deny too (it accepts option abbreviations); node also rejects `--env-file*`, `--openssl-config`, `--experimental-config-file`, deno `--preload`.
- Not covered (follow-up): git/URL package specs (`git+https://`, `github:`) and docker arguments (TD-042).
- Tool definition pinning (ADR-021): every downstream tool definition is hashed (RFC 8785 canonical JSON + SHA-256) and pinned. Agents only ever see the admin-approved definition, never the live one, on `/v1/tools`, `/mcp` tools/list, invocation and the insufficient-scope pre-check; arguments are validated against the approved `inputSchema`. A new or changed definition goes to a review queue (`pending_review`); the previously approved one keeps serving. Flags (injection-like phrases, zero-width/bidi characters, oversize, reserved or duplicate names) are shown to the reviewer and never auto-decide. Audit events carry hashes only.
- Query strings are redacted from request logs and 404 responses; admin-key failures are rate limited per IP and format-checked before argon2; OAuth `state` and raw downstream error bodies are no longer logged.
- Kill switches persist across restarts (`kill_switches` table) and are enforced in the invocation router; killed tools/clients are hidden from tool listings.
- Agent endpoint: deleting an OAuth client now disables it first, then revokes (and retains) its grants and deletes it in one transaction, closes the grants' live `/mcp` streams and audits each as `agent_grant_revoked`. Disabling a client also closes its live streams.
- Agent grants have a `kind` (`oauth` | `one_shot`); only `one_shot` grants may have no OAuth client. An `oauth` grant whose client is gone is rejected. Migration `0003_agent_grant_kind.sql` defaults existing rows to `oauth`, so a pre-existing one-shot grant is rejected until re-minted.
- Registry install persists only the schema-validated `oauth_config` (unknown keys are dropped).

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
- Core packages (audit-file, authz-local, core/db) use pino structured logger instead of console.\*

### Security

- All MCP command array elements validated for shell metacharacters (previously only command[0])
- Base command allowlist prevents execution of arbitrary binaries
- Eval/exec argument patterns detected and rejected
- Credentials no longer exposed in container log aggregators

## [0.8.0-beta.2] - 2026-03-15

Initial public beta release. See [README.md](README.md) for feature overview.
