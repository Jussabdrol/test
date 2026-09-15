const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function collect(relative) {
  const absolute = path.join(root, relative);
  if (fs.statSync(absolute).isDirectory()) {
    return fs.readdirSync(absolute).sort().flatMap(name => collect(path.join(relative, name)));
  }
  return /\.(?:js|cjs|mjs)$/.test(relative) ? [relative] : [];
}

const files = ['server.js', 'eslint.config.cjs', ...['src', 'public', 'scripts', 'test'].flatMap(collect)];
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
console.log(`Syntax checked ${files.length} JavaScript files.`);
