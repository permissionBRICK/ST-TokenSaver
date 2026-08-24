# ST-TokenSaver

Keeps provider-side prompt caches warm for inactive SillyTavern tabs with a one-token completion roughly every five minutes.

After a successful chat generation, the UI extension prepares a hidden depth-0 user-message request with the same chat context. A small SillyTavern server plugin owns the timer, so background-tab throttling does not make the request late. The browser renews a five-minute lease; closing the tab naturally retires its job.

## Install

This single repository is intentionally installed in both supported SillyTavern locations.

1. In **Extensions → Install extension**, install:

   ```text
   https://github.com/permissionBRICK/ST-TokenSaver
   ```

2. Enable server plugins in `config.yaml`:

   ```yaml
   enableServerPlugins: true
   ```

3. From the SillyTavern directory, install the same repository as a server plugin and restart:

   ```bash
   node plugins.js install https://github.com/permissionBRICK/ST-TokenSaver
   ```

4. Enable **Token Saver** in extension settings. The default interval is 295 seconds; profiles can be enabled individually.

Requires SillyTavern 1.18.0+. Server plugins are trusted code with filesystem access; review `server/index.mjs` before enabling it.

## Safety and cost behavior

- Completions are non-streaming and capped to one token.
- Jobs are user- and tab-scoped, pause during foreground inference, and are removed when the browser lease expires.
- Opening a chat alone never arms a keepalive; a real chat generation must occur first.
- No API keys or secrets are stored. The server replays the authenticated request only to SillyTavern’s own loopback endpoint.
- This extension does not override provider selection. OpenRouter provider affinity remains governed by SillyTavern/OpenRouter settings.

The exact savings depend on provider cache pricing, context size, and whether requests remain cache-compatible; “90%” is possible for large cached prompts but is not guaranteed.

## Development

```bash
npm install
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
