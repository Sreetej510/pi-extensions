import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BAR_SEGMENTS, LIMIT_VALUE_COLUMN, RESET_FOREGROUND } from "./constants.js";
import { isOpenAICodexModel, reportMatchesModel } from "./models.js";
import type {
  AdapterUsageReport,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
  NormalizedUsageWindow,
  PiModel,
  ProviderUsageModel,
  UsageQueryError,
  UsageReport,
} from "./types.js";
import {
  addNormalizedUsageKey,
  clampPercent,
  compactLimitLabel,
  formatNumber,
  normalizedKeyHasToken,
  normalizedUsageKey,
  truncateEnd,
} from "./utils.js";

export function formatCodexUsageReport(report: CodexUsageReport, _cacheAgeMs?: number): string {
  const lines = ["  >_ OpenAI Codex Usage", ""];

  for (const snapshot of report.snapshots) {
    const label = snapshot.limitName ?? snapshot.limitId;
    if (!isPrimaryCodexSnapshot(snapshot)) {
      lines.push(`  ${label} limit:`);
    }
    if (snapshot.primary) lines.push(formatWindowLine("5h limit:", snapshot.primary));
    if (snapshot.secondary) lines.push(formatWindowLine("7d limit:", snapshot.secondary));
    if (!snapshot.primary && !snapshot.secondary) {
      lines.push("  Limits unavailable for this account");
    }
  }

  if (report.bankedResetsAvailable !== undefined) {
    lines.push("");
    const expiry = report.nextBankedResetExpiresAt
      ? ` (next expires ${formatReset(report.nextBankedResetExpiresAt)})`
      : "";
    lines.push(`  Banked resets available: ${report.bankedResetsAvailable}${expiry}`);
  }

  return lines.join("\n");
}

export function formatCodexUsageStatusline(report: CodexUsageReport, model?: ProviderUsageModel): string {
  const snapshot = selectSnapshotForUsageModel(report, model);
  if (!snapshot) return "usage unavailable";

  const parts = [formatStatuslinePrefix(snapshot)];
  if (snapshot.primary) parts.push(`${clampPercent(snapshot.primary.usedPercent).toFixed(0)}% 5h`);
  if (snapshot.secondary) parts.push(`${clampPercent(snapshot.secondary.usedPercent).toFixed(0)}% 7d`);
  if (parts.length === 1 && snapshot.credits) parts.push(formatCredits(snapshot.credits));
  return parts.join(" ");
}

export function formatUsageStatusline(report: UsageReport, model?: ProviderUsageModel): string | undefined {
  if (model && !reportMatchesModel(report, model)) return undefined;
  if (report.source === "external-adapter") {
    return formatNormalizedUsageStatusline(report.windows, report.provider, model);
  }
  if (report.provider === "anthropic") {
    if (!model) return report.statusline;
    const hasMatchingModelWindows = report.windows.some(
      (window) =>
        isUsableNormalizedWindow(window) &&
        window.scope.kind === "model" &&
        modelScopeMatchesUsageModel(window.scope.modelIds, model),
    );
    const hasFinancialAccountWindows = report.windows.some(
      (window) => window.scope.kind === "account" && window.windowMinutes === undefined,
    );
    if (!hasMatchingModelWindows && hasFinancialAccountWindows) return report.statusline;
    return formatNormalizedUsageStatusline(report.windows, report.provider, model);
  }
  return formatCodexUsageStatusline(report, model);
}

export function formatUsageReport(report: UsageReport, cacheAgeMs?: number): string {
  if (report.source === "external-adapter") return formatAdapterUsageReport(report);
  if (report.provider === "anthropic") return report.summaryLines.join("\n");
  return formatCodexUsageReport(report, cacheAgeMs);
}

function formatNormalizedUsageStatusline(
  windows: NormalizedUsageWindow[],
  provider: UsageReport["provider"],
  model: ProviderUsageModel | undefined,
): string {
  const usableWindows = windows.filter(isUsableNormalizedWindow);
  const modelWindows = model
    ? usableWindows.filter(
        (window) => window.scope.kind === "model" && modelScopeMatchesUsageModel(window.scope.modelIds, model),
      )
    : [];
  const accountWindows = usableWindows.filter((window) => window.scope.kind === "account");
  const selectedWindows =
    modelWindows.length > 0
      ? modelWindows
      : accountWindows.length > 0
        ? accountWindows
        : model
          ? []
          : selectFirstModelScope(usableWindows);
  if (selectedWindows.length === 0) return "usage unavailable";

  const selectedScope = selectedWindows[0].scope;
  const prefix = selectedScope.kind === "model" ? selectedScope.label : provider === "anthropic" ? "Claude" : "Codex";
  const parts = selectedWindows.map((window, index) => {
    const reset = index === 0 ? formatResetCountdown(window.resetsAt) : undefined;
    return `${window.label} ${clampPercent(window.usedPercent).toFixed(0)}%${reset ? ` ↻${reset}` : ""}`;
  });
  return [prefix, ...parts].join(" · ");
}

