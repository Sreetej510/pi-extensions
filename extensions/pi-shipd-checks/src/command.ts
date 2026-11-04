/** The `/checks` command: settings and the `--solve` Claude CLI benchmark. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { runSolverReview } from "./agents.js";
import {
  AUDITOR_CONCURRENCY_MAX,
  AUDITOR_CONCURRENCY_MIN,
  AUDITOR_TIMEOUT_MAX_MINUTES,
  AUDITOR_TIMEOUT_MIN_MINUTES,
  isAnalyzeProjectEnabled,
  loadAuditorConfig,
  loadChecksConfig,
  loadQualityCheckConfig,
  loadSolverGapConfig,
  loadSolverReviewConfig,
  persistFargateResourceUsage,
  SOLVER_GAP_SOLVER_COUNT_MAX,
  SOLVER_GAP_SOLVER_COUNT_MIN,
  SOLVER_GAP_TIMEOUT_MAX_MINUTES,
  SOLVER_GAP_TIMEOUT_MIN_MINUTES,
  SOLVER_REVIEW_TIMEOUT_MAX_MINUTES,
  SOLVER_REVIEW_TIMEOUT_MIN_MINUTES,
  saveAuditorConfig,
  saveQualityCheckConfig,
  saveSolverGapConfig,
  saveSolverReviewConfig,
  setAnalyzeProjectEnabled,
} from "./config.js";
import { runFargateClaudeBenchmark } from "./fargate-runner.js";
import { runCreatePatches, snapshotGitHead } from "./git.js";
import { extractNewFilesFromPatch } from "./patch.js";
import { PROGRESS_WIDGET_KEY, renderProgressLines } from "./progress.js";
import { buildRunSummary, formatLocalTimestamp, loadExistingReport, mergeReport, REQUIRED_FILES } from "./report.js";
import { loadFairnessRules, loadTestGuidelines } from "./rubric.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import { endReview, isReviewInProgress, startReview } from "./state.js";
import { analyzeToolSettingChanged } from "./tool-sync.js";
import type {
  AuditorConfig,
  ClaudeThinkingLevel,
  CommandOption,
  FargateResourceUsage,
  QualityTestSolutionMode,
  SolverGapConfig,
  SolverReviewConfig,
  SolverReviewResult,
  SolverRunResult,
} from "./types.js";

export const CANCEL_SHORTCUT_LABEL = "Ctrl+Shift+X";

const COMMAND_COMPLETIONS: readonly CommandOption[] = [
  {
    value: "--config",
    label: "--config",
    description: "Configure Claude solvers and reviewers, quality checks, and the auditor tool",
  },
  { value: "--solve", label: "--solve", description: "Run Claude agents on agent_prompt.md" },
];

const COMMAND_MENU_OPTIONS = ["config", "solve"] as const;

/** Every action is used alone, so nothing completes once one is typed. */
function getArgumentCompletions(prefix: string) {
  const trimmed = prefix.trimStart();
  const trailing = /\s$/.test(trimmed);
  const tokens = trimmed.trimEnd().split(/\s+/).filter(Boolean);
  const current = trailing ? "" : (tokens.at(-1) ?? "");
  const used = trailing ? tokens : tokens.slice(0, -1);
  const base = trailing ? trimmed : trimmed.slice(0, trimmed.length - current.length);
  const matches = used.length ? [] : COMMAND_COMPLETIONS.filter((option) => option.value.startsWith(current));
  return matches.length ? matches.map((option) => ({ ...option, value: `${base}${option.value}` })) : null;
}

type ConfigRowId =
  | "solver-model"
  | "solvergap-thinking"
  | "solvergap-timeout"
  | "solvergap-solver-count"
  | "solverreview-model"
  | "solverreview-effort"
  | "solverreview-timeout"
  | "quality-test-solution-mode"
  | "analyze-enabled"
  | "auditor-model"
  | "auditor-effort"
  | "auditor-timeout"
  | "auditor-concurrency";

