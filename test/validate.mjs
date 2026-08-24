import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(pkg.main, 'server/index.mjs');
for (const file of [manifest.js, 'server/index.mjs', 'settings.html', 'README.md', 'LICENSE']) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
