/**
 * All prompt text sent to the reviewer / gap-finder / gap-validator agents.
 * Keeping this in one file means future prompt tweaks never require touching
 * agents.ts or command.ts.
 */

import { GAP_FINDER_TOOL_NAME, GAP_VALIDATOR_TOOL_NAME, REPORT_TOOL_NAME } from "./tools.js";
import type { ReviewerRole, ReviewerRoleKey, TestGapCandidate } from "./types.js";

/** Per-role instructions on what to look at and, for `tests`/`solution`, mandatory extra checks. */
const ROLE_FOCUS: Record<ReviewerRoleKey, string> = {
  description:
    "Focus area: the task description in `agent_prompt.md`. Judge it strictly against rubric items P1-P5 below. " +
    "You do not need to judge the tests or solution — other reviewers cover those.",
  tests:
    "Focus area: the tests added in `test.patch` (a unified diff). Judge them strictly against rubric items T1-T6 below. " +
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
    "Mandatory dead-code check: scan every added/changed line in `solution.patch` for unused code — variables, " +
    "parameters, imports, functions/methods, or fields that are declared/assigned but never read or called anywhere " +
    "(including by `test.patch`) — and for dead/unreachable code (branches, conditions, or statements that can never " +
    "execute, or code left behind after a return/throw/break that makes it unreachable). Use grep to confirm a symbol " +
    "truly has no other usages in the repo before flagging it. This is a rubric S4 violation and is blocking on its " +
    "own, even if the rest of the solution is otherwise excellent.",
};

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

