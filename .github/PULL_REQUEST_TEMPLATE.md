## Description

<!-- A clear, concise description of what this PR does. -->

Fixes # (issue)

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Dependency update
- [ ] Refactor / code cleanup
- [ ] Documentation update
- [ ] Infrastructure / CI change

## Security Checklist

> Complete this section for any change touching auth, crypto, API routes, or data handling.

- [ ] No secrets or credentials hardcoded or logged
- [ ] All new API endpoints have Zod schema validation
- [ ] Error responses use the canonical format `{ error: { code, message } }` — no stack traces
- [ ] No `eval()`, `exec()` with user input, or shell injection vectors
- [ ] No `any` types without eslint-disable comment and justification
- [ ] Token/credential values never logged (even truncated)

**Does this PR change authentication, authorization, or cryptography?**
- [ ] No
- [ ] Yes — @mcpambassador/security has been notified (or is assigned as reviewer)

## Database Changes

- [ ] This PR does NOT change the database schema
- [ ] This PR changes `packages/core/src/schema.ts` and includes a migration in `packages/core/drizzle/`

## Testing

- [ ] I have added/updated unit tests for this change
- [ ] `pnpm test` passes locally on Node 20
- [ ] `pnpm lint` and `pnpm typecheck` pass

## Additional Notes

<!-- Any context for reviewers: why this approach, trade-offs considered, follow-up work needed -->
