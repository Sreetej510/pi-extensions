/** All prompt text sent to the reviewer / gap-finder / gap-validator / solver-gap-finder agents. */

import { SOLVER_GAP_SOLUTIONS_DIRNAME } from "./solvergap.js";
import { GAP_FINDER_TOOL_NAME, GAP_VALIDATOR_TOOL_NAME, REPORT_TOOL_NAME, SOLVER_GAP_TOOL_NAME } from "./tools.js";
import type { ReviewerRole, ReviewerRoleKey, SolverRunResult, StatementGapReport } from "./types.js";

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

function gapFinderPreamble(focusLine: string): string[] {
  return [
    focusLine,
    "You are working inside the actual repository (this is your current directory) in read-only mode. " +
      "You have access to read/grep/find/ls tools only — you cannot execute code or edit files.",
    "Read `agent_prompt.md` for the task requirements and inspect the repository's existing source/code files " +
      "with read/grep/find/ls. Base the analysis on the prompt and the observable behavior supported by those code files.",
  ];
}

const GAP_FINDER_AGGRESSION = [
  "Thoroughness — your job is high recall on genuine gaps only:",
  "- There is no target count or cap: do not stop at 10 (or any other arbitrary number). For each prompt sentence, " +
    "enumerate as many distinct uncovered required behaviors and edge cases as the files justify, then continue " +
    "until an additional sweep finds no new genuine gap.",
  "- Find every gap you can justify with concrete evidence. Do not stop after the first obvious ones — keep reading until " +
    "you have systematically covered the prompt and relevant repository code.",
  "- After your first pass, run at least one deliberate second sweep (re-read `agent_prompt.md` and grep/read the " +
    "relevant code files) before submitting — but if that sweep still finds nothing, submit an empty list.",
  "- Do not self-censor or merge distinct genuine gaps into one — the validator will prune. Never invent or pad the list " +
    "to seem thorough; an empty array is correct when exhaustive analysis truly finds none.",
  "- Hunt subtle gaps too: behaviors that may be missed under other valid inputs, repository conventions, interaction " +
    "effects, ordering/timing, and branches in the relevant source code that need behavioral coverage.",
  "- Include a candidate only when you can cite specific grounding and a concrete false-pass risk — not to meet a quota.",
];