interface ConfigRow {
  id: ConfigRowId;
  section: "Solver" | "Quality Checks" | "Analysis Tools";
  label: string;
  value: string;
  /** "model" rows open a picker (closes the menu, then reopens it); "cycle" rows step through `values` in place. */
  kind: "model" | "cycle";
  values?: string[];
}

/** Builds the current row list from config state — recomputed on every render so pickers' results show up immediately. */
function buildConfigRows(
  ctx: ExtensionCommandContext,
  solverGap: SolverGapConfig,
  auditor: AuditorConfig = loadAuditorConfig(),
  solverReview: SolverReviewConfig = loadSolverReviewConfig(),
): ConfigRow[] {
  return [
    {
      id: "solver-model",
      section: "Solver",
      label: "Solver model (Claude)",
      value: solverGap.modelId,
      kind: "cycle",
      values: ["haiku", "sonnet", "opus"],
    },
    {
      id: "solvergap-thinking",
      section: "Solver",
      label: "Solver effort",
      value: solverGap.thinkingLevel,
      kind: "cycle",
      values: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "solvergap-timeout",
      section: "Solver",
      label: "Solver timeout",
      value: `${solverGap.timeoutMinutes} min`,
      kind: "cycle",
      values: Array.from(
        {
          length: Math.floor((SOLVER_GAP_TIMEOUT_MAX_MINUTES - SOLVER_GAP_TIMEOUT_MIN_MINUTES) / 10) + 1,
        },
        (_, i) => SOLVER_GAP_TIMEOUT_MIN_MINUTES + i * 10,
      ).map((v) => `${v} min`),
    },
    {
      id: "solvergap-solver-count",
      section: "Solver",
      label: "Parallel agents",
      value: String(solverGap.solverCount),
      kind: "cycle",
      values: Array.from(
        { length: SOLVER_GAP_SOLVER_COUNT_MAX - SOLVER_GAP_SOLVER_COUNT_MIN + 1 },
        (_, i) => `${SOLVER_GAP_SOLVER_COUNT_MIN + i}`,
      ),
    },
    {
      id: "solverreview-model",
      section: "Solver",
      label: "Solver reviewer model (Claude)",
      value: solverReview.modelId,
      kind: "cycle",
      values: ["haiku", "sonnet", "opus"],
    },
    {
      id: "solverreview-effort",
      section: "Solver",
      label: "Solver reviewer effort",
      value: solverReview.thinkingLevel,
      kind: "cycle",
      values: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "solverreview-timeout",
      section: "Solver",
      label: "Solver reviewer timeout",
      value: `${solverReview.timeoutMinutes} min`,
      kind: "cycle",
      values: Array.from(
        { length: Math.floor((SOLVER_REVIEW_TIMEOUT_MAX_MINUTES - SOLVER_REVIEW_TIMEOUT_MIN_MINUTES) / 10) + 1 },
        (_, i) => SOLVER_REVIEW_TIMEOUT_MIN_MINUTES + i * 10,
      ).map((v) => `${v} min`),
    },
    {
      id: "quality-test-solution-mode",
      section: "Quality Checks",
      label: "Test and Solution Quality",
      value: loadQualityCheckConfig().testSolutionMode,
      kind: "cycle",
      values: ["sequential", "parallel"],
    },
    {
      id: "analyze-enabled",
      section: "Analysis Tools",
      label: "Enabled here",
      value: isAnalyzeProjectEnabled(ctx.cwd) ? "on" : "off",
      kind: "cycle",
      values: ["on", "off"],
    },
    {
      id: "auditor-model",
      section: "Analysis Tools",
      label: "Auditor model (Claude)",
      value: auditor.modelId,
      kind: "cycle",
      values: ["haiku", "sonnet", "opus"],
    },
    {
      id: "auditor-effort",
      section: "Analysis Tools",
      label: "Auditor effort",
      value: auditor.thinkingLevel,
      kind: "cycle",
      values: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "auditor-timeout",
      section: "Analysis Tools",
      label: "Timeout per reviewer",
      value: `${auditor.timeoutMinutes} min`,
      kind: "cycle",
      values: Array.from(
        { length: Math.floor((AUDITOR_TIMEOUT_MAX_MINUTES - AUDITOR_TIMEOUT_MIN_MINUTES) / 10) + 1 },
        (_, i) => AUDITOR_TIMEOUT_MIN_MINUTES + i * 10,
      ).map((v) => `${v} min`),
    },
    {
      id: "auditor-concurrency",
      section: "Analysis Tools",
      label: "Parallel auditor reviewers",
      value: String(auditor.concurrency),
      kind: "cycle",
      values: Array.from(
        { length: AUDITOR_CONCURRENCY_MAX - AUDITOR_CONCURRENCY_MIN + 1 },
        (_, i) => `${AUDITOR_CONCURRENCY_MIN + i}`,
      ),
    },
  ];
}

