import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    Generate,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    getCurrentChatId,
    getGenerateUrl,
    getRequestHeaders,
    isGenerating,
    main_api,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
} from '../../../../script.js';
import { createGenerationParameters, getChatCompletionModel, oai_settings } from '../../../openai.js';
import { horde_settings } from '../../../horde.js';
import { getStringHash, uuidv4 } from '../../../utils.js';
import { squashSystemMessages } from './prompt-shape.js';

export { init };

const MODULE = 'ST-TokenSaver';
const LEGACY_MODULE = 'keepalive';
const TEMPORARY_CONNECTION_STARTED = 'st-token-saver:temporary-connection-started';
const TEMPORARY_CONNECTION_ENDED = 'st-token-saver:temporary-connection-ended';

// Cap the keepalive completion to a single token. The full prompt prefix is
// still processed by the backend (which is what refreshes the server-side
// cache), but we never pay for a full completion.
const KEEPALIVE_RESPONSE_LENGTH = 1;
const HEARTBEAT_INTERVAL_MS = 20000;
const RETRY_INTERVAL_MS = 5000;
const SETTINGS_REFRESH_DELAY_MS = 300;
const MAIN_CHAT_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

// Extension-prompt key used to inject the keepalive message as a USER message at depth 0.
const KEEPALIVE_INJECT_ID = 'keepalive_ping';

// Original default message; used to migrate untouched installs to the current default wording.
const LEGACY_DEFAULT_MESSAGE = 'Keep the cache warm.';

// Idle-tracking key used when no connection profile is active (manual API panel).
const NONE_KEY = '__none__';

const defaultSettings = {
    enabled: false,
    openRouterSessionIds: true,
    timeoutSeconds: 295,
    message: '[Note: just reply with an empty response to keep the session alive]',
    // Per-profile enable map: { [profileId]: boolean }. Unlisted profiles default to enabled.
    profiles: {},
};

let heartbeatTimer = null;
let jobRegistered = false;
let refreshPromise = null;
let refreshRequested = false;
let refreshTimer = null;
let generationRefreshTimer = null;
let retryTimer = null;
let preparingJob = false;
let lifecycleVersion = 0;
let temporaryConnectionDepth = 0;
let refreshAfterTemporaryConnection = false;
let activeMainRequest = null;
let generationWatchdog = null;
let latestSuccessfulRequestStartedAt = 0;
// Whether keepalive is "armed" for the CURRENT chat. It stays dormant until the user sends a new
// message or starts another foreground generation in the open chat. Merely loading a chat does not
// prove that its prompt is cached server-side. Reset on page reload and whenever the chat changes.
let armed = false;
// Per-profile time of the last verified successful main-chat inference request, keyed by
// connection profile id (or NONE_KEY). In-memory only; a reload starts disarmed.
const lastActivity = {};
// Last successful backend keepalive, keyed by connection profile. The backend returns this after a
// sleeping tab wakes so we can distinguish a still-warm prompt from an expired one.
const lastKeepalive = {};

// Per-document ids keep duplicated tabs independent. Jobs orphaned by a closed or reloaded
// document are deliberately cleaned up by the backend lease.
const keepaliveJobId = uuidv4().replaceAll('-', '');

/**
 * @returns {string} The active connection profile id, or NONE_KEY for a manual connection.
 */
function getActiveProfileKey() {
    return extension_settings.connectionManager?.selectedProfile || NONE_KEY;
}

/**
 * Whether keepalive should run for the CURRENTLY ACTIVE connection. Requires the global
 * master switch; for a real profile it also requires that profile's per-profile toggle
 * (default on). A manual connection (no profile selected) is governed by the master switch alone.
 * @returns {boolean}
 */
function isKeepaliveEnabledForActive() {
    const s = extension_settings[MODULE];
    if (!s.enabled) {
        return false;
    }
    const profileId = extension_settings.connectionManager?.selectedProfile;
    if (!profileId) {
        return true;
    }
    const perProfile = s.profiles?.[profileId];
    return perProfile === undefined ? true : !!perProfile;
}

function getTimeoutMs() {
    return Math.max(60, Number(extension_settings[MODULE].timeoutSeconds) || 295) * 1000;
}

