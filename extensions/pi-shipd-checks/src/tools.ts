/**
 * Custom tools the review/gap agents call to submit their structured results.
 * Each tool just writes into a `capture` object passed in by the caller —
 * that's how agents.ts pulls the final result back out of the agent session.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewReport, TestGapCandidate, TestGapFinal } from "./types.js";

export const REPORT_TOOL_NAME = "submit_review_report";
export const GAP_FINDER_TOOL_NAME = "submit_test_gap_candidates";
export const GAP_VALIDATOR_TOOL_NAME = "submit_filtered_test_gaps";

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

// ── Test-gap finder / filter tools ────────────────────────────────────

const gapFinderToolParams = Type.Object({
  gaps: Type.Array(
    Type.Object({
      description: Type.String({ description: "The specific untested behavior or edge case, in plain terms." }),
      risk: Type.String({
        description:
          "Concretely why a plausible-but-incorrect implementation could still pass every test in test.patch " +
          "despite missing or misimplementing this behavior.",
      }),
    }),
    {
      description:
        "Candidate behavioral test gaps grounded in agent_prompt.md or clear existing repo behavior. Use an empty " +
        "array if you found none — do not manufacture gaps just to report something.",
    },
  ),
});

export function createGapFinderTool(capture: {
  gaps?: TestGapCandidate[];
}): ToolDefinition<typeof gapFinderToolParams> {
  return {
    name: GAP_FINDER_TOOL_NAME,
    label: "Submit Candidate Test Gaps",
    description:
      "Submit your candidate list of behavioral test gaps. This is the ONLY way to report your result — call it " +
      "exactly once, as your last action, after you have finished reading and analyzing the relevant files.",
    parameters: gapFinderToolParams,
    async execute(_toolCallId, params) {
      const gaps = params.gaps ?? [];
      capture.gaps = gaps;
      return {
        content: [{ type: "text", text: `Recorded ${gaps.length} candidate gap(s)` }],
        details: undefined,
      };
    },
  };
}

const gapValidatorToolParams = Type.Object({
  gaps: Type.Array(
    Type.Object({
      description: Type.String({ description: "The confirmed, real, fair test gap (may be reworded for clarity)." }),
      justification: Type.String({
        description:
          "Why this is genuinely grounded in agent_prompt.md or the repo, fair to test per the fairness " +
          "methodology, and a real (non-duplicate) coverage hole in test.patch.",
      }),
    }),
    {
      description:
        "The filtered, final list of confirmed test gaps. Use an empty array if none of the candidates survive " +
        "strict scrutiny.",
    },
  ),
});

export function createGapValidatorTool(capture: {
  gaps?: TestGapFinal[];
}): ToolDefinition<typeof gapValidatorToolParams> {
  return {
    name: GAP_VALIDATOR_TOOL_NAME,
    label: "Submit Filtered Test Gaps",
    description:
      "Submit your final, strictly filtered list of confirmed test gaps. This is the ONLY way to report your " +
      "result — call it exactly once, as your last action, after you have independently verified each candidate.",
    parameters: gapValidatorToolParams,
    async execute(_toolCallId, params) {
      const gaps = params.gaps ?? [];
      capture.gaps = gaps;
      return {
        content: [{ type: "text", text: `Confirmed ${gaps.length} gap(s) after filtering` }],
        details: undefined,
      };
    },
  };
}