function formatAdapterUsageReport(report: AdapterUsageReport): string {
  const providerLabel = report.provider === "anthropic" ? "Anthropic" : "OpenAI Codex";
  const lines = [`  >_ ${providerLabel} Usage`, ""];
  const usableWindows = report.windows.filter(isUsableNormalizedWindow);
  if (usableWindows.length === 0) {
    lines.push("  Usage unavailable");
    return lines.join("\n");
  }

  const groups = new Map<string, { label: string; windows: NormalizedUsageWindow[] }>();
  for (const window of usableWindows) {
    const key = window.scope.kind === "account" ? "account" : `model:${JSON.stringify(window.scope.modelIds)}`;
    const label = window.scope.kind === "account" ? "Account" : window.scope.label;
    const group = groups.get(key) ?? { label, windows: [] };
    group.windows.push(window);
    groups.set(key, group);
  }

  let first = true;
  for (const group of groups.values()) {
    if (!first) lines.push("");
    first = false;
    lines.push(`  ${group.label} usage:`);
    for (const window of group.windows) {
      lines.push(formatWindowLine(`${window.label}:`, window));
    }
  }
  return lines.join("\n");
}

function isUsableNormalizedWindow(window: NormalizedUsageWindow): boolean {
  return Boolean(window.label.trim()) && Number.isFinite(window.usedPercent);
}

function modelScopeMatchesUsageModel(modelIds: string[], model: ProviderUsageModel): boolean {
  const modelKeys = new Set(
    [normalizedUsageKey(model.id), normalizedUsageKey(model.name)].filter((key): key is string => key !== undefined),
  );
  return modelIds.some((modelId) => {
    const key = normalizedUsageKey(modelId);
    return key !== undefined && modelKeys.has(key);
  });
}

function selectFirstModelScope(windows: NormalizedUsageWindow[]): NormalizedUsageWindow[] {
  const first = windows.find((window) => window.scope.kind === "model");
  if (first?.scope.kind !== "model") return [];
  const modelIds = new Set(first.scope.modelIds.map((modelId) => normalizedUsageKey(modelId)));
  return windows.filter(
    (window) =>
      window.scope.kind === "model" &&
      window.scope.modelIds.some((modelId) => modelIds.has(normalizedUsageKey(modelId))),
  );
}

function formatResetCountdown(resetsAt: number | undefined): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
  const remainingMilliseconds = resetsAt * 1000 - Date.now();
  if (remainingMilliseconds <= 0) return undefined;
  const remainingMinutes = Math.floor(remainingMilliseconds / 60_000);
  const remainingHours = Math.floor(remainingMilliseconds / 3_600_000);
  const remainingDays = Math.floor(remainingMilliseconds / 86_400_000);
  if (remainingDays > 0) return `${remainingDays}d`;
  if (remainingHours > 0) return `${remainingHours}h`;
  if (remainingMinutes > 0) return `${remainingMinutes}m`;
  return "<1m";
}

export function showReport(ctx: ExtensionCommandContext, report: UsageReport, fromCache: boolean): void {
  const text = formatUsageReport(report, fromCache ? Date.now() - report.capturedAt : undefined);
  ctx.ui.notify(ctx.hasUI ? brightenInfoNotification(text) : text, "info");
}

export function showReports(ctx: ExtensionCommandContext, reports: UsageReport[], fromCache: boolean): void {
  const ordered = orderReportsForCurrentProvider(reports, ctx.model);
  const text = ordered
    .map((report) => formatUsageReport(report, fromCache ? Date.now() - report.capturedAt : undefined))
    .join("\n\n");
  ctx.ui.notify(ctx.hasUI ? brightenInfoNotification(text) : text, "info");
}

export function formatQueryErrors(errors: UsageQueryError[], partial = false): string {
  if (errors.length === 0) {
    return "No logged-in Codex or Anthropic providers. Run /login to connect one.";
  }

  const lines = [partial ? "Some provider usage is unavailable:" : "Usage unavailable:"];
  for (const error of errors) {
    const source =
      error.source === "pi-auth"
        ? "Codex"
        : error.source === "codex-app-server"
          ? "Codex fallback"
          : error.source === "anthropic-oauth"
            ? "Anthropic"
            : "External adapter";
    lines.push(`- ${source}: ${compactQueryError(error.message)}`);
  }
  return lines.join("\n");
}

