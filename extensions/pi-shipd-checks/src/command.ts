/** Registers the `/checks` command: argument parsing, the --config flow, and the main run orchestration. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runGapFinder, runGapValidator, runReviewer } from "./agents.js";
import {
  getSupportedThinkingLevels,
  loadEnabledModelRefs,
  loadReviewConfig,
  saveReviewConfig,
  splitProviderModel,
} from "./config.js";
import { snapshotGitHead } from "./git.js";
import { PROGRESS_WIDGET_KEY, renderProgressLines } from "./progress.js";
import { buildRunSummary, loadExistingReport, mergeReport, REQUIRED_FILES } from "./report.js";
import { ROLES } from "./roles.js";
import { loadFairnessRules, loadGuidelinesSections } from "./rubric.js";
import { endReview, isReviewInProgress, startReview } from "./state.js";
import type {
  CommandOption,
  GapStageResult,
  ReviewerRole,
  ReviewReport,
  TestGapCandidate,
  TestGapFinal,
  ThinkingLevel,
} from "./types.js";

export const CANCEL_SHORTCUT_LABEL = "Ctrl+Shift+X";

const COMMAND_COMPLETIONS: readonly CommandOption[] = [
  { value: "--all", label: "--all", description: "Run everything: 3 focus reviewers + test-gap finder/filter" },
  {
    value: "--review",
    label: "--review",
    description: "Run only the 3 focus reviewer agents (description/tests/solution)",
  },
  {
    value: "--description",
    label: "--description",
    description: "Run only the problem-description (prompt) focus reviewer",
  },
  { value: "--tests", label: "--tests", description: "Run only the tests focus reviewer" },
  { value: "--solution", label: "--solution", description: "Run only the solution focus reviewer" },
  {
    value: "--gap-finder",
    label: "--gap-finder",
    description: "Run only the 3-agent test-gap flow: positive finder + negative finder (parallel), then validator",
  },
  { value: "--config", label: "--config", description: "Set the reviewer model and thinking level" },
];

function getArgumentCompletions(prefix: string) {
  // Flags are additive (e.g. "--tests --gap-finder"), so completions must
  // account for flags already typed: drop them from suggestions, and keep
  // --config mutually exclusive with everything else.
  const trimmed = prefix.trimStart();
  const trailingSpace = /\s$/.test(trimmed);
  const tokens = trimmed.trimEnd().split(/\s+/).filter(Boolean);
  const current = trailingSpace ? "" : (tokens.at(-1) ?? "");
  const usedTokens = new Set(trailingSpace ? tokens : tokens.slice(0, -1));
  const completionPrefix = trailingSpace ? trimmed : trimmed.slice(0, trimmed.length - current.length);

  const hasConfig = usedTokens.has("--config");
  const hasOtherFlag = [...usedTokens].some((t) => t !== "--config");

  const candidates = COMMAND_COMPLETIONS.filter((o) => {
    if (usedTokens.has(o.value)) return false;
    if (hasConfig) return false;
    if (hasOtherFlag && o.value === "--config") return false;
    return o.value.startsWith(current);
  });

  return candidates.length > 0 ? candidates.map((o) => ({ ...o, value: `${completionPrefix}${o.value}` })) : null;
}

/** Interactive `/checks --config` flow: pick a model (highlighting the current one), then a thinking level. */
async function runConfigFlow(ctx: ExtensionCommandContext) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/checks --config requires interactive mode", "error");
    return;
  }
  const refs = loadEnabledModelRefs();
  if (refs.length === 0) {
    ctx.ui.notify("No enabledModels configured in settings.json.", "error");
    return;
  }
  const existingConfig = loadReviewConfig();
  const available = ctx.modelRegistry.getAll();
  const labeled = refs
    .map((ref) => {
      const parsed = splitProviderModel(ref);
      if (!parsed) return null;
      const found = available.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
      const isCurrent = existingConfig?.provider === parsed.provider && existingConfig?.modelId === parsed.modelId;
      const base = found ? `${found.name} (${ref})` : ref;
      return { ref, parsed, display: isCurrent ? `${base} [current]` : base, found, isCurrent };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (labeled.length === 0) {
    ctx.ui.notify("Could not resolve any enabledModels entries.", "error");
    return;
  }

  // Surface the currently configured model at the top of the list, alongside
  // the "[current]" label, since ctx.ui.select can't pre-position the cursor.
  const orderedModels = [...labeled].sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));

  const choice = await ctx.ui.select(
    "Select model for checks reviewer agents",
    orderedModels.map((l) => l.display),
  );
  if (!choice) return;
  const selected = labeled.find((l) => l.display === choice);
  if (!selected) return;

  let thinkingLevel: ThinkingLevel = "off";
  const supportedLevels = getSupportedThinkingLevels(selected.found);
  if (supportedLevels.length > 1) {
    const currentLevel = selected.isCurrent ? existingConfig?.thinkingLevel : undefined;
    const levelOptions = [...supportedLevels].sort((a, b) =>
      (a === currentLevel) === (b === currentLevel) ? 0 : a === currentLevel ? -1 : 1,
    );
    const levelDisplay = (l: ThinkingLevel) => (l === currentLevel ? `${l} [current]` : l);
    const level = await ctx.ui.select("Select thinking level for reviewer agents", levelOptions.map(levelDisplay));
    if (!level) return;
    thinkingLevel = levelOptions.find((l) => levelDisplay(l) === level) ?? (level as ThinkingLevel);
  }

  saveReviewConfig({ provider: selected.parsed.provider, modelId: selected.parsed.modelId, thinkingLevel });
  ctx.ui.notify(
    `checks config saved: ${selected.parsed.provider}/${selected.parsed.modelId} (thinking: ${thinkingLevel})`,
    "info",
  );
}

