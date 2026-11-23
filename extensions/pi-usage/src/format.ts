import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BAR_SEGMENTS, LIMIT_VALUE_COLUMN, RESET_FOREGROUND } from "./constants.js";
import { isOpenAICodexModel, reportMatchesModel } from "./models.js";
import type {
  AnthropicStatusWindow,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
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

export function formatUsageStatusline(report: UsageReport, model?: ProviderUsageModel): string {
  if (report.provider === "codex") return formatCodexUsageStatusline(report, model);
  return report.statusWindows?.length
    ? `claude ${formatAnthropicStatusWindows(report.statusWindows)}`
    : report.statusline;
}

/** Whether the statusline text changes with the clock (time left to a reset). */
export function usageStatuslineHasCountdown(report: UsageReport): boolean {
  return report.provider === "anthropic" && Boolean(report.statusWindows?.some((window) => window.resetsAt));
}

/** Groups adjacent windows that reset at the same minute, prints the time left
 * once per group and separates groups with ` / `:
 * `5h 9% ↻1h16m / 7d 19% fable 7% ↻9h55m`
 * (the weekly window and the Fable limit reset together). Time left rather than
 * a clock time, so the text is the same in every time zone. */
export function formatAnthropicStatusWindows(windows: AnthropicStatusWindow[]): string {
  const groups: { texts: string[]; resetAt?: number }[] = [];
  for (const window of windows) {
    const resetAt = window.resetsAt ? roundedResetTime(window.resetsAt) : undefined;
    const last = groups.at(-1);
    if (last && last.resetAt === resetAt) last.texts.push(window.text);
    else groups.push({ texts: [window.text], resetAt });
  }
  return groups
    .map((group) => {
      const text = group.texts.join(" ");
      const left = group.resetAt !== undefined ? formatTimeLeft(group.resetAt - Date.now()) : undefined;
      return left ? `${text} ↻${left}` : text;
    })
    .join(" / ");
}

/** `resets_at` jitters around the minute (`21:19:59.98` vs `21:20:00.45` between
 * calls); round to the nearest minute so windows that reset together group together. */
function roundedResetTime(value: string): number | undefined {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.round(time / 60_000) * 60_000 : undefined;
}

/** Time left, rounded down: `45m`, `1h16m`, `23h12m`, `1d10h`. */
function formatTimeLeft(remainingMs: number): string | undefined {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

export function formatUsageReport(report: UsageReport, cacheAgeMs?: number): string {
  return report.provider === "anthropic" ? report.summaryLines.join("\n") : formatCodexUsageReport(report, cacheAgeMs);
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
      error.source === "pi-auth" ? "Codex" : error.source === "codex-app-server" ? "Codex fallback" : "Anthropic";
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
