# MCP Ambassador Server

[![CI](https://github.com/mcpambassador/server/actions/workflows/ci.yml/badge.svg)](https://github.com/mcpambassador/server/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE) [![Version](https://img.shields.io/badge/version-0.8.0--beta.1-orange.svg)]() [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)]() [![Docker](https://img.shields.io/badge/docker-supported-blue.svg)]() [![Website](https://img.shields.io/badge/docs-mcpambassador.ai-blue.svg)](https://mcpambassador.ai)

Centralized authentication, authorization, and audit for MCP tools. One server governs every downstream MCP your organization uses.

## What Is This

MCP Ambassador Server is the control plane for managing MCP tools across your organization. It proxies, authenticates, authorizes, and audits every tool call between AI clients and downstream MCP servers. Think of it as what LiteLLM does for LLM providers, but for MCP servers.

## Key Features

- **MCP Marketplace** -- Admin-published catalog of downstream MCPs with group-based visibility
- **User Self-Service** -- Users browse, subscribe to, and manage their own tool access through the web portal
- **Per-User MCP Isolation** -- Dedicated MCP instances per user with encrypted credential injection
- **Group-Based RBAC** -- Control which teams see which tools through group assignments
- **Credential Vault** -- AES-256-GCM encrypted per-user API keys with HKDF-derived keys
- **OAuth 2.0 Integration** -- Authorization code flow for downstream MCP authentication (GitHub, etc.)
- **Admin Dashboard** -- React SPA for managing users, groups, MCPs, and audit logs
- **Audit Logging** -- Append-only JSONL log of every authentication decision and tool invocation
- **Kill Switches** -- Instantly disable any MCP or client across the entire organization
- **Docker Deployment** -- Single container with bind-mount volumes and auto-generated TLS

## Quick Start

Prerequisites: Docker Engine 20+, docker compose v2

```bash
git clone https://github.com/mcpambassador/server.git
cd server
cp .env.example .env
docker compose up
```

Open https://localhost:9443 for the admin dashboard. Default credentials: admin / admin123.

> **Warning:** Change the default admin password immediately after first login.

### Ports

| Port | Service |
|------|---------|
| 8443 | Client API (MCP proxy) |
| 9443 | Admin and user web portal |

For production deployment, see the [Deployment Guide](https://mcpambassador.ai/docs/docker).

## Connecting a Client

Install the MCP Ambassador Client to connect AI tools to this server.

```bash
npm install -g @mcpambassador/client
```

VS Code configuration example:

```json
{
  "mcp.servers": {
    "mcpambassador": {
      "command": "npx",
      "args": ["-y", "@mcpambassador/client", "--config", "/path/to/amb-client-config.json"],
      "env": {
        "MCP_AMBASSADOR_URL": "https://localhost:8443",
        "MCP_AMBASSADOR_PRESHARED_KEY": "amb_pk_YOUR_KEY"
      }
    }
  }
}
```

See [@mcpambassador/client](https://github.com/mcpambassador/client) for Claude Desktop, OpenCode, and other integrations.

## Monorepo Structure

| Package | Description |
|---------|-------------|
| `@mcpambassador/protocol` | Type-only API contract between client and server (zero runtime deps) |
| `@mcpambassador/core` | Database schema, SPI interfaces, pipeline, validation |
| `@mcpambassador/server` | Hono HTTP/2 server, REST API routes, MCP process pools |
| `@mcpambassador/spa` | React 19 admin dashboard and user self-service portal |
| `@mcpambassador/authn-ephemeral` | Preshared key and ephemeral session authentication |
| `@mcpambassador/authz-local` | Group-based RBAC authorization |
| `@mcpambassador/audit-file` | JSONL audit log provider |
| `@mcpambassador/contracts` | Zod schemas for API request/response validation |

## Security

- TLS on all ports (self-signed auto-generated or CA-signed)
- Argon2id password hashing
- AES-256-GCM credential encryption with per-user HKDF-derived keys
- HMAC-SHA256 session tokens with configurable idle timeout
- Process isolation for stdio MCP child processes
- Non-root Docker container with read-only root filesystem
- Append-only audit log for compliance and forensics

## Development

```bash
# Prerequisites: Node.js 20+, pnpm 8.15+
pnpm install
pnpm -r build
pnpm -r test
pnpm -r lint
pnpm -r typecheck
pnpm format:check
```

## Related Projects

| Project | Description |
|---------|-------------|
| [@mcpambassador/client](https://github.com/mcpambassador/client) | Lightweight MCP proxy for developer workstations |
| [Community Registry](https://github.com/mcpambassador/community-registry) | Curated registry of 38+ MCP server configurations |
| [Documentation](https://mcpambassador.ai) | Full documentation, guides, and API reference |

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Prerequisites: Node.js 20+, pnpm 8.15+, Docker

## License

Apache License 2.0 -- see [LICENSE](./LICENSE).

## Status

MCP Ambassador is at v0.8.0-beta.1. The API may change before 1.0. Production use is supported but expect breaking changes during the beta period.
