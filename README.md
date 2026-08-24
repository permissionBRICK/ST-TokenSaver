# ST-TokenSaver

Pins each OpenRouter chat to a stable session, enables a server-timed one-token keepalive roughly every five minutes, and documents SillyTavern's Anthropic prompt-cache settings so all three cost-saving layers work together.

After a successful chat generation, the UI extension prepares a hidden depth-0 user-message request with the same chat context. A small SillyTavern server plugin owns the timer, so background-tab throttling does not make the request late. The browser renews a five-minute lease; closing the tab naturally retires its job.

For OpenRouter, the UI also hashes SillyTavern's local chat ID into a stable `session_id`. This avoids exposing a chat filename while letting OpenRouter keep that conversation on the same provider endpoint from its first successful request. SillyTavern 1.18 does not forward this field, so the repository includes a minimal, auditable one-block server integration.

## Install

This single repository is intentionally installed in both supported SillyTavern locations.

1. In **Extensions → Install extension**, install:

   ```text
   https://github.com/permissionBRICK/ST-TokenSaver
   ```

2. Enable server plugins and Anthropic prompt caching in `config.yaml`:

   ```yaml
   enableServerPlugins: true

   claude:
     enableSystemPromptCache: true
     cachingAtDepth: 0
     extendedTTL: false
   ```

   These cache settings are built into SillyTavern and apply to direct Anthropic requests and supported Claude models through OpenRouter. `extendedTTL: false` uses the five-minute cache; set it to `true` only when the one-hour cache's higher write price fits your usage.

3. From the SillyTavern directory, install the same repository as a server plugin and restart:

   ```bash
   node plugins.js install https://github.com/permissionBRICK/ST-TokenSaver
   ```

4. Install the OpenRouter forwarding integration from the SillyTavern directory, then restart:

   ```bash
   node plugins/ST-TokenSaver/scripts/openrouter-session-integration.mjs apply .
   node plugins/ST-TokenSaver/scripts/openrouter-session-integration.mjs check .
   ```

   The installer is idempotent, refuses unknown source layouts, and writes a `.token-saver.bak` backup. A SillyTavern update can replace the integration, so rerun `check` afterward. To remove it, use `revert` instead of `apply`.

   For immutable Docker installs, build the included minimal derivative instead of editing a running container:

   ```bash
   docker build -f plugins/ST-TokenSaver/Dockerfile.integration \
     -t sillytavern-token-saver:1.18.0 plugins/ST-TokenSaver
   ```

5. Enable **Token Saver** in extension settings. Leave **Pin each OpenRouter chat** enabled and use a 295-second interval for the default five-minute cache. Every connection profile defaults to keepalive on; use the per-profile selector only to opt out when you know a profile cannot benefit or you do not want its extra one-token requests.

Requires SillyTavern 1.18.0+. Server plugins are trusted code with filesystem access; review `server/index.mjs` before enabling it.

## Short OpenRouter cost recipe

Set `claude.enableSystemPromptCache: true`, `claude.cachingAtDepth: 0`, and `claude.extendedTTL: false`; install/check the bundled OpenRouter session integration; then enable 295-second keepalives (profiles default to on). Avoid a manual OpenRouter `provider.order` when you want sticky routing, because explicit provider ordering takes precedence over session stickiness.

OpenRouter does not provide a dependable profile-level yes/no signal for this toggle: cache behavior and lifetime can vary by the endpoint ultimately selected by the router. Token Saver therefore does not guess from model metadata.

## Safety and cost behavior

- Completions are non-streaming and capped to one token.
- OpenRouter session IDs are deterministic hashes of local chat IDs, never chat names or contents.
- Jobs are user- and tab-scoped, pause during foreground inference, and are removed when the browser lease expires.
- Opening a chat alone never arms a keepalive; a real chat generation must occur first.
- No API keys or secrets are stored. The server replays the authenticated request only to SillyTavern’s own loopback endpoint.
- The integration supplies a sticky-session key but does not force a named provider; OpenRouter can still fail over when its sticky provider is unavailable.

The exact savings depend on provider cache pricing, context size, and whether requests remain cache-compatible; “90%” is possible for large cached prompts but is not guaranteed.

## Development

```bash
npm install
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