/** Custom row-based menu component: renders Solver, Quality Checks and Analysis Tools rows. Cycling rows update and persist in place; only model rows exit the overlay to run a picker. */
class ConfigMenuComponent {
  selectedIndex = 0;
  private rows: ConfigRow[];
  constructor(
    private ctx: ExtensionCommandContext,
    private settingsListTheme: ReturnType<typeof getSettingsListTheme>,
    private theme: Theme,
    private onCycleSaved: () => void,
    private onActivateModel: (id: ConfigRowId) => void,
    private onExit: () => void,
  ) {
    this.rows = buildConfigRows(ctx, loadSolverGapConfig());
  }

  /** Recompute rows from the latest saved config (used after a model picker returns) without resetting selection. */
  refresh() {
    this.rows = buildConfigRows(this.ctx, loadSolverGapConfig());
    this.selectedIndex = Math.min(this.selectedIndex, this.rows.length - 1);
  }

  invalidate() {}

  render(_width: number): string[] {
    const lines: string[] = [];
    const maxLabelWidth = Math.min(30, Math.max(...this.rows.map((r) => r.label.length)));
    let lastSection: string | undefined;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (!row) continue;
      if (row.section !== lastSection) {
        if (lastSection !== undefined) lines.push("");
        lines.push(this.theme.bold(this.theme.fg("accent", row.section)));
        lastSection = row.section;
      }
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.settingsListTheme.cursor : "  ";
      const labelPadded = row.label + " ".repeat(Math.max(0, maxLabelWidth - row.label.length));
      const labelText = this.settingsListTheme.label(labelPadded, isSelected);
      const valueText = this.settingsListTheme.value(row.value, isSelected);
      lines.push(`${prefix}${labelText}  ${valueText}`);
    }
    return lines;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onExit();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex === 0 ? this.rows.length - 1 : this.selectedIndex - 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.selectedIndex === this.rows.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || data === " ") {
      const row = this.rows[this.selectedIndex];
      if (!row) return;
      if (row.kind === "model") {
        this.onActivateModel(row.id);
        return;
      }
      if (!row.values || row.values.length === 0) return;
      const solverGap = loadSolverGapConfig();
      const currentIndex = row.values.indexOf(row.value);
      const nextValue = row.values[(currentIndex + 1) % row.values.length];
      if (nextValue === undefined) return;
      if (row.id === "solver-model") {
        saveSolverGapConfig({ ...solverGap, modelId: nextValue });
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id === "solvergap-timeout") {
        saveSolverGapConfig({ ...solverGap, timeoutMinutes: Number.parseInt(nextValue, 10) });
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id === "solvergap-solver-count") {
        saveSolverGapConfig({ ...solverGap, solverCount: Number.parseInt(nextValue, 10) });
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id.startsWith("solverreview-")) {
        const solverReview = loadSolverReviewConfig();
        if (row.id === "solverreview-model") solverReview.modelId = nextValue;
        else if (row.id === "solverreview-effort") solverReview.thinkingLevel = nextValue as ClaudeThinkingLevel;
        else solverReview.timeoutMinutes = Number.parseInt(nextValue, 10);
        saveSolverReviewConfig(solverReview);
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id === "quality-test-solution-mode") {
        saveQualityCheckConfig({ testSolutionMode: nextValue as QualityTestSolutionMode });
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id.startsWith("auditor-")) {
        const auditor = loadAuditorConfig();
        if (row.id === "auditor-model") auditor.modelId = nextValue;
        else if (row.id === "auditor-effort") auditor.thinkingLevel = nextValue as ClaudeThinkingLevel;
        else if (row.id === "auditor-timeout") auditor.timeoutMinutes = Number.parseInt(nextValue, 10);
        else auditor.concurrency = Number.parseInt(nextValue, 10);
        saveAuditorConfig(auditor);
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id === "solvergap-thinking") {
        saveSolverGapConfig({ ...solverGap, thinkingLevel: nextValue as ClaudeThinkingLevel });
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (row.id === "analyze-enabled") setAnalyzeProjectEnabled(this.ctx.cwd, nextValue === "on");
      this.refresh();
      this.onCycleSaved();
    }
  }
}

