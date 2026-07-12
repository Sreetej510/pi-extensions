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
 *   4. (--all / --gap-finder) Run a sequential 2-stage behavioral test-gap
 *      analysis: an exhaustive researcher agent proposes as many candidate
 *      gaps as it can find — required-but-untested edge cases that could let
 *      an incorrect solution slip past test.patch — then a strict,
 *      independent filter agent re-verifies each candidate against the
 *      fairness rules and keeps only the ones that hold up. This never turns
 *      a PASS into a FAIL; it only annotates the report/summary.
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
 *   /checks --gap-finder  run only the test-gap finder/filter agents
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
import { Key, Text } from "@earendil-works/pi-tui";
import { registerChecksCommand } from "./command.js";
import { PROGRESS_WIDGET_KEY } from "./progress.js";
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
  }>("shipd_checks_report", (message, _options, theme) => {
    const details = message.details ?? {};
    const colorVerdict = (verdict: Verdict) =>
      verdict === "PASS" ? theme.fg("success", verdict) : theme.fg("error", verdict);
    const segments: string[] = [];

    // Whichever reviewer(s) just ran, even if `overall` is still incomplete
    // (e.g. only --tests has run so far) — a partial run must always show its
    // own PASS/FAIL, not just silently defer to the gap-count message.
    if (details.roleVerdicts) {
      for (const [role, verdict] of Object.entries(details.roleVerdicts)) {
        segments.push(`${role}: ${colorVerdict(verdict)}`);
      }
    }

    if (details.overall) {
      const suffix = details.overall === "PASS" && details.hasTestGaps ? " (with test gaps)" : "";
      segments.push(`Overall: ${colorVerdict(details.overall)}${suffix}`);
    }

    if (details.showGaps) {
      const count = details.gapsCount ?? 0;
      segments.push(
        count > 0 ? theme.fg("warning", `${count} test gap(s) found`) : theme.fg("success", "no test gaps found"),
      );
    }

    const text = segments.length > 0 ? segments.join("  ") : theme.fg("dim", "nothing to report");
    return new Text(`${theme.bold("Checks: ")}${text}`, 0, 0);
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
