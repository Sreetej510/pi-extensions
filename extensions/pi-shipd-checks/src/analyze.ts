/**
 * `analyze_test_gaps` — a tool the main agent can call to run the same
 * sentence-by-sentence behavioral gap analysis as `/checks --gap-finder`,
 * as a read-only subagent flow, and get the filtered gaps back as the tool
 * result (`details.testGaps`). Runs directly in the current working
 * directory (no temp snapshot) — the subagents are read-only, so nothing
 * is created or modified.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runGapFinder, runGapValidator } from "./agents.js";
import { isAnalyzeToolEnabled, loadAnalyzeGapConfig, loadChecksConfig } from "./config.js";
import { loadFairnessRules, loadTestGuidelines } from "./rubric.js";
import type { TestGapFinal } from "./types.js";

export const ANALYZE_TOOL_NAME = "analyze_test_gaps";
const ANALYZE_PREVIEW_LINES = 6;

export function registerAnalyzeGapsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: ANALYZE_TOOL_NAME,
    label: "Gap Finder",
    description:
      "Run the sentence-by-sentence behavioral test-gap analysis on the current task and its repository source files: " +
      "a read-only finder agent splits agent_prompt.md into sentences and proposes missing positive/negative " +
      "behavioral tests per sentence, then a read-only fairness reviewer filters out unfair or " +
      "internally-observable candidates (skipped when the finder found nothing). " +
      "Returns the confirmed gaps as the tool result (details.testGaps). Never writes or modifies files.",
    promptSnippet: "Analyze the task's hidden tests for behavioral coverage gaps",
    promptGuidelines: [
      "Use analyze_test_gaps when you need the confirmed list of fair behavioral test gaps for the current task's hidden tests.",
    ],
    parameters: Type.Object({}),
    renderCall(_args, _theme, context) {
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      // The result renderer owns the final header; keep the call placeholder empty
      // so the title is not rendered twice.
      text.setText("");
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state;
      // Live "Elapsed" ticker while the tool is still running, like the shell tool.
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const label = options.isPartial ? "Elapsed" : "Took";
      const endTime = state.endedAt ?? Date.now();
      const duration = state.startedAt !== undefined ? formatDuration(endTime - state.startedAt) : "—";
      const details = result.details as { testGaps?: unknown[] } | undefined;
      const gapCount = Array.isArray(details?.testGaps) ? details.testGaps.length : undefined;
      const metaParts = [`${label} ${duration}`];
      if (gapCount !== undefined) {
        metaParts.push(`${gapCount} gap${gapCount === 1 ? "" : "s"}`);
      }
      const header =
        theme.fg("toolTitle", theme.bold("Gap Finder")) + theme.fg("muted", `  ${metaParts.join("  ·  ")}`);
      const resultText = (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
      const output = resultText.trim();
      let displayLines = output ? removeJustifications(output.split("\n")) : ["(no output)"];
      if (!options.expanded) {
        const remaining = Math.max(0, displayLines.length - ANALYZE_PREVIEW_LINES);
        displayLines = displayLines.slice(0, ANALYZE_PREVIEW_LINES);
        if (remaining > 0) {
          displayLines.push(`... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
        }
      }

      const component =
        context.lastComponent instanceof AnalyzeResultComponent ? context.lastComponent : new AnalyzeResultComponent();
      component.setContent(header, displayLines, theme);
      return component;
    },
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      if (!isAnalyzeToolEnabled()) {
        throw new Error(
          "analyze_test_gaps is disabled. Enable it via /checks --config (Analyze Tool section -> Enabled).",
        );
      }

      const promptPath = join(ctx.cwd, "agent_prompt.md");
      if (!existsSync(promptPath)) {
        throw new Error("Missing required file in project root: agent_prompt.md");
      }

      const analyzeConfig = loadAnalyzeGapConfig() ?? loadChecksConfig();
      const config = analyzeConfig;
      const model = config ? ctx.modelRegistry.find(config.provider, config.modelId) : ctx.model;
      if (!model || (config && !ctx.modelRegistry.hasConfiguredAuth(model))) {
        throw new Error(
          "No model configured/authenticated for analyze_test_gaps. Set one via /checks --config (Analyze Tool section).",
        );
      }
      const thinkingLevel = analyzeConfig?.thinkingLevel ?? "off";

      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      const base = {
        tempDir: ctx.cwd,
        model,
        thinkingLevel,
        testRubric: loadTestGuidelines(),
        fairnessRules: loadFairnessRules(),
        cancelSignal: abort.signal,
      };

      onUpdate?.({
        content: [{ type: "text", text: "Finding behavioral test gaps sentence by sentence..." }],
        details: {},
      });
      const statementReports = await runGapFinder(base);
      if (abort.signal.aborted) throw new Error("Cancelled by user.");
      if (statementReports.status !== "ok") {
        throw new Error(`Gap finder did not complete (status: ${statementReports.status}).`);
      }

      const candidateCount = statementReports.gaps.reduce((count, report) => count + report.gaps.length, 0);
      let testGaps: TestGapFinal[] = [];
      if (candidateCount > 0) {
        onUpdate?.({
          content: [{ type: "text", text: `Validating ${candidateCount} candidate gap(s)...` }],
          details: {},
        });
        const filtered = await runGapValidator({ ...base, statementReports: statementReports.gaps });
        if (abort.signal.aborted) throw new Error("Cancelled by user.");
        if (filtered.status !== "ok") {
          throw new Error(`Gap review did not complete (status: ${filtered.status}).`);
        }
        testGaps = filtered.gaps;
      }

      return {
        content: [
          {
            type: "text",
            text: buildAnalyzeResultText(testGaps),
          },
        ],
        details: { testGaps },
      };
    },
  });
}

/** Remove verbose justification blocks from the compact display. */
function removeJustifications(lines: string[]): string[] {
  const visible: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\d+\.\s+/.test(line)) {
      skipping = false;
      visible.push(line);
    } else if (/^\s*Justification:/i.test(line)) {
      skipping = true;
    } else if (!skipping) {
      visible.push(line);
    }
  }
  return visible;
}