const GAP_FAIRNESS_RULES = [
  "Fairness rules — apply these to every proposed gap and every proposed assertion:",
  "- Ground every candidate in a specific sentence or requirement in `agent_prompt.md`, or in an existing public " +
    "contract that is clear and directly relevant in the repository. Record the observable behavior and the plausible " +
    "incorrect implementation that could pass without this check. Do not create requirements from intuition, taste, " +
    "general best practice, or a desire for more coverage.",
  "- Treat `agent_prompt.md` as the task contract. Existing source can clarify how an already-public API behaves and can " +
    "make an established convention discoverable, but a neighboring helper, default, example, or implementation choice " +
    "does not automatically become a requirement for a new behavior. If repository evidence is absent, mixed, or " +
    "contradictory, leave the detail open rather than choosing one interpretation.",
  "- A fair check must be expressible through a user-visible result, a caller-visible side effect, a named public API, " +
    "or another documented/public contract. Do not require private state, private helpers, internal classes, file " +
    "placement, module boundaries, call order, a particular algorithm, or a particular direct platform/API call when " +
    "another repo-valid route produces the required outcome.",
  "- A newly invented function, class, property, export, constructor, method name, argument shape, import path, or " +
    "registry/config key is not a fair requirement merely because it would be a convenient way to test the feature. " +
    "Require a new API only when `agent_prompt.md` names it, or when the API already exists publicly and the task " +
    "explicitly relies on it.",
  "- For UI behavior, assert the user-facing control, label, visible state, accessible action, or resulting effect when " +
    "that is the contract. Do not require a particular DOM hierarchy, tag, CSS class, selector, test/data attribute, " +
    "ARIA attribute, hidden-shim text, focus order, keyboard traversal, or control implementation unless the prompt " +
    "or an established public UI contract explicitly requires it.",
  "- Test semantics rather than source representation. Do not pin quote style, whitespace, line breaks, token adjacency, " +
    "identifier spelling, generated-source wording, code length, AST node shape, type-text spelling, serialization " +
    "style, or a particular equivalent syntax when the resulting behavior is the same. Normalize, parse, compile, or " +
    "observe the result when that is necessary to compare equivalent forms.",
  "- For structured results, assert the fields, values, relationships, ordering, and preservation that the contract " +
    "actually requires. Allow additional valid fields and metadata unless the prompt explicitly forbids them. Do not " +
    "compare a whole object, list, mapping, or serialized document to a minimal reference-shaped object when only a " +
    "subset of its contents is contractual. For unspecified unknown fields, do not assume either permissive or strict " +
    "validation: acceptance is fair only when extras are expressly allowed or established, and rejection is fair only " +
    "when unknown fields are expressly forbidden or established at that schema level.",
  "- Treat configuration schemas as contracts, not guesses. Field type, collection shape, omitted-field defaults, " +
    "unknown-key policy, extension-based dispatch, coercion, and cross-field constraints are independently specified " +
    "decisions. Do not require a string-only name, a particular list shape, a filename-driven parser, a boolean-only " +
    "flag, a valid range relationship, or rejection of an extra key unless the prompt or a public schema settles it.",
  "- Make aggregation semantics explicit before requiring exact counts. A count may be per input, field, item, target, " +
    "rule, match, category, finding, log record, or operation; multiple units may overlap or be mutually exclusive. " +
    "For repair or mutation output, also distinguish findings measured before the change from findings remaining after " +
    "the change. If the contract does not choose the unit, test presence, effect, or a stated relationship rather than " +
    "an exact number.",
  "- Do not resolve interactions between separately described rules by intuition. Optional-path handling versus " +
    "target-level checks, validation versus evaluation, duplicate detection across collections, cache reuse versus a " +
    "new input, and consensus among agreeing versus dissenting values each need an explicit precedence or scope. " +
    "A test must not silently choose skip-all versus continue, majority versus unanimity, per-collection versus global " +
    "deduplication, or disjoint versus overlapping diagnostic categories.",
  "- Do not infer a concrete value from relational wording. Terms such as current, latest, selected, next, matching, " +
    "appropriate, or stable require the stated relationship or effect, not an arbitrary numeric or serialized value. " +
    "Pin a concrete value only when the prompt or a clear existing public contract determines it.",
  "- Do not infer an exact ordering, grouping, cardinality, count, or error-counting model from incidental map order, " +
    "loop order, a convenient fixture, or one implementation. Require ordering or counts only when the contract makes " +
    "them observable; otherwise assert membership, relationships, preservation, and the required effect without " +
    "choosing a granularity the prompt leaves open. This includes order of newly added versus loaded values and the " +
    "number or placement of repeated diagnostic terms.",
  "- Preserve scope qualifiers. A requirement for aware values, naive values, all-day values, one mode, one target " +
    "state, or one lifecycle phase does not automatically apply to every representation or phase. Do not transfer a " +
    "rule from one subtype to another, or require a changed wall time, timezone, normalization, or side effect outside " +
    "the scope in which the prompt states it.",
  "- Do not invent an input-domain policy for unspecified cases. Do not require acceptance or rejection of a particular " +
    "malformed, nullish, Unicode, unusually large, boolean-like, platform-specific, symlink, missing-parent, or other " +
    "boundary value unless the prompt or an established public contract settles that case. A sensible API policy is not " +
    "automatically the specified policy.",
  "- For failures, assert the failure or user-visible error behavior required by the contract. Do not require a specific " +
    "exception class, message wording, punctuation, embedded input value, capitalization, basename, validation phase, " +
    "or eager-versus-deferred timing unless it is explicitly promised or publicly established. If the contract only says " +
    "an operation fails clearly, accept equivalent clear failures. When the prompt expressly permits more than one " +
    "failure phase or handling path—such as load-time rejection or evaluation-time violation—accept every permitted " +
    "path; do not force one merely because it is easier to assert.",
  "- Do not assume an expression or embedded language has unlisted builtins, operators, container types, mutability, " +
    "mapping shapes, or context bindings. Test only the language surface and binding representation that the prompt or " +
    "an existing public evaluator contract names. A useful operation such as length, indexing, mutation, or a helper " +
    "call is not implicitly available in a restricted environment.",
  "- Respect asynchronous and lazy contracts. If the prompt promises an eventual effect, do not require a callback to " +
    "return a promise, immediate settlement, a particular debounce interval, construction-time validation, or one exact " +
    "observation point. Trigger the public operation and observe or wait for the promised result at a fair boundary.",
  "- Do not select an outcome for an underspecified mode boundary. Dry-run, preview, no-op, conflict, rollback, cache, " +
    "preflight, and post-context-change behavior may have multiple valid outcomes unless the prompt chooses one. Test " +
    "the guarantees that are stated, such as non-mutation or reporting, without adding a rejection, write, refresh, or " +
    "validation policy that was not stated.",
  "- Do not convert an incidental side effect into a requirement. For a no-op or reuse case, test the required content, " +
    "state, preservation, or absence of duplicate effects; do not additionally require an empty file, directory, cache " +
    "entry, history item, or other artifact to exist or not exist unless that artifact is part of the contract.",
  "- For logs and status messages, check that the required operation or failure is reported when reporting is contractual. " +
    "Do not demand arbitrary English words, formatting, punctuation, path spelling, message fragments, or exact output " +
    "layout when the prompt only requires that the operation be communicated.",
  "- A fair behavioral test must not depend on a hidden harness's mock shape, a source-level monkeypatch landing at one " +
    "import binding, an incomplete module mock, reassigned exported state, a particular failure-injection primitive, or " +
    "a synthetic fixture that violates real repository invariants. Patch or fake a dependency at a public lookup boundary " +
    "that supports the repository's valid import styles, rather than assuming whether code imports a module or a symbol. " +
    "A reasonable implementation must be able to use the repository's valid public exports and state model without " +
    "being rejected by the setup.",
  "- Test doubles must preserve the public interface and lifecycle needed to reach the assertion. A double for a " +
    "collaborator must implement existing extension points, return valid shapes, and provide newly required public " +
    "capabilities or isolate them through an explicit seam. Do not make a detached constructor, unmounted widget, " +
    "partial collection, missing pane service, or fake cache stand in for an active production flow unless that " +
    "detached behavior is itself contractual.",
  "- Separate fairness from test strength. A test can be fairly scoped yet too weak if it observes a color anywhere " +
    "instead of on the required target, checks a generic message without associating it with the operation, or verifies " +
    "a destination representation without preserving the required identity/instant/relationship. Do not call such a " +
    "test unfair for being permissive; treat it as insufficient coverage and require a precise public observation.",
  "- Distinguish the semantic goal from the assertion form. If a candidate contains a fair behavioral core plus an " +
    "unsupported value, representation, timing, API, or harness assumption, keep or rewrite the fair core and remove " +
    "only the unsupported co-assertion. Do not discard a real gap merely because the first proposed assertion was too " +
    "specific.",
  "- Do not turn a harness safety limit into a product requirement. A test-level subprocess timeout, signal alarm, " +
    "poll interval, viewport size, or platform-specific signal is only fair when the task or public performance contract " +
    "specifies it. Use a separate generous anti-hang guard for malformed or pathological evaluation, and assert the " +
    "required bounded/failure outcome without choosing an arbitrary wall-clock budget.",
  "- A failed setup and a failed behavioral assertion are different evidence. If a shared fixture crashes before the " +
    "feature is observed, or an observer renders the wrong viewport/widget after locating a valid result, the test is " +
    "broken rather than proof of an implementation gap. If the fixture reaches the public behavior but rejects a valid " +
    "alternative representation or integration path, it is a contract/test mismatch. Do not treat either as a fair " +
    "behavioral requirement.",
  "- Edge-case coverage is valuable only when the edge case is required or discoverable. Do not report 'more negative " +
    "tests would be nice' or every conceivable malformed input. Keep a candidate only when it is distinct, publicly " +
    "testable, concretely grounded, and could let a materially incorrect implementation pass.",
  "- When uncertain, re-read the exact prompt sentence and the closest public source analogues. If two competent " +
    "implementations can satisfy the contract while differing on the proposed assertion, the assertion is not fair; " +
    "return the semantic relationship instead or drop the candidate. An empty result is correct when no candidate " +
    "survives this standard.",
];

