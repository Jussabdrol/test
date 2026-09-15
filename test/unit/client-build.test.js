const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildClient } = require('../../scripts/build-client');
const root = path.resolve(__dirname, '../..');

test('the browser bundle includes every source exactly once and parses in a shared scope', () => {
  const sourceDir = path.join(root, 'src/client');
  function sources(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? sources(file) : file.endsWith('.js') ? [path.relative(sourceDir, file)] : [];
    });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json')));
  assert.deepEqual([...manifest].sort(), sources(sourceDir).sort());
  const bundle = buildClient();
  assert.doesNotThrow(() => new vm.Script(bundle));
  assert.equal(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), bundle);
});
