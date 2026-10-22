/**
 * Shipd Checks Extension for pi
 *
 * Behavioral test-gap finding, prompt humanization, and post-implementation solution-quality prechecking, plus a
 * Claude CLI benchmark runner for tasks described by `agent_prompt.md`.
 *
 * Benchmark flow:
 *   1. Snapshot git HEAD without touching the working tree; copy only agent_prompt.md as task input.
 *   2. Run independent Claude CLI solvers in Fargate, then execute base/new tests and save their logs.
 *   3. Run a read-only local Pi reviewer over the prompt, patched tests, all diffs, and all results.
 *   4. Post the assessment and merge benchmark results into shipd_report.json.
 *
 * Commands:
 *   /analyze:on             enable agent-callable analysis tools for this project
 *   /analyze:off            disable agent-callable analysis tools for this project
 *   /shipd:auth             open a browser for first-time Shipd sign-in
 *   /shipd:link <url>       save the Shipd job link for this chat session
 *   /checks                 open a menu for config or solve
 *   /checks --config        configure local reviewer/analysis models and Claude solver settings
 *   /checks --solve         run Claude solvers, base/new tests, and a fairness review
 *   /checks --autoreview    local Claude CLI replica of the hosted Auto Review (tests + solution)
 * Shortcut: Ctrl+Shift+X cancels an in-progress /checks run.
 *
 * File layout:
 *   index.ts     extension entry point (this file) — renderer, shortcut, command registration
 *   command.ts   /checks command: argument parsing, settings, and run orchestration
 *   agents.ts    local Pi gap-finder, solution-precheck, and benchmark-review sessions
 *   autoreview*.ts  /checks --autoreview: Claude CLI reviewers, synthesis, verdict; prompts and hosted calibration data
 *   prompts.ts   task and reviewer prompt text
 *   fargate-runner.ts/worker.ts remote Claude solver/test execution and report transport
 *   report.ts    shipd_report.json load/merge/summary logic
 *   config.ts    ~/.pi/agent/checks-config.json + settings.json helpers
 *   git.ts       clean git HEAD snapshot into a scratch directory
 *   progress.ts  progress-bar widget rendering
 *   state.ts     shared "run in progress" / cancel state
 *   types.ts     shared TypeScript types
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, Spacer, Text } from "@earendil-works/pi-tui";
import type { AutoReviewSummary } from "./autoreview.js";
import { registerChecksCommand } from "./command.js";
import { PROGRESS_WIDGET_KEY } from "./progress.js";
import type { SolverSummaryDetail } from "./report.js";
import { formatDuration } from "./report.js";
import { cancelReview, isReviewInProgress } from "./state.js";
import { registerSubmitShipdTool } from "./submit.js";
import {
  isAnalyzeSyncNeeded,
  isAnalyzeSyncPending,
  onAnalyzeProjectContext,
  scheduleDelayedAnalyzeSync,
  setAnalyzeEnabled,
  syncAnalyzeTool,
} from "./tool-sync.js";

const CANCEL_SHORTCUT = Key.ctrlShift("x");

export default function shipdChecksExtension(pi: ExtensionAPI) {
  pi.registerCommand("analyze:on", {
    description: "Enable the gap-finder, solution-precheck, and prompt-humanizer tools for this project folder",
    handler: async (_args, ctx) => {
      setAnalyzeEnabled(pi, ctx.cwd, true);
      ctx.ui.notify("Gap-finder, solution-precheck, and prompt-humanizer tools ON in this project", "info");
    },
  });

  pi.registerCommand("analyze:off", {
    description: "Disable the gap-finder, solution-precheck, and prompt-humanizer tools for this project folder",
    handler: async (_args, ctx) => {
      setAnalyzeEnabled(pi, ctx.cwd, false);
      ctx.ui.notify("Gap-finder, solution-precheck, and prompt-humanizer tools OFF in this project", "info");
    },
  });

  pi.registerMessageRenderer<{
    gapsCount?: number;
    showGaps?: boolean;
    showClaudeBenchmark?: boolean;
    solverDetails?: SolverSummaryDetail[];
    solverReviewStatus?: "ok" | "timedOut" | "error";
    solverReviewText?: string;
  }>("shipd_checks_report", (message, _options, theme) => {
    const details = message.details ?? {};
    const container = new Container();
    container.addChild(new Text(theme.bold(theme.fg("accent", "Checks")), 0, 0));

    let wroteSection = false;
    const addLine = (line: string) => {
      container.addChild(new Text(line, 0, 0));
      wroteSection = true;
    };

    if (details.showGaps) {
      const count = details.gapsCount ?? 0;
      addLine(
        count > 0
          ? theme.fg("warning", `  ⚠ ${count} test gap(s) found`)
          : theme.fg("success", "  ✓ no test gaps found"),
      );
    }

    if (details.showClaudeBenchmark) {
      const solvers = details.solverDetails ?? [];
      const passCount = solvers.filter((s) => s.passed).length;
      container.addChild(new Spacer(1));
      addLine(theme.bold(theme.fg("accent", "Claude agent run")));
      for (const s of solvers) {
        const statusIcon = s.passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const statusLabel = s.passed ? "both suites passed" : s.status === "ok" ? "test failure" : s.status;
        const formatTestCounts = (counts: SolverSummaryDetail["baseTestCounts"]) =>
          counts?.totalTests != null && counts.failedTests != null
            ? `${counts.failedTests}/${counts.totalTests} failed${counts.erroredTests ? `, ${counts.erroredTests} errors` : ""}`
            : "counts unavailable";
        const suiteStatus =
          `base ${s.basePassed === undefined ? "n/a" : s.basePassed ? "PASS" : "FAIL"} ` +
          `(${formatTestCounts(s.baseTestCounts)}), ` +
          `new ${s.newPassed === undefined ? "n/a" : s.newPassed ? "PASS" : "FAIL"} ` +
          `(${formatTestCounts(s.newTestCounts)})`;
        addLine(`  ${statusIcon} Agent ${s.index}: ${statusLabel}; ${suiteStatus} (${formatDuration(s.durationMs)})`);
      }
      const passSummary =
        passCount === solvers.length && solvers.length > 0
          ? theme.fg("success", `${passCount}/${solvers.length} agents passed both suites`)
          : theme.fg("warning", `${passCount}/${solvers.length} agents passed both suites`);
      const reviewStatus = details.solverReviewStatus ?? "not completed";
      addLine(`  ${passSummary}; reviewer ${reviewStatus}`);
      if (details.solverReviewText) {
        const reviewText = details.solverReviewText.slice(0, 1200).trim();
        addLine(
          `  Reviewer assessment: ${reviewText}${details.solverReviewText.length > 1200 ? "… (full report in shipd_report.json)" : ""}`,
        );
      }
    }

    if (!wroteSection) {
      container.addChild(new Text(theme.fg("dim", "  nothing to report"), 0, 0));
    }

    return container;
  });

  pi.registerMessageRenderer<AutoReviewSummary>("shipd_autoreview_report", (message, _options, theme) => {
    const summary = message.details;
    const container = new Container();
    container.addChild(new Text(theme.bold(theme.fg("accent", "Auto Review (local)")), 0, 0));
    if (!summary) {
      container.addChild(new Text(theme.fg("dim", "  nothing to report"), 0, 0));
      return container;
    }
    const color = (verdict: string) =>
      verdict === "PASS" ? "success" : verdict === "BLOCK" || verdict === "FAIL" ? "error" : "warning";
    container.addChild(new Text(`  ${theme.bold(theme.fg(color(summary.verdict), summary.verdict))}`, 0, 0));
    container.addChild(
      new Text(
        `  Test Quality ${theme.fg(color(summary.testQuality), summary.testQuality)} (${summary.notFairCount}/${summary.testsGraded} Not fair) · ` +
          `Solution Quality ${theme.fg(color(summary.solutionQuality), summary.solutionQuality)}`,
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        `  ${summary.high.length} gating HIGH, ${summary.mediumCount} MEDIUM; reviewers ${summary.reviewersOk}/${summary.reviewersTotal} ok; ` +
          `${summary.counterTests} counter-tests in the report (${formatDuration(summary.durationMs)})`,
        0,
        0,
      ),
    );
    for (const finding of summary.high.slice(0, 12)) {
      const text = finding.text.length > 240 ? `${finding.text.slice(0, 240)}…` : finding.text;
      container.addChild(new Text(theme.fg("error", `  ✗ ${finding.as || finding.area}: ${text}`), 0, 0));
    }
    if (summary.high.length > 12) {
      container.addChild(new Text(theme.fg("dim", `  … ${summary.high.length - 12} more in the report`), 0, 0));
    }
    container.addChild(new Text(theme.fg("dim", `  report: ${summary.reportPath}`), 0, 0));
    return container;
  });

  pi.registerShortcut(CANCEL_SHORTCUT, {
    description: "Cancel an in-progress /checks run",
    handler: (ctx) => {
      if (!isReviewInProgress()) return;
      if (!cancelReview()) return;
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, [`checks: cancelling (${CANCEL_SHORTCUT})...`]);
      ctx.ui.notify("checks: cancelling...", "warning");
    },
  });

  registerAnalysisToolsSync(pi);
  registerSubmitShipdTool(pi);
  registerChecksCommand(pi);
}

/** Keeps the gap-finder and solution-precheck tools visible only while enabled (like HPC tools). */
function registerAnalysisToolsSync(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    // New, resume, reload, fork — load the persisted setting for this session.
    onAnalyzeProjectContext(pi, ctx.cwd);
    if (event.reason === "resume" || event.reason === "reload" || event.reason === "startup") {
      scheduleDelayedAnalyzeSync(pi);
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    // Branch navigation can restore a different active-tool list.
    onAnalyzeProjectContext(pi, ctx.cwd);
  });
  pi.on("before_agent_start", () => {
    if (!isAnalyzeSyncPending() && !isAnalyzeSyncNeeded(pi)) return;
    syncAnalyzeTool(pi);
  });
}
