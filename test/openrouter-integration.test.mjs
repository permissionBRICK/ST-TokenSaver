import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyForwarding,
    hasForwarding,
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