// Keep the same detailed rules for finders, validators, and solver-based comparison calibration.
const GAP_FINDER_GROUND_RULES = GAP_FAIRNESS_RULES;
const GAP_VALIDATOR_ADDITIONAL_RULES = GAP_FAIRNESS_RULES;

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

export function buildSentenceGapFinderPrompt(testRubric: string, _fairnessRules: string): string {
  const parts = [
    ...gapFinderPreamble(
      "You are an exhaustive behavioral test-gap finder. Review the task prompt sentence by sentence, finding both " +
        "missing required-behavior (positive) and missing forbidden/wrong-behavior (negative) tests.",
    ),
    "",
    "First split `agent_prompt.md` into its meaningful sentences using periods (`.`) as the sentence boundary. " +
      "Create an explicit TODO checklist of every resulting requirement sentence. Work through it one item at a time; " +
      "do not finish until every item is checked off.",
    "",
    "Before analyzing each sentence, use read/grep/find/ls to inspect the relevant source files and their closest " +
      "analogues. Use that code context to understand the public contracts, conventions, branches, guards, early returns, " +
      "state transitions, side effects, boundary handling, and negative/prohibited outcomes required by the sentence. " +
      "Report every distinct, prompt-required behavioral edge case or prohibition that a plausible implementation could " +
      "miss. Include positive and negative gaps together for that sentence. There is no maximum number of gaps: keep " +
      "enumerating distinct missing behaviors for this sentence, including boundary, empty, repeated, interacting, " +
      "and other relevant edge cases; do not treat 10 as sufficient.",
    "",
    ...GAP_FINDER_AGGRESSION,
    "",
    ...GAP_FINDER_GROUND_RULES,
    "",
    "Test-coverage checklist for calibration:",
    testRubric,
  ];
  parts.push(
    "",
    "Fairness: keep only behavior that a user, caller, or existing public contract can observe. Do not require private " +
      "helpers, internal state, implementation structure, call order, selectors, or incidental strings unless the task " +
      "explicitly makes them public requirements.",
  );
  parts.push(
    "",
    "For every candidate, state the missing fair behavioral test, the relevant source behavior or branch that led you " +
      "to investigate it, and why a plausible incorrect implementation could evade that test. The prompt sentence is " +
      "the required specification: do not report incidental implementation details it does not require. Do not propose " +
      "the exact test implementation.",
    `After completing EACH TODO sentence, call \`${GAP_FINDER_TOOL_NAME}\` with that exact sentence and its gap array ` +
      "(including an empty array when none exist). You may and must call the tool multiple times: once per sentence. " +
      "Only finish after every TODO item has been submitted.",
  );
  return parts.join("\n");
}

