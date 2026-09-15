const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'src/client');
const output = path.join(root, 'public/app.js');

function buildClient() {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0 || new Set(manifest).size !== manifest.length) {
    throw new Error('Client manifest must contain unique source files.');
  }
  return manifest.map(file => {
    if (typeof file !== 'string' || !/^[a-z0-9/-]+\.js$/.test(file) || file.startsWith('/')) {
      throw new Error(`Invalid client source path: ${file}`);
    }
    return fs.readFileSync(path.join(sourceDir, file), 'utf8');
  }).join('');
}

if (require.main === module) {
  const source = buildClient();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== source) {
      throw new Error('public/app.js is missing or stale. Run npm run build.');
    }
  } else {
    fs.writeFileSync(output, source);
    console.log('Built public/app.js from src/client/manifest.json');
  }
}

module.exports = { buildClient };
