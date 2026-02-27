// @ts-check
/**
 * ESLint 10 flat config for @mcpambassador/monorepo (backend packages).
 *
 * Scope: packages/{core,server,protocol,contracts,authn-ephemeral,authz-local,audit-file}/src
 *
 * The SPA (packages/spa) has its own eslint.config.js and is explicitly
 * excluded here.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // --------------------------------------------------------
  // Global ignores — these apply before any other config
  // --------------------------------------------------------
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.test.ts',
      '**/__tests__/**',
      'packages/spa/**',
    ],
  },

  // --------------------------------------------------------
  // Backend TypeScript packages
  // --------------------------------------------------------
  {
    files: ['packages/*/src/**/*.ts'],

    extends: [
      // Base JS recommended rules
      js.configs.recommended,
      // TypeScript recommended + type-checked rules
      // (equivalent to the legacy recommended-requiring-type-checking)
      ...tseslint.configs.recommendedTypeChecked,
      // Disable rules that conflict with Prettier
      prettier,
    ],

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        // Resolve the nearest tsconfig.json relative to each linted file.
        // Each package has its own tsconfig.json that extends tsconfig.base.json.
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // Preserve all rules from the legacy .eslintrc.cjs exactly
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // --------------------------------------------------------
  // Server package — suppress type-unsafe rules that fire due to its
  // heavy use of Fastify/Drizzle dynamic patterns and the any-typed db union.
  // The underlying patterns are intentional and pre-approved; this mirrors the
  // per-file eslint-disable comments used in other packages.
  // --------------------------------------------------------
  {
    files: ['packages/server/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      // Fastify preHandler hooks are typed as void-returning but correctly accept
      // async functions at runtime. This is a known Fastify v5 TypeScript limitation.
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
);