export function buildPositiveGapFinderPrompt(testRubric: string, fairnessRules: string): string {
  const parts = [
    ...gapFinderPreamble(
      "You are an exhaustive, research-minded POSITIVE test-coverage analyst for a coding-agent benchmark task. " +
        "Your sole mandate is to surface EVERY genuine POSITIVE behavioral test gap — required behavior that " +
        "`test.patch` never asserts but `agent_prompt.md` requires. Do NOT search for forbidden/wrong-behavior " +
        "gaps; a separate negative-case agent handles those in parallel. Stay in your lane and search exhaustively " +
        "before concluding there are none.",
    ),
    "",
    "Your job: find real POSITIVE TEST GAPS. A positive gap is required or clearly-implied behavior from " +
      "`agent_prompt.md` (and, where relevant, obvious existing repo conventions) that `test.patch` does NOT " +
      "actually verify — such that a plausible implementation could skip or misimplement that required behavior " +
      "and STILL pass every test in `test.patch` as written.",
    "",
    "Focus on required outcomes: happy paths, side effects, state changes, outputs, transitions, edge inputs " +
      "where the prompt still expects correct handling, combined/interacting behaviors, and branches in " +
      "`solution.patch` whose correct outcome is never forced by a test.",
    "",
    "Be systematic and exhaustive — work through ALL of the following passes:",
    "1. Go through `agent_prompt.md` sentence by sentence. For every distinct required behavior, constraint, or " +
      "implied rule, check which test(s) in `test.patch` exercise it and how thoroughly.",
    "2. Go through `solution.patch` branch by branch — every conditional, loop, early return, error path, and " +
      "state transition. For each one, ask whether `test.patch` forces the correct outcome to be checked.",
    "3. Consider standard positive edge-case categories: boundary/limit values, empty/missing/null/zero inputs " +
      "that should still produce the required correct behavior, duplicate or repeated inputs handled correctly, " +
      "ordering and interleaving, concurrent or repeated invocations, error/failure/rollback paths that should " +
      "recover correctly, interaction between two or more required behaviors at once, and state left behind " +
      "after an operation.",
    "4. Cross-check overlapping/interacting requirements — behaviors each tested alone but never tested together.",
    "5. Second-pass sweep: return to any requirement you marked 'covered' and ask whether coverage is shallow — one happy-path " +
      "assertion is not enough if other valid inputs, sequences, or combinations could still slip through.",
    ...GAP_FINDER_AGGRESSION,
    "Do not filter yourself or self-censor for volume. A separate validator will strictly filter afterward — " +
      "your job is recall on POSITIVE gaps only.",
    "",
    ...GAP_FINDER_GROUND_RULES,
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
    "For each gap, prefix the description with `POSITIVE:` and explain: (1) the specific untested required " +
      "behavior/edge case, and (2) concretely why a plausible-but-incomplete implementation would still pass " +
      "every given test despite missing or misimplementing it.",
    `When you are done — after completing ALL the passes above and a deliberate second sweep — call the \`${GAP_FINDER_TOOL_NAME}\` tool exactly ` +
      "once with your full candidate list (empty only if, after genuinely exhaustive analysis, none exist). " +
      "That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}

export function buildNegativeGapFinderPrompt(testRubric: string, fairnessRules: string): string {
  const parts = [
    ...gapFinderPreamble(
      "You are an exhaustive, research-minded NEGATIVE test-coverage analyst for a coding-agent benchmark task. " +
        "Your sole mandate is to surface EVERY genuine NEGATIVE behavioral test gap — forbidden behavior, invalid " +
        "states, or wrong outcomes that `test.patch` never asserts against but `agent_prompt.md` prohibits or " +
        "implies must not happen. Do NOT search for missing required-behavior gaps; a separate positive-case agent " +
        "handles those in parallel. Stay in your lane and search exhaustively before concluding there are none.",
    ),
    "",
    "Your job: find real NEGATIVE TEST GAPS. A negative gap is a prohibition, guard, or 'must not' constraint from " +
      "`agent_prompt.md` (or unambiguous repo convention) that `test.patch` does NOT verify — such that an agent " +
      "could violate `agent_prompt.md` by doing the forbidden thing, leaving the wrong state enabled, applying an " +
      "effect to the wrong target, skipping a guard, or accepting invalid input, and STILL pass every test because " +
      "the suite only checks that correct actions work, not that incorrect ones are rejected.",
    "",
    "Be systematic and exhaustive — work through ALL of the following passes:",
    "1. Re-read `agent_prompt.md` specifically for prohibitions, conditions, guards, and 'only when' / 'must not' / " +
      "'never' / 'disabled when' / 'should not' language. For each, ask: does `test.patch` assert the WRONG thing " +
      "does NOT happen?",
    "2. Go through `solution.patch` for every guard, early return, disabled branch, isolation check, and rejection " +
      "path. Ask whether a sloppy implementation that bypassed that guard would still pass.",
    "3. Hunt these negative patterns explicitly:",
    "   - Controls that must be disabled/unavailable in a given state, but no test drives that state and asserts disabled.",
    "   - Operations that must NOT affect a separate scope/target (isolation), but tests never prove the wrong scope is untouched.",
    "   - Side effects that must NOT occur (duplicate entries, spurious history steps, refresh on no-op).",
    "   - Invalid, out-of-order, or repeated input that should be ignored/rejected/coalesced differently.",
    "   - Undo/redo or rollback boundaries where the first action must NOT be undoable, or redo must NOT be available.",
    "   - Mutual exclusion: doing A must NOT silently change B, but no test proves independence.",
    "4. For every prompt prohibition, ask: 'Is there a test that would catch an agent doing the forbidden thing or " +
      "applying the requirement in the wrong context?' If not, it is a gap.",
    "5. Adversarial pass: imagine a lazy or slightly-wrong implementation that satisfies the obvious tests — list every " +
      "way it could still violate the prompt (wrong scope, wrong timing, wrong guard, spurious side effect, missing " +
      "rejection) and check whether `test.patch` would catch each one.",
    ...GAP_FINDER_AGGRESSION,
    "Do not filter yourself or self-censor for volume. A separate validator will strictly filter afterward — " +
      "your job is recall on NEGATIVE gaps only.",
    "",
    ...GAP_FINDER_GROUND_RULES,
    "- Negative gaps must be grounded in an explicit or clearly implied prohibition/constraint in `agent_prompt.md` " +
      "— not generic 'more negative tests would be nice'.",
    "- A single test that asserts both the positive outcome AND that the forbidden/wrong outcome did not occur counts " +
      "as covered.",
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
    "For each gap, prefix the description with `NEGATIVE:` and explain: (1) the specific untested forbidden/wrong " +
      "behavior or invalid state, and (2) concretely why a plausible-but-wrong implementation would still pass " +
      "every given test despite violating this constraint.",
    `When you are done — after completing ALL the passes above and a deliberate second sweep — call the \`${GAP_FINDER_TOOL_NAME}\` tool exactly ` +
      "once with your full candidate list (empty only if, after genuinely exhaustive analysis, none exist). " +
      "That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}

export function buildGapValidatorPrompt(
  statementReports: StatementGapReport[],
  testRubric: string,
  _fairnessRules: string,
): string {
  const parts = [
    "You are a strict, skeptical fairness auditor for a coding-agent benchmark task.",
    "You are working inside a throwaway, read-only copy of a git repository (this is your current directory). " +
      "You have access to read/grep/find/ls tools only — you cannot execute code or edit files.",
    "Two specialized research agents reviewed `agent_prompt.md` and the repository's source/code files sentence by " +
      "sentence, proposing both positive (missing required-behavior) and negative (missing forbidden/wrong-behavior) " +
      "gaps. It submitted the following per-sentence candidate report:",
    "",
    JSON.stringify(statementReports, null, 2),
    "",
    "Your job is to independently re-verify the files yourself and FILTER this list down to only candidates that " +
      "are ALL of the following:",
    "1. Genuinely grounded — actually required by a specific statement in `agent_prompt.md`, or unambiguous from " +
      "clearly visible, existing repo behavior. Drop anything speculative, nice-to-have, or invented beyond what " +
      "the prompt actually asks for.",
    "2. Fair to test — verifying it would not require undiscoverable private internals, an invented/unnamed API, " +
      "or exact incidental implementation structure. Judge this precisely against the fairness guidance below.",
    "3. A real, distinct behavioral gap — drop near-duplicate candidates and keep only the clearest phrasing of each " +
      "distinct gap. Retain a candidate only when the source code and prompt provide concrete grounding for a behavior " +
      "that deserves an explicit public-outcome check.",
    "4. Behaviorally testable through a public contract — drop candidates that would require an internal helper, " +
      "private state, implementation structure, call order, DOM class/attribute/data hook, selector, or exact " +
      "string literal. The sole exceptions are details explicitly named in `agent_prompt.md` or already established " +
      "as a public contract in the existing repository.",
    "",
    "Be strict: when genuinely unsure whether a candidate holds up, drop it rather than keep it. It is fine — " +
      "expected, even — to return an empty list if none of the candidates survive scrutiny.",
    "",
    "Checklist for the tests focus area, for calibration:",
    testRubric,
  ];

  parts.push(
    "",
    "Fairness: keep only behavior that a user, caller, or existing public contract can observe. Do not require private " +
      "helpers, internal state, implementation structure, call order, selectors, or incidental strings unless the task " +
      "explicitly makes them public requirements.",
    "",
    ...GAP_VALIDATOR_ADDITIONAL_RULES,
  );

  parts.push(
    "",
    "For every gap you keep, give a short justification citing where in `agent_prompt.md` or the repo it is " +
      "grounded. Preserve POSITIVE:/NEGATIVE: prefix when applicable.",
    `When you are done, call the \`${GAP_VALIDATOR_TOOL_NAME}\` tool exactly once with your final filtered list ` +
      "(which may be empty). That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}

// ── Solver gap finder: TDD solver + comparison reviewer ────────────

export function buildSolverPrompt(): string {
  return [
    "You are a adversarial tester. Your goal is to find the most minimal, shortcut implementation that makes all " +
      "new tests pass — not a full, correct solution. This is intentional: we want to discover whether the test " +
      "suite lets through an implementation that barely satisfies the assertions without properly implementing the " +
      "prompt's required behavior.",
    "`agent_prompt.md` in the repo root describes the intended task. Tests for it already exist and are currently " +
      "failing.",
    "",
    "Goal: make ALL of the new tests pass with the least amount of real logic possible.",
    "1. Run `bash test.sh new` to see the failures and what the tests expect. Read the failing tests carefully — " +
      "they are the only spec you need to satisfy.",
    "2. Understand exactly what each test assertion checks. Ask, 'what is the minimum thing I can do — a stub, a " +
      "hardcoded return, a mockish pass-through, a trivial branch — to satisfy this test?', not 'what does " +
      "agent_prompt.md intend?'. Skim `agent_prompt.md` only enough to understand what the test file names and " +
      "assertions refer to, then rely on the test errors to drive what to implement.",
    "3. Prefer the most minimal implementation possible:",
    "   - Hardcode a return value if the test expects one.",
    "   - Add only the code paths a test actually exercises; leave anything untested unimplemented.",
    "   - Mock the minimum number of dependencies (or none) that the test error forces you to touch.",
    "   - Use the most direct, trivial, shortcut approach — do not build abstractions, do not handle unobserved edge " +
      "cases, do not add defensive code.",
    "4. Before declaring success, also run `bash test.sh base` to confirm your changes cause no regressions. The " +
      "shortcut must not break existing tests — that would be a false positive from a different angle.",
    "5. Re-run `bash test.sh new` and iterate until both the new tests and the base tests pass, or you're confident you " +
      "cannot pass more without adding real logic.",
    "",
    "Rules:",
    "- Do NOT modify the test files or `test.sh`. Only change application/library code.",
    "- You have shell access — install any dependencies you need.",
    "- The prompt is not your spec: the tests are. Implement exactly what the tests demand, nothing more. If you " +
      "can satisfy a test with a hardcoded return, do it.",
  ].join("\n");
}

function formatSolverStatusLine(result: SolverRunResult): string {
  const statusLine =
    result.status === "ok"
      ? result.passed
        ? "PASSED all new tests"
        : "did NOT pass all new tests"
      : `did not complete normally (status: ${result.status})`;
  return (
    `- Solver ${result.index} — ${statusLine} — solution.diff / test_output.txt in ` +
    `\`${SOLVER_GAP_SOLUTIONS_DIRNAME}/solver_${result.index}/\``
  );
}

export function buildSolverComparisonPrompt(
  solverResults: SolverRunResult[],
  testRubric: string,
  fairnessRules: string,
): string {
  const parts = [
    "You are a strict, skeptical behavioral-gap auditor for a coding-agent benchmark task.",
    "You are working inside a throwaway, read-only copy of a git repository (this is your current directory). " +
      "You have access to read/grep/find/ls tools only — you cannot execute code, apply patches, or edit files.",
    "The repo root contains `agent_prompt.md` (the real task description), `solution.patch` (a unified diff of " +
      "the real golden/reference solution), and `test.patch` (a unified diff adding the hidden tests).",
    "",
    "Separately, several coding agents ('solvers') were each given the same `agent_prompt.md` plus the failing " +
      "tests from `test.patch` — but never `solution.patch` — and asked to implement the task TDD-style, iterating " +
      "with real shell access until the tests passed or they gave up. Each solver's diff and full `test.sh new` " +
      "output — captured and verified independently by the harness, not self-reported — is saved under " +
      `\`${SOLVER_GAP_SOLUTIONS_DIRNAME}/solver_<index>/\` (\`solution.diff\`, \`test_output.txt\`), with a ` +
      `\`${SOLVER_GAP_SOLUTIONS_DIRNAME}/manifest.json\` summary. Use read/grep/find/ls to open exactly what you ` +
      "need. Status summary:",
    "",
    ...solverResults.map(formatSolverStatusLine),
    "",
    "Your job: compare the reference `solution.patch` with each solver's `solution.diff` to find concrete " +
      "BEHAVIORAL GAPS. Keep only a difference where: (a) `agent_prompt.md` explicitly requires the behavior, " +
      "(b) the solver passed the relevant tests (even if it failed elsewhere), (c) the reference and solver produce observably different behavior for a real " +
      "edge case or scenario, and (d) a fair public-facing test could distinguish them. The reference solution is " +
      "evidence for scenarios to inspect, never a specification by itself.",
    "",
    "How to work:",
    "1. Read `agent_prompt.md` sentence by sentence and note every distinct requirement, constraint, and " +
      "prohibition.",
    "2. Read `solution.patch` to see how the reference solution satisfies those requirements.",
    "3. For each solver, read its `solution.diff` and compare it against the reference behavior. " +
      "Look specifically for a solver shortcut, missed constraint, edge case, or side effect that the PROMPT " +
      "requires, where the solver still passes because the tests do not observe the behavioral difference.",
    "4. A solver that did not pass the full suite may still provide evidence for a completed, relevant part of its " +
      "diff, but only when its test output shows the failure is unrelated to that behavior (or shows the relevant " +
      "tests already passed). Do not treat its failing behavior as a gap, and do not infer gaps from a hypothetical " +
      "wrong implementation.",
    "5. Treat multiple solvers converging on the same divergent-but-passing shortcut as stronger evidence of a " +
      "real gap, not proof it's acceptable — the tests are what's under scrutiny, not majority solver behavior.",
    "",
    ...GAP_FINDER_GROUND_RULES,
    "- Every gap must be evidenced by an actual, cited solver diff and a contrasting reference behavior. For a " +
      "solver that failed the full suite, also cite its test output showing that the relevant behavior already passed " +
      "or is unrelated to the failure. Cite the prompt sentence that makes the behavioral difference required; do " +
      "not report a gap that is purely theoretical or based only on the reference implementation.",
    "- It is fine, and expected, to submit an empty list if the solvers that passed all converged on behavior " +
      "equivalent to the reference solution with no material gaps.",
    "- Do not self-censor for volume, but do not pad the list either — only include what you can concretely " +
      "justify with cited evidence.",
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
    `When you are done, call the \`${SOLVER_GAP_TOOL_NAME}\` tool exactly once with your final list (which may ` +
      "be empty). That tool call is your only way to report a result.",
  );

  return parts.join("\n");
}