/** Component that renders the header + ordered list with hanging indentation on wrapped lines. */
class AnalyzeResultComponent {
  private header = "";
  private styledLines: string[] = [];
  private theme?: import("@earendil-works/pi-coding-agent").Theme;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  setContent(header: string, lines: string[], theme: import("@earendil-works/pi-coding-agent").Theme): void {
    this.header = header;
    this.styledLines = lines.map((line) => styleAnalyzeLine(line, theme));
    this.theme = theme;
    this.cachedWidth = -1;
  }

  invalidate() {
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      const theme = this.theme;
      const out: string[] = [];
      if (this.header) {
        out.push(this.header, "");
      }
      for (const line of this.styledLines) {
        if (theme) {
          out.push(...wrapTextWithAnsi(line, width));
        } else {
          out.push(line);
        }
      }
      this.cachedLines = out;
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }
}

/** Ordered-list styling: `  1. text` with the number in accent and text in muted. */
function styleAnalyzeLine(line: string, theme: import("@earendil-works/pi-coding-agent").Theme): string {
  const item = line.match(/^(\d+)\.\s+(.*)$/);
  if (item) {
    return `${theme.fg("accent", `${item[1]}.`)}  ${theme.fg("muted", item[2] ?? "")}`;
  }
  return theme.fg("toolOutput", line);
}

/** Shell-tool-style elapsed display, e.g. `12s`. */
function formatDuration(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

/**
 * The text sent back to the calling agent: a caution banner plus the
 * confirmed gaps (or a none-found note).
 */
function buildAnalyzeResultText(testGaps: TestGapFinal[]): string {
  if (testGaps.length === 0) {
    return "Gap analysis complete: no confirmed behavioral test gaps were found.";
  }
  const lines = testGaps.map((gap, i) => `${i + 1}. ${gap.description}\n   Justification: ${gap.justification}`);
  return [
    "Below are the gaps found by another agent. If they are fair under our prompt, we need to add tests to fix " +
      "the gap. If not fair, do not mind those — only add tests for gaps that are absolutely fair.",
    "",
    ...lines,
  ].join("\n");
}
