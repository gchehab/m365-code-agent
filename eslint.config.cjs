'use strict';
const js = require('@eslint/js');
const globals = require('globals');
module.exports = [
  { ignores: ['node_modules/**', 'dist/**', '.test-output/**'] },
  { files: ['src/**/*.js', 'scripts/**/*.cjs', 'eslint.config.cjs'], ...js.configs.recommended, languageOptions: { sourceType: 'commonjs', globals: globals.node }, rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] } },
  { files: ['media/*.js'], ...js.configs.recommended, languageOptions: { sourceType: 'script', globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } } }
];
