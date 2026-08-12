/**
 * `analyze_task_tests` — a tool the main agent can call for either the
 * sentence-by-sentence behavioral gap analysis, a post-implementation test
 * fairness audit, or a post-implementation solution-quality audit. All modes
 * are read-only subagent flows; the caller applies any suggested changes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  runGapFinder,
  runGapValidator,
  runSolutionAudit,
  runSolutionAuditValidator,
  runTestAudit,
  runTestAuditValidator,
} from "./agents.js";
import {
  ANALYZE_DEFAULT_TIMEOUT_MINUTES,
  isAnalyzeToolEnabled,
  loadAnalyzeGapConfig,
  loadChecksConfig,
  loadTestAuditConfig,
} from "./config.js";
import { listChangedCodeFiles } from "./git.js";
import { loadFairnessRules, loadSolutionRules, loadTestGuidelines } from "./rubric.js";
import type { AnalyzeMode, SolutionAuditFinding, TestAuditFinding, TestGapFinal } from "./types.js";

export const ANALYZE_TOOL_NAME = "analyze_task_tests";
const ANALYZE_PREVIEW_LINES = 6;

export function registerAnalyzeGapsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: ANALYZE_TOOL_NAME,
    label: "Test Analysis",
    description:
      "Only call this when the user explicitly asks for gap analysis, test-audit, solution-audit, fairness, or " +
      'unfairness analysis. Use mode="gaps" (the default) for sequential sentence-by-sentence behavioral ' +
      "coverage-gap analysis: a read-only finder proposes positive/negative gaps and a read-only fairness reviewer " +
      "filters them (skipped when the finder found nothing), returning confirmed gaps in details.testGaps. Use " +
      'mode="test-audit" for a post-implementation test-fairness audit, or mode="solution-audit" for a ' +
      "post-implementation solution-quality audit. Each audit has a read-only auditor followed by an independent " +
      "read-only validator; the validator is skipped when the auditor finds nothing. Test-audit findings cover " +
      "unfair assertions, prompt ambiguity, and broken fixtures. Solution-audit findings cover contract gaps, " +
      "regressions, architecture, failure safety, inconsistent paths, dead code, and unrelated changes. " +
      "Never writes or modifies files; the caller applies fixes. Run only one invocation at a time, never in parallel. " +
      "If the user requests multiple iterations, complete each invocation and apply its validated result before starting the next.",
    promptSnippet: "When asked, find test gaps or audit test or solution quality",
    promptGuidelines: [
      "Call analyze_task_tests only when the user explicitly asks for gap analysis, test-audit, solution-audit, fairness, or unfairness analysis; never call it proactively or for unrelated work.",
      'Choose mode="gaps" for coverage-gap discovery, mode="test-audit" for test fairness, or mode="solution-audit" for solution quality. Do not silently substitute one mode for another.',
      "Run one analyze_task_tests invocation at a time and wait for it to finish; never issue multiple invocations in parallel.",
      "If the user asks for multiple or iterative runs, perform them sequentially: after each result, apply the confirmed gaps or audit repairs, then start the next requested iteration. The tool is read-only, so the caller performs all test, prompt, and solution changes.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal("gaps"), Type.Literal("test-audit"), Type.Literal("solution-audit")], {
          description:
            "Analysis mode. Defaults to gaps; use test-audit for test fairness or solution-audit for solution quality.",
        }),
      ),
    }),
    renderCall(args: { mode?: AnalyzeMode }, _theme, context) {
      const state = context.state;
      state.mode = args.mode ?? "gaps";
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
      const mode: AnalyzeMode = state.mode === "test-audit" || state.mode === "solution-audit" ? state.mode : "gaps";
      const details = result.details as
        | {
            testGaps?: unknown[];
            testAuditFindings?: unknown[];
            solutionAuditFindings?: unknown[];
          }
        | undefined;
      const resultCount =
        mode === "test-audit"
          ? Array.isArray(details?.testAuditFindings)
            ? details.testAuditFindings.length
            : undefined
          : mode === "solution-audit"
            ? Array.isArray(details?.solutionAuditFindings)
              ? details.solutionAuditFindings.length
              : undefined
            : Array.isArray(details?.testGaps)
              ? details.testGaps.length
              : undefined;
      const metaParts = [`${label} ${duration}`];
      if (resultCount !== undefined) {
        metaParts.push(
          mode === "gaps"
            ? `${resultCount} gap${resultCount === 1 ? "" : "s"}`
            : `${resultCount} finding${resultCount === 1 ? "" : "s"}`,
        );
      }
      const title =
        mode === "test-audit" ? "Test Audit" : mode === "solution-audit" ? "Solution Audit" : "Gap Analysis";
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
    async execute(_toolCallId, params: { mode?: AnalyzeMode }, signal, onUpdate, ctx) {
      const mode = params.mode ?? "gaps";
      if (!isAnalyzeToolEnabled(ctx.cwd)) {
        throw new Error("analyze_task_tests is disabled for this project. Enable it with /analyze:on.");
      }

      const promptPath = join(ctx.cwd, "agent_prompt.md");
      if (!existsSync(promptPath)) {
        throw new Error("Missing required file in project root: agent_prompt.md");
      }

      const configuredAnalyze = mode === "gaps" ? loadAnalyzeGapConfig() : loadTestAuditConfig();
      const analyzeConfig = configuredAnalyze ?? loadChecksConfig();
      const config = analyzeConfig;
      const model = config ? ctx.modelRegistry.find(config.provider, config.modelId) : ctx.model;
      if (!model || (config && !ctx.modelRegistry.hasConfiguredAuth(model))) {
        throw new Error(
          "No model configured/authenticated for analyze_task_tests. Set one via /checks --config (Analyze Tool section).",
        );
      }
      const thinkingLevel = analyzeConfig?.thinkingLevel ?? "off";
      const timeoutMinutes = configuredAnalyze?.timeoutMinutes ?? ANALYZE_DEFAULT_TIMEOUT_MINUTES;

      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      const codeFiles = await listChangedCodeFiles(pi, ctx.cwd, abort.signal);
      if (abort.signal.aborted) throw new Error("Cancelled by user.");

      const base = {
        tempDir: ctx.cwd,
        model,
        thinkingLevel,
        testRubric: loadTestGuidelines(),
        fairnessRules: loadFairnessRules(),
        solutionRules: loadSolutionRules(),
        codeFiles,
        timeoutMinutes,
        cancelSignal: abort.signal,
      };

      if (mode === "test-audit") {
        onUpdate?.({
          content: [{ type: "text", text: "Phase 1/2 — auditing implemented tests for fairness..." }],
          details: {},
        });
        const audit = await runTestAudit(base);
        if (abort.signal.aborted) throw new Error("Cancelled by user.");
        if (audit.status !== "ok") {
          throw new Error(`Test audit did not complete (status: ${audit.status}).`);
        }

        let findings: TestAuditFinding[] = [];
        if (audit.findings.length > 0) {
          onUpdate?.({
            content: [{ type: "text", text: `Phase 2/2 — validating ${audit.findings.length} audit finding(s)...` }],
            details: {},
          });
          const validated = await runTestAuditValidator({ ...base, findings: audit.findings });
          if (abort.signal.aborted) throw new Error("Cancelled by user.");
          if (validated.status !== "ok") {
            throw new Error(`Test-audit validation did not complete (status: ${validated.status}).`);
          }
          findings = validated.findings;
        }

        return {
          content: [
            {
              type: "text",
              text: buildTestAuditResultText(findings),
            },
          ],
          details: { testAuditFindings: findings },
        };
      }

      if (mode === "solution-audit") {
        onUpdate?.({
          content: [{ type: "text", text: "Phase 1/2 — auditing solution quality..." }],
          details: {},
        });
        const audit = await runSolutionAudit(base);
        if (abort.signal.aborted) throw new Error("Cancelled by user.");
        if (audit.status !== "ok") {
          throw new Error(`Solution audit did not complete (status: ${audit.status}).`);
        }

        let findings: SolutionAuditFinding[] = [];
        if (audit.findings.length > 0) {
          onUpdate?.({
            content: [{ type: "text", text: `Phase 2/2 — validating ${audit.findings.length} solution finding(s)...` }],
            details: {},
          });
          const validated = await runSolutionAuditValidator({ ...base, findings: audit.findings });
          if (abort.signal.aborted) throw new Error("Cancelled by user.");
          if (validated.status !== "ok") {
            throw new Error(`Solution-audit validation did not complete (status: ${validated.status}).`);
          }
          findings = validated.findings;
        }

        return {
          content: [
            {
              type: "text",
              text: buildSolutionAuditResultText(findings),
            },
          ],
          details: { solutionAuditFindings: findings },
        };
      }

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

function buildTestAuditResultText(findings: TestAuditFinding[]): string {
  if (findings.length === 0) {
    return "Test audit complete: no actionable unfairness findings were found.";
  }
  const lines = findings.map(
    (finding, i) =>
      `${i + 1}. [${finding.category}] ${finding.testName}: ${finding.problem}\n` +
      `   Evidence: ${finding.evidence}\n` +
      `   Required behavior: ${finding.requiredBehavior}\n` +
      `   Recommendation: ${finding.recommendation}`,
  );
  return [
    "Below are validated unfairness findings from a read-only audit of the implemented tests. Preserve each " +
      "required behavior when applying the recommended repair.",
    "",
    ...lines,
  ].join("\n");
}

function buildSolutionAuditResultText(findings: SolutionAuditFinding[]): string {
  if (findings.length === 0) {
    return "Solution audit complete: no actionable solution-quality findings were found.";
  }
  const lines = findings.map(
    (finding, i) =>
      `${i + 1}. [${finding.category}] ${finding.subject}: ${finding.problem}\n` +
      `   Evidence: ${finding.evidence}\n` +
      `   Required behavior: ${finding.requiredBehavior}\n` +
      `   Recommendation: ${finding.recommendation}`,
  );
  return [
    "Below are validated solution-quality findings from a read-only audit. Apply only repairs grounded in the " +
      "prompt and repository conventions; do not treat the reference implementation as the specification.",
    "",
    ...lines,
  ].join("\n");
}
