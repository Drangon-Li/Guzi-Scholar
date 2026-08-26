// Lint gate for the desktop JavaScript sources.
//
// Same philosophy as ruff.toml: rules that find real defects and can stay at
// zero, rather than a style migration across a 12k-line entrypoint. That is
// exactly the remit of eslint's own recommended set ("problems", not "style"),
// so this now takes it wholesale instead of hand-listing a subset of it.
//
// no-undef earns its place here more than anywhere else: web/app.js is one
// closure with hundreds of functions, so a mistyped identifier is otherwise
// only discovered at runtime, in whichever feature happens to touch it.

import js from '@eslint/js';
import globals from 'globals';

const defects = {
  ...js.configs.recommended.rules,
  // An empty catch is the deliberate idiom here for "this may fail and the
  // failure is not interesting"; an empty block anywhere else is not.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Unused function arguments are usually positional placeholders, and a
  // leading underscore is the existing convention for a deliberate discard.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
};

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'data/**', 'web/vendor/**'],
  },
  {
    // Browser sources loaded as classic scripts.
    files: ['web/**/*.js'],
    ignores: ['web/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Attached by the sibling classic scripts, in load order.
        MyScholarCore: 'readonly',
        MyScholarOnboarding: 'readonly',
        MyScholarGraphModel: 'readonly',
        MyScholarGraphView: 'readonly',
        cytoscape: 'readonly',
        // The UMD tails check for a CommonJS environment so Node tests can
        // require them.
        module: 'readonly',
      },
    },
    rules: defects,
  },
  {
    files: ['web/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: defects,
  },
  {
    // Electron main process and build scripts.
    files: ['electron/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: defects,
  },
  {
    // Node-side tests. They also carry browser globals because the bodies of
    // page.evaluate() callbacks are serialised and run inside the page.
    files: ['tests/**/*.js', 'tests/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: defects,
  },
];
