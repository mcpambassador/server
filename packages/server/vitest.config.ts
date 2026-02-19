import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Allow running E2E tests when RUN_E2E=1 is set in the environment.
    exclude: process.env.RUN_E2E
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    passWithNoTests: true,
  },
});
