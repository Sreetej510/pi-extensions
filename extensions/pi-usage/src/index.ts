/**
 * Pi Usage Extension
 *
 * Reports provider usage and rate-limit budgets for OpenAI Codex and Anthropic
 * OAuth subscriptions via /usage, with an optional statusline widget and custom
 * footer that right-aligns usage status.
 *
 * File layout:
 *   index.ts              extension entry point (this file) — commands + lifecycle events
 *   constants.ts          command name, URLs, timeouts, cache paths, UI constants
 *   types.ts              shared TypeScript types (public types exported)
 *   args.ts               /usage argument completions and parsing
 *   utils.ts              small helpers (asString, parseJsonObject, delay, etc.)
 *   errors.ts             UsageEndpointError, stale-context detection, rate-limit backoff
 *   http.ts               fetchWithTimeout
 *   models.ts             provider/model matching and auth candidate enumeration
 *   shared-cache.ts       on-disk shared usage cache read/write across pi sessions
 *   codex-auth.ts         resolve Pi Codex auth headers (+ WHAM + account id)
 *   codex-reset-credits.ts fetch/consume/format Codex banked resets
 *   codex-app-server.ts   CodexAppServerClient + queryViaCodexAppServer fallback
 *   normalize-codex.ts    normalize backend + app-server Codex rate-limit payloads
 *   normalize-anthropic.ts normalize Anthropic OAuth usage payloads
 *   codex-query.ts        queryViaPiAuth + queryCodexUsageWithFallback
 *   anthropic-auth.ts     resolve Pi Anthropic OAuth auth headers
 *   anthropic-query.ts    queryAnthropicUsage + fetchRawUsagePayloads (--raw)
 *   query.ts              queryUsage, queryAllUsage, queryUsageWithRetries
 *   format.ts             usage report/statusline formatting and display notifications
 *   footer.ts             custom footer with right-aligned usage status
 *   statusline.ts         statusline state, timers, and background refresh
 *   command.ts            /usage command handler
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerUsageCommand } from "./command.js";
import { installUsageFooter, isFooterRegistered, setFooterRegistered } from "./footer.js";
import { isUsageSupportedModel } from "./models.js";
import {
  clearUsageStatusline,
  handleStaleContextError,
  refreshCurrentUsageStatusline,
  rethrowUnlessStaleContextError,
  setSessionActive,
} from "./statusline.js";

export { completeCodexStatusArguments, parseArgs } from "./args.js";
export { isStaleExtensionContextError } from "./errors.js";
export { formatCodexUsageReport, formatCodexUsageStatusline } from "./format.js";
export { normalizeAppServerResponse, normalizeBackendPayload } from "./normalize-codex.js";
export type {
  AnthropicUsageReport,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
  ProviderUsageModel,
} from "./types.js";

export default function usageExtension(pi: ExtensionAPI) {
  registerUsageCommand(pi);

  const ensureUsageFooter = (ctx: ExtensionContext) => {
    if (isFooterRegistered() || !ctx.hasUI) return;
    try {
      installUsageFooter(pi, ctx);
      setFooterRegistered(true);
    } catch (error) {
      if (!handleStaleContextError(ctx, error)) throw error;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    setSessionActive(true);
    ensureUsageFooter(ctx);
    if (isUsageSupportedModel(ctx.model)) {
      void refreshCurrentUsageStatusline(ctx, ctx.model).catch(rethrowUnlessStaleContextError(ctx));
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isUsageSupportedModel(ctx.model)) {
      void refreshCurrentUsageStatusline(ctx, ctx.model).catch(rethrowUnlessStaleContextError(ctx));
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("model_select", (event, ctx) => {
    if (isUsageSupportedModel(event.model)) {
      void refreshCurrentUsageStatusline(ctx, event.model).catch(rethrowUnlessStaleContextError(ctx));
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    setSessionActive(false);
    clearUsageStatusline(ctx);
  });
}
