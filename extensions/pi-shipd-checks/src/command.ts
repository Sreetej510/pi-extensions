/** The `/checks` command: settings and the `solve` Claude CLI benchmark. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { runSolverReview } from "./agents.js";
import {
  ANALYZE_DEFAULT_TIMEOUT_MINUTES,
  ANALYZE_TIMEOUT_MAX_MINUTES,
  ANALYZE_TIMEOUT_MIN_MINUTES,
  getSupportedThinkingLevels,
  isAnalyzeToolEnabled,
  loadAnalyzeEnabledProjects,
  loadChecksConfig,
  loadEnabledModelRefs,
  loadSolverGapConfig,
  persistFargateResourceUsage,
  SOLVER_GAP_SOLVER_COUNT_MAX,
  SOLVER_GAP_SOLVER_COUNT_MIN,
  SOLVER_GAP_TIMEOUT_MAX_MINUTES,
  SOLVER_GAP_TIMEOUT_MIN_MINUTES,
  saveChecksConfig,
  saveSolverGapConfig,
  setAnalyzeProjectEnabled,
  splitProviderModel,
} from "./config.js";
import { runFargateClaudeBenchmark } from "./fargate-runner.js";
import { snapshotGitHead } from "./git.js";
import { PROGRESS_WIDGET_KEY, renderProgressLines } from "./progress.js";
import { buildRunSummary, formatLocalTimestamp, loadExistingReport, mergeReport, REQUIRED_FILES } from "./report.js";
import { loadFairnessRules, loadTestGuidelines } from "./rubric.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import { endReview, isReviewInProgress, startReview } from "./state.js";
import { analyzeToolSettingChanged } from "./tool-sync.js";
import type {
  AnalyzeGapConfig,
  ChecksConfig,
  ClaudeThinkingLevel,
  CommandOption,
  FargateResourceUsage,
  SolverGapConfig,
  SolverReviewResult,
  SolverRunResult,
  ThinkingLevel,
} from "./types.js";

export const CANCEL_SHORTCUT_LABEL = "Ctrl+Shift+X";

const COMMAND_COMPLETIONS: readonly CommandOption[] = [
  {
    value: "--config",
    label: "--config",
    description: "Configure local Pi reviewer, analysis tools, and Claude solvers",
  },
  { value: "solve", label: "solve", description: "Run Claude agents on agent_prompt.md" },
];

const COMMAND_MENU_OPTIONS = ["config", "solve"] as const;

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

const DEFAULT_ANALYZE_GAP: AnalyzeGapConfig = {
  provider: "",
  modelId: "",
  thinkingLevel: "off",
  timeoutMinutes: ANALYZE_DEFAULT_TIMEOUT_MINUTES,
};

function getAnalyzeGapConfig(current: ChecksConfigLike | null): AnalyzeGapConfig {
  const configured = current?.analyzeGap;
  const configuredTimeout = configured?.timeoutMinutes;
  const timeoutMinutes =
    typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout)
      ? Math.min(ANALYZE_TIMEOUT_MAX_MINUTES, Math.max(ANALYZE_TIMEOUT_MIN_MINUTES, configuredTimeout))
      : ANALYZE_DEFAULT_TIMEOUT_MINUTES;
  return { ...DEFAULT_ANALYZE_GAP, ...configured, timeoutMinutes };
}

type ConfigRowId =
  | "solver-model"
  | "solvergap-thinking"
  | "reviewer-model"
  | "reviewer-thinking"
  | "solvergap-timeout"
  | "solvergap-solver-count"
  | "analyze-enabled"
  | "analyze-timeout"
  | "analyze-gap-model"
  | "analyze-gap-thinking";

interface ConfigRow {
  id: ConfigRowId;
  section: "Solver" | "Analysis Tools";
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
  const analyzeGapLevels = analyzeGap.provider
    ? supportedThinkingLevelsFor(ctx, analyzeGap.provider, analyzeGap.modelId)
    : ["off"];
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
      label: "Thinking level",
      value: solverGap.thinkingLevel,
      kind: "cycle",
      values: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "solvergap-timeout",
      section: "Solver",
      label: "Timeout",
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
      id: "reviewer-model",
      section: "Solver",
      label: "Local reviewer model (Pi)",
      value: current ? `${current.provider}/${current.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "reviewer-thinking",
      section: "Solver",
      label: "Local reviewer thinking",
      value: current?.thinkingLevel ?? "off",
      kind: "cycle",
      values: reviewerLevels,
    },
    {
      id: "analyze-enabled",
      section: "Analysis Tools",
      label: "Enabled here",
      value: isAnalyzeToolEnabled(ctx.cwd) ? "on" : "off",
      kind: "cycle",
      values: ["on", "off"],
    },
    {
      id: "analyze-timeout",
      section: "Analysis Tools",
      label: "Timeout",
      value: `${analyzeGap.timeoutMinutes} min`,
      kind: "cycle",
      values: [10, 15, 20, 25, ANALYZE_TIMEOUT_MAX_MINUTES]
        .filter((value, index, values) => value >= ANALYZE_TIMEOUT_MIN_MINUTES && values.indexOf(value) === index)
        .map((value) => `${value} min`),
    },
    {
      id: "analyze-gap-model",
      section: "Analysis Tools",
      label: "Analysis model",
      value: analyzeGap.provider ? `${analyzeGap.provider}/${analyzeGap.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "analyze-gap-thinking",
      section: "Analysis Tools",
      label: "Analysis thinking",
      value: analyzeGap.thinkingLevel,
      kind: "cycle",
      values: analyzeGapLevels,
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

/** Custom row-based menu component: renders Solver and Analysis Tools rows. Cycling rows update and persist in place; only model rows exit the overlay to run a picker. */
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
      loadSolverGapConfig(),
      getAnalyzeGapConfig(loadChecksConfig()),
    );
  }

  /** Recompute rows from the latest saved config (used after a model picker returns) without resetting selection. */
  refresh() {
    const current = loadChecksConfig();
    this.rows = buildConfigRows(this.ctx, current, loadSolverGapConfig(), getAnalyzeGapConfig(current));
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
      if (row.id === "solvergap-thinking") {
        saveSolverGapConfig({ ...solverGap, thinkingLevel: nextValue as ClaudeThinkingLevel });
        this.refresh();
        this.onCycleSaved();
        return;
      }
      if (!current) {
        this.ctx.ui.notify(
          "Set the local Pi reviewer model first — it's required before analysis-tool settings",
          "warning",
        );
        return;
      }
      const analyzeGap = getAnalyzeGapConfig(current);
      if (row.id === "reviewer-thinking") {
        saveChecksConfig({ ...current, thinkingLevel: nextValue as ThinkingLevel, solverGap, analyzeGap });
      } else if (row.id === "analyze-enabled") {
        setAnalyzeProjectEnabled(this.ctx.cwd, nextValue === "on");
      } else if (row.id === "analyze-timeout") {
        saveChecksConfig({
          ...current,
          analyzeGap: { ...analyzeGap, timeoutMinutes: Number.parseInt(nextValue, 10) },
        });
      } else if (row.id === "analyze-gap-thinking") {
        saveChecksConfig({ ...current, analyzeGap: { ...analyzeGap, thinkingLevel: nextValue as ThinkingLevel } });
      }
      this.refresh();
      this.onCycleSaved();
    }
  }
}

