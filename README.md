# MCP Ambassador Server

[![CI](https://github.com/mcpambassador/server/actions/workflows/ci.yml/badge.svg)](https://github.com/mcpambassador/server/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE) [![Version](https://img.shields.io/badge/version-0.10.0-blue.svg)](./CHANGELOG.md) [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](<>) [![Website](https://img.shields.io/badge/docs-mcpambassador.ai-blue.svg)](https://mcpambassador.ai)

One server to authenticate, authorize, and audit every MCP tool your team uses. It proxies tool calls between AI clients and downstream MCP servers, and records each decision.

## Features

- **Marketplace and self-service**: admins publish downstream MCPs; users browse and subscribe from the web portal. Visibility follows group membership.
- **Group RBAC**, including **per-tool group policy**: a group's MCP grant can allow all tools, only a list, or all but a list.
- **Per-user MCP instances** with encrypted credentials (AES-256-GCM, HKDF-derived keys) and OAuth 2.0 for downstream MCPs.
- **Tool pinning**: tool definitions are hashed; new or changed tools wait in a review queue (single and bulk approve) before agents see them.
- **Approval gates**: an admin can require a person to approve each use of a risky tool.
- **Kill switches**: disable a client, an MCP, or a single tool of one MCP.
- **Progressive disclosure**: agents can be given three search/describe/call tools instead of the full tool list.
- **Audit log**: append-only JSONL of authentication decisions and tool calls.
- **Admin and user SPA** (React 19) on the web port.

Details for each: [mcpambassador.ai/docs](https://mcpambassador.ai/docs).

## Quick start

Needs Docker Engine 20+ and docker compose v2.

```bash
git clone https://github.com/mcpambassador/server.git
cd server
cp .env.example .env
mkdir -p data config cache   # bind mounts; see setup-host-dirs.sh for ownership
docker compose up -d
```

Open https://localhost:9443 (self-signed TLS) and follow the first-run setup wizard to create the admin account.

| Port | Serves                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 8443 | MCP client protocol (registration, discovery, invocation) and the agent endpoint (`/mcp`, `/oauth/*`) |
| 9443 | Admin API, user API (cookie-authenticated routes), and the SPA                                        |

The reference compose file binds 9443 to `127.0.0.1`. Production setup, TLS, and reverse proxies: [Docker guide](https://mcpambassador.ai/docs/docker) and [Production guide](https://mcpambassador.ai/docs/production).

## Container requirements

MCP children run under their own uids, so the container must start as root, drop to uid 1000 in the entrypoint, and keep only the capabilities it needs. `docker-compose.yml` in this repo is the reference; a deployment's compose must match it:

```yaml
user: '0:0'
cap_drop: [ALL]
cap_add: [SETUID, SETGID, KILL, CHOWN, SETPCAP]
security_opt:
  - no-new-privileges:true
read_only: true # with ./data:/data and ./cache:/tmp bind mounts
deploy:
  resources:
    limits:
      pids: 4096
```

Without SETUID/SETGID/KILL, MCP children refuse to start; without SETPCAP, the container refuses to start. See the 0.10.0 BREAKING notes in [CHANGELOG.md](./CHANGELOG.md) before upgrading.

## Configuration

Configured by environment variables (see `.env.example`, `docker-compose.yml`, and the [configuration reference](https://mcpambassador.ai/docs/configuration)). Commonly used:

| Variable                                               | Default               | Purpose                                                                                                                     |
| ------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AMBASSADOR_DATA_DIR`                              | `/data`               | Database, TLS certs, audit log, secrets                                                                                     |
| `MCP_AMBASSADOR_HOST` / `MCP_AMBASSADOR_PORT`          | `0.0.0.0` / `8443`    | Client listener                                                                                                             |
| `MCP_AMBASSADOR_LOG_LEVEL`                             | `info`                | Log level                                                                                                                   |
| `MCP_AMBASSADOR_CHILD_UID_RANGE`                       | `20000-20999` (image) | Each downstream instance gets its own uid/gid and 0700 home. Widen it if startup warns that 80%+ is assigned.               |
| `MCP_AMBASSADOR_CHILD_NPROC`                           | `256` (`0` disables)  | `RLIMIT_NPROC` per instance; counts threads. Browser MCPs may need e.g. `1024`; keep well under the container `pids` limit. |
| `MCP_AMBASSADOR_TRUST_PROXY`                           | off                   | `true`, `false`, or an IP/CIDR list. Hop counts are no longer accepted.                                                     |
| `PUBLIC_URL`                                           |                       | Public base URL for OAuth callbacks behind a reverse proxy                                                                  |
| `REGISTRY_URL` / `REGISTRY_TOKEN` / `REGISTRY_ENABLED` | community registry /  | Registry source, token for a private registry, on/off                                                                       |

## Security model

- **Isolation**: each downstream stdio MCP instance runs under its own uid with a private home, cannot read `/data` or other instances, and starts with `no-new-privs`. The container has a read-only root filesystem and a reduced capability set.
- **Tool pinning**: the full definition of every downstream tool is hashed. Unreviewed or changed definitions are hidden from agents until an admin approves them; flagged or previously revoked definitions need an explicit extra step.
- **Authorization order per call**: kill switch, group policy, then the subscription's selected tools. A tool that is denied answers the same as one that does not exist.
- **Approval gates**: per-tool human approval with an argument preview.
- **Credentials**: AES-256-GCM encryption with per-user HKDF-derived keys; Argon2id password hashing; HMAC-SHA256 session tokens.
- **Transport**: TLS on every listener (self-signed by default, or CA-signed).
- **Audit**: every decision and call is written to an append-only log.

Report vulnerabilities as described in [.github/SECURITY.md](.github/SECURITY.md). Deeper reading: [security](https://mcpambassador.ai/docs/security), [tool pinning](https://mcpambassador.ai/docs/tool-pinning), [approval gates](https://mcpambassador.ai/docs/approval-gates), [kill switches](https://mcpambassador.ai/docs/kill-switches), [RBAC](https://mcpambassador.ai/docs/rbac), [progressive disclosure](https://mcpambassador.ai/docs/progressive-disclosure).

## Connecting a client

The [client](https://github.com/mcpambassador/client) is a stdio MCP you point your AI tool at. It is not published to npm yet (npm only has `0.8.0-beta.2`); install it from source following the client README. Agents that speak MCP over HTTP can also use the agent endpoint on 8443 (see [client-server docs](https://mcpambassador.ai/docs/client-server)).

## Repository layout

pnpm monorepo:

| Package                          | Role                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| `@mcpambassador/protocol`        | Type-only wire contract between client and server               |
| `@mcpambassador/contracts`       | Zod schemas for API requests and responses                      |
| `@mcpambassador/core`            | Database schema (Drizzle), SPI interfaces, pipeline             |
| `@mcpambassador/server`          | Fastify servers, REST routes, downstream MCP process management |
| `@mcpambassador/spa`             | React admin and user portal                                     |
| `@mcpambassador/authn-ephemeral` | Preshared-key and ephemeral-session authentication              |
| `@mcpambassador/authz-local`     | Group-based authorization                                       |
| `@mcpambassador/audit-file`      | JSONL audit provider                                            |

## Development

Node.js 20+ and pnpm 8.15+. Changes to `protocol` or `contracts` also affect the client; see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
pnpm install && pnpm -r build && pnpm -r lint && pnpm format:check && pnpm -r typecheck && pnpm -r test
```

## Related

[Client](https://github.com/mcpambassador/client) · [Community registry](https://github.com/mcpambassador/community-registry) · [Documentation](https://mcpambassador.ai/docs) · [Changelog](./CHANGELOG.md)

## Support

Free and open source. Sponsor: https://github.com/sponsors/mcpambassador

- Bitcoin: `3QH4WQoQqnhU3LhbZQU8ttXaNco5Ge3xVp`
- Ethereum: `0xa5462444c5AEf0B2e32822D9a9B7f91aC794FfF0`

## License

Apache License 2.0, see [LICENSE](./LICENSE). Pre-1.0: the API may change between releases.
