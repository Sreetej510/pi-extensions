import type {
  AppServerCreditsSnapshot,
  AppServerRateLimitResetCredits,
  AppServerRateLimitResponse,
  AppServerRateLimitSnapshot,
  AppServerWindowSnapshot,
  BackendAdditionalRateLimit,
  BackendCreditsSnapshot,
  BackendRateLimitDetails,
  BackendRateLimitResetCredits,
  BackendWindowSnapshot,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
  RateLimitStatusPayload,
} from "./types.js";
import { asBoolean, asNumber, asString, assertObject } from "./utils.js";

export function normalizeBackendPayload(
  payload: RateLimitStatusPayload,
  capturedAt: number,
  source: "pi-auth" | "codex-app-server",
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const planType = asString(payload.plan_type);
  const bankedResetsAvailable = normalizeResetCreditCount(payload.rate_limit_reset_credits);
  const primary = normalizeBackendSnapshot("codex", undefined, payload.rate_limit, payload.credits);
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    const additionalLimit = assertObject(item, "additional rate limit") as BackendAdditionalRateLimit;
    const limitId = asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
    if (!limitId) continue;
    const snapshot = normalizeBackendSnapshot(
      limitId,
      asString(additionalLimit.limit_name),
      additionalLimit.rate_limit,
      undefined,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  if (snapshots.length === 0) {
    throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
  }

  return { provider: "codex", source, capturedAt, planType, bankedResetsAvailable, snapshots };
}

function normalizeBackendSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  credits: unknown,
): NormalizedRateLimitSnapshot | undefined {
  if (rateLimit === null || rateLimit === undefined) {
    const normalizedCredits = normalizeBackendCredits(credits);
    return normalizedCredits ? { limitId, limitName, credits: normalizedCredits } : undefined;
  }

  const details = assertObject(rateLimit, "rate limit") as BackendRateLimitDetails;
  const primary = normalizeBackendWindow(details.primary_window);
  const secondary = normalizeBackendWindow(details.secondary_window);
  const normalizedCredits = normalizeBackendCredits(credits);

  if (!primary && !secondary && !normalizedCredits) return undefined;
  return { limitId, limitName, primary, secondary, credits: normalizedCredits };
}

function normalizeBackendWindow(value: unknown): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "rate-limit window") as BackendWindowSnapshot;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = asNumber(window.limit_window_seconds);
  const resetsAt = asNumber(window.reset_at);
  return {
    usedPercent,
    windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
    resetsAt,
  };
}

function normalizeBackendCredits(value: unknown): NormalizedCredits | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "credits") as BackendCreditsSnapshot;
  const hasCredits = asBoolean(credits.has_credits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

export function normalizeAppServerResponse(response: AppServerRateLimitResponse, capturedAt: number): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const bankedResetsAvailable = normalizeResetCreditCount(response.rateLimitResetCredits);
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
    if (!snapshot) return;
    const existingIndex = snapshots.findIndex((item) => item.limitId === snapshot.limitId);
    if (existingIndex >= 0) snapshots[existingIndex] = mergeSnapshot(snapshots[existingIndex], snapshot);
    else snapshots.push(snapshot);
  };

  addSnapshot(response.rateLimits, "codex");
  if (response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
    for (const [limitId, raw] of Object.entries(response.rateLimitsByLimitId)) {
      addSnapshot(raw, limitId);
    }
  }

  if (snapshots.length === 0) {
    throw new Error("codex app-server returned no displayable rate-limit windows.");
  }

  const planType = asAppServerPlanType(response.rateLimits);
  return {
    provider: "codex",
    source: "codex-app-server",
    capturedAt,
    planType,
    bankedResetsAvailable,
    snapshots,
  };
}

function asAppServerPlanType(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(raw, "app-server rate-limit snapshot") as AppServerRateLimitSnapshot;
  return asString(snapshot.planType);
}

function normalizeAppServerSnapshot(raw: unknown, fallbackId: string): NormalizedRateLimitSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(raw, "app-server rate-limit snapshot") as AppServerRateLimitSnapshot;
  const limitId = asString(snapshot.limitId) ?? fallbackId;
  const limitName = asString(snapshot.limitName);
  const primary = normalizeAppServerWindow(snapshot.primary);
  const secondary = normalizeAppServerWindow(snapshot.secondary);
  const credits = normalizeAppServerCredits(snapshot.credits);
  if (!primary && !secondary && !credits) return undefined;
  return { limitId, limitName, primary, secondary, credits };
}

function normalizeAppServerWindow(value: unknown): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "app-server rate-limit window") as AppServerWindowSnapshot;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: asNumber(window.windowDurationMins),
    resetsAt: asNumber(window.resetsAt),
  };
}

function normalizeAppServerCredits(value: unknown): NormalizedCredits | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "app-server credits") as AppServerCreditsSnapshot;
  const hasCredits = asBoolean(credits.hasCredits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

function normalizeResetCreditCount(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "rate limit reset credits") as
    | BackendRateLimitResetCredits
    | AppServerRateLimitResetCredits;
  const count = asNumber(credits.available_count) ?? asNumber(credits.availableCount);
  return count !== undefined ? Math.max(0, Math.trunc(count)) : undefined;
}

function mergeSnapshot(
  left: NormalizedRateLimitSnapshot,
  right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
  return {
    limitId: right.limitId || left.limitId,
    limitName: right.limitName ?? left.limitName,
    primary: right.primary ?? left.primary,
    secondary: right.secondary ?? left.secondary,
    credits: right.credits ?? left.credits,
  };
}
