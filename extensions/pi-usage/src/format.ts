import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BAR_SEGMENTS, LIMIT_VALUE_COLUMN, RESET_FOREGROUND } from "./constants.js";
import { isOpenAICodexModel, reportMatchesModel } from "./models.js";
import type {
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
} from "./utils.js";

export function formatCodexUsageReport(report: CodexUsageReport, _cacheAgeMs?: number): string {
  const lines = ["  >_ OpenAI Codex Usage", ""];

  for (const snapshot of report.snapshots) {
    const label = snapshot.limitName ?? snapshot.limitId;
    if (!isPrimaryCodexSnapshot(snapshot)) {
      lines.push(`  ${label} limit:`);
    }
    if (snapshot.primary) lines.push(formatWindowLine("5h limit:", snapshot.primary));
    if (snapshot.secondary) lines.push(formatWindowLine("Weekly limit:", snapshot.secondary));
    if (!snapshot.primary && !snapshot.secondary) {
      lines.push("  Limits unavailable for this account");
    }
  }

  if (report.bankedResetsAvailable !== undefined) {
    lines.push("");
    lines.push(`  Banked resets available: ${report.bankedResetsAvailable}`);
  }

  return lines.join("\n");
}

export function formatCodexUsageStatusline(report: CodexUsageReport, model?: ProviderUsageModel): string {
  const snapshot = selectSnapshotForUsageModel(report, model);
  if (!snapshot) return "usage unavailable";

  const parts = [formatStatuslinePrefix(snapshot)];
  if (snapshot.primary) parts.push(`${clampPercent(snapshot.primary.usedPercent).toFixed(0)}% 5h`);
  if (snapshot.secondary) parts.push(`${clampPercent(snapshot.secondary.usedPercent).toFixed(0)}% wk`);
  if (parts.length === 1 && snapshot.credits) parts.push(formatCredits(snapshot.credits));
  return parts.join(" ");
}

export function formatUsageStatusline(report: UsageReport, model?: ProviderUsageModel): string {
  return report.provider === "anthropic" ? report.statusline : formatCodexUsageStatusline(report, model);
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

export function formatQueryErrors(errors: UsageQueryError[]): string {
  const lines = ["Unable to read usage for the current provider."];
  for (const error of errors) {
    const source =
      error.source === "pi-auth"
        ? "Pi Codex auth"
        : error.source === "codex-app-server"
          ? "Codex app-server fallback"
          : "Anthropic OAuth usage";
    lines.push(`- ${source}: ${error.message}`);
  }
  lines.push("");
  lines.push(
    "Tip: use a Pi OpenAI Codex model or Pi Anthropic model. For Codex, /login with OpenAI ChatGPT Plus/Pro. For Anthropic, /login with Anthropic so the OAuth usage endpoint can be queried.",
  );
  return lines.join("\n");
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