/** Interactive `/checks --config` settings menu with Solver and Analysis Tools sections; Ctrl+S (or Esc) saves and exits. */
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
    const solverGap = loadSolverGapConfig();
    const analyzeGap = getAnalyzeGapConfig(current);

    if (activated === "reviewer-model") {
      const picked = await pickModelOnly(ctx, current, "Select local Pi reviewer model");
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
      ctx.ui.notify(`Local Pi reviewer model saved: ${picked.provider}/${picked.modelId}`, "info");
      continue;
    }

    if (activated === "analyze-gap-model") {
      if (!current) {
        ctx.ui.notify("Set the local Pi reviewer model first — it's required before analyze-tool settings.", "warning");
        continue;
      }
      const picked = await pickModelOnly(ctx, analyzeGap.provider ? analyzeGap : null, "Select gap-finder model");
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(analyzeGap.thinkingLevel) ? analyzeGap.thinkingLevel : (levels[0] ?? "off");
      saveChecksConfig({ ...current, analyzeGap: { ...analyzeGap, ...picked, thinkingLevel } });
      ctx.ui.notify(`Gap-finder model saved: ${picked.provider}/${picked.modelId}`, "info");
    }
  }
}

function extractNewFilesFromPatch(patchText: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const sections = patchText.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    if (!/^new file mode /m.test(section)) continue;
    const patchPath = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!patchPath) continue;
    const normalizedPath = patchPath.replace(/\\/g, "/");
    if (
      normalizedPath.startsWith("/") ||
      /^[A-Za-z]:/.test(normalizedPath) ||
      normalizedPath.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error(`Unsafe new-file path in test.patch: ${patchPath}`);
    }
    const content: string[] = [];
    const hasNoFinalNewline = section.includes("\\ No newline at end of file");
    let inHunk = false;
    for (const line of section.split(/\r?\n/)) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk || line === "" || line.startsWith("\\ No newline at end of file")) continue;
      if (line.startsWith("+")) content.push(line.slice(1));
      else if (line.startsWith("diff --git ")) break;
      else throw new Error(`Unexpected non-addition line in new test.patch file ${patchPath}.`);
    }
    const fileContent = content.join("\n");
    files.push({ path: normalizedPath, content: hasNoFinalNewline ? fileContent : `${fileContent}\n` });
  }
  return files;
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
    description: "Configure checks or run the solve benchmark for agent_prompt.md.",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      let sub = args.trim();
      if (!sub) {
        const choice = await ctx.ui.select("Choose a checks action", [...COMMAND_MENU_OPTIONS]);
        if (!choice) return;
        sub = choice === "config" ? "--config" : choice;
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
      if (tokens.includes("--config")) {
        if (tokens.length > 1) ctx.ui.notify("--config must be used alone.", "warning");
        else await runConfigFlow(pi, ctx);
        return;
      }
      if (tokens.length !== 1 || tokens[0] !== "solve") {
        ctx.ui.notify("Run `/checks solve` to solve and review this task.", "warning");
        return;
      }
      const runClaudeBenchmark = true;
      if (isReviewInProgress()) {
        ctx.ui.notify("A checks run is already in progress.", "warning");
        return;
      }
      const reviewerConfig = loadChecksConfig();
      const config: ChecksConfig = reviewerConfig ?? {
        provider: "claude-cli",
        modelId: "default",
        thinkingLevel: "off",
      };
      const reviewerModel = reviewerConfig
        ? ctx.modelRegistry.find(reviewerConfig.provider, reviewerConfig.modelId)
        : ctx.model;
      if (!reviewerModel || (reviewerConfig && !ctx.modelRegistry.hasConfiguredAuth(reviewerModel))) {
        ctx.ui.notify(
          "Configure an authenticated local Pi reviewer model in `/checks --config` before running `/checks solve`.",
          "error",
        );
        return;
      }
      const reviewerThinkingLevel = reviewerConfig?.thinkingLevel ?? "off";
      const reviewerModelName = `${reviewerModel.provider}/${reviewerModel.id}`;
      const reviewerContextWindow = Number.isFinite(reviewerModel.contextWindow)
        ? reviewerModel.contextWindow
        : undefined;
      const missing = [...REQUIRED_FILES, "Dockerfile", "test.patch"].filter(
        (file) => !existsSync(join(ctx.cwd, file)),
      );
      if (missing.length) {
        ctx.ui.notify(`Missing required file(s): ${missing.join(", ")}`, "error");
        return;
      }
      const solverConfig: SolverGapConfig = loadSolverGapConfig();
      const taskPrompt = readFileSync(join(ctx.cwd, "agent_prompt.md"), "utf-8");
      const abort = startReview();
      const solverCount = solverConfig.solverCount;
      const total = solverCount + 1;
      const progressStartedAt = Date.now();
      let progressLabel = "preparing image";
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
              model: reviewerModel,
              thinkingLevel: reviewerThinkingLevel,
              contextWindow: reviewerContextWindow,
              taskPrompt,
              solverResults,
              testGuidelines: loadTestGuidelines(),
              fairnessRules: loadFairnessRules(),
              cancelSignal: abort.signal,
            });
            solverReview = { ...review, model: reviewerModelName, thinkingLevel: reviewerThinkingLevel };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            solverReview = {
              status: "error",
              text: message,
              model: reviewerModelName,
              thinkingLevel: reviewerThinkingLevel,
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
        const reportConfig: ChecksConfig = {
          ...config,
          provider: "claude-cli",
          modelId: solverConfig.modelId,
          thinkingLevel: "off",
        };
        const merged = mergeReport({
          existingReport: loadExistingReport(join(ctx.cwd, "shipd_report.json")),
          config: reportConfig,
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