function updateLastKeepalive(profileKey, value) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
        lastKeepalive[profileKey] = Math.max(lastKeepalive[profileKey] || 0, timestamp);
    }
}

/**
 * Adds a privacy-preserving, stable per-chat OpenRouter session key before the
 * request is sent to SillyTavern's backend. The bundled server integration
 * forwards this top-level value to OpenRouter.
 * @param {object} generateData Mutable chat-completion request payload.
 */
function addOpenRouterSessionId(generateData) {
    if (!extension_settings[MODULE]?.openRouterSessionIds || oai_settings.chat_completion_source !== 'openrouter') {
        return;
    }

    const chatId = getCurrentChatId();
    if (chatId) {
        generateData.session_id = `st-${getStringHash(chatId)}`;
    }
}

async function updateOpenRouterIntegrationStatus() {
    const status = $('#keepalive_openrouter_status');
    try {
        const response = await fetch('/api/plugins/token-saver/capabilities', { headers: getRequestHeaders() });
        const capabilities = await response.json();
        status.text(capabilities.openRouterSessionForwarding
            ? 'OpenRouter per-chat session forwarding is active.'
            : 'OpenRouter session IDs are generated, but server forwarding is not installed. See the README.');
        status.toggleClass('warning', !capabilities.openRouterSessionForwarding);
    } catch {
        status.text('Could not verify the Token Saver server integration.');
        status.addClass('warning');
    }
}

function getLastWarmTime(profileKey = getActiveProfileKey()) {
    return Math.max(lastActivity[profileKey] || 0, lastKeepalive[profileKey] || 0);
}

function isWarmPromptExpired(profileKey = getActiveProfileKey()) {
    const lastWarmTime = getLastWarmTime(profileKey);
    return lastWarmTime > 0 && (Date.now() - lastWarmTime) >= getTimeoutMs();
}

function disarmExpiredJob() {
    armed = false;
    jobRegistered = false;
    refreshRequested = false;
    lifecycleVersion++;
    clearTimeout(retryTimer);
    clearTimeout(refreshTimer);
    clearTimeout(generationRefreshTimer);
}