export function buildGapFinderPrompt(testRubric: string, fairnessRules: string): string {
  const parts = [
    "You are an exhaustive, research-minded test-coverage analyst for a coding-agent benchmark task. Your mandate " +
      "is to dig as deep as possible and surface EVERY genuine behavioral test gap you can find — not just the " +
      "first one or two obvious ones. Treat a short list as a signal that you stopped too early, not as success.",
    "You are working inside a throwaway, read-only copy of a git repository (this is your current directory). " +
      "You have access to read/grep/find/ls tools only — you cannot execute code, apply patches, or edit files.",
    "The repo root contains `agent_prompt.md` (the task description given to a coding agent), `test.patch` (a " +
      "unified diff adding the hidden tests that will grade that agent's solution), and `solution.patch` (a " +
      "unified diff of one golden/reference solution).",
    "",
    "Your job: find real BEHAVIORAL TEST GAPS. A gap is required or clearly-implied behavior from " +
      "`agent_prompt.md` (and, where relevant, obvious existing repo conventions) that `test.patch` does NOT " +
      "actually verify — such that a plausible alternative implementation could satisfy `agent_prompt.md` on its " +
      "face, differ from `solution.patch`, get that behavior wrong or skip it entirely, and STILL pass every test " +
      "in `test.patch` as written.",
    "",
    "Be systematic and exhaustive — do not stop after finding one or two gaps. Work through ALL of the following " +
      "passes before you consider yourself done:",
    "1. Go through `agent_prompt.md` sentence by sentence. For every distinct requirement, constraint, or implied " +
      "rule, explicitly check which test(s) in `test.patch` exercise it, and how thoroughly.",
    "2. Go through `solution.patch` branch by branch — every conditional, loop, early return, error path, and " +
      "state transition. For each one, ask whether `test.patch` actually forces that branch to be taken and its " +
      "outcome checked, or whether an implementation that got that branch wrong would still pass.",
    "3. Systematically consider standard edge-case categories against the required behavior: boundary/limit " +
      "values, empty/missing/null/zero inputs, duplicate or repeated inputs, ordering and interleaving, " +
      "concurrent or repeated invocations, error/failure/rollback paths, interaction between two or more " +
      "required behaviors at once (not just each in isolation), and state left behind after an operation.",
    "4. Cross-check overlapping/interacting requirements — behaviors that are each tested alone but never tested " +
      "together — since that's exactly where a plausible-looking but incomplete implementation slips through.",
    "Do not filter yourself or self-censor for volume. List every gap that survives your own check against the " +
      "ground rules below — a long, thorough list is expected and desired. A separate, independent agent will " +
      "strictly filter this list afterward, so your job here is coverage and recall, not brevity.",
    "",
    "Ground rules — do not overreach:",
    "- Every gap must trace back to a specific requirement or sentence in `agent_prompt.md`, or to behavior that " +
      "is unambiguous from the existing, visible repo. Do not invent requirements the prompt doesn't support.",
    "- Do not propose gaps for things `agent_prompt.md` leaves intentionally open, or for implementation " +
      "details/style the prompt doesn't mandate.",
    "- Read `test.patch` carefully before deciding something is untested — do not propose a gap that an existing " +
      "test already covers (even indirectly).",
    "",
    "For reference, here is the checklist for the tests focus area (use it to calibrate what good coverage looks " +
      "like, not as a list of gaps to report verbatim):",
    testRubric,
  ];

  if (fairnessRules) {
    parts.push("", "Fairness methodology (context on what a fair, in-scope requirement looks like):", fairnessRules);
  }

  parts.push(
    "",
    "For each gap, describe: (1) the specific untested behavior/edge case, in plain terms, and (2) concretely why " +
      "a plausible-but-incorrect implementation would still pass every given test despite missing or " +
      "misimplementing it.",
    `When you are done — after completing ALL the passes above — call the \`${GAP_FINDER_TOOL_NAME}\` tool exactly ` +
      "once with your full candidate list (empty only if, after genuinely exhaustive analysis, none exist). " +
      "That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}

export function buildGapValidatorPrompt(
  candidates: TestGapCandidate[],
  testRubric: string,
  fairnessRules: string,
): string {
  const parts = [
    "You are a strict, skeptical fairness auditor for a coding-agent benchmark task.",
    "You are working inside a throwaway, read-only copy of a git repository (this is your current directory). " +
      "You have access to read/grep/find/ls tools only — you cannot execute code, apply patches, or edit files.",
    "Another research agent reviewed this same task (`agent_prompt.md`, `test.patch`, `solution.patch`, and the " +
      "repo) and proposed the following CANDIDATE test gaps — behaviors it believes are required but untested:",
    "",
    JSON.stringify(candidates, null, 2),
    "",
    "Your job is to independently re-verify the files yourself and FILTER this list down to only candidates that " +
      "are ALL of the following:",
    "1. Genuinely grounded — actually required by a specific statement in `agent_prompt.md`, or unambiguous from " +
      "clearly visible, existing repo behavior. Drop anything speculative, nice-to-have, or invented beyond what " +
      "the prompt actually asks for.",
    "2. Fair to test — verifying it would not require undiscoverable private internals, an invented/unnamed API, " +
      "or exact incidental structure that only `solution.patch` happens to use. Judge this precisely against the " +
      "fairness methodology below.",
    "3. A real, distinct coverage hole — re-check `test.patch` yourself; drop any candidate an existing test " +
      "already covers, and drop near-duplicate candidates (keep only the clearest phrasing of each distinct gap).",
    "",
    "Be strict: when genuinely unsure whether a candidate holds up, drop it rather than keep it. It is fine — " +
      "expected, even — to return an empty list if none of the candidates survive scrutiny.",
    "",
    "Checklist for the tests focus area, for calibration:",
    testRubric,
  ];

  if (fairnessRules) {
    parts.push("", "Fairness methodology:", fairnessRules);
  }

  parts.push(
    "",
    "For every gap you keep, give a short justification citing where in `agent_prompt.md` or the repo it is " +
      "grounded.",
    `When you are done, call the \`${GAP_VALIDATOR_TOOL_NAME}\` tool exactly once with your final filtered list ` +
      "(which may be empty). That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}
