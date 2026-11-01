/**
 * Custom tool the focus reviewers call to submit their structured result.
 * Each tool just writes into a `capture` object passed in by the caller —
 * that's how agents.ts pulls the final result back out of the agent session.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewReport } from "./types.js";

export const REPORT_TOOL_NAME = "submit_review_report";

// ── Reviewer report tool ─────────────────────────────────────────────

const reportToolParams = Type.Object({
  verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")], {
    description:
      "FAIL only for a genuine blocking issue (clear rubric violation, agent-fault-worthy gap, unfair/undiscoverable " +
      "test requirement, or a real determinism/regression risk). Optional, minor, or stylistic points are NOT grounds " +
      "for FAIL — put those in `notes` instead and use PASS.",
  }),
  summary: Type.String({ description: "One short sentence summarizing the verdict." }),
  reasons: Type.Array(Type.String(), {
    description:
      "Specific BLOCKING justifications only, citing rubric item IDs and concrete evidence from the files you read. " +
      "Required (non-empty) when verdict is FAIL. Use an empty array when verdict is PASS.",
  }),
  notes: Type.Array(Type.String(), {
    description:
      "Non-blocking, optional/minor observations or suggested improvements — the kind of feedback a real reviewer " +
      "leaves as 'Minor/optional' without failing the task. Include these regardless of verdict; use an empty array " +
      "if you truly have none.",
  }),
});

export function createReportTool(capture: { report?: ReviewReport }): ToolDefinition<typeof reportToolParams> {
  return {
    name: REPORT_TOOL_NAME,
    label: "Submit Review Report",
    description:
      "Submit your final verdict for this review. This is the ONLY way to report your result — " +
      "call it exactly once, as your last action, after you have finished reading and analyzing the relevant files. " +
      "Do not write a plain-text final answer instead of calling this tool.",
    parameters: reportToolParams,
    async execute(_toolCallId, params) {
      capture.report = {
        verdict: params.verdict,
        summary: params.summary,
        reasons: params.reasons ?? [],
        notes: params.notes ?? [],
      };
      return {
        content: [{ type: "text", text: `Report recorded: ${params.verdict}` }],
        details: undefined,
      };
    },
  };
}