async function postKeepaliveBackend(path, body) {
    return fetch(`/api/plugins/token-saver/${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: keepaliveJobId, ...body }),
    });
}

async function stopBackendJob() {
    lifecycleVersion++;
    jobRegistered = false;
    clearTimeout(retryTimer);
    try {
        await postKeepaliveBackend('stop', {});
    } catch (error) {
        console.debug('[Keepalive] Could not stop backend job:', error);
    }
}

async function sendBackendHeartbeat() {
    if (temporaryConnectionDepth > 0 || !armed || !isKeepaliveEnabledForActive()) {
        return;
    }
    // Registration is normally created as soon as a response finishes. If that one-shot event
    // was missed (or registration failed), the regular heartbeat must self-heal instead of doing
    // nothing forever.
    if (!jobRegistered) {
        if (isWarmPromptExpired()) {
            disarmExpiredJob();
            return;
        }
        queueJobRefresh();
        return;
    }
    const version = lifecycleVersion;
    const profileKey = getActiveProfileKey();
    try {
        const response = await postKeepaliveBackend('heartbeat', {});
        const state = await response.json().catch(() => ({}));
        if (version !== lifecycleVersion) {
            return;
        }
        updateLastKeepalive(profileKey, state.lastRun);
        if (response.status === 404) {
            jobRegistered = false;
            if (isWarmPromptExpired(profileKey)) {
                disarmExpiredJob();
                return;
            }
            queueJobRefresh();
        }
    } catch (error) {
        console.debug('[Keepalive] Backend heartbeat failed:', error);
    }
}

/**
 * A new user message may lead to a main-chat request, but does not prove the provider accepted it.
 * Arm the feature and refresh only the replay payload; the deadline remains unchanged until the
 * request-success event arrives.
 */
function onMessageSent() {
    armed = true;
    queueJobRefresh();
}

/**
 * Opening or switching chats disarms keepalive: a freshly loaded chat is not proof its prompt is
 * still cached server-side, so we wait for a new message or foreground generation before running.
 */
function onChatChanged() {
    armed = false;
    activeMainRequest = null;
    clearTimeout(generationWatchdog);
    latestSuccessfulRequestStartedAt = 0;
    void stopBackendJob();
}

/**
 * Caps a prepared request to a single, non-streaming completion token.
 * @param {string} endpoint Backend generation endpoint.
 * @param {object} payload Prepared generation payload.
 * @returns {object} Cloned and capped payload.
 */
function capKeepalivePayload(endpoint, payload) {
    const capped = structuredClone(payload);
    capped.stream = false;
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_length', 'max_new_tokens', 'n_predict']) {
        if (Object.hasOwn(capped, key)) {
            capped[key] = KEEPALIVE_RESPONSE_LENGTH;
        }
    }
    if (endpoint === '/api/backends/chat-completions/generate'
        && !Object.hasOwn(capped, 'max_tokens')
        && !Object.hasOwn(capped, 'max_completion_tokens')) {
        capped.max_tokens = KEEPALIVE_RESPONSE_LENGTH;
    }
    if (Object.hasOwn(capped, 'n')) {
        capped.n = 1;
    }
    return capped;
}

/**
 * Gives the keepalive dry run the system-message squashing that SillyTavern applies only to live
 * requests. Registered as the first prompt-ready listener so later listeners see the squashed
 * prompt, exactly as they do for a live request.
 * @param {{chat: object[], dryRun: boolean}} eventData Assembled prompt, modified in place.
 */
function squashKeepalivePrompt(eventData) {
    if (!preparingJob || !eventData?.dryRun || !oai_settings.squash_system_messages || !Array.isArray(eventData.chat)) {
        return;
    }
    const separateContents = [
        oai_settings.new_chat_prompt,
        oai_settings.new_group_chat_prompt,
        oai_settings.new_example_chat_prompt,
        oai_settings.group_nudge_prompt,
    ].filter(Boolean).map(prompt => substituteParams(prompt));
    eventData.chat.splice(0, eventData.chat.length, ...squashSystemMessages(eventData.chat, separateContents));
}

/**
 * Dry-runs prompt assembly and returns a request the backend can replay later.
 * @returns {Promise<{endpoint: string, payload: object}>}
 */
async function prepareKeepaliveRequest() {
    const api = main_api;
    let capturedData = null;
    const captureData = (data, dryRun) => {
        if (dryRun && preparingJob) {
            capturedData = structuredClone(data);
        }
    };

    preparingJob = true;
    eventSource.on(event_types.GENERATE_AFTER_DATA, captureData);
    setExtensionPrompt(KEEPALIVE_INJECT_ID, extension_settings[MODULE].message, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
    try {
        // Dry runs skip the user's system-message squashing; squashKeepalivePrompt() applies it so
        // provider cache keys see the same prompt as a live request.
        await Generate('quiet', { quiet_prompt: '', force_name2: true }, true);
    } finally {
        setExtensionPrompt(KEEPALIVE_INJECT_ID, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, captureData);
        preparingJob = false;
    }

    if (!capturedData || api !== main_api) {
        throw new Error('Active connection changed while preparing the keepalive request');
    }

    let endpoint;
    let payload;
    if (api === 'openai') {
        endpoint = '/api/backends/chat-completions/generate';
        const model = getChatCompletionModel(oai_settings);
        ({ generate_data: payload } = await createGenerationParameters(oai_settings, model, 'quiet', capturedData.prompt));
        await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, payload);
    } else if (api === 'koboldhorde') {
        endpoint = '/api/horde/generate-text';
        const params = structuredClone(capturedData);
        const prompt = params.prompt;
        delete params.prompt;
        Object.assign(params, {
            n: 1,
            max_length: KEEPALIVE_RESPONSE_LENGTH,
            frmtadsnsp: false,
            frmtrmblln: false,
            frmtrmspch: false,
            frmttriminc: false,
        });
        payload = {
            prompt,
            params,
            trusted_workers: horde_settings.trusted_workers_only,
            models: horde_settings.models,
        };
    } else {
        endpoint = getGenerateUrl(api);
        payload = capturedData;
    }

    return { endpoint, payload: capKeepalivePayload(endpoint, payload) };
}

async function registerBackendJob() {
    if (temporaryConnectionDepth > 0) {
        refreshAfterTemporaryConnection = true;
        return;
    }
    if (!armed || !isKeepaliveEnabledForActive()) {
        await stopBackendJob();
        return;
    }
    const profileKey = getActiveProfileKey();
    if (!getLastWarmTime(profileKey)) {
        return;
    }
    if (isWarmPromptExpired(profileKey)) {
        disarmExpiredJob();
        return;
    }
    const version = lifecycleVersion;
    const hadRegisteredJob = jobRegistered;
    try {
        if (isGenerating()) {
            throw new Error('Waiting for the active generation to finish');
        }
        const request = await prepareKeepaliveRequest();
        if (version !== lifecycleVersion || !armed || !isKeepaliveEnabledForActive()) {
            return;
        }
        const timeoutMs = getTimeoutMs();
        const last = getLastWarmTime(profileKey) || Date.now();
        const remaining = timeoutMs - (Date.now() - last);
        if (remaining <= 0) {
            disarmExpiredJob();
            return;
        }
        const response = await postKeepaliveBackend('register', {
            ...request,
            intervalMs: timeoutMs,
            delayMs: remaining,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        if (version !== lifecycleVersion || !armed || !isKeepaliveEnabledForActive()) {
            await stopBackendJob();
            return;
        }
        clearTimeout(retryTimer);
        jobRegistered = true;
    } catch (error) {
        // A failed payload refresh does not mean the existing backend job disappeared. Keeping
        // this state is especially important while a foreground request is starting, because its
        // lifecycle handler still needs to pause that existing job before provider dispatch.
        jobRegistered = hadRegisteredJob;
        console.debug('[Keepalive] Could not register backend job:', error);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(queueJobRefresh, RETRY_INTERVAL_MS);
    }
}

function queueJobRefresh() {
    refreshRequested = true;
    if (refreshPromise) {
        return;
    }
    refreshPromise = (async () => {
        while (refreshRequested) {
            refreshRequested = false;
            await registerBackendJob();
        }
    })().finally(() => {
        refreshPromise = null;
    });
}

function scheduleJobRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(queueJobRefresh, SETTINGS_REFRESH_DELAY_MS);
}

function scheduleGenerationJobRefresh() {
    clearTimeout(generationRefreshTimer);
    generationRefreshTimer = setTimeout(() => {
        if (armed && isKeepaliveEnabledForActive()) {
            queueJobRefresh();
        }
    }, SETTINGS_REFRESH_DELAY_MS);
}

function setupHeartbeatLoop() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => void sendBackendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void sendBackendHeartbeat();
        }
    });
}

/**
 * Renders the per-profile enable checkboxes from the current Connection Manager profiles.
 */
function renderProfileToggles() {
    const container = $('#keepalive_profiles_list');
    if (!container.length) {
        return;
    }
    container.empty();

    const profiles = extension_settings.connectionManager?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        container.append(
            $('<small>')
                .attr('data-i18n', 'ext_keepalive_no_profiles')
                .text('No connection profiles found. Keepalive uses the active model, governed by the master toggle above.'),
        );
        return;
    }

    const perProfile = extension_settings[MODULE].profiles || {};
    const sorted = profiles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const profile of sorted) {
        const enabled = perProfile[profile.id] === undefined ? true : !!perProfile[profile.id];
        const label = $('<label>').addClass('checkbox_label');
        const input = $('<input>')
            .attr('type', 'checkbox')
            .addClass('keepalive_profile_toggle')
            .attr('data-profile-id', profile.id)
            .prop('checked', enabled);
        const span = $('<span>').text(profile.name);
        label.append(input, span);
        container.append(label);
    }
}

/**
 * Loads settings into the global store and hydrates the UI controls.
 */
function loadSettings() {
    if (extension_settings[MODULE] === undefined && extension_settings[LEGACY_MODULE] !== undefined) {
        extension_settings[MODULE] = structuredClone(extension_settings[LEGACY_MODULE]);
        saveSettingsDebounced();
    }
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = {};
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = structuredClone(defaultSettings[key]);
        }
    }

    // Guard against a corrupted/legacy value for the per-profile map.
    if (typeof extension_settings[MODULE].profiles !== 'object' || extension_settings[MODULE].profiles === null) {
        extension_settings[MODULE].profiles = {};
    }

    // Migrate the original default message to the current default so installs that never
    // customized it pick up the improved wording (custom messages are left untouched).
    if (extension_settings[MODULE].message === LEGACY_DEFAULT_MESSAGE) {
        extension_settings[MODULE].message = defaultSettings.message;
        saveSettingsDebounced();
    }

    $('#keepalive_enabled').prop('checked', extension_settings[MODULE].enabled);
    $('#keepalive_openrouter_session_ids').prop('checked', extension_settings[MODULE].openRouterSessionIds);
    $('#keepalive_timeout').val(extension_settings[MODULE].timeoutSeconds);
    $('#keepalive_message').val(extension_settings[MODULE].message);
    renderProfileToggles();
}

/**
 * Wires up the settings UI control handlers.
 */
function setupListeners() {
    $('#keepalive_openrouter_session_ids').on('change', function () {
        extension_settings[MODULE].openRouterSessionIds = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#keepalive_enabled').on('change', function () {
        extension_settings[MODULE].enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (extension_settings[MODULE].enabled && armed) {
            queueJobRefresh();
        } else {
            void stopBackendJob();
        }
    });

    $('#keepalive_timeout').on('input', function () {
        extension_settings[MODULE].timeoutSeconds = Number($(this).val()) || 295;
        saveSettingsDebounced();
        if (armed && isKeepaliveEnabledForActive()) {
            scheduleJobRefresh();
        }
    });

    $('#keepalive_message').on('input', function () {
        extension_settings[MODULE].message = String($(this).val());
        saveSettingsDebounced();
        if (armed && isKeepaliveEnabledForActive()) {
            scheduleJobRefresh();
        }
    });

    // Per-profile toggles are rendered dynamically; use a delegated handler.
    $('#keepalive_profiles_list').on('change', '.keepalive_profile_toggle', function () {
        const profileId = $(this).attr('data-profile-id');
        if (!profileId) {
            return;
        }
        extension_settings[MODULE].profiles[profileId] = !!$(this).prop('checked');
        saveSettingsDebounced();
        // If the toggled profile is the one currently active, update its backend job immediately.
        if (profileId === extension_settings.connectionManager?.selectedProfile) {
            if (isKeepaliveEnabledForActive() && armed) {
                queueJobRefresh();
            } else {
                void stopBackendJob();
            }
        }
    });
}

async function pauseBackendJob() {
    if (!jobRegistered) {
        return;
    }
    try {
        const response = await postKeepaliveBackend('pause', {});
        if (response.status === 404) {
            jobRegistered = false;
        }
    } catch (error) {
        console.debug('[Keepalive] Could not pause backend job:', error);
    }
}

async function resumeBackendJob(activityStartedAt = null) {
    if (!jobRegistered) {
        return;
    }
    const elapsedMs = Number.isFinite(activityStartedAt)
        ? Math.max(0, Date.now() - activityStartedAt)
        : null;
    const profileKey = getActiveProfileKey();
    try {
        const response = await postKeepaliveBackend('resume', {
            activityElapsedMs: elapsedMs,
        });
        const state = await response.json().catch(() => ({}));
        updateLastKeepalive(profileKey, state.lastRun);
        if (response.status === 404) {
            jobRegistered = false;
        }
    } catch (error) {
        console.debug('[Keepalive] Could not resume backend job:', error);
    }
}

async function onGenerationStarted(type, _params, dryRun) {
    if (temporaryConnectionDepth > 0 || dryRun || !MAIN_CHAT_GENERATION_TYPES.has(type)) {
        return;
    }
    if (activeMainRequest) {
        await finishForegroundRequest(false);
    }
    armed = true;
    activeMainRequest = {
        profileKey: getActiveProfileKey(),
        startedAt: Date.now(),
        type,
    };
    await pauseBackendJob();
    clearTimeout(generationWatchdog);
    generationWatchdog = setTimeout(() => {
        if (activeMainRequest && !isGenerating()) {
            void finishForegroundRequest(false);
        }
    }, 120000);
}

async function finishForegroundRequest(success) {
    const activeRequest = activeMainRequest;
    if (!activeRequest) {
        return;
    }
    activeMainRequest = null;
    clearTimeout(generationWatchdog);

    if (success) {
        const startedAt = activeRequest.startedAt;
        lastActivity[activeRequest.profileKey] = Math.max(lastActivity[activeRequest.profileKey] || 0, startedAt);
        latestSuccessfulRequestStartedAt = Math.max(latestSuccessfulRequestStartedAt, startedAt);
        armed = true;
    }

    const successfulStartedAt = latestSuccessfulRequestStartedAt || null;
    latestSuccessfulRequestStartedAt = 0;
    await resumeBackendJob(successfulStartedAt);

    // A failed request may still have changed local chat content, so refresh the replay payload,
    // but registerBackendJob() will retain the old deadline. A successful request supplies the
    // verified activity timestamp used for the new deadline.
    scheduleGenerationJobRefresh();
}

function onMessageReceived(_chatId, type) {
    if (activeMainRequest && (!type || MAIN_CHAT_GENERATION_TYPES.has(type))) {
        void finishForegroundRequest(true);
    }
}

function onChatContentChanged() {
    // Editing, deleting, or swiping local chat content does not contact the text provider and
    // therefore cannot refresh its prompt cache. Rebuild the replay payload, but preserve the
    // deadline from the last real text generation/keepalive. This also keeps image-message edits
    // and gallery activity from postponing text keepalives.
    if (armed && isKeepaliveEnabledForActive()) {
        queueJobRefresh();
    }
}

async function onConnectionChanged() {
    if (temporaryConnectionDepth > 0) {
        return;
    }
    // Remove the previous connection's request before assembling one with the new settings.
    await stopBackendJob();
    if (armed && isKeepaliveEnabledForActive()) {
        queueJobRefresh();
    }
}

function onTemporaryConnectionStarted() {
    temporaryConnectionDepth++;
}

function onTemporaryConnectionEnded() {
    temporaryConnectionDepth = Math.max(0, temporaryConnectionDepth - 1);
    if (temporaryConnectionDepth === 0 && refreshAfterTemporaryConnection) {
        refreshAfterTemporaryConnection = false;
        queueJobRefresh();
    }
}

async function init() {
    const settingsHtml = await renderExtensionTemplateAsync(`third-party/${MODULE}`, 'settings');
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    setupListeners();
    setupHeartbeatLoop();

    // A user message arms keepalive, but only the exact provider-request lifecycle below is allowed
    // to move its deadline. Regenerate/swipe/continue requests arm it when their request starts.
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);

    // Only actual text-provider generations reset the cache deadline. Local chat edits still
    // refresh the stored request so the server replays the latest prompt without pretending that
    // those edits refreshed the provider cache.
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.makeFirst(event_types.CHAT_COMPLETION_PROMPT_READY, squashKeepalivePrompt);
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, addOpenRouterSessionId);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, () => void finishForegroundRequest(false));
    eventSource.on(event_types.MESSAGE_EDITED, onChatContentChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onChatContentChanged);
    eventSource.on(event_types.MESSAGE_UPDATED, onChatContentChanged);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatContentChanged);

    // Opening/switching a chat disarms keepalive — it must be re-armed by a new sent message.
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // When the active profile changes, replace the backend job without marking it as activity.
    // Temporary profile switches used by background image-prompt generation are explicitly ignored.
    eventSource.on(TEMPORARY_CONNECTION_STARTED, onTemporaryConnectionStarted);
    eventSource.on(TEMPORARY_CONNECTION_ENDED, onTemporaryConnectionEnded);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, onConnectionChanged);
    eventSource.on(event_types.MAIN_API_CHANGED, onConnectionChanged);
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, onConnectionChanged);
    eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, onConnectionChanged);
    eventSource.on(event_types.PRESET_CHANGED, onConnectionChanged);

    // Keep the per-profile toggle list in sync with Connection Manager.
    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, renderProfileToggles);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, renderProfileToggles);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, renderProfileToggles);

    void updateOpenRouterIntegrationStatus();
}
