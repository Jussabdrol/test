const globals = require('globals');

const correctness = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'valid-typeof': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'src/client/**'] },
  {
    files: ['server.js', 'eslint.config.cjs', 'src/server/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: correctness,
  },
  {
    // Validate the assembled classic script: fragments share one lexical scope.
    files: ['public/**/*.js', 'public/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, L: 'readonly', XLSX: 'readonly', mammoth: 'readonly', saveAs: 'readonly' },
    },
    rules: correctness,
  },
  { files: ['public/**/*.mjs'], languageOptions: { sourceType: 'module' } },
];
