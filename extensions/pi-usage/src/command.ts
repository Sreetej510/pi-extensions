import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchRawUsagePayloads } from "./anthropic-query.js";
import { completeCodexStatusArguments, parseArgs } from "./args.js";
import {
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  formatCodexResetCreditChoice,
  formatCodexResetCreditList,
} from "./codex-reset-credits.js";
import { CACHE_TTL_MS, COMMAND_NAME } from "./constants.js";
import { isRateLimitErrorMessage, rateLimitBackoffMs } from "./errors.js";
import { formatQueryErrors, showReports } from "./format.js";
import { queryAllUsage } from "./query.js";
import {
  clearSharedBackoff,
  clearSharedUsageReport,
  readSharedUsageCache,
  saveSharedBackoff,
  saveSharedUsageReport,
} from "./shared-cache.js";
import {
  applyCurrentProviderStatusline,
  clearCodexMemoryCache,
  clearStatuslineValue,
  clearUsageStatusline,
  getCombinedCache,
  handleStaleContextError,
  isSessionActive,
  setCombinedCache,
  setStatuslineChecking,
} from "./statusline.js";
import type { SharedCacheEntry } from "./types.js";
import { errorMessage } from "./utils.js";

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show usage for all configured providers (Codex and Anthropic)",
    getArgumentCompletions: completeCodexStatusArguments,
    handler: async (args, ctx) => {
      try {
        const options = parseArgs(args);
        if (!options.ok) {
          ctx.ui.notify(options.error, "warning");
          return;
        }

        if (options.value.clearStatusline) {
          clearUsageStatusline(ctx);
          ctx.ui.notify("Usage statusline cleared.", "info");
          return;
        }

        if (options.value.raw) {
          const rawTimeoutMs = options.value.timeoutMs;
          void fetchRawUsagePayloads(ctx, rawTimeoutMs)
            .then((text) => {
              if (isSessionActive()) ctx.ui.notify(text, "info");
            })
            .catch((error: unknown) => {
              if (!handleStaleContextError(ctx, error)) {
                ctx.ui.notify(errorMessage(error), "error");
              }
            });
          return;
        }

        if (options.value.listBankedResets) {
          const resets = await fetchCodexResetCredits(ctx, options.value.timeoutMs);
          ctx.ui.notify(formatCodexResetCreditList(resets), "info");
          return;
        }

        if (options.value.consumeBankedReset) {
          const resets = await fetchCodexResetCredits(ctx, options.value.timeoutMs);
          if (resets.availableCount <= 0 || resets.credits.length === 0) {
            ctx.ui.notify("No Codex banked resets are available.", "info");
            return;
          }
          let resetId = options.value.consumeBankedResetId;
          if (!resetId) {
            if (!ctx.hasUI) {
              ctx.ui.notify(
                "Usage: /usage --consume-banked-reset <id> (or run with a TUI to pick interactively)",
                "warning",
              );
              return;
            }
            const selected = await ctx.ui.select(
              "Choose a Codex banked reset to consume",
              resets.credits.map((credit) => formatCodexResetCreditChoice(credit)),
            );
            if (!selected) return;
            resetId = resets.credits.find((credit) => formatCodexResetCreditChoice(credit) === selected)?.id;
          }
          if (!resetId) {
            ctx.ui.notify("Could not determine which banked reset to consume.", "warning");
            return;
          }
          await consumeCodexResetCredit(ctx, options.value.timeoutMs, resetId);
          clearCodexMemoryCache();
          setCombinedCache(undefined);
          clearSharedUsageReport("codex");
          ctx.ui.notify(`Consumed Codex banked reset ${resetId}.`, "info");
          void queryAllUsage(ctx, { timeoutMs: options.value.timeoutMs })
            .then((result) => {
              if (result.reports.length > 0) {
                setCombinedCache({ createdAt: Date.now(), reports: result.reports });
                for (const report of result.reports) saveSharedUsageReport(report);
                showReports(ctx, result.reports, false);
              }
            })
            .catch(() => {});
          return;
        }

        const combined = getCombinedCache();
        let cached = combined && Date.now() - combined.createdAt < CACHE_TTL_MS ? combined : undefined;
        if (!cached) {
          // Fall back to reports fetched by other pi sessions.
          const shared = readSharedUsageCache();
          if (shared) {
            const entries = Object.values(shared.entries).filter(
              (entry): entry is SharedCacheEntry => !!entry && Date.now() - entry.createdAt < CACHE_TTL_MS,
            );
            if (entries.length > 0) {
              cached = {
                createdAt: Math.min(...entries.map((entry) => entry.createdAt)),
                reports: entries.map((entry) => entry.report),
              };
            }
          }
        }
        if (cached && !options.value.refresh) {
          if (options.value.statusline) applyCurrentProviderStatusline(ctx, cached.reports);
          showReports(ctx, cached.reports, true);
          return;
        }

        // Fire and forget — return immediately so the command doesn't block.
        // Results arrive as a notification once both providers finish.
        const cmdOptions = options.value;
        // Explicit refresh is a manual override — drop any stored backoff.
        if (cmdOptions.refresh) clearSharedBackoff();
        if (cmdOptions.statusline) setStatuslineChecking(ctx);
        void queryAllUsage(ctx, cmdOptions)
          .then((result) => {
            if (!isSessionActive()) return;
            if (result.reports.length === 0) {
              if (cmdOptions.statusline) clearStatuslineValue(ctx);
              ctx.ui.notify(formatQueryErrors(result.errors), "error");
              return;
            }
            setCombinedCache({ createdAt: Date.now(), reports: result.reports });
            for (const report of result.reports) saveSharedUsageReport(report);
            for (const error of result.errors) {
              if (isRateLimitErrorMessage(error.message)) {
                saveSharedBackoff(
                  error.source === "anthropic-oauth" ? "anthropic" : "codex",
                  Date.now() + rateLimitBackoffMs([error]),
                );
              }
            }
            const kept = cmdOptions.statusline ? applyCurrentProviderStatusline(ctx, result.reports) : false;
            if (cmdOptions.statusline && !kept) clearStatuslineValue(ctx);
            showReports(ctx, result.reports, false);
            // Surface partial failures (e.g. one provider worked, the other didn't).
            if (result.errors.length > 0) {
              ctx.ui.notify(formatQueryErrors(result.errors), "warning");
            }
          })
          .catch((error: unknown) => {
            if (cmdOptions.statusline) clearStatuslineValue(ctx);
            if (!handleStaleContextError(ctx, error)) {
              ctx.ui.notify(errorMessage(error), "error");
            }
          });
        // Return right away — the fetch continues in the background.
      } catch (error) {
        if (handleStaleContextError(ctx, error)) return;
        throw error;
      }
    },
  });
}
