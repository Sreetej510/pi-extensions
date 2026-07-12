import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandArgumentCompletion } from "./types.js";

export const COMMAND_NAME = "usage";
export const CODEX_PROVIDER_ID = "openai-codex";
export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CODEX_CONSUME_RESET_CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
export const CODEX_OPENAI_BETA = "codex-1";
export const ANTHROPIC_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const CACHE_TTL_MS = 3 * 60 * 1000;
export const STATUSLINE_RETRY_ATTEMPTS = 3;
export const STATUSLINE_RETRY_DELAY_MS = 1_000;
/** Default backoff after a 429 when the server doesn't say when to retry. */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
/** Bounds for server-provided Retry-After values. */
export const RATE_LIMIT_BACKOFF_MIN_MS = 30 * 1000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Shared on-disk usage cache so concurrent pi sessions don't each hit the APIs. */
export const SHARED_CACHE_FILE = join(homedir(), ".pi", "agent", "usage-cache.json");
export const SHARED_CACHE_VERSION = 1;
export const STATUS_KEY = "provider-usage";
export const BAR_SEGMENTS = 20;
export const LIMIT_VALUE_COLUMN = 29;
export const MAX_ERROR_BODY_CHARS = 600;
export const RESET_FOREGROUND = "\x1b[39m";
/** Payload keys that are not enterprise budget windows. Everything else that
 * looks like a `{ used_dollars, limit_dollars }` object is treated as one —
 * Anthropic uses rotating codenames (cinder_cove, amber_ladder, …) so we
 * detect windows by shape instead of a hardcoded key list. */
export const ANTHROPIC_NON_WINDOW_KEYS = new Set(["five_hour", "seven_day", "extra_usage"]);

export const COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "--refresh", label: "--refresh", description: "Refresh usage instead of cached data" },
	{ value: "--no-statusline", label: "--no-statusline", description: "Do not update the statusline" },
	{
		value: "--clear-statusline",
		label: "--clear-statusline",
		description: "Clear the usage statusline",
	},
	{ value: "--timeout ", label: "--timeout", description: "Set query timeout in seconds" },
	{ value: "--raw", label: "--raw", description: "Show raw usage API responses (for debugging)" },
	{
		value: "--list-banked-resets",
		label: "--list-banked-resets",
		description: "List available Codex banked resets and expiry dates",
	},
	{
		value: "--consume-banked-reset ",
		label: "--consume-banked-reset",
		description: "Consume a Codex banked reset by id",
	},
];
