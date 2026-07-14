/**
 * Shipd Checks Extension for pi
 *
 * Strict, parallel 3-agent review of a task's agent_prompt.md, test.patch, and
 * solution.patch against a combined rubric (see rubric.ts): the per-focus
 * P1-P5/T1-T6/S1-S4 checklist and the fairness methodology — agent-fault vs
 * prompt-ambiguity vs test-flaw, fair/unfair test examples. Reviewers only
 * FAIL for genuine blocking issues; everything else is captured as
 * non-blocking notes, mirroring how real shipd reviews mostly surface
 * optional/minor suggestions rather than hard failures.
 *
 * Flow (for whichever stages/roles the chosen option below runs):
 *   1. Snapshot the current git HEAD (no working-dir mutation) into a temp dir
 *      via `git archive HEAD | tar -x` (see git.ts).
 *   2. Copy agent_prompt.md, solution.patch, test.patch from the project root
 *      into that temp dir.
 *   3. (--all / --review / --description / --tests / --solution) Spawn the
 *      selected read-only reviewer agent(s) — description / tests / solution,
 *      all 3 in parallel for --all/--review, or just the one requested —
 *      each restricted to read/grep/find/ls plus a single
 *      `submit_review_report` tool they must call with a structured verdict
 *      (see agents.ts, tools.ts).
 *   4. (--all / --gap-finder) Run a 3-agent behavioral test-gap analysis: two
 *      specialized finders run in parallel — one for positive (missing required-
 *      behavior) gaps, one for negative (missing forbidden-behavior) gaps — then a
 *      strict validator filters the combined candidate list. This never turns a
 *      PASS into a FAIL; it only annotates the report/summary.
 *   5. Post a one-line chat message and merge results into shipd_report.json
 *      in the project root (merged, not overwritten — running any of
 *      --review/--description/--tests/--solution/--gap-finder separately, in
 *      any order, builds up one combined report; see report.ts). `overall`
 *      only reflects a confident PASS/FAIL once all 3 focus reviewers have
 *      run at least once; PASS gets "(with test gaps)" appended when the
 *      filter stage kept any.
 *
 * Commands (all flags below except --config are additive/combinable, e.g.
 * "/checks --tests --gap-finder" runs just the tests reviewer plus the
 * gap-finder/filter stages; --config must be used alone):
 *   /checks               list available options (runs nothing)
 *   /checks --all         run all 3 focus reviewers + test-gap analysis
 *   /checks --review      run only the 3 focus reviewer agents
 *   /checks --description run only the problem-description (prompt) reviewer
 *   /checks --tests       run only the tests reviewer
 *   /checks --solution    run only the solution reviewer
 *   /checks --gap-finder  run positive + negative gap finders, then validator
 *   /checks --solver-gap-finder  run several TDD solver agents, then compare their solutions to find gaps
 *   /checks --config      set the reviewer model and thinking level
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
import type { Verdict } from "./types.js";

const CANCEL_SHORTCUT = Key.ctrlShift("x");

export default function shipdChecksExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<{
    overall?: Verdict;
    hasTestGaps?: boolean;
    gapsCount?: number;
    roleVerdicts?: Record<string, Verdict>;
    showGaps?: boolean;
    showSolverGaps?: boolean;
    solverDetails?: SolverSummaryDetail[];
    solverGapsCount?: number;
  }>("shipd_checks_report", (message, _options, theme) => {
    const details = message.details ?? {};
    const colorVerdict = (verdict: Verdict) =>
      verdict === "PASS" ? theme.fg("success", verdict) : theme.fg("error", verdict);

    const container = new Container();
    container.addChild(new Text(theme.bold(theme.fg("accent", "Checks")), 0, 0));

    let wroteSection = false;
    const addLine = (line: string) => {
      container.addChild(new Text(line, 0, 0));
      wroteSection = true;
    };

    // Whichever reviewer(s) just ran — a partial run (e.g. only --tests) always shows its own
    // PASS/FAIL, and `overall` only appears when this invocation ran all 3 focus reviewers.
    if (details.roleVerdicts && Object.keys(details.roleVerdicts).length > 0) {
      for (const [role, verdict] of Object.entries(details.roleVerdicts)) {
        const icon = verdict === "PASS" ? theme.fg("success", "✓") : theme.fg("error", "✗");
        addLine(`  ${icon} ${theme.bold(role)}: ${colorVerdict(verdict)}`);
      }
      if (details.overall) {
        const suffix = details.overall === "PASS" && details.hasTestGaps ? " (with test gaps)" : "";
        addLine(`  ${theme.bold("Overall:")} ${colorVerdict(details.overall)}${suffix}`);
      }
    }

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

  registerChecksCommand(pi);
}
