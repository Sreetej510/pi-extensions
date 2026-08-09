/** The `/checks` command: configuration and solver-based gap finding. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { runSolverComparisonReviewer } from "./agents.js";
import {
  getSupportedThinkingLevels,
  isAnalyzeToolEnabled,
  loadAnalyzeEnabledProjects,
  loadChecksConfig,
  loadEnabledModelRefs,
  loadSolverGapConfig,
  recordFargateResourceUsage,
  SOLVER_GAP_DEFAULT_SAVE_ARTIFACTS,
  SOLVER_GAP_DEFAULT_SOLVER_COUNT,
  SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES,
  SOLVER_GAP_SOLVER_COUNT_MAX,
  SOLVER_GAP_SOLVER_COUNT_MIN,
  SOLVER_GAP_TIMEOUT_MAX_MINUTES,
  SOLVER_GAP_TIMEOUT_MIN_MINUTES,
  saveChecksConfig,
  setAnalyzeProjectEnabled,
  splitProviderModel,
} from "./config.js";
import { runFargateSolverGapFinder } from "./fargate-runner.js";
import { snapshotGitHead } from "./git.js";
import { PROGRESS_WIDGET_KEY, renderProgressLines } from "./progress.js";
import { buildRunSummary, formatLocalTimestamp, loadExistingReport, mergeReport, REQUIRED_FILES } from "./report.js";
import { loadFairnessRules, loadTestGuidelines } from "./rubric.js";
import { writeSolverSolutionsToDisk } from "./solvergap.js";
import { endReview, isReviewInProgress, startReview } from "./state.js";
import { analyzeToolSettingChanged } from "./tool-sync.js";
import type {
  AnalyzeGapConfig,
  CommandOption,
  FargateResourceUsage,
  GapStageResult,
  SolverGap,
  SolverGapConfig,
  SolverRunResult,
  ThinkingLevel,
} from "./types.js";

export const CANCEL_SHORTCUT_LABEL = "Ctrl+Shift+X";

const COMMAND_COMPLETIONS: readonly CommandOption[] = [
  { value: "--config", label: "--config", description: "Configure reviewer, gap-finder, and test-audit models" },
  {
    value: "--solver-gap-finder",
    label: "--solver-gap-finder",
    description: "Use TDD solver attempts to find behavioral gaps",
  },
];

const COMMAND_MENU_OPTIONS = ["config", "solver-gap-finder"] as const;

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

const DEFAULT_ANALYZE_GAP: AnalyzeGapConfig = {
  provider: "",
  modelId: "",
  thinkingLevel: "off",
};

type ConfigRowId =
  | "reviewer-model"
  | "reviewer-thinking"
  | "solver-model"
  | "solver-thinking"
  | "solvergap-timeout"
  | "solvergap-solver-count"
  | "solvergap-save-artifacts"
  | "analyze-enabled"
  | "analyze-gap-model"
  | "analyze-gap-thinking"
  | "analyze-audit-model"
  | "analyze-audit-thinking";

interface ConfigRow {
  id: ConfigRowId;
  section: "Solver" | "Analyze Tool";
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
  analyzeGap: AnalyzeGapConfig,
): ConfigRow[] {
  const reviewerLevels = current ? supportedThinkingLevelsFor(ctx, current.provider, current.modelId) : ["off"];
  const solverGapLevels = solverGap.provider
    ? supportedThinkingLevelsFor(ctx, solverGap.provider, solverGap.modelId)
    : ["off"];
  const analyzeGapLevels = analyzeGap.provider
    ? supportedThinkingLevelsFor(ctx, analyzeGap.provider, analyzeGap.modelId)
    : ["off"];
  const testAuditProvider = analyzeGap.testAuditProvider ?? analyzeGap.provider;
  const testAuditModelId = analyzeGap.testAuditModelId ?? analyzeGap.modelId;
  const testAuditLevels = testAuditProvider
    ? supportedThinkingLevelsFor(ctx, testAuditProvider, testAuditModelId)
    : ["off"];
  return [
    {
      id: "solver-model",
      section: "Solver",
      label: "Solver model",
      value: solverGap.provider ? `${solverGap.provider}/${solverGap.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "solver-thinking",
      section: "Solver",
      label: "Solver thinking",
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
    {
      id: "reviewer-model",
      section: "Solver",
      label: "Reviewer model",
      value: current ? `${current.provider}/${current.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "reviewer-thinking",
      section: "Solver",
      label: "Reviewer thinking",
      value: current?.thinkingLevel ?? "off",
      kind: "cycle",
      values: reviewerLevels,
    },
    {
      id: "analyze-enabled",
      section: "Analyze Tool",
      label: "Enabled here",
      value: isAnalyzeToolEnabled(ctx.cwd) ? "on" : "off",
      kind: "cycle",
      values: ["on", "off"],
    },
    {
      id: "analyze-gap-model",
      section: "Analyze Tool",
      label: "Gap finder model",
      value: analyzeGap.provider ? `${analyzeGap.provider}/${analyzeGap.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "analyze-gap-thinking",
      section: "Analyze Tool",
      label: "Gap finder thinking",
      value: analyzeGap.thinkingLevel,
      kind: "cycle",
      values: analyzeGapLevels,
    },
    {
      id: "analyze-audit-model",
      section: "Analyze Tool",
      label: "Test-audit model",
      value: testAuditProvider ? `${testAuditProvider}/${testAuditModelId}` : "not set",
      kind: "model",
    },
    {
      id: "analyze-audit-thinking",
      section: "Analyze Tool",
      label: "Test-audit thinking",
      value: analyzeGap.testAuditThinkingLevel ?? analyzeGap.thinkingLevel,
      kind: "cycle",
      values: testAuditLevels,
    },
  ];
}

type ChecksConfigLike = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  solverGap?: SolverGapConfig;
  enabledProjects?: string[];
  enableAnalyzeTool?: boolean;
  analyzeGap?: AnalyzeGapConfig;
};

/** Custom row-based menu component: renders Solver and Analyze Tool rows. Cycling rows update and persist in place; only model rows exit the overlay to run a picker. */
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
    this.rows = buildConfigRows(
      ctx,
      loadChecksConfig(),
      loadChecksConfig()?.solverGap ?? DEFAULT_SOLVER_GAP,
      loadChecksConfig()?.analyzeGap ?? DEFAULT_ANALYZE_GAP,
    );
  }

  /** Recompute rows from the latest saved config (used after a model picker returns) without resetting selection. */
  refresh() {
    const current = loadChecksConfig();
    this.rows = buildConfigRows(
      this.ctx,
      current,
      current?.solverGap ?? DEFAULT_SOLVER_GAP,
      current?.analyzeGap ?? DEFAULT_ANALYZE_GAP,
    );
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
        this.ctx.ui.notify("Set the reviewer model first — it's required before solver settings", "warning");
        return;
      }
      const solverGap = current.solverGap ?? DEFAULT_SOLVER_GAP;
      const analyzeGap = current.analyzeGap ?? DEFAULT_ANALYZE_GAP;
      const currentIndex = row.values.indexOf(row.value);
      const nextValue = row.values[(currentIndex + 1) % row.values.length];
      if (nextValue === undefined) return;
      if (row.id === "reviewer-thinking") {
        saveChecksConfig({ ...current, thinkingLevel: nextValue as ThinkingLevel, solverGap, analyzeGap });
      } else if (row.id === "solver-thinking") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, thinkingLevel: nextValue as ThinkingLevel } });
      } else if (row.id === "solvergap-timeout") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, timeoutMinutes: Number.parseInt(nextValue, 10) } });
      } else if (row.id === "solvergap-solver-count") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, solverCount: Number.parseInt(nextValue, 10) } });
      } else if (row.id === "solvergap-save-artifacts") {
        saveChecksConfig({ ...current, solverGap: { ...solverGap, saveArtifacts: nextValue === "on" } });
      } else if (row.id === "analyze-enabled") {
        setAnalyzeProjectEnabled(this.ctx.cwd, nextValue === "on");
      } else if (row.id === "analyze-gap-thinking") {
        saveChecksConfig({ ...current, analyzeGap: { ...analyzeGap, thinkingLevel: nextValue as ThinkingLevel } });
      } else if (row.id === "analyze-audit-thinking") {
        saveChecksConfig({
          ...current,
          analyzeGap: { ...analyzeGap, testAuditThinkingLevel: nextValue as ThinkingLevel },
        });
      }
      this.refresh();
      this.onCycleSaved();
    }
  }
}