function compactQueryError(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (/invalid_grant|refresh token not found|token refresh request failed/i.test(normalized)) {
    return "login expired or invalid; run /login to reconnect.";
  }
  if (/no .*auth|no api key|not logged in/i.test(normalized)) {
    return "not logged in; run /login to connect.";
  }

  const summary = normalized.split(/;\s*(?:details|stack)=/i, 1)[0] ?? normalized;
  return truncateEnd(summary, 180);
}

export function progressBarUsed(percentUsed: number): string {
  const filled = Math.round((clampPercent(percentUsed) / 100) * BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function selectSnapshotForUsageModel(
  report: CodexUsageReport,
  model: ProviderUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
  const codexSnapshot = report.snapshots.find(isPrimaryCodexSnapshot);
  if (!model || !isOpenAICodexModel(model)) return codexSnapshot ?? report.snapshots[0];

  const modelKeys = normalizedModelUsageKeys(model);
  const exactMatch = report.snapshots.find((snapshot) =>
    normalizedSnapshotUsageKeys(snapshot).some((key) => modelKeys.has(key)),
  );
  if (exactMatch) return exactMatch;

  const variants = codexModelVariantKeys(modelKeys);
  for (const variant of variants) {
    const matches = report.snapshots.filter(
      (snapshot) =>
        !isPrimaryCodexSnapshot(snapshot) &&
        normalizedSnapshotUsageKeys(snapshot).some((key) => normalizedKeyHasToken(key, variant)),
    );
    if (matches.length === 1) return matches[0];
  }

  return codexSnapshot ?? report.snapshots[0];
}

function normalizedModelUsageKeys(model: ProviderUsageModel): Set<string> {
  const keys = new Set<string>();
  addNormalizedUsageKey(keys, model.id);
  addNormalizedUsageKey(keys, model.name);

  for (const key of [...keys]) {
    const codexIndex = key.indexOf("codex");
    if (codexIndex >= 0) keys.add(key.slice(codexIndex));
  }

  return keys;
}

function normalizedSnapshotUsageKeys(snapshot: NormalizedRateLimitSnapshot): string[] {
  return [normalizedUsageKey(snapshot.limitId), normalizedUsageKey(snapshot.limitName)].filter(
    (key): key is string => key !== undefined,
  );
}

function codexModelVariantKeys(modelKeys: Set<string>): string[] {
  const variants = new Set<string>();
  for (const key of modelKeys) {
    const match = key.match(/(?:^|-)codex-(.+)$/);
    if (match?.[1]) variants.add(match[1]);
  }
  return [...variants];
}

function formatStatuslinePrefix(snapshot: NormalizedRateLimitSnapshot): string {
  if (isPrimaryCodexSnapshot(snapshot)) return "codex";
  const label = snapshot.limitName ?? snapshot.limitId;
  return `codex ${compactLimitLabel(label)}`;
}

function orderReportsForCurrentProvider(
  reports: UsageReport[],
  model: Pick<PiModel, "provider"> | undefined,
): UsageReport[] {
  return [...reports].sort((left, right) => {
    const leftCurrent = reportMatchesModel(left, model) ? 0 : 1;
    const rightCurrent = reportMatchesModel(right, model) ? 0 : 1;
    return leftCurrent - rightCurrent;
  });
}

function brightenInfoNotification(text: string): string {
  return `${RESET_FOREGROUND}${text}`;
}

function isPrimaryCodexSnapshot(snapshot: NormalizedRateLimitSnapshot): boolean {
  return normalizedUsageKey(snapshot.limitId) === "codex" || normalizedUsageKey(snapshot.limitName) === "codex";
}

function formatWindowLine(label: string, window: NormalizedRateLimitWindow): string {
  return `  ${label.padEnd(LIMIT_VALUE_COLUMN)}${formatWindow(window)}`;
}

function formatWindow(window: NormalizedRateLimitWindow): string {
  const used = clampPercent(window.usedPercent);
  const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
  return `${progressBarUsed(used)} ${used.toFixed(0)}% used${reset}`;
}

function formatCredits(credits: NormalizedCredits): string {
  if (!credits.hasCredits) return "no credits";
  if (credits.unlimited) return "unlimited credits";
  const balance = credits.balance?.trim();
  if (!balance) return "credits available";
  return `${formatNumber(Number(balance), balance)} credits`;
}

function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";

  const now = new Date();
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset.getMinutes().toString().padStart(2, "0")}`;
  if (reset.toDateString() === now.toDateString()) return time;
  const day = reset.getDate().toString();
  const month = reset.toLocaleDateString(undefined, { month: "short" });
  return `${time} on ${day} ${month}`;
}
