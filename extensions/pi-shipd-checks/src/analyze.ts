/** Agent-callable gap-finder and solution-precheck tools. Both use one read-only agent flow. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runGapFinder, runSolutionAudit } from "./agents.js";
import {
  ANALYZE_DEFAULT_TIMEOUT_MINUTES,
  isAnalyzeToolEnabled,
  loadAnalyzeGapConfig,
  loadChecksConfig,
} from "./config.js";
import { getChangedCodeDiff, listChangedCodeFiles } from "./git.js";
import { formatDuration } from "./report.js";
import { loadFairnessRules, loadGapRules, loadSolutionRules, loadTestGuidelines } from "./rubric.js";
import type { SolutionAuditFinding, TestGapFinal } from "./types.js";

export const GAP_FINDER_TOOL_NAME = "gap-finder";
export const SOLUTION_PRECHECK_TOOL_NAME = "solution-precheck";

const ANALYZE_PREVIEW_LINES = 6;
const analysisToolParams = Type.Object({});
type AnalysisKind = "gaps" | "solution";

function analysisToolName(kind: AnalysisKind): string {
  return kind === "gaps" ? GAP_FINDER_TOOL_NAME : SOLUTION_PRECHECK_TOOL_NAME;
}

function analysisTitle(kind: AnalysisKind): string {
  return kind === "gaps" ? "Gap Finder" : "Solution Precheck";
}

function analysisCountLabel(kind: AnalysisKind, count: number): string {
  return kind === "gaps" ? `${count} gap${count === 1 ? "" : "s"}` : `${count} finding${count === 1 ? "" : "s"}`;
}

export function registerAnalysisTools(pi: ExtensionAPI): void {
  registerAnalysisTool(pi, "gaps");
  registerAnalysisTool(pi, "solution");
}

function registerAnalysisTool(pi: ExtensionAPI, kind: AnalysisKind): void {
  const toolName = analysisToolName(kind);
  const title = analysisTitle(kind);
  pi.registerTool({
    name: toolName,
    label: title,
    description:
      kind === "gaps"
        ? "Use only when explicitly asked to find behavioral test-coverage gaps. Run one exhaustive read-only agent that reviews the prompt sentence by sentence, performs its own fairness and evidence check, and returns confirmed gaps. It never writes or modifies files."
        : "Use only when explicitly asked for a solution precheck or solution audit. Run one exhaustive read-only agent that checks the implementation for contract gaps, regressions, failure safety, architecture, dead code, and unrelated changes. It never writes or modifies files.",
    promptSnippet: kind === "gaps" ? "Find behavioral test gaps" : "Precheck solution quality",
    promptGuidelines:
      kind === "gaps"
        ? [
            "Call gap-finder only when the user explicitly asks for behavioral test-gap analysis; never call it proactively or for unrelated work.",
            "gap-finder has no parameters and runs one read-only agent that performs its own discovery and fairness validation.",
            "Run one gap-finder invocation at a time and wait for it to finish; never issue multiple invocations in parallel.",
            "Read details.testGaps for the confirmed behavioral gaps; the caller applies any changes.",
          ]
        : [
            "Call solution-precheck only when the user explicitly asks for a solution precheck or solution audit; never call it proactively or for unrelated work.",
            "solution-precheck has no parameters and runs one read-only solution-quality auditor.",
            "Run one solution-precheck invocation at a time and wait for it to finish; never issue multiple invocations in parallel.",
            "Read details.solutionAuditFindings for the confirmed solution-quality findings; the caller applies any changes.",
          ],
    parameters: analysisToolParams,
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
      state.startedAt ??= Date.now();
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1_000);
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
      const details = result.details as
        | {
            testGaps?: unknown[];
            solutionAuditFindings?: unknown[];
          }
        | undefined;
      const findings = kind === "gaps" ? details?.testGaps : details?.solutionAuditFindings;
      const metaParts = [`${label} ${duration}`];
      if (Array.isArray(findings)) metaParts.push(analysisCountLabel(kind, findings.length));
      const header = theme.fg("toolTitle", theme.bold(title)) + theme.fg("muted", `  ${metaParts.join("  ·  ")}`);
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
      if (!isAnalyzeToolEnabled(ctx.cwd)) {
        throw new Error(`${toolName} is disabled for this project. Enable the analysis tools with /analyze:on.`);
      }

      const promptPath = join(ctx.cwd, "agent_prompt.md");
      if (!existsSync(promptPath)) {
        throw new Error("Missing required file in project root: agent_prompt.md");
      }

      const configuredAnalyze = loadAnalyzeGapConfig();
      const config = configuredAnalyze ?? loadChecksConfig();
      const model = config ? ctx.modelRegistry.find(config.provider, config.modelId) : ctx.model;
      if (!model || (config && !ctx.modelRegistry.hasConfiguredAuth(model))) {
        throw new Error(`No model configured/authenticated for ${toolName}. Set one via /checks --config.`);
      }
      const thinkingLevel = configuredAnalyze?.thinkingLevel ?? config?.thinkingLevel ?? "off";
      const timeoutMinutes = configuredAnalyze?.timeoutMinutes ?? ANALYZE_DEFAULT_TIMEOUT_MINUTES;

      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      const codeFiles = await listChangedCodeFiles(pi, ctx.cwd, abort.signal);
      if (abort.signal.aborted) throw new Error("Cancelled by user.");
      const changedCodeDiff = kind === "solution" ? await getChangedCodeDiff(pi, ctx.cwd, codeFiles, abort.signal) : "";
      if (abort.signal.aborted) throw new Error("Cancelled by user.");

      const common = {
        tempDir: ctx.cwd,
        model,
        thinkingLevel,
        codeFiles,
        timeoutMinutes,
        cancelSignal: abort.signal,
      };

      if (kind === "solution") {
        onUpdate?.({ content: [{ type: "text", text: "Prechecking solution quality..." }], details: {} });
        const audit = await runSolutionAudit({
          ...common,
          solutionRules: loadSolutionRules(),
          changedCodeDiff,
        });
        if (abort.signal.aborted) throw new Error("Cancelled by user.");
        if (audit.status !== "ok") throw new Error(`Solution precheck did not complete (status: ${audit.status}).`);

        const findings: SolutionAuditFinding[] = audit.findings;
        return {
          content: [{ type: "text", text: buildSolutionAuditResultText(findings) }],
          details: { solutionAuditFindings: findings },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: "Finding behavioral test gaps..." }], details: {} });
      const gaps = await runGapFinder({
        ...common,
        testRubric: loadTestGuidelines(),
        gapRules: loadGapRules(),
        fairnessRules: loadFairnessRules(),
      });
      if (abort.signal.aborted) throw new Error("Cancelled by user.");
      if (gaps.status !== "ok") throw new Error(`Gap finder did not complete (status: ${gaps.status}).`);

      const testGaps: TestGapFinal[] = gaps.gaps;
      return {
        content: [{ type: "text", text: buildGapFinderResultText(testGaps) }],
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
        if (theme) out.push(...wrapTextWithAnsi(line, width));
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
  if (item) return `${theme.fg("accent", `${item[1]}.`)}  ${theme.fg("muted", item[2] ?? "")}`;
  return theme.fg("toolOutput", line);
}

function buildGapFinderResultText(testGaps: TestGapFinal[]): string {
  if (testGaps.length === 0) return "Gap finder complete: no confirmed behavioral test gaps were found.";
  const lines = testGaps.map((gap, i) => `${i + 1}. ${gap.description}\n   Justification: ${gap.justification}`);
  return [
    "Below are behavioral test gaps found by the gap-finder agent. Validate each against the prompt and repository before implementing a test.",
    "",
    ...lines,
  ].join("\n");
}

function buildSolutionAuditResultText(findings: SolutionAuditFinding[]): string {
  if (findings.length === 0) return "Solution precheck complete: no actionable solution-quality findings were found.";
  const lines = findings.map(
    (finding, i) =>
      `${i + 1}. [${finding.category}] ${finding.subject}: ${finding.problem}\n` +
      `   Evidence: ${finding.evidence}\n` +
      `   Required behavior: ${finding.requiredBehavior}\n` +
      `   Recommendation: ${finding.recommendation}`,
  );
  return [
    "Below are suggestions from the solution-precheck agent, not instructions. Decide whether each finding is valid under the prompt and repository, and implement only the repairs you judge appropriate.",
    "",
    ...lines,
  ].join("\n");
}
