#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const FORWARDING_BLOCK = `            if (typeof request.body.session_id === 'string' && request.body.session_id.length <= 256) {
                bodyParams['session_id'] = request.body.session_id;
            }

`;

const MARKER = "bodyParams['session_id'] = request.body.session_id";
const GENERATE_ROUTE = "router.post('/generate'";
const OPENROUTER_BRANCH = '} else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {';
const INSERTION_ANCHOR = '            if (request.body.min_p !== undefined) {';

export function backendPath(root) {
    return path.join(path.resolve(root), 'src/endpoints/backends/chat-completions.js');
}

/**
 * Installs the forwarding block on disk using an atomic sibling-file rename.
 * @param {string} root SillyTavern root.
 * @param {{backup?: boolean}} options Installation options.
 * @returns {{changed: boolean, target: string, backup: string|null}}
 */
export function installForwarding(root, { backup = true } = {}) {
    const target = backendPath(root);
    const source = fs.readFileSync(target, 'utf8');
    const updated = applyForwarding(source);
    if (updated === source) {
        return { changed: false, target, backup: null };
    }

    let backupPath = null;
    if (backup) {
        backupPath = `${target}.token-saver.bak`;
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(target, backupPath);
        }
    }

    const temporaryPath = `${target}.token-saver.tmp-${process.pid}`;
    const mode = fs.statSync(target).mode;
    try {
        fs.writeFileSync(temporaryPath, updated, { mode });
        fs.renameSync(temporaryPath, target);
    } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }

    return { changed: true, target, backup: backupPath };
}

export function hasForwarding(source) {
    return source.includes(MARKER);
}

export function applyForwarding(source) {
    if (hasForwarding(source)) {
        return source;
    }

    const routeIndex = source.indexOf(GENERATE_ROUTE);
    const branchIndex = source.indexOf(OPENROUTER_BRANCH, routeIndex);
    const anchorIndex = source.indexOf(INSERTION_ANCHOR, branchIndex);
    if (routeIndex < 0 || branchIndex < 0 || anchorIndex < 0) {
        throw new Error('Compatible OpenRouter generation branch not found. Refusing to modify SillyTavern.');
    }

    return source.slice(0, anchorIndex) + FORWARDING_BLOCK + source.slice(anchorIndex);
}

export function removeForwarding(source) {
    if (!hasForwarding(source)) {
        return source;
    }
    if (!source.includes(FORWARDING_BLOCK)) {
        throw new Error('Session forwarding marker exists in an unknown form. Refusing to modify SillyTavern.');
    }
    return source.replace(FORWARDING_BLOCK, '');
}

function usage() {
    console.error('Usage: node openrouter-session-integration.mjs <check|apply|revert> [SillyTavern root] [--no-backup]');
}

function run() {
    const [command, rootArg = process.cwd()] = process.argv.slice(2).filter(arg => arg !== '--no-backup');
    const noBackup = process.argv.includes('--no-backup');
    if (!['check', 'apply', 'revert'].includes(command)) {
        usage();
        process.exitCode = 2;
        return;
    }

    const target = backendPath(rootArg);
    const source = fs.readFileSync(target, 'utf8');
    if (command === 'check') {
        const installed = hasForwarding(source);
        console.log(installed ? 'OpenRouter session forwarding: installed' : 'OpenRouter session forwarding: missing');
        process.exitCode = installed ? 0 : 1;
        return;
    }

    if (command === 'apply') {
        const result = installForwarding(rootArg, { backup: !noBackup });
        console.log(result.changed
            ? `OpenRouter session forwarding installed in ${result.target}`
            : 'OpenRouter session forwarding already installed.');
        return;
    }

    const updated = removeForwarding(source);
    if (updated === source) {
        console.log(`OpenRouter session forwarding already ${command === 'apply' ? 'installed' : 'absent'}.`);
        return;
    }

    if (!noBackup) {
        const backup = `${target}.token-saver.bak`;
        if (!fs.existsSync(backup)) {
            fs.copyFileSync(target, backup);
            console.log(`Backup written to ${backup}`);
        }
    }
    fs.writeFileSync(target, updated);
    console.log(`OpenRouter session forwarding removed from ${target}`);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    run();
}
