# MCP Ambassador Server — Copilot Instructions

## Repo Context

This is the **mcpambassador_server** repository — a pnpm monorepo containing the Ambassador Server. It is the core of the platform: a Fastify HTTP server with a React SPA, SQLite database, and a plugin-based architecture for auth, authorization, and audit.

**Version:** 0.8.0-beta.1  
**Stack:** Node.js 20+, TypeScript strict, pnpm workspaces, Fastify, Zod, Drizzle ORM (SQLite), React 19, Tailwind v4, Vite, Docker

## Monorepo Package Structure

```
packages/
  core/          # Database schema (Drizzle), migrations, shared types
  protocol/      # MCP protocol types and wire format
  contracts/     # Shared Zod schemas for API contracts
  authn-ephemeral/ # SPI implementation: authentication (ephemeral sessions)
  authz-local/   # SPI implementation: authorization (local RBAC)
  audit-file/    # SPI implementation: audit logging (append-only file)
  server/        # Main Fastify server, routes, plugin wiring
  spa/           # React 19 SPA (admin + user UI)
```

## Architecture Patterns

### SPI (Service Provider Interface)
AuthN, AuthZ, and Audit are injected as SPI plugins — never hardcoded. The server core depends on interfaces (`IAuthnProvider`, `IAuthzProvider`, `IAuditProvider`), not implementations. When adding auth-related code, always work through these interfaces.

### Fastify Conventions
- All routes must use `schema: { body: ZodSchema, params: ZodSchema }` — never skip validation
- Error responses use the canonical format: `{ error: { code: string, message: string } }`
- Never expose stack traces, internal error messages, or Zod validation internals in responses
- Use Fastify's `reply.code(n).send(...)` pattern consistently

### Drizzle ORM
- Schema lives in `packages/core/src/schema.ts`
- Migrations live in `packages/core/drizzle/`
- Any schema change requires a migration — do NOT use `push` in production
- Sensitive columns (credentials, tokens) are encrypted at the application layer before storage

## Security Patterns (CRITICAL)

### Cryptography
- Credentials encrypted with **AES-256-GCM** using HKDF-SHA256 per-user derived keys
- Master encryption key loaded from environment — NEVER embedded in code or config files
- Password hashing uses **Argon2id** via the `argon2` package — no bcrypt, no SHA-256 for passwords
- Token generation uses `crypto.randomBytes(32).toString('hex')` or `base64url` — NOT `Math.random()`

### Token Handling
- Preshared keys use prefix `amb_pk_` — validate prefix before processing
- Session tokens use prefix `amb_st_` — stored as HttpOnly Secure cookies
- Admin keys use prefix `amb_ak_` — never in client-side code
- Never log token values, even truncated

### Input Validation Rules
- ALL inputs validated with Zod before touching business logic
- Zod errors are caught and re-thrown as sanitized `{ error: { code: 'VALIDATION_ERROR', message: '...' } }`
- Never call `schema.parse()` in a route handler without a try/catch
- Use `.safeParse()` for external/untrusted data; handle the `success: false` case explicitly

### Forbidden Patterns
```typescript
// NEVER do these:
eval(userInput)
execSync(`command ${userParam}`)
JSON.parse(rawBody)  // use Zod instead
res.json(error)      // use canonical error format
console.log(token)   // use structured logger
```

## Code Review Criteria (for Copilot PR Review)

Flag these as **BLOCKING** issues:
1. Any route handler missing Zod schema validation
2. Any `any` type without eslint-disable comment
3. Raw SQL string concatenation with user input
4. Token or credential values in logs
5. `eval`, `exec`, or shell injection vectors
6. Changes to `packages/core/src/schema.ts` without a corresponding migration file
7. Changes to auth/crypto code without security comment explaining the design

Flag these as **WARNINGS**:
1. `catch (e: unknown)` blocks that silently swallow errors
2. Missing error handling on promises
3. Hardcoded port numbers or hostnames (use config)
4. Non-deterministic test assertions

## Testing Standards
- Tests live in `tests/` at monorepo root and `packages/*/tests/`
- Use Vitest; test files are `*.test.ts`
- Unit tests mock external dependencies (DB, file system)
- Integration tests use in-memory SQLite
- Target: `pnpm test` must pass on Node 20 and Node 22

## Docker
- See `Dockerfile` — multi-stage build, non-root user `mcpambassador:1000`, `/data` volume
- Do NOT add `RUN npm install -g` or similar in the runtime stage
- `docker-compose.yml` is for local development only — not K8s/production
