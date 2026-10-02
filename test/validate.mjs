import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(pkg.main, 'server/index.mjs');
assert.equal(pkg.version, manifest.version);
for (const file of [manifest.js, 'prompt-shape.js', 'server/index.mjs', 'scripts/openrouter-session-integration.mjs', 'integration/openrouter-session-id.patch', 'Dockerfile.integration', 'settings.html', 'README.md', 'LICENSE']) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
