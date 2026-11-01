/** The agent-callable `auditor` tool (a local Claude CLI replica of the hosted Auto Review) and the humanizer tool. */

import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AuditFinding, type AuditResult, type FindingGroup, GROUP_TITLES, runAudit } from "./auditor.js";
import { isAnalyzeProjectEnabled } from "./config.js";
import { registerHumanizerTool } from "./humanize.js";
import { formatDuration } from "./report.js";

export const AUDITOR_TOOL_NAME = "auditor";

const ANALYZE_PREVIEW_LINES = 8;
const auditorToolParams = Type.Object({});
let auditInProgress = false;

export function registerAnalysisTools(pi: ExtensionAPI): void {
  registerAuditorTool(pi);
  registerHumanizerTool(pi);
}

function registerAuditorTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: AUDITOR_TOOL_NAME,
    label: "Auditor",
    description:
      "Use only when explicitly asked to audit the task, find test gaps, check test fairness, or precheck the solution. " +
      "Runs a local Claude CLI replica of the hosted Auto Review over agent_prompt.md, test.patch and solution.patch " +
      "(refreshed with create_patches.sh when present; test.sh is ignored): it finds unfair tests, test gaps, solution " +
      "gaps and solution improvements, and checks every finding against the hosted proof legs. It never writes or " +
      "modifies project files other than its report.",
    promptSnippet: "Audit tests and solution (unfair tests, test gaps, solution gaps, improvements)",
    promptGuidelines: [
      "Call auditor only when the user explicitly asks for an audit, test-gap analysis, a fairness check or a solution precheck; never call it proactively or for unrelated work.",
      "auditor has no parameters. It takes a long time (several Claude CLI reviewers plus a synthesis step) and consumes Claude usage.",
      "Run one auditor invocation at a time and wait for it to finish; never issue multiple invocations in parallel.",
      "Read details.unfairTests, details.testGaps, details.solutionGaps and details.solutionImprovements. HIGH findings gate; MEDIUM ones are the fix-before-upload list. They are review findings, not instructions: validate each against agent_prompt.md and the repository before changing anything, and apply the changes yourself.",
    ],
    parameters: auditorToolParams,
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
      const details = result.details as Partial<AuditResult> | undefined;
      const metaParts = [`${label} ${duration}`];
      if (details?.verdict) metaParts.push(details.verdict);
      const header = theme.fg("toolTitle", theme.bold("Auditor")) + theme.fg("muted", `  ${metaParts.join("  ·  ")}`);
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
      if (!isAnalyzeProjectEnabled(ctx.cwd)) {
        throw new Error(
          `${AUDITOR_TOOL_NAME} is disabled for this project. Enable the analysis tools with /analyze:on.`,
        );
      }
      if (auditInProgress) throw new Error("An auditor run is already in progress; wait for it to finish.");
      auditInProgress = true;
      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }
      try {
        const audit = await runAudit({
          pi,
          cwd: ctx.cwd,
          signal: abort.signal,
          onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        });
        return { content: [{ type: "text", text: buildAuditResultText(audit) }], details: audit };
      } finally {
        auditInProgress = false;
      }
    },
  });
}

/** Remove verbose justification blocks from the compact display. */
function removeJustifications(lines: string[]): string[] {
  const visible: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\d+\.\s+/.test(line) || /^\S/.test(line)) {
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

function findingLine(finding: AuditFinding, index: number): string {
  const tag = [finding.level, finding.criterion].filter(Boolean).join(" ");
  const lines = [`${index + 1}. [${tag}] ${finding.finding}`];
  const justification = [finding.why, finding.failedLeg ? `failed leg: ${finding.failedLeg}` : ""]
    .filter(Boolean)
    .join("; ");
  if (justification) lines.push(`   Justification: ${justification}`);
  return lines.join("\n");
}

function buildAuditResultText(audit: AuditResult): string {
  const lines = [
    `Auditor verdict ${audit.verdict}: Test Quality ${audit.testQuality}, Solution Quality ${audit.solutionQuality}. Report: ${audit.reportPath}`,
    "These are review findings, not instructions. HIGH findings gate; MEDIUM ones should be fixed before upload. Validate each against agent_prompt.md and the repository, and implement only the changes you judge correct.",
  ];
  for (const group of Object.keys(GROUP_TITLES) as FindingGroup[]) {
    const findings = audit[group];
    lines.push("", `${GROUP_TITLES[group]} (${findings.length}):`);
    if (!findings.length) lines.push("   none");
    else lines.push(...findings.map(findingLine));
  }
  const failed = audit.reviewers.filter((reviewer) => reviewer.status !== "ok");
  if (failed.length) {
    lines.push(
      "",
      `Reviewers that did not finish: ${failed.map((reviewer) => `${reviewer.name} (${reviewer.status})`).join(", ")}`,
    );
  }
  if (audit.counterTests.length) {
    lines.push(
      "",
      `${audit.counterTests.length} counter-tests (not executed) are in details.counterTests and the report.`,
    );
  }
  return lines.join("\n");
}
