import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    // Build output is generated, and CI builds the console before it lints — without this,
    // `eslint apps/` would walk the bundled artifacts.
    ignores: ['**/dist/**', '**/build/**'],
  },
  {
    // Backend (Node). pino is the mandated logger here, so `no-console` is an error.
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser apps (console, antfarm). A separate block rather than a widened glob above,
    // because the rule set genuinely differs:
    //   - `no-console` is deliberately absent: it exists on the backend because pino is the
    //     mandated alternative, and there is no browser equivalent to point people at.
    //   - `.tsx` needs ecmaFeatures.jsx, which the backend has no reason to enable.
    //   - the react-hooks rules only make sense where React is.
    // `apps/*/*.config.ts` (vite configs) is included so the build config is linted too.
    files: ['apps/*/src/**/*.{ts,tsx}', 'apps/*/*.config.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // An error, not a warning: a stale dependency array is a real bug, and a rule that only
      // warns never actually gates. Deliberate omissions get an explicit disable comment.
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // caughtErrorsIgnorePattern matches the existing `catch (_err)` convention in the apps;
      // without it, typescript-eslint v8 flags every intentionally-ignored catch binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
