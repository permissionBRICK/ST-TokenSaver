import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    applyForwarding,
    hasForwarding,
    installForwarding,
    removeForwarding,
} from '../scripts/openrouter-session-integration.mjs';

const compatibleSource = `
router.post('/generate', async function () {
    let bodyParams;
    if (false) {
        bodyParams = {};
    } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        bodyParams = {
            transforms: getOpenRouterTransforms(request),
        };

            if (request.body.min_p !== undefined) {
        }
    }
});
`;

test('installs, detects, and removes OpenRouter session forwarding idempotently', () => {
    const installed = applyForwarding(compatibleSource);
    assert.equal(hasForwarding(installed), true);
    assert.equal(applyForwarding(installed), installed);
    assert.equal(removeForwarding(installed), compatibleSource);
    assert.equal(removeForwarding(compatibleSource), compatibleSource);
});

test('refuses to edit an unknown SillyTavern layout', () => {
    assert.throws(() => applyForwarding('not a compatible backend'), /Refusing to modify/);
});

test('installs on disk atomically, backs up once, and remains idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-integration-'));
    const backendDirectory = path.join(root, 'src/endpoints/backends');
    fs.mkdirSync(backendDirectory, { recursive: true });
    const target = path.join(backendDirectory, 'chat-completions.js');
    fs.writeFileSync(target, compatibleSource);

    const first = installForwarding(root);
    assert.equal(first.changed, true);
    assert.equal(hasForwarding(fs.readFileSync(target, 'utf8')), true);
    assert.equal(fs.readFileSync(`${target}.token-saver.bak`, 'utf8'), compatibleSource);

    const second = installForwarding(root);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(`${target}.token-saver.bak`, 'utf8'), compatibleSource);
    assert.deepEqual(fs.readdirSync(backendDirectory).filter(name => name.includes('.tmp-')), []);
});
