# ST-TokenSaver

Pins each OpenRouter chat to a stable session, enables a server-timed one-token keepalive roughly every five minutes, and documents SillyTavern's Anthropic prompt-cache settings so all three cost-saving layers work together.

The backend keeps a timer after every successful chat, and if no new message has been sent after the interval, it automatically sends a request to the API capped at max 1 token, just enough to refresh the cache timer for the price of your input tokens at reduced cache prices, plus 1 output token, meaning you only pay 10% on your next message instead of the full input token price.

For OpenRouter, the UI also hashes SillyTavern's local chat ID into a stable `session_id`. This avoids exposing a chat filename while letting OpenRouter keep that conversation on the same provider endpoint from its first successful request. SillyTavern 1.18 does not forward this field, so the server plugin automatically installs a minimal, auditable one-block integration at startup.

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

   These cache settings are built into SillyTavern and apply to direct Anthropic requests and supported Claude models through OpenRouter. The point is to enable input token caching at all (most of all providers have it enabled by default).

3. From the SillyTavern directory, install the same repository as a server plugin and restart:

   ```bash
   node plugins.js install https://github.com/permissionBRICK/ST-TokenSaver
   ```

4. For Docker, the server plugin checks and installs OpenRouter session forwarding automatically. SillyTavern imports its backend routes before plugins, so the first container startup after installation or an upstream overwrite exits once with code 75; the container's normal restart policy immediately starts it again with the integration active. No custom Docker image is required.

   For a non-Docker install, run the explicit `apply` command before starting SillyTavern. The same script provides `check` and `revert` commands for auditing and recovery:

   ```bash
   node plugins/ST-TokenSaver/scripts/openrouter-session-integration.mjs apply .
   node plugins/ST-TokenSaver/scripts/openrouter-session-integration.mjs check .
   ```

   The installer is idempotent, refuses unknown source layouts, writes atomically, and keeps a `.token-saver.bak` backup. Set `TOKEN_SAVER_AUTO_PATCH=false` to disable Docker automatic installation or `TOKEN_SAVER_AUTO_RESTART=false` to require a manual Docker restart.

5. Enable **Token Saver** in extension settings. Leave **Pin each OpenRouter chat** enabled and use a 280-second interval for the default five-minute cache. Every connection profile defaults to keepalive on; use the per-profile selector only to opt out when you know a profile cannot benefit or you do not want its extra one-token requests.

Requires SillyTavern 1.18.0+.

## How this actually saves you money

If you usually reply at least once every five minutes in every thread, the keepalive does nothing and costs nothing. If you sometimes wait longer than five minutes between messages for some chats (if you have several open at once), your first message would have to re-load the input without cache, and you'd pay full price. In this case, the extension would send an empty request just before expiry, costing only 10% of that full price, and your actual message some minutes later would then also only cost 10%, meaning you saved up to 80% in cost for that initial request after the pause.

Just mathematically, as long as your pauses are between 5 and 40 minutes, this plugin still saves you money compared to just paying the full fee. between 40 and 60 (if consistent), you'd likly be cheaper off with the long-cache option where input tokens cost twice as much. Above 60 min, you're definitely cheaper off by just letting it decay and then paying full price.

If you want to optimize, try to find the sweetspot you can set the keepalive at just below 300, that still makes openrouter show the cached input tokens in the logs with every request using anthropic (some of the most aggressive ones in terms of cache, also the most expensive). Usually, somewhere between 270-290 works consistently for me.

Aside from that, if you are using Models that have more than one provider, the session id pinning helps in avoiding cache misses by in theory stopping openrouter from randomly switching providers mid-session (independantly of how often you send messages), so this alone also helps reduce costs there.

## Development

```bash
npm install
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
