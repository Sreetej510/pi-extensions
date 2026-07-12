import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RATE_LIMIT_BACKOFF_MAX_MS, SHARED_CACHE_FILE, SHARED_CACHE_VERSION } from "./constants.js";
import type { SharedCacheEntry, SharedUsageCache, UsageProviderKey, UsageReport } from "./types.js";

export function readSharedUsageCache(): SharedUsageCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(SHARED_CACHE_FILE, "utf8")) as SharedUsageCache;
    if (!parsed || parsed.version !== SHARED_CACHE_VERSION) return undefined;
    if (!parsed.entries || typeof parsed.entries !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeSharedUsageCache(mutate: (cacheFile: SharedUsageCache) => void): void {
  try {
    const cacheFile = readSharedUsageCache() ?? { version: SHARED_CACHE_VERSION, entries: {} };
    mutate(cacheFile);
    mkdirSync(dirname(SHARED_CACHE_FILE), { recursive: true });
    const tmpFile = `${SHARED_CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(cacheFile));
    try {
      renameSync(tmpFile, SHARED_CACHE_FILE);
    } catch {
      // Windows can refuse to rename over an open file; fall back to direct write.
      writeFileSync(SHARED_CACHE_FILE, JSON.stringify(cacheFile));
    }
  } catch {
    // Best-effort — a broken shared cache must never break usage display.
  }
}

export function saveSharedUsageReport(report: UsageReport): void {
  writeSharedUsageCache((cacheFile) => {
    cacheFile.entries[report.provider] = { createdAt: Date.now(), report };
    if (cacheFile.backoffUntil) delete cacheFile.backoffUntil[report.provider];
  });
}

export function clearSharedUsageReport(provider: UsageProviderKey): void {
  writeSharedUsageCache((cacheFile) => {
    delete cacheFile.entries[provider];
  });
}

export function saveSharedBackoff(provider: UsageProviderKey, untilMs: number): void {
  // Never persist a backoff further out than the max — protects against
  // clock skew between sessions producing absurd values.
  const clamped = Math.min(untilMs, Date.now() + RATE_LIMIT_BACKOFF_MAX_MS);
  writeSharedUsageCache((cacheFile) => {
    cacheFile.backoffUntil = { ...(cacheFile.backoffUntil ?? {}), [provider]: clamped };
  });
}

export function clearSharedBackoff(): void {
  writeSharedUsageCache((cacheFile) => {
    cacheFile.backoffUntil = undefined;
  });
}

export function sharedBackoffRemainingMs(provider: UsageProviderKey): number {
  const until = readSharedUsageCache()?.backoffUntil?.[provider] ?? 0;
  // Distrust stored timestamps: a skewed clock in another session must not
  // lock us out for hours. Cap the effective backoff at the configured max.
  return Math.min(until - Date.now(), RATE_LIMIT_BACKOFF_MAX_MS);
}

export type { SharedCacheEntry };
