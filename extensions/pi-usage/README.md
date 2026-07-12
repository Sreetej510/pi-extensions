# @sreetej510/pi-usage

A [pi](https://github.com/earendil-works/pi) coding agent extension that reports provider
usage / rate-limit budgets — OpenAI Codex, Anthropic OAuth, and pi-auth-backed providers — via
`/usage`, with an optional live statusline widget.

## What it does

- Queries the active model's provider usage endpoint (Codex app-server usage/rate-limit-reset
  APIs, or Anthropic's OAuth usage API) and renders remaining budget/reset windows.
- Caches results on disk (`~/.pi/agent/usage-cache.json`) for a few minutes so multiple
  concurrent pi sessions don't hammer the provider APIs.
- Can push a compact usage summary into the statusline, refreshed automatically with retry/backoff
  on rate limits (`429`).
- Supports listing and consuming Codex "banked" rate-limit resets.

## Commands

| Command | Effect |
|---|---|
| `/usage` | Show cached usage (fetches fresh data if the cache is stale) |
| `/usage --refresh` | Force a fresh fetch, bypassing the cache |
| `/usage --no-statusline` | Don't update the statusline widget |
| `/usage --clear-statusline` | Clear the usage statusline widget |
| `/usage --timeout <seconds>` | Set the query timeout |
| `/usage --raw` | Show raw usage API responses (debugging) |
| `/usage --list-banked-resets` | List available Codex banked resets and expiry dates |
| `/usage --consume-banked-reset <id>` | Consume a specific Codex banked reset |

## Install

```bash
npm install -g @sreetej510/pi-usage
```

Then add it to your pi `settings.json`:

```json
{
  "packages": ["npm:@sreetej510/pi-usage"]
}
```

Or, for local development, point at the file directly:

```json
{
  "extensions": ["/absolute/path/to/pi-extensions/extensions/pi-usage/src/index.ts"]
}
```

## File layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry point + session event wiring |
| `src/command.ts` | `/usage` command handler |
| `src/statusline.ts` | Statusline state, timers, background refresh |
| `src/footer.ts` | Custom footer with right-aligned usage status |
| `src/query.ts` | Top-level usage query orchestration |
| `src/codex-query.ts` | Codex pi-auth + app-server fallback queries |
| `src/anthropic-query.ts` | Anthropic OAuth usage queries |
| `src/codex-auth.ts` | Codex auth header resolution |
| `src/anthropic-auth.ts` | Anthropic auth header resolution |
| `src/codex-app-server.ts` | `codex app-server` RPC client |
| `src/codex-reset-credits.ts` | Banked reset list/consume/format |
| `src/normalize-codex.ts` | Codex backend + app-server payload normalization |
| `src/normalize-anthropic.ts` | Anthropic usage payload normalization |
| `src/format.ts` | Report/statusline formatting and display |
| `src/shared-cache.ts` | On-disk shared usage cache |
| `src/models.ts` | Provider/model matching helpers |
| `src/args.ts` | `/usage` argument parsing and completions |
| `src/constants.ts` | Shared constants |
| `src/types.ts` | Shared TypeScript types |
| `src/utils.ts` | Small parsing/formatting helpers |
| `src/errors.ts` | HTTP/rate-limit error helpers |
| `src/http.ts` | `fetchWithTimeout` wrapper |

## Development

```bash
npm install
npm run --workspace @sreetej510/pi-usage check     # biome + typecheck
npm run --workspace @sreetej510/pi-usage format
```
