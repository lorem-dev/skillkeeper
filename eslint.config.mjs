import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/storybook-static/**',
      '**/*.config.{js,mjs,ts}',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // React rules apply only to the desktop renderer.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Guard against XSS: dangerouslySetInnerHTML is banned by default. A
      // genuinely safe use (trusted build-time markup, never user input) may
      // opt in with an eslint-disable-next-line carrying a justification.
      'react/no-danger': 'error',
    },
  },
  // Story files legitimately export non-component values (the CSF default
  // meta and named story objects), and a CSF `render` function is invoked as a
  // component by Storybook's runtime even though it is syntactically a plain
  // arrow -- so neither fast-refresh nor rules-of-hooks constraints apply.
  {
    files: ['apps/desktop/src/renderer/**/*.stories.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  // Node build scripts (e.g. the icon generator) run under Node, so expose its
  // globals -- js.configs.recommended enables no-undef for plain .mjs files
  // (unlike the TS configs, which delegate undefined-name checks to tsc).
  {
    files: ['apps/desktop/build/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  // Keep this last: disable formatting rules that conflict with Prettier.
  prettier,
);
