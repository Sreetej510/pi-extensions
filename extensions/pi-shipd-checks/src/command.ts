/** The `/checks` command: behavioral and solver-based gap finders only. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import {
  runGapValidator,
  runGapFinder as runSentenceGapFinder,
  runSolverAgent,
  runSolverComparisonReviewer,
} from "./agents.js";
import {
  getSupportedThinkingLevels,
  loadChecksConfig,
  loadEnabledModelRefs,
  loadSolverGapConfig,
  SOLVER_GAP_DEFAULT_SAVE_ARTIFACTS,
  SOLVER_GAP_DEFAULT_SOLVER_COUNT,
  SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES,
  SOLVER_GAP_SOLVER_COUNT_MAX,
  SOLVER_GAP_SOLVER_COUNT_MIN,
  SOLVER_GAP_TIMEOUT_MAX_MINUTES,
  SOLVER_GAP_TIMEOUT_MIN_MINUTES,
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
  StatementGapReport,
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

/** Model-only picker (no thinking-level step) for the config menu's model rows; thinking level is a separate cycling row. */
async function pickModelOnly(
  ctx: ExtensionCommandContext,
  existingConfig: { provider: string; modelId: string } | null,
  selectLabel: string,
): Promise<{ provider: string; modelId: string } | null> {
  const refs = loadEnabledModelRefs();
  if (refs.length === 0) {
    ctx.ui.notify("No enabledModels configured in settings.json.", "error");
    return null;
  }
  const available = ctx.modelRegistry.getAll();
  const labeled = refs
    .map((ref) => {
      const parsed = splitProviderModel(ref);
      if (!parsed) return null;
      const found = available.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
      const isCurrent = existingConfig?.provider === parsed.provider && existingConfig?.modelId === parsed.modelId;
      const base = found ? `${found.name} (${ref})` : ref;
      return { ref, parsed, display: isCurrent ? `${base} [current]` : base, isCurrent };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (labeled.length === 0) {
    ctx.ui.notify("Could not resolve any enabledModels entries.", "error");
    return null;
  }

  const orderedModels = [...labeled].sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
  const choice = await ctx.ui.select(
    selectLabel,
    orderedModels.map((l) => l.display),
  );
  if (!choice) return null;
  const selected = labeled.find((l) => l.display === choice);
  if (!selected) return null;
  return { provider: selected.parsed.provider, modelId: selected.parsed.modelId };
}

/** Supported thinking levels for the model currently saved at `provider`/`modelId`, or just `["off"]` if unresolvable. */
function supportedThinkingLevelsFor(ctx: ExtensionCommandContext, provider: string, modelId: string): ThinkingLevel[] {
  const model = ctx.modelRegistry.getAll().find((m) => m.provider === provider && m.id === modelId);
  return getSupportedThinkingLevels(model);
}

const DEFAULT_SOLVER_GAP: SolverGapConfig = {
  provider: "",
  modelId: "",
  thinkingLevel: "off",
  timeoutMinutes: SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES,
  solverCount: SOLVER_GAP_DEFAULT_SOLVER_COUNT,
  saveArtifacts: SOLVER_GAP_DEFAULT_SAVE_ARTIFACTS,
};

type ConfigRowId =
  | "reviewer-model"
  | "reviewer-thinking"
  | "solvergap-model"
  | "solvergap-thinking"
  | "solvergap-timeout"
  | "solvergap-solver-count"
  | "solvergap-save-artifacts";

interface ConfigRow {
  id: ConfigRowId;
  section: "Reviewer" | "Solver";
  label: string;
  value: string;
  /** "model" rows open a picker (closes the menu, then reopens it); "cycle" rows step through `values` in place. */
  kind: "model" | "cycle";
  values?: string[];
}

/** Builds the current row list from config state — recomputed on every render so pickers' results show up immediately. */
function buildConfigRows(
  ctx: ExtensionCommandContext,
  current: ChecksConfigLike | null,
  solverGap: SolverGapConfig,
): ConfigRow[] {
  const reviewerLevels = current ? supportedThinkingLevelsFor(ctx, current.provider, current.modelId) : ["off"];
  const solverGapLevels = solverGap.provider
    ? supportedThinkingLevelsFor(ctx, solverGap.provider, solverGap.modelId)
    : ["off"];
  return [
    {
      id: "reviewer-model",
      section: "Reviewer",
      label: "Model",
      value: current ? `${current.provider}/${current.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "reviewer-thinking",
      section: "Reviewer",
      label: "Thinking level",
      value: current?.thinkingLevel ?? "off",
      kind: "cycle",
      values: reviewerLevels,
    },
    {
      id: "solvergap-model",
      section: "Solver",
      label: "Model",
      value: solverGap.provider ? `${solverGap.provider}/${solverGap.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "solvergap-thinking",
      section: "Solver",
      label: "Thinking level",
      value: solverGap.thinkingLevel,
      kind: "cycle",
      values: solverGapLevels,
    },
    {
      id: "solvergap-timeout",
      section: "Solver",
      label: "Timeout",
      value: `${solverGap.timeoutMinutes} min`,
      kind: "cycle",
      values: [10, 20, 30, 40, 50, SOLVER_GAP_TIMEOUT_MAX_MINUTES]
        .filter((v, i, arr) => v >= SOLVER_GAP_TIMEOUT_MIN_MINUTES && arr.indexOf(v) === i)
        .map((v) => `${v} min`),
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
      id: "solvergap-save-artifacts",
      section: "Solver",
      label: "Save artifacts",
      value: solverGap.saveArtifacts ? "on" : "off",
      kind: "cycle",
      values: ["on", "off"],
    },
  ];
}

type ChecksConfigLike = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  solverGap?: SolverGapConfig;
};

/** Custom row-based menu component: renders section headers inline between "Reviewer" and "Solver" rows. Cycling rows update and persist in place (no overlay teardown); only model rows exit the overlay to run a picker. */
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
    this.rows = buildConfigRows(ctx, loadChecksConfig(), loadChecksConfig()?.solverGap ?? DEFAULT_SOLVER_GAP);
  }

  /** Recompute rows from the latest saved config (used after a model picker returns) without resetting selection. */
  refresh() {
    const current = loadChecksConfig();
    this.rows = buildConfigRows(this.ctx, current, current?.solverGap ?? DEFAULT_SOLVER_GAP);
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
      const current = loadChecksConfig();
      if (!current) {
        this.ctx.ui.notify(
          "Set the reviewer model first — it's required before solver-gap-finder settings.",
          "warning",
        );
        return;
      }
      const solverGap = current.solverGap ?? DEFAULT_SOLVER_GAP;
      const currentIndex = row.values.indexOf(row.value);
      const nextValue = row.values[(currentIndex + 1) % row.values.length];
      if (nextValue === undefined) return;
      if (row.id === "reviewer-thinking") {
        saveChecksConfig({ ...current, thinkingLevel: nextValue as ThinkingLevel, solverGap });
      } else if (row.id === "solvergap-thinking") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, thinkingLevel: nextValue as ThinkingLevel } });
      } else if (row.id === "solvergap-timeout") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, timeoutMinutes: Number.parseInt(nextValue, 10) } });
      } else if (row.id === "solvergap-solver-count") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, solverCount: Number.parseInt(nextValue, 10) } });
      } else if (row.id === "solvergap-save-artifacts") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, saveArtifacts: nextValue === "on" } });
      }
      this.refresh();
      this.onCycleSaved();
    }
  }
}