export function registerChecksCommand(pi: ExtensionAPI) {
  pi.registerCommand("checks", {
    description: "Strict review of agent_prompt.md/test.patch/solution.patch. Requires an option — see /checks.",
    getArgumentCompletions,

    handler: async (args, ctx) => {
      const sub = args.trim();

      // ── /checks (no args) — list options, run nothing ──
      if (sub === "") {
        ctx.ui.notify(COMMAND_COMPLETIONS.map((o) => `${o.value}  —  ${o.description}`).join("\n"), "info");
        return;
      }

      const tokens = [...new Set(sub.split(/\s+/).filter(Boolean))];
      const knownFlags = new Set(COMMAND_COMPLETIONS.map((o) => o.value));
      const unknown = tokens.filter((t) => !knownFlags.has(t));
      if (unknown.length > 0) {
        ctx.ui.notify(
          `Unknown option(s): ${unknown.join(", ")}. Run /checks with no arguments to see the available options.`,
          "warning",
        );
        return;
      }

      // ── /checks --config ───────────────────────────
      if (tokens.includes("--config")) {
        if (tokens.length > 1) {
          ctx.ui.notify("--config cannot be combined with other options.", "warning");
          return;
        }
        await runConfigFlow(ctx);
        return;
      }

      // Flags are additive — any combination of role flags / --review / --all /
      // --gap-finder may be passed together (e.g. "--tests --gap-finder" runs
      // just the tests reviewer plus the gap-finder/filter stages).
      const roleKeys = new Set<ReviewerRole["key"]>();
      if (tokens.includes("--all") || tokens.includes("--review")) {
        for (const role of ROLES) roleKeys.add(role.key);
      }
      for (const role of ROLES) {
        if (tokens.includes(`--${role.key}`)) roleKeys.add(role.key);
      }
      const runGapStages = tokens.includes("--all") || tokens.includes("--gap-finder");
      const activeRoles = ROLES.filter((r) => roleKeys.has(r.key));
      const runReviewers = activeRoles.length > 0;

      if (!runReviewers && !runGapStages) {
        ctx.ui.notify(
          `Nothing to run for: ${tokens.join(" ")}. Run /checks with no arguments to see the available options.`,
          "warning",
        );
        return;
      }
      const runLabel = tokens.join(" ");

      if (isReviewInProgress()) {
        ctx.ui.notify("A checks run is already in progress.", "warning");
        return;
      }

      const config = loadReviewConfig();
      if (!config) {
        ctx.ui.notify("No reviewer model configured. Run /checks --config first.", "error");
        return;
      }

      const model = ctx.modelRegistry.find(config.provider, config.modelId);
      if (!model) {
        ctx.ui.notify(
          `Configured model ${config.provider}/${config.modelId} not found. Run /checks --config again.`,
          "error",
        );
        return;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(`No auth configured for ${config.provider}/${config.modelId}.`, "error");
        return;
      }

      const missing = REQUIRED_FILES.filter((f) => !existsSync(join(ctx.cwd, f)));
      if (missing.length > 0) {
        ctx.ui.notify(`Missing required file(s) in project root: ${missing.join(", ")}`, "error");
        return;
      }

      const reviewAbort = startReview();
      // Stage count: focus reviewers + 2 parallel gap finders + 1 validator.
      const TOTAL_STAGES = (runReviewers ? activeRoles.length : 0) + (runGapStages ? 3 : 0);
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("preparing clean snapshot", 0, TOTAL_STAGES));
      ctx.ui.notify(`checks (${runLabel}) started. Press ${CANCEL_SHORTCUT_LABEL} to cancel.`, "info");

      let tempDir: string | undefined;
      try {
        // Unique per-run directory (UUID) so concurrent runs — even across different
        // projects/sessions — never collide on the same temp path.
        const dir = join(tmpdir(), `checks-${randomUUID()}`);
        mkdirSync(dir, { recursive: true });
        tempDir = dir;

        const snapshot = await snapshotGitHead(pi, ctx.cwd, dir);
        if (snapshot.status === "error") {
          ctx.ui.notify(`checks: ${snapshot.error}`, "error");
          return;
        }

        for (const f of REQUIRED_FILES) {
          copyFileSync(join(ctx.cwd, f), join(dir, f));
        }

        const sections = loadGuidelinesSections();
        const fairnessRules = loadFairnessRules();
        let completed = 0;

        let reports: ReviewReport[] = [];
        if (runReviewers) {
          ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("reviewing", completed, TOTAL_STAGES));
          reports = await Promise.all(
            activeRoles.map((role) =>
              runReviewer({
                pi,
                role,
                tempDir: dir,
                model,
                thinkingLevel: config.thinkingLevel,
                rubric: sections[role.key],
                fairnessRules,
                cancelSignal: reviewAbort.signal,
              }).then((report) => {
                completed += 1;
                ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("reviewing", completed, TOTAL_STAGES));
                return report;
              }),
            ),
          );

          if (reviewAbort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }

        // ── Test-gap analysis: two specialized finders (positive + negative) run
        // in parallel to propose candidate gaps, then a strict validator filters
        // the combined list. This never turns a PASS into a FAIL.
        let positiveGapFinding: GapStageResult<TestGapCandidate> = { status: "ok", gaps: [] };
        let negativeGapFinding: GapStageResult<TestGapCandidate> = { status: "ok", gaps: [] };
        let gapFiltering: GapStageResult<TestGapFinal> = { status: "ok", gaps: [] };
        if (runGapStages) {
          const gapFinderBase = {
            tempDir: dir,
            model,
            thinkingLevel: config.thinkingLevel,
            testRubric: sections.tests,
            fairnessRules,
            cancelSignal: reviewAbort.signal,
          };

          ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("finding test gaps", completed, TOTAL_STAGES));
          [positiveGapFinding, negativeGapFinding] = await Promise.all([
            runGapFinder({ ...gapFinderBase, kind: "positive" }).then((result) => {
              completed += 1;
              ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("finding test gaps", completed, TOTAL_STAGES));
              return result;
            }),
            runGapFinder({ ...gapFinderBase, kind: "negative" }).then((result) => {
              completed += 1;
              ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("finding test gaps", completed, TOTAL_STAGES));
              return result;
            }),
          ]);

          if (reviewAbort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }

          const candidateGaps = [...positiveGapFinding.gaps, ...negativeGapFinding.gaps];
          if (candidateGaps.length > 0) {
            ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("validating test gaps", completed, TOTAL_STAGES));
            gapFiltering = await runGapValidator({
              tempDir: dir,
              model,
              thinkingLevel: config.thinkingLevel,
              testRubric: sections.tests,
              fairnessRules,
              candidates: candidateGaps,
              cancelSignal: reviewAbort.signal,
            });
          }
          completed += 1;
          ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("validating test gaps", completed, TOTAL_STAGES));

          if (reviewAbort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }

        ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("finalizing report", TOTAL_STAGES, TOTAL_STAGES));

        // Each reviewer's structured report lives under its own key so per-agent
        // detail is always preserved. Test gaps never affect `overall` — they're
        // supplementary, filtered notes.
        const byRole: Record<string, ReviewReport> = {};
        activeRoles.forEach((role, i) => {
          if (reports[i]) byRole[role.key] = reports[i];
        });
        const testGaps = gapFiltering.gaps;
        const hadGapCandidates = positiveGapFinding.gaps.length > 0 || negativeGapFinding.gaps.length > 0;
        const gapAnalysisIncomplete =
          runGapStages &&
          (positiveGapFinding.status !== "ok" ||
            negativeGapFinding.status !== "ok" ||
            (hadGapCandidates && gapFiltering.status !== "ok"));

        // Merge into any existing shipd_report.json instead of clobbering it —
        // running --review/--description/--tests/--solution/--gap-finder
        // separately (in any order) should build up one combined report rather
        // than each overwriting the others' results.
        const reportPath = join(ctx.cwd, "shipd_report.json");
        const existingReport = loadExistingReport(reportPath);
        const merged = mergeReport({
          existingReport,
          config,
          runReviewers,
          byRole,
          runGapStages,
          testGaps,
          gapAnalysisIncomplete,
          positiveGapFinderStatus: positiveGapFinding.status,
          negativeGapFinderStatus: negativeGapFinding.status,
          gapFilterStatus: gapFiltering.status,
        });

        const summary = buildRunSummary({ merged, runReviewers, activeRoles, byRole, runGapStages });
        pi.sendMessage({
          customType: "shipd_checks_report",
          content: summary.content,
          display: true,
          details: summary.details,
        });

        writeFileSync(reportPath, JSON.stringify(merged, null, 2), "utf-8");
        ctx.ui.notify(`checks: wrote details to ${reportPath}`, "info");
      } catch (err) {
        ctx.ui.notify(`checks failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
        if (tempDir) {
          try {
            rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // best effort cleanup
          }
        }
        endReview();
      }
    },
  });
}