/** Interactive `/checks --config` settings menu with Solver, Quality Checks and Analysis Tools sections; Ctrl+S (or Esc) saves and exits. */
async function runConfigFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/checks --config requires interactive mode", "error");
    return;
  }

  let selectedIndex = 0;
  for (;;) {
    const activated = await ctx.ui.custom<ConfigRowId | undefined>((tui, theme, _kb, done) => {
      const menu = new ConfigMenuComponent(
        ctx,
        getSettingsListTheme(),
        theme,
        () => {
          analyzeToolSettingChanged(pi, ctx.cwd);
          tui.requestRender();
        },
        (id) => done(id),
        () => done(undefined),
      );
      menu.selectedIndex = selectedIndex;

      const container = new Container();
      container.addChild(new Text(theme.bold(theme.fg("accent", "Checks settings"))));
      container.addChild({
        render: (width: number) => menu.render(width),
        invalidate: () => menu.invalidate(),
      });
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  ctrl+s save & exit  esc cancel")));

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          menu.handleInput(data);
          selectedIndex = menu.selectedIndex;
          tui.requestRender();
        },
      };
    });

    // every row cycles in place; only exiting the menu ends the loop
    if (!activated) return;
  }
}

function prepareLocalSolverReviewWorkspace(repoDir: string, workspaceDir: string, results: SolverRunResult[]): void {
  for (const file of ["agent_prompt.md", "test.patch", "solution.patch", "Dockerfile"]) {
    rmSync(join(workspaceDir, file), { recursive: true, force: true });
  }
  const assetsDir = join(workspaceDir, "review_assets");
  mkdirSync(assetsDir, { recursive: true });
  copyFileSync(join(repoDir, "agent_prompt.md"), join(assetsDir, "agent_prompt.md"));
  const testPatch = readFileSync(join(repoDir, "test.patch"), "utf-8");
  copyFileSync(join(repoDir, "test.patch"), join(assetsDir, "test.patch"));
  if (existsSync(join(repoDir, "solution.patch"))) {
    copyFileSync(join(repoDir, "solution.patch"), join(assetsDir, "reference_solution.patch"));
  }
  for (const file of extractNewFilesFromPatch(testPatch)) {
    const path = join(assetsDir, "proposed_tests", file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, "utf-8");
  }

  for (const result of results) {
    const dir = join(assetsDir, `solver_${result.index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "solver_solution.patch"), result.diff, "utf-8");
    writeFileSync(join(dir, "agent_output.txt"), result.agentOutput ?? "", "utf-8");
    writeFileSync(join(dir, "base_test_output.txt"), result.baseTests?.output ?? "not run", "utf-8");
    writeFileSync(join(dir, "new_test_output.txt"), result.newTests?.output ?? "not run", "utf-8");
    writeFileSync(
      join(dir, "result.json"),
      `${JSON.stringify(
        {
          index: result.index,
          status: result.status,
          passed: result.passed,
          baseTests: result.baseTests && {
            passed: result.baseTests.passed,
            exitCode: result.baseTests.exitCode,
            totalTests: result.baseTests.totalTests,
            failedTests: result.baseTests.failedTests,
            erroredTests: result.baseTests.erroredTests,
            skippedTests: result.baseTests.skippedTests,
          },
          newTests: result.newTests && {
            passed: result.newTests.passed,
            exitCode: result.newTests.exitCode,
            totalTests: result.newTests.totalTests,
            failedTests: result.newTests.failedTests,
            erroredTests: result.newTests.erroredTests,
            skippedTests: result.newTests.skippedTests,
          },
          error: result.error,
          tokenUsage: result.tokenUsage,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
}

export function registerChecksCommand(pi: ExtensionAPI) {
  pi.registerCommand("checks", {
    description: "Configure checks or run the solve benchmark.",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      let sub = args.trim();
      if (!sub) {
        const choice = await ctx.ui.select("Choose a checks action", [...COMMAND_MENU_OPTIONS]);
        if (!choice) return;
        sub = `--${choice}`;
      }
      const tokens = [...new Set(sub.split(/\s+/).filter(Boolean))];
      const known = new Set(COMMAND_COMPLETIONS.map((option) => option.value));
      const unknown = tokens.filter((token) => !known.has(token));
      if (unknown.length) {
        ctx.ui.notify(
          `Unknown argument(s): ${unknown.join(", ")}. Run /checks with no arguments to see options.`,
          "warning",
        );
        return;
      }
      if (tokens.length !== 1) {
        ctx.ui.notify("Use one of `--config` or `--solve` at a time.", "warning");
        return;
      }
      if (tokens[0] === "--config") {
        await runConfigFlow(pi, ctx);
        return;
      }
      const runClaudeBenchmark = true;
      if (isReviewInProgress()) {
        ctx.ui.notify("A checks run is already in progress.", "warning");
        return;
      }
      const config = loadChecksConfig();
      const reviewerConfig = loadSolverReviewConfig();
      const reviewerModelName = `claude-cli/${reviewerConfig.modelId}`;
      const requiredFiles = [...REQUIRED_FILES, "Dockerfile", "test.patch"];
      const missingFiles = (files: string[]) => files.filter((file) => !existsSync(join(ctx.cwd, file)));
      const missing = missingFiles(["create_patches.sh", ...requiredFiles]);
      if (missing.length) {
        ctx.ui.notify(`Missing required file(s): ${missing.join(", ")}`, "error");
        return;
      }
      const solverConfig: SolverGapConfig = loadSolverGapConfig();
      const abort = startReview();
      const solverCount = solverConfig.solverCount;
      const total = solverCount + 1;
      const progressStartedAt = Date.now();
      let progressLabel = "running create_patches.sh";
      let progressDone = 0;
      let progressShowBar = false;
      const updateProgress = (label = progressLabel, done = progressDone, showBar = progressShowBar) => {
        progressLabel = label;
        progressDone = done;
        progressShowBar = showBar;
        ctx.ui.setWidget(
          PROGRESS_WIDGET_KEY,
          renderProgressLines(label, done, total, { showBar, startedAt: progressStartedAt }),
        );
      };
      const progressTimer = setInterval(() => updateProgress(), 1000);
      updateProgress();
      ctx.ui.notify(`checks (${tokens.join(" ")}) started. Press ${CANCEL_SHORTCUT_LABEL} to cancel.`, "info");
      let tempDir: string | undefined;
      try {
        // Regenerate test.patch and solution.patch first, like the quality checks do.
        await runCreatePatches(pi, ctx.cwd, abort.signal);
        if (abort.signal.aborted) return;
        const missingAfterPatches = missingFiles(requiredFiles);
        if (missingAfterPatches.length) {
          ctx.ui.notify(`Missing required file(s) after create_patches.sh: ${missingAfterPatches.join(", ")}`, "error");
          return;
        }
        const taskPrompt = readFileSync(join(ctx.cwd, "agent_prompt.md"), "utf-8");
        const dir = join(tmpdir(), `checks-${randomUUID()}`);
        mkdirSync(dir, { recursive: true });
        tempDir = dir;
        const snapshot = await snapshotGitHead(pi, ctx.cwd, dir, abort.signal);
        if (snapshot.status === "error") {
          ctx.ui.notify(`checks: ${snapshot.error}`, "error");
          return;
        }
        if (abort.signal.aborted) return;
        let completed = 0;
        let solverResults: SolverRunResult[] = [];
        let solverReview: SolverReviewResult | undefined;
        let fargateResourceUsage: FargateResourceUsage | undefined;
        if (runClaudeBenchmark && solverConfig) {
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
          const completedSolvers = new Map<number, SolverRunResult>();
          let remoteStarted = false;
          const solverStatusText = () =>
            Array.from({ length: solverCount }, (_, index) => {
              const result = completedSolvers.get(index + 1);
              return result ? `${index + 1}${result.passed ? "✓" : "✗"}` : `${index + 1}…`;
            }).join(" ");
          const renderSolverProgress = (phase: string) => {
            if (phase === "running agents" || phase === "reviewing solutions") remoteStarted = true;
            const showBar =
              remoteStarted &&
              (phase === "running agents" || phase === "reviewing solutions" || phase === "finalizing");
            const label = phase === "running agents" ? `${phase} (${solverStatusText()})` : phase;
            const currentResults = [...completedSolvers.values()];
            updateProgress(label, completed + currentResults.length, showBar);
          };
          const recordSolverProgress = (results: SolverRunResult[]) => {
            for (const result of results) completedSolvers.set(result.index, result);
            renderSolverProgress("running agents");
          };
          const recordSolverCompletion = (result: SolverRunResult) => {
            completedSolvers.set(result.index, result);
            renderSolverProgress("finalizing");
          };
          renderSolverProgress("preparing image");
          const runId = formatLocalTimestamp().replace(/[:.]/g, "-");
          const solverRun = await runFargateClaudeBenchmark({
            pi,
            repoDir: ctx.cwd,
            snapshotDir: dir,
            taskPrompt,
            config,
            solverConfig,
            cancelSignal: abort.signal,
            runId,
            onSolverCompleted: recordSolverCompletion,
            onSolverProgress: recordSolverProgress,
            onResourceUsage: (usage) => {
              fargateResourceUsage = usage;
            },
            onPhase: renderSolverProgress,
          });
          solverResults = solverRun.results;
          fargateResourceUsage = solverRun.resourceUsage ?? fargateResourceUsage;
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
          renderSolverProgress("reviewing solutions");
          try {
            prepareLocalSolverReviewWorkspace(ctx.cwd, dir, solverResults);
            const review = await runSolverReview({
              tempDir: dir,
              config: reviewerConfig,
              taskPrompt,
              solverResults,
              testGuidelines: loadTestGuidelines(),
              fairnessRules: loadFairnessRules(),
              hasReferenceSolution: existsSync(join(ctx.cwd, "solution.patch")),
              cancelSignal: abort.signal,
            });
            solverReview = { ...review, model: reviewerModelName, thinkingLevel: reviewerConfig.thinkingLevel };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            solverReview = {
              status: "error",
              text: message,
              model: reviewerModelName,
              thinkingLevel: reviewerConfig.thinkingLevel,
              error: message,
            };
          }
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
          const runDir = join(ctx.cwd, SOLVER_ARTIFACTS_DIRNAME, runId);
          mkdirSync(runDir, { recursive: true });
          writeFileSync(
            join(runDir, "fairness_review.md"),
            solverReview.text || solverReview.error || "No reviewer output.",
            "utf-8",
          );
          completed += 1;
          renderSolverProgress("finalizing");
          if (fargateResourceUsage) persistFargateResourceUsage(ctx.cwd, fargateResourceUsage);
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }
        const merged = mergeReport({
          existingReport: loadExistingReport(join(ctx.cwd, "shipd_report.json")),
          runGapFinder: false,
          testGaps: [],
          gapAnalysisIncomplete: false,
          gapFinderStatus: "ok",
          gapFilterStatus: "ok",
          runClaudeBenchmark,
          solverConfig,
          solverResults,
          fargateResourceUsage,
          solverReview,
        });
        const summary = buildRunSummary({ merged, runGapFinder: false, runClaudeBenchmark });
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
        clearInterval(progressTimer);
        ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        endReview();
      }
    },
  });
}
