import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CACHE_TTL_MS, DEFAULT_TIMEOUT_MS, STATUS_KEY } from "./constants.js";
import { isRateLimitErrorMessage, isStaleExtensionContextError, rateLimitBackoffMs } from "./errors.js";
import { formatUsageStatusline } from "./format.js";
import { isUsageSupportedModel, providerKeyForModel, reportMatchesModel } from "./models.js";
import { queryUsageWithRetries } from "./query.js";
import {
  readSharedUsageCache,
  saveSharedBackoff,
  saveSharedUsageReport,
  sharedBackoffRemainingMs,
} from "./shared-cache.js";
import type { CachedReport, ProviderUsageModel, UsageReport } from "./types.js";
import { formatAgeShort } from "./utils.js";

let cache: CachedReport | undefined;
let combinedCache: { createdAt: number; reports: UsageReport[] } | undefined;
let statuslineClearTimer: ReturnType<typeof setTimeout> | undefined;
let statuslineRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let statuslineRequestId = 0;
let sessionActive = false;
let activeStatuslineContext: ExtensionContext | undefined;

export function isSessionActive(): boolean {
  return sessionActive;
}

export function setSessionActive(value: boolean): void {
  sessionActive = value;
}

export function getCombinedCache(): { createdAt: number; reports: UsageReport[] } | undefined {
  return combinedCache;
}

export function setCombinedCache(value: { createdAt: number; reports: UsageReport[] } | undefined): void {
  combinedCache = value;
}

export function clearCodexMemoryCache(): void {
  cache = undefined;
}

const clearStatuslineTimers = () => {
  if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
  if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
  statuslineClearTimer = undefined;
  statuslineRefreshTimer = undefined;
};

export function handleStaleContextError(ctx: ExtensionContext, error: unknown): boolean {
  if (!isStaleExtensionContextError(error)) return false;
  if (ctx === activeStatuslineContext) {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    activeStatuslineContext = undefined;
  }
  return true;
}

export const rethrowUnlessStaleContextError = (ctx: ExtensionContext) => (error: unknown) => {
  if (!handleStaleContextError(ctx, error)) throw error;
};

const setStatuslineValue = (ctx: ExtensionContext, value: string | undefined): boolean => {
  try {
    ctx.ui.setStatus(STATUS_KEY, value);
    return true;
  } catch (error) {
    if (handleStaleContextError(ctx, error)) return false;
    throw error;
  }
};

export function clearUsageStatusline(ctx: ExtensionContext) {
  statuslineRequestId += 1;
  clearStatuslineTimers();
  activeStatuslineContext = undefined;
  setStatuslineValue(ctx, undefined);
}

const scheduleTemporaryStatuslineClear = (ctx: ExtensionContext) => {
  if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
  const requestId = statuslineRequestId;
  statuslineClearTimer = setTimeout(() => {
    statuslineClearTimer = undefined;
    if (!sessionActive || requestId !== statuslineRequestId) return;
    setStatuslineValue(ctx, undefined);
  }, CACHE_TTL_MS);
  statuslineClearTimer.unref?.();
};

const scheduleStatuslineRefresh = (
  ctx: ExtensionContext,
  model: ProviderUsageModel | undefined,
  delayMs: number = CACHE_TTL_MS,
) => {
  if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
  const requestId = statuslineRequestId;
  statuslineRefreshTimer = setTimeout(() => {
    statuslineRefreshTimer = undefined;
    if (!sessionActive || requestId !== statuslineRequestId) return;
    void refreshCurrentUsageStatusline(ctx, model).catch(rethrowUnlessStaleContextError(ctx));
  }, delayMs);
  statuslineRefreshTimer.unref?.();
};

const setUsageStatusline = (
  ctx: ExtensionContext,
  report: UsageReport,
  options: {
    autoRefresh: boolean;
    model: ProviderUsageModel | undefined;
    staleAgeMs?: number;
    refreshDelayMs?: number;
  },
) => {
  let text = formatUsageStatusline(report, options.model);
  if (options.staleAgeMs !== undefined && options.staleAgeMs > CACHE_TTL_MS) {
    text = `${text} (${formatAgeShort(options.staleAgeMs)} old)`;
  }
  if (!setStatuslineValue(ctx, text)) return;
  activeStatuslineContext = ctx;
  if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
  statuslineClearTimer = undefined;
  if (options.autoRefresh) scheduleStatuslineRefresh(ctx, options.model, options.refreshDelayMs);
  else scheduleTemporaryStatuslineClear(ctx);
};

