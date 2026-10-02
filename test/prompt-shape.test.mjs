import assert from 'node:assert/strict';
import test from 'node:test';
import { squashSystemMessages } from '../prompt-shape.js';

const NEW_CHAT = '[Start a new Chat]';
const EXAMPLE_CHAT = '[Example Chat]';
const NUDGE = '[Write the next reply only as Alice.]';
const separate = [NEW_CHAT, EXAMPLE_CHAT, NUDGE];
const system = (content, name) => ({ role: 'system', content, ...(name ? { name } : {}) });

test('merges consecutive system prompts the way a live request does', () => {
    const chat = [
        system('Main prompt'), system('Character description'), system('Scenario'),
        { role: 'user', content: 'Persona note' },
        system(EXAMPLE_CHAT), system('Example user line', 'example_user'), system('Example reply', 'example_assistant'),
        system(EXAMPLE_CHAT), system('Second example', 'example_user'),
        system(NEW_CHAT), system('Lore entry'), system('Author note'),
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: '[Note: keepalive]' },
    ];
    assert.deepEqual(squashSystemMessages(chat, separate), [
        system('Main prompt\nCharacter description\nScenario'),
        { role: 'user', content: 'Persona note' },
        system(EXAMPLE_CHAT), system('Example user line', 'example_user'), system('Example reply', 'example_assistant'),
        system(EXAMPLE_CHAT), system('Second example', 'example_user'),
        system(NEW_CHAT), system('Lore entry\nAuthor note'),
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: '[Note: keepalive]' },
    ]);
});

test('keeps the group nudge separate and drops empty system messages', () => {
    const chat = [system('Main'), system(''), system('World info'), { role: 'user', content: 'Hi' }, system(NUDGE), system('Trailing')];
    assert.deepEqual(squashSystemMessages(chat, separate), [
        system('Main\nWorld info'), { role: 'user', content: 'Hi' }, system(NUDGE), system('Trailing'),
    ]);
});

test('does not modify the input messages', () => {
    const chat = [system('A'), system('B')];
    const snapshot = structuredClone(chat);
    squashSystemMessages(chat, separate);
    assert.deepEqual(chat, snapshot);
});
