## Playwright E2E Test Plan

### Scope
- Smoke test login and dashboard redirect for SPA served at https://localhost:9443

### Environments
- Docker-based local environment; Docker must be running with the server exposing 9443

### Tests
- Load `/login` and assert username and password inputs visible
- Perform login with `admin` / `admin123` and assert redirect to `/app/dashboard`

### Edge cases
- TLS: self-signed certs -> Playwright must use `ignoreHTTPSErrors: true`
- Broken login -> assert error message displayed (not implemented in smoke)

### Execution
- From repo root: `pnpm --filter @mcpambassador/spa...`
- In `packages/spa`: `pnpm install` then `npx playwright install chromium`
- Run: `npx playwright test --list`
