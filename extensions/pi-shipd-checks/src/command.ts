/** Registers the `/checks` command: argument parsing, the --config flow, and the main run orchestration. */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { runGapFinder, runGapValidator, runReviewer, runSolverAgent, runSolverComparisonReviewer } from "./agents.js";
import {
  getSupportedThinkingLevels,
  loadChecksConfig,
  loadEnabledModelRefs,
  loadSolverGapConfig,
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
import { ROLES } from "./roles.js";
import { loadFairnessRules, loadGuidelinesSections } from "./rubric.js";
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
  ReviewerRole,
  ReviewReport,
  SolverGap,
  SolverGapConfig,
  SolverRunResult,
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
  {
    value: "--solver-gap-finder",
    label: "--solver-gap-finder",
    description:
      "Run several solver agents TDD-style against agent_prompt.md + test.patch (no solution.patch), then compare their solutions to find gaps",
  },
  {
    value: "--config",
    label: "--config",
    description: "Open the settings menu: reviewer model/thinking level + solver-gap-finder settings",
  },
];

function getArgumentCompletions(prefix: string) {
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
};

type ConfigRowId =
  | "reviewer-model"
  | "reviewer-thinking"
  | "solvergap-model"
  | "solvergap-thinking"
  | "solvergap-timeout"
  | "solvergap-solver-count";

interface ConfigRow {
  id: ConfigRowId;
  section: "Reviewer" | "Solver Gap Finder";
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
      section: "Solver Gap Finder",
      label: "Model",
      value: solverGap.provider ? `${solverGap.provider}/${solverGap.modelId}` : "not set",
      kind: "model",
    },
    {
      id: "solvergap-thinking",
      section: "Solver Gap Finder",
      label: "Thinking level",
      value: solverGap.thinkingLevel,
      kind: "cycle",
      values: solverGapLevels,
    },
    {
      id: "solvergap-timeout",
      section: "Solver Gap Finder",
      label: "Timeout",
      value: `${solverGap.timeoutMinutes} min`,
      kind: "cycle",
      values: [10, 20, 30, 40, 50, SOLVER_GAP_TIMEOUT_MAX_MINUTES]
        .filter((v, i, arr) => v >= SOLVER_GAP_TIMEOUT_MIN_MINUTES && arr.indexOf(v) === i)
        .map((v) => `${v} min`),
    },
    {
      id: "solvergap-solver-count",
      section: "Solver Gap Finder",
      label: "Parallel agents",
      value: String(solverGap.solverCount),
      kind: "cycle",
      values: Array.from(
        { length: SOLVER_GAP_SOLVER_COUNT_MAX - SOLVER_GAP_SOLVER_COUNT_MIN + 1 },
        (_, i) => `${SOLVER_GAP_SOLVER_COUNT_MIN + i}`,
      ),
    },
  ];
}

type ChecksConfigLike = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  solverGap?: SolverGapConfig;
};

/** Custom row-based menu component: renders section headers inline between "Reviewer" and "Solver Gap Finder" rows. Cycling rows update and persist in place (no overlay teardown); only model rows exit the overlay to run a picker. */
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
      }
      this.refresh();
      this.onCycleSaved();
    }
  }
}

/** Interactive `/checks --config` settings menu: a single row-based menu with "Reviewer" / "Solver Gap Finder" section headers; Ctrl+S (or Esc) saves and exits. */
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
      const picked = await pickModelOnly(ctx, current, "Select model for checks reviewer agents");
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
      const picked = await pickModelOnly(
        ctx,
        solverGap.provider ? solverGap : null,
        "Select model for solver-gap-finder's solver agents",
      );
      if (!picked) continue;
      const levels = supportedThinkingLevelsFor(ctx, picked.provider, picked.modelId);
      const thinkingLevel = levels.includes(solverGap.thinkingLevel) ? solverGap.thinkingLevel : (levels[0] ?? "off");
      saveChecksConfig({ ...current, solverGap: { ...solverGap, ...picked, thinkingLevel } });
      ctx.ui.notify(`Solver-gap-finder model saved: ${picked.provider}/${picked.modelId}`, "info");
    }
  }
}