const getCachedReportForModel = (model: ProviderUsageModel | undefined): CachedReport | undefined => {
  let best = cache && reportMatchesModel(cache.report, model) ? cache : undefined;
  if (combinedCache) {
    const report = combinedCache.reports.find((item) => reportMatchesModel(item, model));
    if (report) {
      const candidate = { createdAt: combinedCache.createdAt, report };
      if (!best || candidate.createdAt > best.createdAt) best = candidate;
    }
  }
  // Another pi session may have fetched more recently — use its data.
  const shared = readSharedUsageCache()?.entries?.[providerKeyForModel(model)];
  if (shared?.report && reportMatchesModel(shared.report, model)) {
    if (!best || shared.createdAt > best.createdAt) best = shared;
  }
  return best;
};

export async function refreshCurrentUsageStatusline(ctx: ExtensionContext, model?: ProviderUsageModel) {
  if (!sessionActive) return;
  activeStatuslineContext = ctx;
  const selectedModel = model ?? ctx.model;
  if (!isUsageSupportedModel(selectedModel)) {
    clearUsageStatusline(ctx);
    return;
  }

  const requestId = statuslineRequestId + 1;
  statuslineRequestId = requestId;
  const cached = getCachedReportForModel(selectedModel);
  const freshCached = cached && Date.now() - cached.createdAt < CACHE_TTL_MS ? cached : undefined;
  // Fresh cache is always good enough — avoids double-fetching when /usage
  // just updated it or another pi session already fetched. The scheduled
  // timer fires when the TTL actually expires.
  if (freshCached) {
    const remainingMs = CACHE_TTL_MS - (Date.now() - freshCached.createdAt);
    setUsageStatusline(ctx, freshCached.report, {
      autoRefresh: true,
      model: selectedModel,
      refreshDelayMs: Math.max(remainingMs, 10_000),
    });
    return;
  }

  // Respect a shared rate-limit backoff set by any session.
  const providerKey = providerKeyForModel(selectedModel);
  const backoffRemaining = sharedBackoffRemainingMs(providerKey);
  if (backoffRemaining > 0) {
    if (cached) {
      setUsageStatusline(ctx, cached.report, {
        autoRefresh: true,
        model: selectedModel,
        staleAgeMs: Date.now() - cached.report.capturedAt,
        refreshDelayMs: Math.max(backoffRemaining, 10_000),
      });
    } else if (setStatuslineValue(ctx, `usage rate-limited (${formatAgeShort(backoffRemaining)})`)) {
      scheduleStatuslineRefresh(ctx, selectedModel, Math.max(backoffRemaining, 10_000));
    }
    return;
  }

  if (!cached && !setStatuslineValue(ctx, "checking")) return;
  const result = await queryUsageWithRetries(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!sessionActive || requestId !== statuslineRequestId) return;

  if (!result.ok) {
    const rateLimited = result.errors.some((error) => isRateLimitErrorMessage(error.message));
    // Honor the server's Retry-After when it sends one; fall back to default.
    const retryDelayMs = rateLimited ? rateLimitBackoffMs(result.errors) : CACHE_TTL_MS;
    if (rateLimited) {
      saveSharedBackoff(providerKey, Date.now() + retryDelayMs);
    }
    // Background refreshes fail silently — the statusline text is the only
    // indicator. Detailed errors are shown when /usage is run explicitly.
    if (cached) {
      setUsageStatusline(ctx, cached.report, {
        autoRefresh: true,
        model: selectedModel,
        staleAgeMs: Date.now() - cached.report.capturedAt,
        refreshDelayMs: retryDelayMs,
      });
      return;
    }
    const errorLabel = rateLimited ? `usage rate-limited (${formatAgeShort(retryDelayMs)})` : "usage error";
    if (setStatuslineValue(ctx, errorLabel)) {
      scheduleStatuslineRefresh(ctx, selectedModel, retryDelayMs);
    }
    return;
  }

  cache = { createdAt: Date.now(), report: result.report };
  saveSharedUsageReport(result.report);
  setUsageStatusline(ctx, result.report, { autoRefresh: true, model: selectedModel });
}

export function applyCurrentProviderStatusline(ctx: ExtensionContext, reports: UsageReport[]): boolean {
  const current = reports.find((report) => reportMatchesModel(report, ctx.model));
  if (!current) {
    setStatuslineValue(ctx, undefined);
    return false;
  }
  cache = { createdAt: Date.now(), report: current };
  setUsageStatusline(ctx, current, {
    autoRefresh: isUsageSupportedModel(ctx.model),
    model: ctx.model,
  });
  return true;
}

export function setStatuslineChecking(ctx: ExtensionContext): boolean {
  return setStatuslineValue(ctx, "checking");
}

export function clearStatuslineValue(ctx: ExtensionContext): boolean {
  return setStatuslineValue(ctx, undefined);
}
