# MCP Ambassador — Server

The **Ambassador Server** is the centralized control plane for the MCP Ambassador platform. It manages, secures, audits, and exposes every downstream MCP server on behalf of authorized users and organizations.

---

## Architecture Role

```
┌──────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│  Ambassador      │       │  Ambassador      │       │  Downstream     │
│  Clients         │◄─────►│  Server          │◄─────►│  MCP Servers    │
│  (developer      │ gRPC/ │  (this repo)     │  MCP  │  (GitHub, DB,   │
│   workstations)  │ REST  │                  │       │   AWS, Sentry…) │
└──────────────────┘       └──────────┬───────┘       └─────────────────┘
                                      │
                           ┌──────────┴───────────┐
                           │  PostgreSQL · Redis   │
                           │  (state, cache, audit)│
                           └──────────────────────┘
```

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Authentication (AuthN)** | OAuth2, OIDC, API keys — verify developer identity |
| **Authorization (AuthZ)** | RBAC + ABAC — control which tools each role/user can access |
| **Audit** | Full audit trail of every tool invocation, parameter, and result |
| **Kill Switches** | Instantly disable any downstream MCP, tool, or user at any level |
| **Dynamic Tool Discovery** | Aggregate tool schemas from all connected MCP servers into a unified catalog |
| **Request Transformation** | Inject credentials, strip PII, enforce parameter policies before relaying to downstream MCPs |
| **Horizontal Scaling** | Stateless server nodes behind a load balancer; state in PostgreSQL + Redis |
| **Multi-Tenancy** | Organization-level isolation with per-org configuration and billing |

---

## Technology

- **Language:** TypeScript / Node.js
- **API:** gRPC + REST (admin dashboard)
- **Database:** PostgreSQL (config, audit, tenancy) + Redis (cache, sessions, rate limiting)
- **Deployment:** Docker / Kubernetes
- **Auth:** OAuth2 / OIDC provider integration

---

## Status

> **Pre-development.** See [mcpambassador_docs/VISION.md](../mcpambassador_docs/VISION.md) for the full product vision.

---

## Related Repositories

| Repository | Purpose |
|---|---|
| `mcpambassador_client` | Ambassador Client — lightweight MCP proxy for developer workstations |
| `mcpambassador_docs` | Documentation, vision statement, research |
| `personas` | AI agent team definitions |