export function registerChecksCommand(pi: ExtensionAPI) {
  pi.registerCommand("checks", {
    description: "Strict review of agent_prompt.md/test.patch/solution.patch. Requires an option — see /checks.",
    getArgumentCompletions,

    handler: async (args, ctx) => {
      const sub = args.trim();

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

      if (tokens.includes("--config")) {
        if (tokens.length > 1) {
          ctx.ui.notify("--config cannot be combined with other options.", "warning");
          return;
        }
        await runConfigFlow(ctx);
        return;
      }

      const roleKeys = new Set<ReviewerRole["key"]>();
      if (tokens.includes("--all") || tokens.includes("--review")) {
        for (const role of ROLES) roleKeys.add(role.key);
      }
      for (const role of ROLES) {
        if (tokens.includes(`--${role.key}`)) roleKeys.add(role.key);
      }
      const runGapStages = tokens.includes("--all") || tokens.includes("--gap-finder");
      const runSolverGapFinder = tokens.includes("--solver-gap-finder");
      const activeRoles = ROLES.filter((r) => roleKeys.has(r.key));
      const runReviewers = activeRoles.length > 0;

      if (!runReviewers && !runGapStages && !runSolverGapFinder) {
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

      const config = loadChecksConfig();
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

      let solverGapConfig: SolverGapConfig | null = null;
      // biome-ignore lint/suspicious/noExplicitAny: model type is not on pi-coding-agent's public generic surface
      let solverGapModel: any;
      if (runSolverGapFinder) {
        solverGapConfig = loadSolverGapConfig();
        if (!solverGapConfig) {
          ctx.ui.notify("No solver-gap-finder model configured. Run /checks --config and set it up.", "error");
          return;
        }
        solverGapModel = ctx.modelRegistry.find(solverGapConfig.provider, solverGapConfig.modelId);
        if (!solverGapModel) {
          ctx.ui.notify(
            `Configured solver-gap-finder model ${solverGapConfig.provider}/${solverGapConfig.modelId} not found. Run /checks --config again.`,
            "error",
          );
          return;
        }
        if (!ctx.modelRegistry.hasConfiguredAuth(solverGapModel)) {
          ctx.ui.notify(`No auth configured for ${solverGapConfig.provider}/${solverGapConfig.modelId}.`, "error");
          return;
        }
        if (!existsSync(join(ctx.cwd, "test.sh"))) {
          ctx.ui.notify("Missing required file in project root for --solver-gap-finder: test.sh", "error");
          return;
        }
      }

      const reviewAbort = startReview();
      const solverCount = solverGapConfig?.solverCount ?? SOLVER_GAP_DEFAULT_SOLVER_COUNT;
      const TOTAL_STAGES =
        (runReviewers ? activeRoles.length : 0) + (runGapStages ? 3 : 0) + (runSolverGapFinder ? solverCount + 1 : 0);
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("preparing clean snapshot", 0, TOTAL_STAGES));
      ctx.ui.notify(`checks (${runLabel}) started. Press ${CANCEL_SHORTCUT_LABEL} to cancel.`, "info");

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

        let solverResults: SolverRunResult[] = [];
        let solverComparison: GapStageResult<SolverGap> = { status: "ok", gaps: [] };
        if (runSolverGapFinder && solverGapConfig) {
          ctx.ui.setWidget(
            PROGRESS_WIDGET_KEY,
            renderProgressLines("solver-gap-finder: solving", completed, TOTAL_STAGES),
          );

          const testPatchPath = join(ctx.cwd, "test.patch");
          const agentPromptPath = join(ctx.cwd, "agent_prompt.md");
          const setups = await Promise.all(
            Array.from({ length: solverCount }, async (_, i) => {
              const solverDir = join(tmpdir(), `checks-solvergap-${randomUUID()}`);
              mkdirSync(solverDir, { recursive: true });
              solverDirs.push(solverDir);
              const setup = await setupSolverWorkspace({
                pi,
                repoDir: ctx.cwd,
                solverDir,
                testPatchPath,
                agentPromptPath,
              });
              return { index: i + 1, setup };
            }),
          );

          const runId = formatLocalTimestamp().replace(/[:.]/g, "-");
          solverResults = await Promise.all(
            setups.map(async ({ index, setup }) => {
              if (setup.status !== "ok") {
                completed += 1;
                ctx.ui.setWidget(
                  PROGRESS_WIDGET_KEY,
                  renderProgressLines("solver-gap-finder: solving", completed, TOTAL_STAGES),
                );
                return {
                  index,
                  status: setup.status,
                  passed: false,
                  diff: "",
                  testOutputTail: setup.error,
                  durationMs: 0,
                } satisfies SolverRunResult;
              }

              const startedAt = Date.now();
              const { outcome, trajectory } = await runSolverAgent({
                pi,
                solverDir: setup.solverDir,
                model: solverGapModel,
                thinkingLevel: solverGapConfig.thinkingLevel,
                timeoutMinutes: solverGapConfig.timeoutMinutes,
                cancelSignal: reviewAbort.signal,
              });
              const { testOutputXmlPath, ...result } = await finalizeSolverRun({
                pi,
                index,
                workspace: setup,
                status: outcome === "done" ? "ok" : outcome,
                durationMs: Date.now() - startedAt,
              });
              const artifactsDir = saveSolverArtifacts({
                repoDir: ctx.cwd,
                runId,
                index,
                trajectory,
                solutionPatch: result.diff,
                testOutputXmlPath,
                testOutputTail: result.testOutputTail,
              });
              completed += 1;
              ctx.ui.setWidget(
                PROGRESS_WIDGET_KEY,
                renderProgressLines("solver-gap-finder: solving", completed, TOTAL_STAGES),
              );
              return { ...result, artifactsDir } satisfies SolverRunResult;
            }),
          );

          if (reviewAbort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }

          const anySolverRan = solverResults.some((r) => r.status !== "patchFailed" && r.status !== "error");
          if (anySolverRan) {
            ctx.ui.setWidget(
              PROGRESS_WIDGET_KEY,
              renderProgressLines("solver-gap-finder: comparing solutions", completed, TOTAL_STAGES),
            );
            writeSolverSolutionsToDisk(dir, solverResults);
            solverComparison = await runSolverComparisonReviewer({
              tempDir: dir,
              model,
              thinkingLevel: config.thinkingLevel,
              solverResults,
              cancelSignal: reviewAbort.signal,
            });
          } else {
            ctx.ui.notify("checks: all solver-gap-finder solvers failed to set up; skipping comparison.", "warning");
          }
          completed += 1;
          ctx.ui.setWidget(
            PROGRESS_WIDGET_KEY,
            renderProgressLines("solver-gap-finder: comparing solutions", completed, TOTAL_STAGES),
          );

          if (reviewAbort.signal.aborted) {
            ctx.ui.notify("checks: cancelled.", "warning");
            return;
          }
        }

        ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines("finalizing report", TOTAL_STAGES, TOTAL_STAGES));

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

        const reportPath = join(ctx.cwd, "shipd_report.json");
        const existingReport = loadExistingReport(reportPath);
        const solverGapAnalysisIncomplete =
          runSolverGapFinder && (solverResults.some((r) => r.status === "error") || solverComparison.status !== "ok");

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
          runSolverGapFinder,
          solverResults,
          solverGaps: solverComparison.gaps,
          solverGapAnalysisIncomplete,
          solverComparisonStatus: solverComparison.status,
        });

        const summary = buildRunSummary({
          merged,
          runReviewers,
          activeRoles,
          byRole,
          runGapStages,
          runSolverGapFinder,
        });
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
        for (const solverDir of solverDirs) {
          cleanupSolverWorkspace(solverDir);
        }
        endReview();
      }
    },
  });
}
