import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    // TD-047: heavy per-file setup (DB migrate, argon2id) can exceed the 5s default when the host is
    // loaded; files then failed together and passed alone.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Allow running E2E tests when RUN_E2E=1 is set in the environment.
    exclude: process.env.RUN_E2E
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    passWithNoTests: true,
    setupFiles: ['./tests/setup-no-network.ts'],
    server: {
      deps: {
        // re2 is a native C++ module that cannot be transformed by Vite
        external: [/re2/],
      },
    },
  },
});
