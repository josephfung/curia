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
    //   - `no-console` is deliberately absent. It exists on the backend because pino is the
    //     mandated alternative, and pino is a Node logger. There is no single browser
    //     replacement to point people at: antfarm has `clientWarn` (src/client-log.ts) but
    //     the console app has nothing, so turning the rule on here would flag ~68 call sites
    //     with no consistent fix to offer. Worth revisiting once the apps agree on a wrapper.
    //   - `.tsx` needs ecmaFeatures.jsx, which the backend has no reason to enable.
    //   - the react-hooks rules only make sense where React is.
    // The glob is deliberately `apps/**` and not `apps/*/src/**` plus a config special-case.
    // A path-shaped list is what #1726 and #1727 both were: `apps/console/tools/`, an
    // `e2e/` directory, or a vite config nested one level deeper would each match nothing
    // and be silently unlinted, with `eslint apps/` still exiting 0. Extensions are listed
    // for the same reason — a `.js`/`.jsx` file matches ESLint's built-in default and would
    // otherwise be counted as "linted" while no rule-bearing config applies to it.
    files: ['apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
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