/** Interactive `/checks --config` settings menu with Solver and Analyze Tool sections; Ctrl+S (or Esc) saves and exits. */
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

    if (!activated) return;

    const current = loadChecksConfig();
    const solverGap = current?.solverGap ?? DEFAULT_SOLVER_GAP;
    const analyzeGap = current?.analyzeGap ?? DEFAULT_ANALYZE_GAP;

    if (activated === "reviewer-model") {
      const picked = await pickModelOnly(ctx, current, "Select reviewer model");
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(current?.thinkingLevel ?? "off")
        ? (current?.thinkingLevel ?? "off")
        : (levels[0] ?? "off");
      saveChecksConfig({
        ...picked,
        thinkingLevel,
        solverGap,
        analyzeGap,
        enabledProjects: current?.enabledProjects ?? loadAnalyzeEnabledProjects(),
        enableAnalyzeTool: current?.enableAnalyzeTool,
      });
      ctx.ui.notify(`Reviewer model saved: ${picked.provider}/${picked.modelId}`, "info");
      continue;
    }

    if (activated === "solver-model") {
      if (!current) {
        ctx.ui.notify("Set the reviewer model first — it's required before solver settings.", "warning");
        continue;
      }
      const picked = await pickModelOnly(ctx, solverGap.provider ? solverGap : null, "Select solver model");
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(solverGap.thinkingLevel) ? solverGap.thinkingLevel : (levels[0] ?? "off");
      saveChecksConfig({ ...current, solverGap: { ...solverGap, ...picked, thinkingLevel } });
      ctx.ui.notify(`Solver model saved: ${picked.provider}/${picked.modelId}`, "info");
      continue;
    }

    if (activated === "analyze-gap-model") {
      if (!current) {
        ctx.ui.notify("Set the reviewer model first — it's required before analyze-tool settings.", "warning");
        continue;
      }
      const picked = await pickModelOnly(ctx, analyzeGap.provider ? analyzeGap : null, "Select gap-finder model");
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(analyzeGap.thinkingLevel) ? analyzeGap.thinkingLevel : (levels[0] ?? "off");
      saveChecksConfig({ ...current, analyzeGap: { ...analyzeGap, ...picked, thinkingLevel } });
      ctx.ui.notify(`Gap-finder model saved: ${picked.provider}/${picked.modelId}`, "info");
      continue;
    }

    if (activated === "analyze-audit-model") {
      if (!current) {
        ctx.ui.notify("Set the reviewer model first — it's required before analyze-tool settings.", "warning");
        continue;
      }
      const currentAudit = analyzeGap.testAuditProvider
        ? {
            provider: analyzeGap.testAuditProvider,
            modelId: analyzeGap.testAuditModelId ?? analyzeGap.modelId,
          }
        : analyzeGap.provider
          ? { provider: analyzeGap.provider, modelId: analyzeGap.modelId }
          : null;
      const picked = await pickModelOnly(ctx, currentAudit, "Select test-audit model");
      if (!picked) continue;
      const currentThinking = analyzeGap.testAuditThinkingLevel ?? analyzeGap.thinkingLevel;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(currentThinking) ? currentThinking : (levels[0] ?? "off");
      saveChecksConfig({
        ...current,
        analyzeGap: {
          ...analyzeGap,
          testAuditProvider: picked.provider,
          testAuditModelId: picked.modelId,
          testAuditThinkingLevel: thinkingLevel,
        },
      });
      ctx.ui.notify(`Test-audit model saved: ${picked.provider}/${picked.modelId}`, "info");
    }
  }
}

