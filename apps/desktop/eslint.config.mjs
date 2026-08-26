// Lint gate for the desktop JavaScript sources.
//
// Same philosophy as ruff.toml: a narrow set of rules that finds real defects
// and can realistically stay at zero, rather than a style migration across a
// 12k-line entrypoint. Stylistic rules are deliberately absent.
//
// no-undef earns its place here more than anywhere else: web/app.js is one
// closure with hundreds of functions, so a mistyped identifier is otherwise
// only discovered at runtime, in whichever feature happens to touch it.

import globals from 'globals';

const defects = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-const-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-sparse-arrays': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
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
