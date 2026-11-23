/** The agent-callable `auditor` tool (a local Codex CLI replica of the hosted Auto Review). */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AuditResult, runAudit } from "./auditor.js";
import { isAnalyzeProjectEnabled } from "./config.js";
import { formatDuration } from "./report.js";

export const AUDITOR_TOOL_NAME = "auditor";

const auditorToolParams = Type.Object({});
let auditInProgress = false;

export function registerAnalysisTools(pi: ExtensionAPI): void {
  registerAuditorTool(pi);
}

function registerAuditorTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: AUDITOR_TOOL_NAME,
    label: "Auditor",
    description:
      "Use only when explicitly asked to audit the task, find test gaps, check test fairness, or precheck the solution. " +
      "Runs a local Codex CLI replica of the hosted Auto Review over agent_prompt.md, test.patch and solution.patch " +
      "(created by create_patches.sh before every run; test.sh is ignored). Test agents find unfair tests, test gaps and " +
      "test code-quality issues; solution agents find wrong outputs and solution code-quality issues; a combined " +
      "synthesis checks every finding against the hosted proof legs and writes a concise report under .pi/shipd-checks.",
    promptSnippet: "Audit tests and solution (unfair tests, test gaps, wrong outputs, code quality)",
    promptGuidelines: [
      "Call auditor only when the user explicitly asks for an audit, test-gap analysis, a fairness check or a solution precheck; never call it proactively or for unrelated work.",
      "auditor has no parameters. It takes a long time (test and solution Codex CLI agents sized to the patches, plus a combined synthesis) and consumes Codex usage.",
      "Run one auditor invocation at a time and wait for it to finish; never issue multiple invocations in parallel.",
      "Read the report. HIGH findings gate and MEDIUM findings are advisory. Test-gap recommendations cover only required public behavior. Preserve implementation freedom when writing tests and validate findings against agent_prompt.md and the repository before applying changes.",
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
      const displayLines = resultText.trim().split("\n");

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

class AnalyzeResultComponent {
  private header = "";
  private styledLines: string[] = [];
  private theme?: import("@earendil-works/pi-coding-agent").Theme;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  setContent(header: string, lines: string[], theme: import("@earendil-works/pi-coding-agent").Theme): void {
    this.header = header;
    this.styledLines = lines.map((line) => theme.fg("toolOutput", line));
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

function buildAuditResultText(audit: AuditResult): string {
  return `Auditor ${audit.verdict}. Tests: ${audit.testQuality} | Solution: ${audit.solutionQuality}\nReport: ${audit.reportPath}`;
}
