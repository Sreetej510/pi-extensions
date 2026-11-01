/** Prompt text for the focus reviewers and the `--solve` solver fairness reviewer (the auditor's prompts live in auditor-prompts.ts). */

import { REPORT_TOOL_NAME } from "./tools.js";
import type { ReviewerRole, ReviewerRoleKey, SolverRunResult } from "./types.js";

const ROLE_FOCUS: Record<ReviewerRoleKey, string> = {
  description:
    "Focus area: the task description in `agent_prompt.md`. Judge it strictly against rubric items P1-P5 below. " +
    "You do not need to judge the tests or solution — other reviewers cover those.",
  tests:
    "Focus area: the tests added in `test.patch` (a unified diff). Judge them strictly against rubric items T1-T8 below. " +
    "You cannot execute code or apply the patch, so read the diff carefully and reason about determinism, coverage, and " +
    "strictness directly from the added code. Read `agent_prompt.md` for context on what behavior is in scope, and skim " +
    "`solution.patch` only to understand what the tests are checking. Do not judge the description or the solution's code quality.\n" +
    "Mandatory symbol-fairness check: for every non-trivial method/function/property/export name that a test calls, " +
    "mutates, mocks, or asserts on, use grep/read on the repository (the pre-existing code, not solution.patch) to " +
    "confirm it actually exists there, OR confirm it is explicitly named in `agent_prompt.md`. Pay special attention to " +
    "any such name that is new/invented and that duplicates, shadows, or conflicts with an existing, differently-named " +
    "public API doing the same thing (e.g. a test calling `setFoo(...)` when the repo's real, visible API is `setBar(...)`) " +
    "— that is a textbook unfair/undiscoverable test per the fairness methodology, and is blocking on its own even if " +
    "every other test in the patch is fine.",
  solution:
    "Focus area: the golden solution in `solution.patch` (a unified diff). Judge it strictly against rubric items S1-S4 below. " +
    "Read `agent_prompt.md` for the requirements and `test.patch` to see what must pass, and use read/grep/ls/find on the rest " +
    "of the repository to check for regressions, inconsistent style, and irrelevant/unexplained changes. Do not judge the " +
    "description's wording or the tests' coverage.\n" +
    "Mandatory repo-conventions check: for every file and area touched by `solution.patch`, read the corresponding " +
    "pre-existing code in the repo — same directory, sibling modules, similar components/services/hooks, and any " +
    "files the patch imports from or extends. Establish how this repo actually does things (error handling and logging, " +
    "naming, exports, state management, async patterns, i18n, test helpers, DI/service boundaries, comment density, " +
    "defensive checks) and judge whether the solution matches those conventions. Flag clear deviations as S2/S4 issues — " +
    "e.g. inventing a new logger when the repo uses a shared one, raw `console.*` where the codebase uses a structured " +
    "error reporter, a different hook/service pattern than neighboring features, or new abstractions where similar code " +
    "inlines the same logic. Use grep/read to find 2–3 closest analogues before concluding a pattern is acceptable.\n" +
    "Mandatory dead-code check: scan every added/changed line in `solution.patch` for unused code — variables, " +
    "parameters, imports, functions/methods, or fields that are declared/assigned but never read or called anywhere " +
    "(including by `test.patch`) — and for dead/unreachable code (branches, conditions, or statements that can never " +
    "execute, or code left behind after a return/throw/break that makes it unreachable). Use grep to confirm a symbol " +
    "truly has no other usages in the repo before flagging it. This is a rubric S4 violation and is blocking on its " +
    "own, even if the rest of the solution is otherwise excellent.",
};

// Rule text is supplied by the mode-specific `rules.md` section. Keep prompt
// builders focused on procedure and evidence rather than duplicating policy.

