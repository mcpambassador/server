# MCP Ambassador Server

Production proxy server for MCP (Model Context Protocol) tools with authentication, authorization, and audit.

## Architecture

This is a **pnpm monorepo** containing five packages:

| Package | Description | Dependencies |
|---|---|---|
| `@mcpambassador/protocol` | Type-only API contract (client ↔ server) | None (zero runtime deps) |
| `@mcpambassador/core` | SPI interfaces, database, pipeline | protocol, drizzle, pino, zod |
| `@mcpambassador/authn-apikey` | API Key authentication provider | core |
| `@mcpambassador/authz-local` | Local RBAC authorization provider | core |
| `@mcpambassador/audit-file` | File-based audit provider (JSONL) | core |

**Dependencies flow:** `protocol` → `core` → `authn-*`, `authz-*`, `audit-*`

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Run linter
pnpm lint

# Format code
pnpm format

# Type check
pnpm typecheck

# Database utilities
pnpm db:generate  # Generate migration from schema
pnpm db:push      # Push schema to database
pnpm db:studio    # Open Drizzle Studio
```

## Project Structure

```
mcpambassador_server/
├── packages/
│   ├── protocol/         ← API types (published to npm)
│   ├── core/             ← Database, SPI, pipeline
│   ├── authn-apikey/     ← API Key authentication
│   ├── authz-local/      ← Local RBAC
│   └── audit-file/       ← JSONL audit logger
├── pnpm-workspace.yaml   ← Workspace configuration
├── tsconfig.base.json    ← Shared TypeScript config
├── package.json          ← Root package scripts
└── .github/workflows/    ← CI/CD pipelines
```

## Database Schema

Phase 1 schema (M1):
- `clients` — Registered Ambassador Clients
- `tool_profiles` — Authorization rules (with inheritance)
- `admin_keys` — Admin API keys (Community tier)
- `audit_events` — Audit trail (Phase 2 database provider)

**Drivers:** SQLite (Community, embedded), PostgreSQL (Pro/Enterprise, external)

See `packages/core/src/schema/` and `mcpambassador_docs/database-schema.md`.

## Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# With coverage
pnpm test -- --coverage
```

Tests run against both SQLite and PostgreSQL (via CI).

## CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`):
1. **Lint** — ESLint + Prettier
2. **Type Check** — TypeScript compiler (no emit)
3. **Build** — Compile all packages
4. **Test** — Vitest on Node 18 + 20
5. **Integration** — Both SQLite and PostgreSQL

## Contributing

- All changes require Code Reviewer approval
- Security Engineer reviews auth/crypto/external API changes
- Database Engineer reviews schema changes
- Follow the existing patterns (see `docs/lessons-learned.md`)

## License

MIT

## Documentation

See the `mcpambassador_docs` repository for:
- Architecture (`architecture.md`)
- VISION (`VISION.md`)
- ADRs (`adr/`)
- Database schema (`database-schema.md`)
- Development plan (`../docs/dev-plan.md`)

> **Pre-development.** See [mcpambassador_docs/VISION.md](../mcpambassador_docs/VISION.md) for the full product vision.

---

## Related Repositories

| Repository | Purpose |
|---|---|
| `mcpambassador_client` | Ambassador Client — lightweight MCP proxy for developer workstations |
| `mcpambassador_docs` | Documentation, vision statement, research |
| `personas` | AI agent team definitions |