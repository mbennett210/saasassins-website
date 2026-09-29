import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    // exhaustive-deps is off (below); without this, the codebase's ~25 existing
    // inline `eslint-disable react-hooks/exhaustive-deps` comments would flip to
    // "unused directive" warnings. Silence those.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // ignoreRestSiblings: the `const { drop, ...rest } = obj` field-omission
      // pattern is used throughout the store migrations; the dropped key is
      // intentionally unused.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', ignoreRestSiblings: true }],
      // The React Compiler lint rules (eslint-plugin-react-hooks v6) are advisory
      // and fire on intentional, working patterns throughout the app (sync effects,
      // manual memoization, Date.now() in a memo). Their "fixes" are real refactors
      // of shipped, working code — not worth the regression risk for a production
      // launch. Disable the advisory ones; the genuine correctness rule
      // `react-hooks/rules-of-hooks` stays on (errors). `exhaustive-deps` is off to
      // match the codebase's established inline-disable convention + the compiler.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // Dev-only Fast-Refresh hint; store/index.jsx intentionally co-exports the
      // provider + hooks/constants. Splitting touches every import site for zero
      // production benefit.
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Backend serverless functions — Node runtime, not the browser.
    files: ['api/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, fetch: 'readonly' },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Vite + Node config files run under Node, not the browser.
    files: ['vite.config.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    // ── Reports-hub filter gate ──────────────────────────────────────────────
    // Filters here MUST use the searchable <FilterSelect> (via reportKit's
    // ManagerFilter / CustomerFilter / SelectFilter), never a raw <select> — that
    // plain-<select> mismatch was the recurring "filter boxes don't conform in
    // size" bug. This makes the wrong control fail `npm run lint` instead of
    // getting caught in review. Rule: UI_RULES §19 (single facet → FilterSelect) +
    // §31 (searchable pickers, not bare <select>, for entity fields).
    files: ['src/pages/reports/**/*.jsx'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "JSXOpeningElement[name.name='select']",
        message: 'Reports filters must use the searchable <FilterSelect> (reportKit ManagerFilter / CustomerFilter / SelectFilter), not a raw <select>. See UI_RULES §19 + §31.',
      }],
    },
  },
])
