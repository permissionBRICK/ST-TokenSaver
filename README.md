# ST-TokenSaver

Pins each OpenRouter chat to a stable session, enables a server-timed minimal keepalive roughly every five minutes, and documents SillyTavern's Anthropic prompt-cache settings so all three cost-saving layers work together.

The backend keeps a timer after every successful chat, and if no new message has been sent after the interval, it automatically sends a request to the API capped at 16 output tokens (the smallest limit every chat-completion provider accepts; text-completion backends get 1), just enough to refresh the cache timer for the price of your input tokens at reduced cache prices, plus a few output tokens, meaning you only pay 10% on your next message instead of the full input token price.

For OpenRouter, the UI also hashes SillyTavern's local chat ID into a stable `session_id`. This avoids exposing a chat filename while letting OpenRouter keep that conversation on the same provider endpoint from its first successful request. The same value goes out as `prompt_cache_key`, which providers with OpenAI-style caching use to send the chat to the same cache. SillyTavern does not forward either field, so the server plugin automatically installs a minimal, auditable one-block integration at startup (and upgrades the session-only block of earlier releases).

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

5. Enable **Token Saver** in extension settings. Leave **Pin each OpenRouter chat** enabled and use a 280-second interval for the default five-minute cache (Gemini models use their own schedule, see below). Keep the keepalive message at its one-character default (see the Gemini note below). Every connection profile defaults to keepalive on; use the per-profile selector only to opt out when you know a profile cannot benefit or you do not want its extra keepalive requests.

Requires SillyTavern 1.18.0+.

## How this actually saves you money

If you usually reply at least once every five minutes in every thread, the keepalive does nothing and costs nothing. If you sometimes wait longer than five minutes between messages for some chats (if you have several open at once), your first message would have to re-load the input without cache, and you'd pay full price. In this case, the extension would send an empty request just before expiry, costing only 10% of that full price, and your actual message some minutes later would then also only cost 10%, meaning you saved up to 80% in cost for that initial request after the pause.

Just mathematically, as long as your pauses are between 5 and 40 minutes, this plugin still saves you money compared to just paying the full fee. between 40 and 60 (if consistent), you'd likly be cheaper off with the long-cache option where input tokens cost twice as much. Above 60 min, you're definitely cheaper off by just letting it decay and then paying full price.

If you want to optimize, try to find the sweetspot you can set the keepalive at just below 300, that still makes openrouter show the cached input tokens in the logs with every request using anthropic (some of the most aggressive ones in terms of cache, also the most expensive). Usually, somewhere between 270-290 works consistently for me.

Aside from that, if you are using Models that have more than one provider, the session id pinning helps in avoiding cache misses by in theory stopping openrouter from randomly switching providers mid-session (independantly of how often you send messages), so this alone also helps reduce costs there.

### When keepalive stops by itself

Some providers drop a chat's cache no matter how often it is refreshed, and a keepalive that misses costs the full input price. When two keepalives without a message in between read less than half of their prompt from cache, Token Saver stops for that chat until your next message, regenerate, swipe or continue. Providers that cache reliably never get there, and providers that do not cache at all stop after two requests. This needs cache figures in the response, which SillyTavern passes on for OpenRouter and other OpenAI-compatible backends; direct Claude and Gemini connections keep the plain timer.

## Provider notes

Measured through OpenRouter in October 2026:

- **Gemini** caches implicitly; no SillyTavern cache setting is needed. OpenRouter moves *every* system message into Gemini's system instruction, so a system message that changes each turn after the chat history (Author's Note, an at-depth lorebook entry, an extension injection) moves the start of the prompt and every request misses. Set **Prompt Post-Processing** to **Semi-strict** in Gemini connection profiles. Mid-chat system messages are then sent as user messages, stay where they were placed, and the shared prefix caches (about 90% of a 23k-token prompt).
- **Gemini 4 Argon on Vertex** (OpenRouter's `Google` provider) keeps cache entries for a load-dependent time, not a fixed five minutes. In 30-minute test chats some entries outlived 15 minutes without a refresh and others were gone after 90 seconds; some chats missed on every keepalive while others hit on every one, which is what the automatic stop is for. A cache read covers an earlier request's prompt except its last 2049 tokens, and only a later prompt at least as long as that request can use it. With a 20-token keepalive message, a shorter reply read only the system prompt, so the default message is a single `.`. Every Argon keepalive still pays full price for those 2049 tokens, about $0.004. Intervals from 240 to 420 seconds refreshed about equally well; at 600 seconds fewer keepalives hit. A fresh entry is read back reliably for about a minute (about 86% of first reads within 60 seconds, 50 to 60% after 90 seconds or more), but an entry that was read again lasts more than seven minutes. Gemini models therefore get their own schedule: a keepalive 45 seconds after each message, then one every 420 seconds. With it, 19 of 20 keepalives and all 8 next messages after 10- and 20-minute pauses hit, and a 24k-token chat paid 20 to 45% less than without keepalive. The plain 280-second schedule missed about a third of its keepalives at full price and cost more than no keepalive. With the 2049-token floor, keepalive only pays off for chats above about 10k tokens. `google-vertex/us` cached no better than `global` and costs 10% more, and OpenRouter ignores `cache_control` breakpoints for Argon, so explicit caching is not an alternative.
- **Meta Muse** caches automatically too, but only reliably with `prompt_cache_key`: identical replays hit about 30% of the time without it and every time with it. It also rejects `max_tokens` below 16, which is why chat-completion keepalives request 16 tokens.

## Development

```bash
npm install
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