export function registerChecksCommand(pi: ExtensionAPI) {
  pi.registerCommand("checks", {
    description: "Configure checks or run the solver-based behavioral gap finder.",
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
          `Unknown option(s): ${unknown.join(", ")}. Run /checks with no arguments to see options.`,
          "warning",
        );
        return;
      }
      if (tokens.includes("--config")) {
        if (tokens.length > 1) ctx.ui.notify("--config cannot be combined with other options.", "warning");
        else await runConfigFlow(pi, ctx);
        return;
      }
      const runSolverGapFinder = tokens.includes("--solver-gap-finder");
      if (!runSolverGapFinder) return;
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
      const total = solverCount + 1;
      const progressStartedAt = Date.now();
      let progressLabel = runSolverGapFinder ? "preparing image" : "preparing clean snapshot";
      let progressDone = 0;
      let progressShowBar = !runSolverGapFinder;
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
        const dir = join(tmpdir(), `checks-${randomUUID()}`);
        mkdirSync(dir, { recursive: true });
        tempDir = dir;
        const snapshot = await snapshotGitHead(pi, ctx.cwd, dir, abort.signal);
        if (snapshot.status === "error") {
          ctx.ui.notify(`checks: ${snapshot.error}`, "error");
          return;
        }
        if (abort.signal.aborted) return;
        for (const file of REQUIRED_FILES) copyFileSync(join(ctx.cwd, file), join(dir, file));
        const testRubric = loadTestGuidelines();
        const fairnessRules = loadFairnessRules();
        let completed = 0;
        let solverResults: SolverRunResult[] = [];
        let fargateResourceUsage: FargateResourceUsage | undefined;
        let comparison: GapStageResult<SolverGap> = { status: "ok", gaps: [] };
        if (runSolverGapFinder && solverConfig) {
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
            if (phase === "running agents") remoteStarted = true;
            const showBar = remoteStarted && (phase === "running agents" || phase === "finalizing");
            const label = phase === "running agents" ? `${phase} (${solverStatusText()})` : phase;
            const solverResults = [...completedSolvers.values()];
            updateProgress(label, completed + solverResults.length, showBar);
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
          solverResults = await runFargateSolverGapFinder({
            pi,
            repoDir: ctx.cwd,
            snapshotDir: dir,
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
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
          if (solverResults.some((result) => result.status !== "patchFailed" && result.status !== "error")) {
            renderSolverProgress("finalizing");
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
          renderSolverProgress("finalizing");
          if (fargateResourceUsage) saveChecksConfig(recordFargateResourceUsage(config, ctx.cwd, fargateResourceUsage));
          if (abort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }
        const merged = mergeReport({
          existingReport: loadExistingReport(join(ctx.cwd, "shipd_report.json")),
          config,
          runGapFinder: false,
          testGaps: [],
          gapAnalysisIncomplete: false,
          gapFinderStatus: "ok",
          gapFilterStatus: "ok",
          runSolverGapFinder,
          solverResults,
          fargateResourceUsage,
          solverGaps: comparison.gaps,
          solverGapAnalysisIncomplete:
            runSolverGapFinder &&
            (solverResults.some((result) => result.status === "error") || comparison.status !== "ok"),
          solverComparisonStatus: comparison.status,
        });
        const summary = buildRunSummary({ merged, runGapFinder: false, runSolverGapFinder });
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
