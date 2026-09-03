import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `scripts/` holds standalone operator tooling run with plain node, outside
    // the TypeScript project. Type-aware linting cannot see it, and pulling it
    // into tsconfig would put non-shipping scripts in the build graph.
    // `extension/` is a separate CommonJS package with its own tsconfig — it is
    // not in this TypeScript project, so type-aware linting cannot see it. It is
    // typechecked and built by `npm run build:extension` and exercised by
    // `npm run verify:extension`.
    // `bench/` runs against the built output with plain node, for the same
    // reason as `scripts/`.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'scripts/**',
      'extension/**',
      'bench/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Secrets must never reach logs (spec §34, §51).
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
