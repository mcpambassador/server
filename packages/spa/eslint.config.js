// ESLint 9 flat config for @mcpambassador/spa (React 19 + Vite + TypeScript)
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  // ---------------------------------------------------------------------------
  // Global ignores — equivalent to .eslintignore
  // ---------------------------------------------------------------------------
  {
    ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'e2e/**'],
  },

  // ---------------------------------------------------------------------------
  // Base JavaScript recommended rules (applies to all non-ignored files)
  // ---------------------------------------------------------------------------
  js.configs.recommended,

  // ---------------------------------------------------------------------------
  // TypeScript support via @typescript-eslint/eslint-plugin v8 flat configs.
  // flat/recommended spreads into 3 config objects that:
  //   [0] register the @typescript-eslint plugin and set the TS parser
  //   [1] apply TS-specific rule overrides for *.ts / *.tsx / *.mts / *.cts
  //   [2] apply remaining recommended rules
  // ---------------------------------------------------------------------------
  ...tsPlugin.configs['flat/recommended'],

  // ---------------------------------------------------------------------------
  // React: hooks rules + fast-refresh validation
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],

    plugins: {
      // recommended-latest already registers the plugin, but we also need
      // react-refresh which isn't part of it.
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },

    languageOptions: {
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },

    rules: {
      // React Hooks — from recommended-latest (flat-config-aware)
      ...reactHooks.configs['recommended-latest'].rules,

      // React Refresh — warn when a module exports non-components alongside
      // components, which breaks HMR fast-refresh.
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },

    linterOptions: {
      // Replaces the legacy --report-unused-disable-directives CLI flag
      reportUnusedDisableDirectives: 'warn',
    },
  },
];