export function buildReviewerPrompt(role: ReviewerRole, rubric: string, fairnessRules: string): string {
  const parts = [
    "You are a careful, calibrated reviewer for a coding-agent benchmark task.",
    "You are working inside a throwaway, read-only copy of a git repository (this is your current directory). " +
      "You have access to read/grep/find/ls tools only — you cannot execute code, apply patches, or edit files.",
    "The repo root may contain: `agent_prompt.md` (the task description), `test.patch` (unified diff adding tests), " +
      "and `solution.patch` (unified diff of the golden solution). Read whichever are relevant to your focus, and read " +
      "the rest of the repository as needed via grep/read/ls/find to judge things against real repo context.",
    "",
    ROLE_FOCUS[role.key],
    "",
    "Checklist for your focus area:",
    rubric,
  ];

  if (fairnessRules) {
    parts.push(
      "",
      "Fairness methodology (use this to judge whether an issue is actually blocking, and to distinguish agent-fault " +
        "from prompt-ambiguity from test-flaw problems):",
      fairnessRules,
    );
  }

  if (role.key === "solution") {
    parts.push(
      "",
      "Solution-specific calibration for repo standards (S2/S4):",
      "Before returning PASS, you must have read real analogue files in the repo and compared patterns. A clear, " +
        "documented mismatch with established repo conventions — wrong error/logging approach, inconsistent service " +
        "or hook structure vs neighboring code, new patterns where the repo consistently uses existing ones — is " +
        "blocking under S2/S4, not a minor note. Purely cosmetic nits (spacing, import order) with no pattern break " +
        "belong in `notes`.",
    );
  }

  parts.push(
    "",
    "How to set the verdict — calibrate, don't nitpick:",
    "FAIL only for a genuine BLOCKING issue: a checklist item is clearly violated, a requirement stated in " +
      "`agent_prompt.md` is untested or contradicted, a test asserts something unfair/undiscoverable per the " +
      "fairness methodology above (private internals, exact class names not in the prompt, exact call order, " +
      "reference-solution-only structure, etc.), a test is genuinely non-deterministic in a way that risks real " +
      "CI flakiness (real network calls, unseeded randomness, race-prone ordering), or the solution has a real " +
      "regression, missing requirement, or unrelated/unexplained change.",
    "Do NOT fail for: optional coverage suggestions, 'would also be nice to test X', dead/unused code that doesn't " +
      "affect correctness, minor style inconsistencies, or defensible implementation choices the prompt didn't " +
      "forbid. These are exactly the kind of thing a real reviewer leaves as a 'Minor/optional' note without " +
      "failing the task — put them in `notes` and still return PASS.",
    "When genuinely torn between PASS and FAIL, default to PASS with the concern captured in `notes`, unless the " +
      "issue would let a materially incorrect agent solution pass the hidden tests, or would unfairly fail a " +
      "correct one — that is always blocking.",
    "A single blocking issue is enough to FAIL, even if it affects only one test or one line out of many, and even " +
      "if the rest of the suite is excellent. Do NOT average it away or let a large, otherwise-strong test suite " +
      "talk you into a PASS — one unfair or undiscoverable test (e.g. requiring a private/invented API name that " +
      "doesn't exist in the repo and isn't named in the prompt, especially one that conflicts with an existing, " +
      "differently-named public API) is exactly as blocking as many.",
    "",
    `When you are done analyzing, call the \`${REPORT_TOOL_NAME}\` tool exactly once with your structured verdict. ` +
      "That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}

// ── Claude CLI benchmark solvers and local Claude CLI fairness reviewer ─────

function solverOutcomeLine(result: SolverRunResult): string {
  const tests = (value: boolean | undefined) => (value === undefined ? "not run" : value ? "PASS" : "FAIL");
  return (
    `- Agent ${result.index}: process=${result.status}; base=${tests(result.baseTests?.passed)}; ` +
    `new=${tests(result.newTests?.passed)}; diff=${result.diff ? "present" : "empty"}`
  );
}

export function buildSolverReviewPrompt(
  taskPrompt: string,
  solverResults: SolverRunResult[],
  testGuidelines: string,
  fairnessRules: string,
  hasReferenceSolution: boolean,
): string {
  const comparison = hasReferenceSolution
    ? [
        "",
        "Then, as a separate step, compare the implementation logic of every solver's `solver_solution.patch` directly " +
          "with our `review_assets/reference_solution.patch` (the task author's solution) for this exact prompt. Look " +
          "only at non-test source code: ignore test files, fixtures, documentation, comments, docstrings, changelogs, " +
          "and other non-code changes in both patches, and do not use test results or the test patch as evidence here. " +
          "Report only places where our solution has a logical error or mishandles an edge case that a solver's code " +
          "handles correctly, for example a missed input/state combination, a wrong boundary or condition, an " +
          "unhandled error or empty/None case, wrong ordering, or a code path that the prompt's behavior also covers " +
          "but ours does not update. Do not report style, naming, structure, simplicity, performance, or idiom " +
          "preferences, differences that are equally correct, or behavior the prompt does not ask for. For each " +
          "finding, name the solver(s), cite the relevant hunks from both patches and the prompt text the behavior " +
          "serves, give a concrete input or state where our code is wrong and the solver's is right, and state the " +
          "logic change our solution should make. If no solver handles anything better, say so.",
      ]
    : [];
  return [
    "You are an independent, skeptical reviewer for a coding-agent task benchmark.",
    "This is a read-only review. The source tree at the current working directory is clean HEAD and no patch has been " +
      "applied to it. `review_assets/` contains the exact agent_prompt.md, test.patch, an optional reference_solution.patch, " +
      "standalone copies of new files extracted from test.patch under `proposed_tests/`, and `solver_<index>/` folders " +
      "with each solver's unapplied `solver_solution.patch`, one-shot output, base/new logs, and result metadata. " +
      "Inspect the patches as patches; do not apply them. For changed existing tests, compare the test.patch hunk with " +
      "the clean-HEAD file. The task Dockerfile is not included.",
    "",
    "Exact task prompt sent as the solver's only first user message:",
    "--- BEGIN TASK PROMPT ---",
    taskPrompt,
    "--- END TASK PROMPT ---",
    "",
    "Agents saw clean HEAD (including any files already committed there) and that exact prompt; no test patch or external task Dockerfile was overlaid. The harness ran " +
      "`bash test.sh --output_path <file> base` and `bash test.sh --output_path <file> new` after each solver finished. " +
      "These are harness-captured results, not agent self-reports. Status summary:",
    ...solverResults.map(solverOutcomeLine),
    "",
    "Review the tests for fairness against the exact requirements in `review_assets/agent_prompt.md`, and review all " +
      "solver patches and results. Do not read entire test logs directly: use search/grep to locate failures, errors, " +
      "assertions, and summaries, then read only the relevant ranges to conserve context. For each failed or incomplete " +
      "agent, decide whether the evidence points to: (1) an incorrect or incomplete solution relative to the prompt, " +
      "(2) an unfair, defective, or prompt-misaligned test, (3) an execution/setup failure unrelated to task quality, " +
      "or (4) insufficient evidence. A failed test alone does not prove that the test is unfair; cite the relevant " +
      "prompt text, test behavior, diff, and output.",
    "For the fairness review, the optional reference_solution.patch is context only, not a specification; do not infer " +
      "requirements from it that the prompt does not state. Consider whether the tests' setup, assumptions, fixtures, " +
      "expected values, and base/new separation are discoverable and reasonable for an agent working from clean HEAD " +
      "and the exact prompt.",
    ...comparison,
    "",
    "Use this test-quality checklist as guidance:",
    testGuidelines,
    "",
    "Apply these fairness rules:",
    fairnessRules,
    "",
    "Return a concise Markdown report with: an overall assessment; concrete fairness findings (or say none found); " +
      "a per-agent outcome table; " +
      (hasReferenceSolution
        ? "a 'Suggested improvements to our solution' section with the comparison findings (or say none found); "
        : "") +
      "and prompt/test/diff/log evidence for every attribution. Clearly label uncertain conclusions. Do not edit " +
      "files or run commands.",
  ].join("\n");
}
