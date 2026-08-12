/**
 * Shipd Checks Extension for pi
 *
 * Behavioral test-gap analysis plus post-implementation test-fairness and
 * solution-quality auditing for a task's agent_prompt.md, tests, and repository source,
 * with an optional solver-based gap finder.
 *
 * Flow:
 *   1. Snapshot the current git HEAD (no working-dir mutation) into a temp dir
 *      via `git archive HEAD | tar -x` (see git.ts).
 *   2. Copy agent_prompt.md, solution.patch, test.patch from the project root
 *      into that temp dir.
 *   3. (/checks --solver-gap-finder) Run TDD solver agents and compare their
 *      passing implementations to the reference behavior.
 *   4. (analyze_task_tests) Run the requested read-only gap, test-audit, or
 *      solution-audit mode; audit modes use an Auditor plus an independent validator.
 *   5. Post a one-line chat message and merge solver results into
 *      shipd_report.json in the project root.
 *
 * Commands:
 *   /analyze:on           enable the agent-callable test-analysis tool for this project
 *   /analyze:off          disable the agent-callable test-analysis tool for this project
 *   /checks               open a menu for config or solver-gap-finder
 *   /checks --config      set reviewer, gap-analysis, and Auditor models
 *   /checks --solver-gap-finder  run several TDD solver agents, then compare their solutions to find gaps
 * Shortcut: Ctrl+Shift+X cancels an in-progress /checks run.
 *
 * File layout:
 *   index.ts     extension entry point (this file) — renderer, shortcut, command registration
 *   command.ts   /checks command: arg parsing, --config flow, run orchestration
 *   agents.ts     spawns/races the reviewer + gap-finder/validator agent sessions
 *   prompts.ts    all prompt text sent to those agents
 *   tools.ts      custom tools agents call to submit structured results
 *   rubric.ts     embedded guidelines/fairness rubric text + section loaders
 *   roles.ts      the 3 reviewer roles (description/tests/solution) metadata
 *   report.ts     shipd_report.json load/merge/summary logic
 *   config.ts     ~/.pi/agent/checks-config.json + settings.json helpers
 *   git.ts        clean git HEAD snapshot into a scratch directory
 *   progress.ts   progress-bar widget rendering
 *   state.ts      shared "run in progress" / cancel state
 *   types.ts      shared TypeScript types
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, Spacer, Text } from "@earendil-works/pi-tui";
import { registerChecksCommand } from "./command.js";
import { PROGRESS_WIDGET_KEY } from "./progress.js";
import type { SolverSummaryDetail } from "./report.js";
import { formatDuration } from "./report.js";
import { cancelReview, isReviewInProgress } from "./state.js";
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
    description: "Enable the test-analysis tool for this project folder",
    handler: async (_args, ctx) => {
      setAnalyzeEnabled(pi, ctx.cwd, true);
      ctx.ui.notify("Test-analysis tool ON in this project", "info");
    },
  });

  pi.registerCommand("analyze:off", {
    description: "Disable the test-analysis tool for this project folder",
    handler: async (_args, ctx) => {
      setAnalyzeEnabled(pi, ctx.cwd, false);
      ctx.ui.notify("Test-analysis tool OFF in this project", "info");
    },
  });

  pi.registerMessageRenderer<{
    gapsCount?: number;
    showGaps?: boolean;
    showSolverGaps?: boolean;
    solverDetails?: SolverSummaryDetail[];
    solverGapsCount?: number;
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

    if (details.showSolverGaps) {
      const solvers = details.solverDetails ?? [];
      const passCount = solvers.filter((s) => s.passed).length;
      const gapsCount = details.solverGapsCount ?? 0;

      container.addChild(new Spacer(1));
      addLine(theme.bold(theme.fg("accent", "Solver gap finder")));
      for (const s of solvers) {
        const statusIcon = s.passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const statusLabel = s.passed ? "passed" : s.status === "ok" ? "failed tests" : s.status;
        addLine(`  ${statusIcon} Solver ${s.index}: ${statusLabel} (${formatDuration(s.durationMs)})`);
      }
      const passSummary =
        passCount === solvers.length && solvers.length > 0
          ? theme.fg("success", `${passCount}/${solvers.length} solvers passed`)
          : theme.fg("warning", `${passCount}/${solvers.length} solvers passed`);
      const gapsSummary =
        gapsCount > 0
          ? theme.fg("warning", `${gapsCount} behavioral gap(s) found`)
          : theme.fg("success", "no behavioral gaps found");
      addLine(`  ${passSummary}, ${gapsSummary}`);
    }

    if (!wroteSection) {
      container.addChild(new Text(theme.fg("dim", "  nothing to report"), 0, 0));
    }

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

  registerAnalyzeGapsSync(pi);
  registerChecksCommand(pi);
}

/** Keeps the analyze_task_tests tool visible only while enabled (like HPC tools). */
function registerAnalyzeGapsSync(pi: ExtensionAPI) {
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
