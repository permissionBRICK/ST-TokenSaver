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

test('upgrades a legacy session-only block in place and can remove either form', () => {
    const legacyBlock = `            if (typeof request.body.session_id === 'string' && request.body.session_id.length <= 256) {
                bodyParams['session_id'] = request.body.session_id;
            }

`;
    const anchor = '            if (request.body.min_p !== undefined) {';
    const legacy = compatibleSource.replace(anchor, legacyBlock + anchor);
    assert.equal(hasForwarding(legacy), false);

    const upgraded = applyForwarding(legacy);
    assert.equal(hasForwarding(upgraded), true);
    assert.equal(upgraded, applyForwarding(compatibleSource));
    assert.match(upgraded, /bodyParams\['prompt_cache_key'\] = request\.body\.prompt_cache_key/);
    assert.equal(removeForwarding(legacy), compatibleSource);
});

test('refuses to upgrade a session block it does not recognize', () => {
    const anchor = '            if (request.body.min_p !== undefined) {';
    const edited = compatibleSource.replace(anchor, "            bodyParams['session_id'] = request.body.session_id;\n" + anchor);
    assert.throws(() => applyForwarding(edited), /unknown form/);
    assert.throws(() => removeForwarding(edited), /unknown form/);
});