/** Interactive `/checks --config` settings menu: a single row-based menu with "Reviewer" / "Solver" section headers; Ctrl+S (or Esc) saves and exits. */
async function runConfigFlow(ctx: ExtensionCommandContext) {
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
        () => tui.requestRender(),
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

    if (!activated) return;

    const current = loadChecksConfig();
    const solverGap = current?.solverGap ?? DEFAULT_SOLVER_GAP;

    if (activated === "reviewer-model") {
      const picked = await pickModelOnly(ctx, current, "Select reviewer model");
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(current?.thinkingLevel ?? "off")
        ? (current?.thinkingLevel ?? "off")
        : (levels[0] ?? "off");
      saveChecksConfig({ ...picked, thinkingLevel, solverGap });
      ctx.ui.notify(`Reviewer model saved: ${picked.provider}/${picked.modelId}`, "info");
      continue;
    }

    if (activated === "solvergap-model") {
      if (!current) {
        ctx.ui.notify("Set the reviewer model first — it's required before solver-gap-finder settings.", "warning");
        continue;
      }
      const picked = await pickModelOnly(ctx, solverGap.provider ? solverGap : null, "Select solver model");
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(solverGap.thinkingLevel) ? solverGap.thinkingLevel : (levels[0] ?? "off");
      saveChecksConfig({ ...current, solverGap: { ...solverGap, ...picked, thinkingLevel } });
      ctx.ui.notify(`Solver model saved: ${picked.provider}/${picked.modelId}`, "info");
    }
  }
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
      const total = (runGapFinder ? 2 : 0) + (runSolverGapFinder ? solverCount + 1 : 0);
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
        let statementReports: GapStageResult<StatementGapReport> = { status: "ok", gaps: [] };
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
          ctx.ui.setWidget(
            PROGRESS_WIDGET_KEY,
            renderProgressLines("finding sentence-by-sentence test gaps", completed, total),
          );
          statementReports = await runSentenceGapFinder(base);
          completed += 1;
          ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("reviewing test gaps", completed, total));
          const candidateCount = statementReports.gaps.reduce((count, report) => count + report.gaps.length, 0);
          if (candidateCount > 0)
            filtered = await runGapValidator({ ...base, statementReports: statementReports.gaps });
          completed += 1;
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }
        let solverResults: SolverRunResult[] = [];
        let comparison: GapStageResult<SolverGap> = { status: "ok", gaps: [] };
        if (runSolverGapFinder && solverConfig) {
          const completedSolvers: SolverRunResult[] = [];
          const recordSolverCompletion = (result: SolverRunResult) => {
            completedSolvers.push(result);
            completed += 1;
            ctx.ui.setWidget(
              PROGRESS_WIDGET_KEY,
              renderProgressLines("solver gap finder: solving", completed, total, {
                passed: completedSolvers.filter((solver) => solver.passed).length,
                failed: completedSolvers.filter((solver) => !solver.passed).length,
              }),
            );
          };
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
              if (setup.status !== "ok") {
                const result = {
                  index,
                  status: setup.status,
                  passed: false,
                  diff: "",
                  testOutputTail: setup.error,
                  durationMs: 0,
                  totalTests: null,
                  failedTests: null,
                } satisfies SolverRunResult;
                recordSolverCompletion(result);
                return result;
              }
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
              const solverResult = { ...result, artifactsDir };
              recordSolverCompletion(solverResult);
              return solverResult;
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
          (statementReports.status !== "ok" || (statementReports.gaps.length > 0 && filtered.status !== "ok"));
        const merged = mergeReport({
          existingReport: loadExistingReport(join(ctx.cwd, "shipd_report.json")),
          config,
          runGapFinder,
          testGaps: filtered.gaps,
          gapAnalysisIncomplete: incomplete,
          gapFinderStatus: statementReports.status,
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
