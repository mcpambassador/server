# Project Instructions

## Current State
- Development plan: `mcpambassador_docs/dev-plan.md`
- Architecture: `mcpambassador_docs/architecture.md`
- Status: `mcpambassador_docs/status.md`

## Working Agreements
- All code changes require Code Reviewer review before merge
- Security Engineer signs off on auth, crypto, and external API changes
- Database Engineer signs off on schema changes
- Write outputs to `mcpambassador_docs/` — not just chat
- Update `mcpambassador_docs/status.md` after completing any task
- Append to `mcpambassador_docs/lessons-learned.md`, never overwrite

## Definition of Done — CI Gate (MANDATORY)

No code change is considered complete until ALL of the following pass locally:

```bash
pnpm -r build        # All 8+ packages compile
pnpm -r lint         # 0 errors (warnings OK)
pnpm format:check    # All files match Prettier style
pnpm -r typecheck    # tsc --noEmit passes in every package
pnpm -r test         # All tests pass
```

If any step fails, the agent MUST fix the issue before calling the task complete.
These mirror the GitHub Actions CI workflow (`.github/workflows/ci.yml`).

### Common gotchas
- **Prettier:** After editing ANY `.ts`, `.json`, or `.md` file, run `pnpm format` before committing
- **ESLint:** The config is `eslint.config.js` (ESLint 10 flat config). No `.eslintrc.*` files.
- **Typecheck:** Each package has its own `tsconfig.json` extending `tsconfig.base.json`. Changes to shared types can break downstream packages.
- **Node version:** CI runs on Node 20. Do not use APIs added after Node 20 (e.g., `import.meta.dirname` requires Node 21.2+).
