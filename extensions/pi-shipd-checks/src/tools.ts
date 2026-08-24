/**
 * Custom tools the review/gap agents call to submit their structured results.
 * Each tool just writes into a `capture` object passed in by the caller —
 * that's how agents.ts pulls the final result back out of the agent session.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ReviewReport,
  SolutionAuditFinding,
  SolverGap,
  StatementGapReport,
  TestAuditFinding,
  TestGapFinal,
} from "./types.js";

export const REPORT_TOOL_NAME = "submit_review_report";
export const GAP_FINDER_TOOL_NAME = "submit_test_gap_candidates";
export const GAP_VALIDATOR_TOOL_NAME = "submit_filtered_test_gaps";
export const TEST_AUDIT_TOOL_NAME = "submit_test_audit_findings";
export const SOLUTION_AUDIT_TOOL_NAME = "submit_solution_audit_findings";
export const SOLVER_GAP_TOOL_NAME = "submit_solver_gaps";

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
  statement: Type.String({ description: "One sentence from agent_prompt.md, copied verbatim." }),
  gaps: Type.Array(
    Type.Object({
      description: Type.String({ description: "A fair, publicly observable missing behavioral test." }),
      risk: Type.String({
        description: "Why an incorrect implementation could pass the current tests despite this missing behavior.",
      }),
    }),
    {
      description:
        "All candidate positive and negative gaps for this sentence; there is no maximum or target count, so " +
        "include every distinct evidence-backed gap and relevant edge case rather than stopping at 10; use an " +
        "empty array only when exhaustive analysis finds none.",
    },
  ),
});

export function createGapFinderTool(capture: {
  statements?: StatementGapReport[];
}): ToolDefinition<typeof gapFinderToolParams> {
  return {
    name: GAP_FINDER_TOOL_NAME,
    label: "Submit Candidate Test Gaps",
    description:
      "Submit one candidate-gap list for one prompt sentence. Call this after each sentence so the orchestrator can " +
      "track the todo list; empty lists are required when that sentence has no gaps.",
    parameters: gapFinderToolParams,
    async execute(_toolCallId, params) {
      const statements = capture.statements ?? [];
      statements.push({ statement: params.statement, gaps: params.gaps ?? [] });
      capture.statements = statements;
      return {
        content: [{ type: "text", text: `Recorded ${params.gaps?.length ?? 0} candidate gap(s)` }],
        details: undefined,
      };
    },
  };
}

const gapValidatorToolParams = Type.Object({
  gaps: Type.Array(
    Type.Object({
      description: Type.String({
        description:
          "The confirmed, real, fair test gap (may be reworded for clarity). Keep POSITIVE:/NEGATIVE: prefix when " +
          "applicable.",
      }),
      justification: Type.String({
        description:
          "Why this is genuinely grounded in agent_prompt.md or the repo, fair to test per the fairness " +
          "methodology, and a real (non-duplicate) coverage hole in test.patch — for negative gaps, cite the " +
          "prompt's prohibition/constraint and why no existing test catches the forbidden outcome.",
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

const testAuditFindingParams = Type.Object({
  category: Type.Union(
    [Type.Literal("unfair-assertion"), Type.Literal("prompt-ambiguity"), Type.Literal("broken-fixture")],
    {
      description: "The kind of actionable problem found in the current test or its setup.",
    },
  ),
  testName: Type.String({
    description: "The test name or short identifier that lets the caller find the affected assertion.",
  }),
  problem: Type.String({
    description: "What is wrong with the test and why it is blocking or actionable.",
  }),
  evidence: Type.String({
    description: "The prompt, public repository contract, test, or fixture evidence supporting the finding.",
  }),
  requiredBehavior: Type.String({
    description: "The semantic behavior or gap that must remain covered after the test is repaired.",
  }),
  recommendation: Type.String({
    description: "A fair repair, or a prompt clarification when the contract is genuinely ambiguous.",
  }),
});

const testAuditFindingsParams = Type.Object({
  findings: Type.Array(testAuditFindingParams, {
    description:
      "Only confirmed, actionable test-fairness, ambiguity, or fixture findings from the complete audit. " +
      "Use an empty array when the current tests contain no confirmed unfairness.",
  }),
});

export function createTestAuditTool(capture: {
  findings?: TestAuditFinding[];
}): ToolDefinition<typeof testAuditFindingsParams> {
  return {
    name: TEST_AUDIT_TOOL_NAME,
    label: "Submit Test Audit Findings",
    description:
      "Submit the complete result from the single post-implementation test-fairness audit. This is the ONLY way " +
      "to report your result — call it exactly once, as your last action. Use an empty list when no actionable issue " +
      "is found.",
    parameters: testAuditFindingsParams,
    async execute(_toolCallId, params) {
      const findings = params.findings ?? [];
      capture.findings = findings;
      return {
        content: [{ type: "text", text: `Recorded ${findings.length} test-audit candidate(s)` }],
        details: undefined,
      };
    },
  };
}

const solutionAuditFindingParams = Type.Object({
  category: Type.Union(
    [
      Type.Literal("missing-requirement"),
      Type.Literal("regression"),
      Type.Literal("architecture"),
      Type.Literal("unsafe-failure"),
      Type.Literal("inconsistent-path"),
      Type.Literal("dead-code"),
      Type.Literal("unrelated-change"),
    ],
    {
      description: "The kind of actionable quality problem found in the solution implementation.",
    },
  ),
  subject: Type.String({
    description: "A short behavior, symbol, or concern identifier; do not require a source line or file location.",
  }),
  problem: Type.String({
    description: "What is wrong with the implementation and why it is actionable.",
  }),
  evidence: Type.String({
    description: "The prompt, repository, implementation, or regression evidence supporting the finding.",
  }),
  requiredBehavior: Type.String({
    description: "The requirement, invariant, or solution-quality property that must be preserved.",
  }),
  recommendation: Type.String({
    description: "A concrete repair that stays within the prompt and repository conventions.",
  }),
});

const solutionAuditFindingsParams = Type.Object({
  findings: Type.Array(solutionAuditFindingParams, {
    description:
      "Only confirmed, actionable solution-quality findings. Use an empty array when the implementation meets the " +
      "prompt and repository standards.",
  }),
});

export function createSolutionAuditTool(capture: {
  findings?: SolutionAuditFinding[];
}): ToolDefinition<typeof solutionAuditFindingsParams> {
  return {
    name: SOLUTION_AUDIT_TOOL_NAME,
    label: "Submit Solution Audit Findings",
    description:
      "Submit the complete result from the single post-implementation solution-quality audit. This is the ONLY " +
      "way to report your result — call it exactly once, as your last action. Use an empty list when no actionable " +
      "issue is found.",
    parameters: solutionAuditFindingsParams,
    async execute(_toolCallId, params) {
      const findings = params.findings ?? [];
      capture.findings = findings;
      return {
        content: [{ type: "text", text: `Recorded ${findings.length} solution-audit finding(s)` }],
        details: undefined,
      };
    },
  };
}

// ── Solver-gap-finder comparison reviewer tool ──────────────────────────

const solverGapToolParams = Type.Object({
  gaps: Type.Array(
    Type.Object({
      description: Type.String({
        description:
          "The specific behavioral gap: a way one or more solver's diff differs materially from what " +
          "agent_prompt.md/solution.patch require, despite that solver passing `./test.sh new`.",
      }),
      justification: Type.String({
        description:
          "Why this is a genuine requirement from agent_prompt.md or solution.patch (cite the specific " +
          "requirement/line) that the solver's diff misses, contradicts, or diverges from — and why the current " +
          "tests fail to catch that divergence.",
      }),
      evidence: Type.String({
        description:
          "Which solver(s) (by index) exhibit this, and the specific part of their diff that grounds the gap.",
      }),
    }),
    {
      description:
        "Concrete, diff-grounded behavioral gaps — cases where a passing solver's materially different approach " +
        "reveals that `test.sh new` under-specifies a real requirement. Use an empty array if the solvers " +
        "converged on equivalent behavior; do not manufacture gaps just to report something.",
    },
  ),
});

export function createSolverGapTool(capture: { gaps?: SolverGap[] }): ToolDefinition<typeof solverGapToolParams> {
  return {
    name: SOLVER_GAP_TOOL_NAME,
    label: "Submit Solver Gaps",
    description:
      "Submit your final list of behavioral gaps found by comparing the solver diffs against the real " +
      "solution.patch. This is the ONLY way to report your result — call it exactly once, as your " +
      "last action, after you have finished comparing every solver.",
    parameters: solverGapToolParams,
    async execute(_toolCallId, params) {
      const gaps = params.gaps ?? [];
      capture.gaps = gaps;
      return {
        content: [{ type: "text", text: `Recorded ${gaps.length} solver gap(s)` }],
        details: undefined,
      };
    },
  };
}
