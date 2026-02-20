# Test Plan: M32.4 — SPA Hook Tests with MSW

## Scope
Cover all SPA hooks that make API calls under `packages/spa/src/api/hooks/` using MSW to mock responses. Ensure success, error, and loading states where applicable. Include mutation payload verification.

## Hooks to test
- use-credentials: `useCredentialStatus`, `useSetCredentials`, `useDeleteCredentials`
- use-profile: `useProfile`, `useChangePassword`
- use-clients: `useClients`, `useClient`, `useCreateClient`, `useUpdateClient`, `useDeleteClient`, `useClientSubscriptions`, `useSubscribe`, `useUpdateSubscription`, `useUnsubscribe`
- use-marketplace: `useMarketplace`, `useMcpDetail`
- use-admin: all exported hooks (queries and mutations)

## Test scenarios per hook
- Success: MSW returns `{ ok: true, data: ... }` and hook returns unwrapped `data`.
- Error: MSW returns `{ ok: false, error: { code, message } }` with a 4xx/5xx status and hook surfaces an `ApiError` (request rejects).
- Loading: for queries, ensure `isLoading` is true initially and resolves after response.
- Mutations: ensure mutation call sends expected payload and resolves to mocked data; verify query invalidation indirectly by ensuring no unexpected errors.

## Fixtures and mocks
- Use `packages/spa/src/test/mocks/server.ts` and expand `handlers.ts` to include endpoints used by hooks.
- Use `server.use()` in tests to override error responses.

## Test tooling
- Vitest with `jsdom` environment (already configured)
- `@testing-library/react` `renderHook`, `waitFor`
- MSW `http` handlers

## Files to add
- `packages/spa/src/test/hooks/api-hooks.test.tsx` — comprehensive tests grouped by hook file.

## Validation
- Run: `pnpm --filter @mcpambassador/spa exec vitest run --reporter=verbose` and expect all tests to pass.

## Notes
- Tests are deterministic and avoid timers.
- If additional endpoints are needed, update `src/test/mocks/handlers.ts` accordingly.
