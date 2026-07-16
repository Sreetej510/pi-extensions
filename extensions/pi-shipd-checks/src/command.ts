/** The `/checks` command: behavioral and solver-based gap finders only. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runGapFinder, runGapValidator, runSolverAgent, runSolverComparisonReviewer } from "./agents.js";
import {
  getSupportedThinkingLevels,
  loadChecksConfig,
  loadEnabledModelRefs,
  loadSolverGapConfig,
  SOLVER_GAP_DEFAULT_SAVE_ARTIFACTS,
  SOLVER_GAP_DEFAULT_SOLVER_COUNT,
  SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES,
  saveChecksConfig,
  splitProviderModel,
} from "./config.js";
import { snapshotGitHead } from "./git.js";
import { PROGRESS_WIDGET_KEY, renderProgressLines } from "./progress.js";
import { buildRunSummary, formatLocalTimestamp, loadExistingReport, mergeReport, REQUIRED_FILES } from "./report.js";
import { loadFairnessRules, loadTestGuidelines } from "./rubric.js";
import {
  cleanupSolverWorkspace,
  finalizeSolverRun,
  saveSolverArtifacts,
  setupSolverWorkspace,
  writeSolverSolutionsToDisk,
} from "./solvergap.js";
import { endReview, isReviewInProgress, startReview } from "./state.js";
import type {
  CommandOption,
  GapStageResult,
  SolverGap,
  SolverGapConfig,
  SolverRunResult,
  TestGapCandidate,
  TestGapFinal,
  ThinkingLevel,
} from "./types.js";

export const CANCEL_SHORTCUT_LABEL = "Ctrl+Shift+X";
const COMMAND_COMPLETIONS: readonly CommandOption[] = [
  { value: "--gap-finder", label: "--gap-finder", description: "Find and validate behavioral test-coverage gaps" },
  {
    value: "--solver-gap-finder",
    label: "--solver-gap-finder",
    description: "Use TDD solver attempts to find behavioral gaps",
  },
  { value: "--config", label: "--config", description: "Configure gap-finder models" },
];

function getArgumentCompletions(prefix: string) {
  const trimmed = prefix.trimStart();
  const trailing = /\s$/.test(trimmed);
  const tokens = trimmed.trimEnd().split(/\s+/).filter(Boolean);
  const current = trailing ? "" : (tokens.at(-1) ?? "");
  const used = new Set(trailing ? tokens : tokens.slice(0, -1));
  const base = trailing ? trimmed : trimmed.slice(0, trimmed.length - current.length);
  const hasConfig = used.has("--config");
  const hasOther = [...used].some((token) => token !== "--config");
  const matches = COMMAND_COMPLETIONS.filter(
    (option) =>
      !used.has(option.value) &&
      !hasConfig &&
      !(hasOther && option.value === "--config") &&
      option.value.startsWith(current),
  );
  return matches.length ? matches.map((option) => ({ ...option, value: `${base}${option.value}` })) : null;
}

async function pickModel(ctx: ExtensionCommandContext, label: string, current?: { provider: string; modelId: string }) {
  const models = ctx.modelRegistry.getAll();
  const options = loadEnabledModelRefs()
    .map((ref) => {
      const parsed = splitProviderModel(ref);
      if (!parsed) return null;
      const model = models.find((item) => item.provider === parsed.provider && item.id === parsed.modelId);
      return {
        ref,
        parsed,
        label: `${model?.name ?? ref} (${ref})${current?.provider === parsed.provider && current.modelId === parsed.modelId ? " [current]" : ""}`,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (!options.length) {
    ctx.ui.notify("No enabledModels configured in settings.json.", "error");
    return null;
  }
  const selected = await ctx.ui.select(
    label,
    options.map((option) => option.label),
  );
  return options.find((option) => option.label === selected)?.parsed ?? null;
}

async function runConfigFlow(ctx: ExtensionCommandContext) {
  const existing = loadChecksConfig();
  const target = await ctx.ui.select("Configure checks", ["Reviewer model", "Solver model"]);
  if (!target) return;

  if (target === "Reviewer model") {
    const reviewer = await pickModel(ctx, "Select reviewer model", existing ?? undefined);
    if (!reviewer) return;
    const levels = getSupportedThinkingLevels(ctx.modelRegistry.find(reviewer.provider, reviewer.modelId));
    const thinkingLevel = (await ctx.ui.select("Select reviewer thinking level", levels)) as ThinkingLevel | undefined;
    if (!thinkingLevel) return;
    saveChecksConfig({
      provider: reviewer.provider,
      modelId: reviewer.modelId,
      thinkingLevel,
      solverGap: existing?.solverGap,
    });
    ctx.ui.notify("Reviewer model saved.", "info");
    return;
  }

  if (!existing) {
    ctx.ui.notify("Configure the reviewer model first.", "warning");
    return;
  }
  const solver = await pickModel(ctx, "Select solver model", existing.solverGap);
  if (!solver) return;
  const levels = getSupportedThinkingLevels(ctx.modelRegistry.find(solver.provider, solver.modelId));
  const thinkingLevel = (await ctx.ui.select("Select solver thinking level", levels)) as ThinkingLevel | undefined;
  if (!thinkingLevel) return;
  saveChecksConfig({
    provider: existing.provider,
    modelId: existing.modelId,
    thinkingLevel: existing.thinkingLevel,
    solverGap: {
      provider: solver.provider,
      modelId: solver.modelId,
      thinkingLevel,
      timeoutMinutes: existing.solverGap?.timeoutMinutes ?? SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES,
      solverCount: existing.solverGap?.solverCount ?? SOLVER_GAP_DEFAULT_SOLVER_COUNT,
      saveArtifacts: existing.solverGap?.saveArtifacts ?? SOLVER_GAP_DEFAULT_SAVE_ARTIFACTS,
    },
  });
  ctx.ui.notify("Solver model saved.", "info");
}

export function registerChecksCommand(pi: ExtensionAPI) {
  pi.registerCommand("checks", {
    description: "Find behavioral gaps in test coverage. Requires an option — see /checks.",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (!sub) {
        ctx.ui.notify(
          COMMAND_COMPLETIONS.map((option) => `${option.value}  —  ${option.description}`).join("\n"),
          "info",
        );
        return;
      }
      const tokens = [...new Set(sub.split(/\s+/).filter(Boolean))];
      const known = new Set(COMMAND_COMPLETIONS.map((option) => option.value));
      const unknown = tokens.filter((token) => !known.has(token));
      if (unknown.length) {
        ctx.ui.notify(
          `Unknown option(s): ${unknown.join(", ")}. Run /checks with no arguments to see options.`,
          "warning",
        );
        return;
      }
      if (tokens.includes("--config")) {
        if (tokens.length > 1) ctx.ui.notify("--config cannot be combined with other options.", "warning");
        else await runConfigFlow(ctx);
        return;
      }
      const runGapFinder = tokens.includes("--gap-finder");
      const runSolverGapFinder = tokens.includes("--solver-gap-finder");
      if (!runGapFinder && !runSolverGapFinder) return;
      if (isReviewInProgress()) {
        ctx.ui.notify("A checks run is already in progress.", "warning");
        return;
      }
      const config = loadChecksConfig();
      if (!config) {
        ctx.ui.notify("No gap-finder model configured. Run /checks --config first.", "error");
        return;
      }
      const model = ctx.modelRegistry.find(config.provider, config.modelId);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(
          "Configured behavioral gap-finder model is unavailable or unauthenticated. Run /checks --config.",
          "error",
        );
        return;
      }
      const missing = REQUIRED_FILES.filter((file) => !existsSync(join(ctx.cwd, file)));
      if (missing.length) {
        ctx.ui.notify(`Missing required file(s): ${missing.join(", ")}`, "error");
        return;
      }
      let solverConfig: SolverGapConfig | null = null;
      let solverModel: unknown;
      if (runSolverGapFinder) {
        solverConfig = loadSolverGapConfig();
        if (!solverConfig || !existsSync(join(ctx.cwd, "test.sh"))) {
          ctx.ui.notify("Configure solver gap finder and provide test.sh before running it.", "error");
          return;
        }
        solverModel = ctx.modelRegistry.find(solverConfig.provider, solverConfig.modelId);
        if (!solverModel || !ctx.modelRegistry.hasConfiguredAuth(solverModel as never)) {
          ctx.ui.notify("Configured solver gap-finder model is unavailable or unauthenticated.", "error");
          return;
        }
      }
      const abort = startReview();
      const solverCount = solverConfig?.solverCount ?? 0;
      const total = (runGapFinder ? 3 : 0) + (runSolverGapFinder ? solverCount + 1 : 0);
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("preparing clean snapshot", 0, total));
      ctx.ui.notify(`gap finders (${tokens.join(" ")}) started. Press ${CANCEL_SHORTCUT_LABEL} to cancel.`, "info");
      let tempDir: string | undefined;
      const solverDirs: string[] = [];
      try {
        const dir = join(tmpdir(), `checks-${randomUUID()}`);
        mkdirSync(dir, { recursive: true });
        tempDir = dir;
        const snapshot = await snapshotGitHead(pi, ctx.cwd, dir);
        if (snapshot.status === "error") {
          ctx.ui.notify(`checks: ${snapshot.error}`, "error");
          return;
        }
        for (const file of REQUIRED_FILES) copyFileSync(join(ctx.cwd, file), join(dir, file));
        const testRubric = loadTestGuidelines();
        const fairnessRules = loadFairnessRules();
        let completed = 0;
        let positive: GapStageResult<TestGapCandidate> = { status: "ok", gaps: [] };
        let negative: GapStageResult<TestGapCandidate> = { status: "ok", gaps: [] };
        let filtered: GapStageResult<TestGapFinal> = { status: "ok", gaps: [] };
        if (runGapFinder) {
          const base = {
            tempDir: dir,
            model,
            thinkingLevel: config.thinkingLevel,
            testRubric,
            fairnessRules,
            cancelSignal: abort.signal,
          };
          [positive, negative] = await Promise.all([
            runGapFinderAgent(base, "positive"),
            runGapFinderAgent(base, "negative"),
          ]);
          completed += 2;
          ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("validating test gaps", completed, total));
          const candidates = [...positive.gaps, ...negative.gaps];
          if (candidates.length) filtered = await runGapValidator({ ...base, candidates });
          completed += 1;
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }
        let solverResults: SolverRunResult[] = [];
        let comparison: GapStageResult<SolverGap> = { status: "ok", gaps: [] };
        if (runSolverGapFinder && solverConfig) {
          const setups = await Promise.all(
            Array.from({ length: solverCount }, async (_, i) => {
              const solverDir = join(tmpdir(), `checks-solvergap-${randomUUID()}`);
              mkdirSync(solverDir, { recursive: true });
              solverDirs.push(solverDir);
              return {
                index: i + 1,
                setup: await setupSolverWorkspace({
                  pi,
                  repoDir: ctx.cwd,
                  solverDir,
                  testPatchPath: join(ctx.cwd, "test.patch"),
                  agentPromptPath: join(ctx.cwd, "agent_prompt.md"),
                }),
              };
            }),
          );
          const runId = formatLocalTimestamp().replace(/[:.]/g, "-");
          solverResults = await Promise.all(
            setups.map(async ({ index, setup }) => {
              if (setup.status !== "ok")
                return {
                  index,
                  status: setup.status,
                  passed: false,
                  diff: "",
                  testOutputTail: setup.error,
                  durationMs: 0,
                } satisfies SolverRunResult;
              const started = Date.now();
              const { outcome, trajectory } = await runSolverAgent({
                pi,
                solverDir: setup.solverDir,
                model: solverModel,
                thinkingLevel: solverConfig.thinkingLevel,
                timeoutMinutes: solverConfig.timeoutMinutes,
                cancelSignal: abort.signal,
              });
              const { testOutputXmlPath, ...result } = await finalizeSolverRun({
                pi,
                index,
                workspace: setup,
                status: outcome === "done" ? "ok" : outcome,
                durationMs: Date.now() - started,
              });
              const artifactsDir = solverConfig.saveArtifacts
                ? saveSolverArtifacts({
                    repoDir: ctx.cwd,
                    runId,
                    index,
                    trajectory,
                    solutionPatch: result.diff,
                    testOutputXmlPath,
                    testOutputTail: result.testOutputTail,
                  })
                : undefined;
              completed += 1;
              ctx.ui.setWidget(
                PROGRESS_WIDGET_KEY,
                renderProgressLines("solver gap finder: solving", completed, total),
              );
              return { ...result, artifactsDir };
            }),
          );
          if (solverResults.some((result) => result.status !== "patchFailed" && result.status !== "error")) {
            writeSolverSolutionsToDisk(dir, solverResults);
            comparison = await runSolverComparisonReviewer({
              tempDir: dir,
              model,
              thinkingLevel: config.thinkingLevel,
              solverResults,
              testRubric,
              fairnessRules,
              cancelSignal: abort.signal,
            });
          }
          completed += 1;
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }
        const incomplete =
          runGapFinder &&
          (positive.status !== "ok" ||
            negative.status !== "ok" ||
            ((positive.gaps.length > 0 || negative.gaps.length > 0) && filtered.status !== "ok"));
        const merged = mergeReport({
          existingReport: loadExistingReport(join(ctx.cwd, "shipd_report.json")),
          config,
          runGapFinder,
          testGaps: filtered.gaps,
          gapAnalysisIncomplete: incomplete,
          positiveGapFinderStatus: positive.status,
          negativeGapFinderStatus: negative.status,
          gapFilterStatus: filtered.status,
          runSolverGapFinder,
          solverResults,
          solverGaps: comparison.gaps,
          solverGapAnalysisIncomplete:
            runSolverGapFinder &&
            (solverResults.some((result) => result.status === "error") || comparison.status !== "ok"),
          solverComparisonStatus: comparison.status,
        });
        const summary = buildRunSummary({ merged, runGapFinder, runSolverGapFinder });
        pi.sendMessage({
          customType: "shipd_checks_report",
          content: summary.content,
          display: true,
          details: summary.details,
        });
        const reportPath = join(ctx.cwd, "shipd_report.json");
        writeFileSync(reportPath, JSON.stringify(merged, null, 2), "utf-8");
        ctx.ui.notify(`checks: wrote details to ${reportPath}`, "info");
      } catch (error) {
        ctx.ui.notify(`checks failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        for (const dir of solverDirs) cleanupSolverWorkspace(dir);
        endReview();
      }
    },
  });
}

async function runGapFinderAgent(
  base: {
    tempDir: string;
    model: unknown;
    thinkingLevel: ThinkingLevel;
    testRubric: string;
    fairnessRules: string;
    cancelSignal: AbortSignal;
  },
  kind: "positive" | "negative",
) {
  return runGapFinder({ ...base, kind });
}
