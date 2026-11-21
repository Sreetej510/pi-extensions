/**
 * Reviewer prompts for the `auditor` tool, ported from the shipd-workflow Auto Review replica
 * (shipd-v5/rulebook/rulebook_agents.py and shipd-v5/tq_local.py) and tuned to what the newer hosted Test Quality and
 * Solution Quality checks flag. There are two agent types, each with its own prompt, and one combined synthesis:
 *   - test agents own test.patch: unfair tests, missing coverage, and test code quality. Each gets a slice of the test
 *     files to judge for fairness and quality, and a slice of the prompt's requirement sentences to check coverage for
 *     across the whole suite.
 *   - solution agents own solution.patch: concrete wrong outputs, and solution code quality. Each gets a slice of the
 *     changed hunks and reads the rest of the change for context.
 *   - synthesis sees every finding from both types, problem.md and both patches, applies the hosted proof legs, and
 *     drops duplicates and wrong findings.
 * The rules.md families (fairness, test gaps, solution gaps) go to the type they belong to. test.sh is out of scope.
 *
 * Every reviewer runs as a read-only Codex CLI session in a workspace laid out as:
 *   repo/            clean git HEAD (the pinned base; patches NOT applied)
 *   review_assets/   problem.md (agent_prompt.md), test.patch (without test.sh), solution.patch, proposed_tests/
 * Reviewers cannot write files, so each prompt asks for one final ```json block; counter-tests travel inline.
 * Hosted calibration is distilled into general patterns (auditor-data.ts), never quotes from past tasks.
 */

import {
  HOSTED_TEST_GAP_PATTERNS,
  HOSTED_UNFAIR_TEST_PATTERNS,
  HOSTED_WRONG_OUTPUT_PATTERNS,
  SOLUTION_FINDING_FAMILIES,
  SOLUTION_QUALITY_CATEGORIES,
  SYNTH_DEMOTION_PATTERNS,
  SYNTH_HIGH_PATTERNS,
  SYNTH_MEDIUM_PATTERNS,
  TEST_FINDING_FAMILIES,
  TEST_QUALITY_CATEGORIES,
  TQ_FAIR_PATTERNS,
  TQ_PROCEDURE,
  TQ_UNFAIR_FAMILIES,
  TQ_UNFAIR_PATTERNS,
} from "./auditor-data.js";
import { loadFairnessRules, loadGapRules, loadSolutionRules } from "./rubric.js";

const FENCE = "```";
export const REPO_DIR = "repo";
export const ASSETS_DIR = "review_assets";
const PROBLEM = `${ASSETS_DIR}/problem.md`;
const TEST_PATCH = `${ASSETS_DIR}/test.patch`;
const SOLUTION_PATCH = `${ASSETS_DIR}/solution.patch`;
/** Patches above this size are referenced by path instead of being inlined. */
const INLINE_LIMIT = 150_000;

export const QUALITY_CATEGORIES = ["Clutter", "Conventions", "Design", "Practice", "Scope", "Stale callers"] as const;

const WORKSPACE = `Workspace (your current directory). Read it with read-only shell commands (for example rg, sed -n, head, ls, find); the sandbox blocks writes, and you must not run tests, builds or installs:
- ${REPO_DIR}/ is the pinned repository at its base commit. Neither patch is applied there: reconstruct patched code from the diffs.
- ${PROBLEM} is the task description given to solvers (problem.md).
- ${TEST_PATCH} holds the hidden tests; ${SOLUTION_PATCH} is the reference solution.
- ${ASSETS_DIR}/proposed_tests/ holds standalone copies of files test.patch adds.
- The test runner (test.sh) is out of scope for this review: do not look for it, grade it, or report findings about it.
Read the repository's working tree only: only files present in ${REPO_DIR}/ count as repository evidence; a file a patch adds does not.`;

const REPLY = "Reply with exactly one ";
const NO_FILES =
  "You cannot write files: put everything in that final json block (counter-test patches and commands inline as strings).";

const VALIDATE = `Be as hard to pass as the hosted check. The hosted reviewers find blocking issues round after round on submissions their authors believed were clean, so a clean result from you must be earned, not assumed:
- Assume there are findings until an exhaustive search shows otherwise. Work through every item in your slice and every lens or method above; a slice you skimmed is not a clean slice.
- After your first pass, do a second full sweep from a different angle (for tests: from the prompt sentences back to the tests; for the solution: from the call sequences and failure points back to the code) and add what it finds.
- Report borderline candidates too, marked as such in "why": the combined synthesis step decides severity and drops what is wrong, so an unreported real issue costs more than a reported weak one.
Validate before you report: re-read every candidate against problem.md, the patches and the repo, and drop only what is contradicted by the code, already covered by a test, or a duplicate. Do not pad with invented issues.`;

export interface PromptInputs {
  problem: string;
  testPatch: string;
  solutionPatch: string;
}

function inline(label: string, path: string, text: string): string {
  if (text.length > INLINE_LIMIT) {
    return `${label}: ${text.length} characters, too large to inline. Read ${path} in full, in chunks, from its first line to its last.`;
  }
  return `${label} (${path}):\n<<<\n${text}\n>>>`;
}

function teamLine(kind: "test" | "solution", index: number, total: number): string {
  if (total === 1) return `You are the only ${kind} agent: everything below is yours.`;
  return `You are ${kind} agent ${index + 1} of ${total}. The other ${kind} agents own the other slices; own yours completely and do not report on theirs. A combined synthesis step sees every agent's findings.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Test agents: test.patch only (fairness, coverage, test code quality)
// ---------------------------------------------------------------------------------------------------------------------

const FAIRNESS_METHOD = `Fairness (the hosted Test Quality method). Each test must check something problem.md states, something a developer would discover in the pinned repository, or standard external semantics (SQL, IEEE 754, HTTP, a language's own library contract). A test that pins a choice the description leaves open is unfair, even when the reference solution makes that choice. One unfair co-assertion makes the whole test unfair.

For every test in your slice, first source every assertion and every API it needs to compile: a problem.md quote, a repo file:line present at the pin, a named standard, or a value derived from the test's own setup. An assertion with no source is a pin. Before calling a test unfair, run the refutation battery: search problem.md for the pinned detail and its synonyms, grep the repo for the literal and the concept, and describe a second, equally grounded implementation that satisfies every problem.md sentence and fails the assertion. If you can describe one, the test is unfair.

Refutation procedure distilled from hosted reviews:
${TQ_PROCEDURE}

Hosted rules:
1. The API surface is a co-asserted detail only when the repo conflicts with it: a signature, return shape or getter type problem.md does not give is unfair when the repo has a same-form API a competent developer would copy and that copy fails against the test. A function problem.md names without a full signature, in code the repo does not have yet, is fair on that ground alone.
2. A scoped guarantee does not state its converse; a test requiring behaviour for the excluded case pins an open choice.
3. A co-assertion stronger than the stated property is a pin even when likely ("escalates" does not give "doubles").
4. A specific number, factor, order or threshold where problem.md only states a direction or quality is unfair unless the repo fixes it.
5. Observing the result through one particular surface (one getter, one log line, one internal map, one notification channel) when plausible implementations expose it elsewhere pins representation.
6. Simulate each test's fixture and every shared helper it reaches: their assertions and navigation are the test's assertions. A helper that rejects a correct implementation makes every test that uses it unfair.
And these are fair (do not flag them): behaviour the repo already has on paths the description keeps; setup calls needed to drive a stated behaviour; a general stated rule applied to every case it names; "only X is supported" grounding an error for the others; a value two stated sentences give together under the plain reading.

Patterns the newer hosted check blocks on:
${HOSTED_UNFAIR_TEST_PATTERNS}

Families of unfair tests seen in hosted reviews:
${TQ_UNFAIR_FAMILIES}

Calibration, unfair:
${TQ_UNFAIR_PATTERNS}

Calibration, fair only after a repo or standard argument (do not flag these):
${TQ_FAIR_PATTERNS}

Fairness rules from rules.md (authoritative where stricter):
${loadFairnessRules()}`;

const COVERAGE_METHOD = `Coverage. For every requirement sentence in your slice, decide from the test bodies (never from test names) whether the hidden tests would FAIL a wrong implementation. A gap is a prompt-stated behaviour that a believable wrong implementation gets wrong while every test still passes; name that wrong implementation and quote the sentence. Behaviour problem.md leaves open is not a gap.

Walk each requirement through: malformed, missing, empty or boundary inputs; weak assertions (a count where values matter, one item of a combined report); persistence, cache and lifecycle paths, including restarts and process kills; the repo's existing operations (rename, move, reload, delete) applied to new state; routing, cancellation and transaction transitions; the public contract called directly; alternate routes, backends or mirror directions the rule names but one test covers; ordering, deduplication and collision boundaries; state isolation through the real implementation. A sentence about a class is covered only when the tests hit more than one representative of it on every axis a wrong implementation could split it on. Assertions that run only inside a success branch or behind "if it still exists" are vacuous. An explicitly excluded case needs a test an over-broad implementation fails.

G1 discrimination: for every stated value, default, threshold, duration, count or open class, report the wrong value the tests accept: masked (only observed behind another field or cap), loose bound (double, half, off by one also pass), single point (one example of an open class), untested sibling (another path that reaches the behaviour), unobserved state (state that carries over a transition, never observed after it).

Patterns the newer hosted check blocks on:
${HOSTED_TEST_GAP_PATTERNS}

Coverage finding families hosted raises most often:
${TEST_FINDING_FAMILIES}

Test-gap rules from rules.md (authoritative):
${loadGapRules()}`;

const TEST_QUALITY_METHOD = `Test code quality (non-blocking). For the test files in your slice and the helpers and fixtures they use, report concrete code-quality problems by category, each with file:line (symbol), what is wrong, and the change:
${TEST_QUALITY_CATEGORIES}
Compare with the repo's existing tests for the same area before claiming a convention (name the file). Do not report cosmetic nits.`;

export function buildTestAgentPrompt(opts: {
  inputs: PromptInputs;
  files: Array<{ path: string; text: string }>;
  requirements: string[];
  index: number;
  total: number;
}): string {
  const fileList = opts.files.map((file) => `- ${file.path}`).join("\n") || "- (none)";
  const requirementList = opts.requirements.map((sentence) => `- ${sentence}`).join("\n") || "- (none)";
  const bodies = opts.files
    .map((file) => `--- ${file.path} (from test.patch)\n${file.text.slice(0, 60_000)}`)
    .join("\n\n");
  return `You are a hosted-style Test Quality reviewer: a TEST agent. You review test.patch only (do not judge the reference solution's quality). ${teamLine("test", opts.index, opts.total)}

${WORKSPACE}

Your slice:
1. Fairness and test code quality for EVERY test (each testcase the runner reports) defined or changed in these files, plus every helper and fixture they reach:
${fileList}
2. Coverage, across the WHOLE test.patch, for these requirement sentences of problem.md:
${requirementList}

${FAIRNESS_METHOD}

${COVERAGE_METHOD}

${TEST_QUALITY_METHOD}

${VALIDATE}

problem.md:
<<<
${opts.inputs.problem}
>>>

${
  opts.inputs.testPatch.length > INLINE_LIMIT
    ? `Your test files:\n${bodies || "(none)"}\n\n${inline("The full test.patch", TEST_PATCH, opts.inputs.testPatch)} You need all of it for coverage.`
    : `${inline("The full test.patch (your files are in it)", TEST_PATCH, opts.inputs.testPatch)}`
}

Read ${SOLUTION_PATCH} only to check that a demanded test would pass the reference (a gap the reference itself fails is a solution defect: say so in "details").

${REPLY}${FENCE}json block as your final message. ${NO_FILES}
{"tests":[{"name":"<every test in your files>","file":"<path>","fair":true|false}],
 "unfairTests":[{"test":"<test name, or the helper and every test it reaches>","file":"<path:line>","finding":"<what the test demands that the prompt does not>","details":"<the correct, prompt-compliant implementation that fails, and the exact assertion or helper line it fails>","why":"<problem.md quote and, if any, the other test in the suite that accepts the same behaviour>","suggestedChange":"<loosen the assertion to X | state it in problem.md | drop the test>"}],
 "testGaps":[{"requirement":"<verbatim problem.md sentence>","finding":"<which behaviour no test checks>","details":"<the wrong implementation that passes every test, concretely>","why":"<why that behaviour is required: quote>","suggestedChange":"<the test to add: setup, action, assertion; it must pass the reference>","severity":"HIGH|MEDIUM"}],
 "testImprovements":[{"category":"Clutter|Conventions|Design|Practice","location":"<file:line (symbol)>","finding":"...","suggestedChange":"..."}]}
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Solution agents: solution.patch only (wrong outputs, solution code quality)
// ---------------------------------------------------------------------------------------------------------------------

const LENSES: Record<string, [string, string]> = {
  paths: [
    "D-PATH, D-CONSUMER",
    "Every registered plugin, handler or backend of the same kind as the ones the solution changes, every configuration surface that can set the feature, and every entry point that can reach each stated behaviour (alternate APIs, sync/async, single/batch, fallback, retry, reload, recovery/restore, legacy implementations, other protocols, caches). Silence is not exclusion: a surface that reaches the same object is in scope unless problem.md excludes it.",
  ],
  identity: [
    "D-IDENTITY, D-STATE, D-REPR",
    "Same logical value in a different representation (alias vs canonical, case, raw vs normalized), what identifies each item (every key component), where state lives (per instance, per key, shared, global), and what happens across create/update/delete/reload/restart/rename after a value was set.",
  ],
  ordering: [
    "D-ORDER, D-FAILURE, D-CONCURRENCY",
    "Order of steps (validate before or after transform; authorise before side effects), failure paths (partial failure, rollback, state left unchanged, errors propagated not swallowed, later items still processed, one missing piece must not abort the rest), and concurrent callers.",
  ],
  variants: [
    "D-VARIANT, D-CONFIG, D-PRECEDENCE",
    "Every variant, mode, format and option the behaviour covers, every config combination and default, and precedence when the higher-priority source is present, absent, invalid or incompatible.",
  ],
  numeric: [
    "D-TYPE, D-NUMERIC, D-BOUND, D-CARD",
    "Type widths and signedness, values not exactly representable, overflow, both sides of every stated boundary, empty/one/many, first vs later element, exact limits.",
  ],
  compose: [
    "D-COMPOSE, D-OUTCOME",
    "Calls into APIs with preconditions and whether every input that reaches them meets them; parsers of user syntax on inputs with quotes, groups, escapes or markup; internal fields leaking into user-visible output; combinations with existing features; checks on a proxy (a flag, a count) instead of the promised property.",
  ],
  crash: [
    "D-LIFECYCLE, D-PERSISTENCE",
    "For every multi-step persistent operation (write, publish, journal, quarantine, undo, recovery), kill the process between each pair of steps, restart, and run the operation again: does every scratch file or folder the operation created get cleaned or recorded, does a created folder get removed, does a record survive while leftovers remain, and does the retry report a failure rather than success when it cannot finish? Also: call twice in a row, call then undo, act on a missing or already-handled target, remove and re-create under the same name, rename then use.",
  ],
  platform: [
    "D-PLATFORM",
    "Primitives that exist only on some platforms or filesystems (renameat2, link(), O_NOFOLLOW semantics, Darwin calls) checked against the project's declared platform support (packaging classifiers, CI matrix); the fallback each caller takes and the errors it catches.",
  ],
  behaviour: [
    "D-OUTCOME, D-REGRESSION",
    "Every PRE-EXISTING public method, config key, default, error shape, return value or persisted field whose behaviour the solution alters (including through a shared helper), checked against problem.md and against existing callers and tests: an alteration the description does not ask for that an existing caller or test would see is a wrong output.",
  ],
};

const WRONG_OUTPUT_METHOD = `Wrong outputs (blocking). Find inputs or call sequences a real caller can produce, inside what problem.md promises, for which the solution as patched gives a wrong result, leaves state inconsistent, leaks its own scratch state, or reports success when the stated outcome did not happen. Walk your units through each lens, one at a time:
${Object.entries(LENSES)
  .map(([lens, [dims, ask]]) => `- ${lens} (${dims}): ${ask}`)
  .join("\n")}

Patterns the newer hosted check blocks on:
${HOSTED_WRONG_OUTPUT_PATTERNS}

Solution finding families hosted raises most often:
${SOLUTION_FINDING_FAMILIES}

Repo oracle rule: before any claim about identity, equality or "the same X", find the repo's own definition and cite it; a solution stricter or looser than that oracle is wrong, a claim that needs a different notion than the oracle is not. Every finding gives a concrete input, the expected output (from a problem.md quote or an existing repo contract), and what the solution actually does (trace it line by line; say which file:line causes it). A case no test here can reach (a kill at an exact step, another platform) still counts: trace it. Write a counter-test when one can show it: a unified diff that adds ONE new test which passes on a correct implementation and fails on this solution ("counter_test_patch"), and the command that runs only that test ("counter_test_cmd").

Solution-gap rules from rules.md (authoritative):
${loadSolutionRules()}`;

const SOLUTION_QUALITY_METHOD = `Solution code quality (non-blocking). For the code in your units, report concrete problems by category, each with file:line (symbol), what is wrong, the evidence (an analogue file:line, a grep result, or counts that show the growth), and the change:
${SOLUTION_QUALITY_CATEGORIES}
Compare each changed area with the one or two closest real analogues in the repo before claiming a convention. Do not prescribe one design when alternatives remain valid, and do not report cosmetic nits.`;

/** One changed hunk of solution.patch: the unit solution agents divide between them. */
export interface SolutionUnit {
  id: string;
  name: string;
  file: string;
  header: string;
  text: string;
}

function unitPackets(units: SolutionUnit[]): string {
  return units
    .map(
      (unit) =>
        `# ${unit.id}: ${unit.name}\nfile: ${unit.file} (${unit.header})\n${FENCE}diff\n${unit.text.slice(0, 16_000)}\n${FENCE}`,
    )
    .join("\n\n");
}

export function buildSolutionAgentPrompt(opts: {
  inputs: PromptInputs;
  units: SolutionUnit[];
  index: number;
  total: number;
}): string {
  const prefix = `CT-sol${String(opts.index).padStart(2, "0")}`;
  return `You are a hosted-style Solution Quality reviewer: a SOLUTION agent. You review solution.patch only (do not judge the hidden tests). ${teamLine("solution", opts.index, opts.total)}

${WORKSPACE}

Your slice: these units (changed hunks of the reference solution). For every unit, open its complete code in ${SOLUTION_PATCH}, the file it lives in at ${REPO_DIR}/, and every caller; read the rest of solution.patch for context. A finding belongs to you when the faulty line is in your units.

${unitPackets(opts.units)}

${WRONG_OUTPUT_METHOD}

${SOLUTION_QUALITY_METHOD}

${VALIDATE}

problem.md:
<<<
${opts.inputs.problem}
>>>

${REPLY}${FENCE}json block as your final message. ${NO_FILES}
{"solutionGaps":[{"id":"${prefix}-<nn>","input":"<the concrete input or call sequence, including any kill/restart point>","expectedOutput":"<what problem.md or the existing contract requires>","received":"<what the solution does instead, traced>","why":"<problem.md quote and why the sequence is real>","suggestedChange":"<file:line (symbol): the fix>","counter_test_patch":"<unified diff or empty>","counter_test_cmd":"<command or empty>"}],
 "solutionImprovements":[{"category":"Practice|Clutter|Design|Conventions|Scope|Stale callers","location":"<file:line (symbol)>","finding":"<what is wrong, with evidence>","suggestedChange":"..."}]}
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Combined synthesis (rulebook_agents.SYNTH_RULES): every finding from both agent types, against all changes
// ---------------------------------------------------------------------------------------------------------------------

const SYNTH_RULES = `You are the hosted Auto Review SYNTHESIS step. Test agents and solution agents proposed the findings below. Read problem.md, test.patch, solution.patch and the repo checkout yourself: you see all of the change, so judge each finding against the whole of it, merge duplicates, and catch findings one agent got wrong because it only owned a slice. A finding may stay HIGH (it gates the verdict) only when every proof leg holds; otherwise demote it to MEDIUM or DROP it if it is wrong.

Proof legs (all must hold for HIGH):
1. failing_case: a concrete input or call sequence, reachable through the public surface a real caller uses, that shows the problem. A process killed or closed mid-operation is a real call sequence when problem.md promises cleanup of partial work or behaviour after restart.
2. wrong_impl (test findings): a named, believable wrong implementation that passes every current test, or for unfair tests a correct implementation that fails one.
3. promise_citation: a verbatim problem.md sentence (or an unmistakable repo contract, such as declared platform support or an existing test of an existing method) that the behaviour violates or the test demands. If problem.md allows the behaviour or puts the case out of scope, the leg fails.
4. load_bearing_check: the exact line or assertion that makes the claim true. Quote it.
5. provenance: the defect is introduced or required by this change, not behaviour the pinned repo already had that problem.md does not ask to change.
6. materiality: the input is something a real caller produces; pathological magnitudes, impossible states and float noise fail this leg.
7. reference_pass (test findings that demand a new or stricter check): the demanded check must pass the reference solution; if the reference would fail it, the finding is a solution defect: answer HIGH with "as":"S1" when legs 1,3,5,6 hold.
8. exercised_environment: claims about how the runtime environment behaves (offline, non-root, permissions) need a log; inferred only from reading, demote.

Severity:
- Unfair tests (T5/T7) are HIGH when a reasonable, prompt-compliant implementation fails; MEDIUM when the repo's existing pattern makes the choice obvious. A shared helper that fails correct UIs is HIGH once, for every test it reaches.
- Coverage gaps (T3/T4) are HIGH when the wrong implementation breaks a main stated behaviour; a bounded edge of an otherwise covered behaviour is MEDIUM.
- Solution wrong outputs (S1/S2) are HIGH when legs 1,3,5,6 hold.
- Code-quality findings (test or solution: Clutter, Conventions, Design, Practice, Scope, Stale callers) never gate: keep them MEDIUM with "as" set to the category when their evidence holds, and DROP them when the cited analogue, grep or counts do not hold. A code-quality finding that actually changes an output is a wrong output: say so in "why".
- Test comments that name the grading process (grader, hidden tests, reward, the submission, reference solution) are MEDIUM Clutter unless they leak the solution.
- When a leg cannot be checked from the files, the finding is unproven: MEDIUM, not HIGH.`;

export interface SynthesisCandidate {
  id: string;
  text: string;
}

export function buildSynthesisPrompt(candidates: SynthesisCandidate[]): string {
  const items = candidates.map((candidate) => `- ${candidate.id}: ${candidate.text}`).join("\n");
  return `Each finding below carries the proposing agent's own severity. Agents under-rate as often as they over-rate: decide every severity yourself (a MEDIUM may become HIGH, a HIGH may become MEDIUM). When several ids are one defect, keep the clearest one and answer DROP for the others with "why":"duplicate of <id>". Be as hard to pass as the hosted check: DROP a finding only when the files show it is wrong (the behaviour is tested, the code handles the case, the prompt allows it); a finding you merely cannot fully prove stays MEDIUM, and one whose legs all hold is HIGH even if the agent marked it borderline.
${SYNTH_RULES}

Patterns hosted kept HIGH/BLOCKER:
${SYNTH_HIGH_PATTERNS}

Patterns hosted rated MEDIUM:
${SYNTH_MEDIUM_PATTERNS}

Why hosted demoted HIGH findings (the leg that failed):
${SYNTH_DEMOTION_PATTERNS}

${WORKSPACE}
Execution evidence: none. No counter-test, mutant or kill/restart run was executed for this review, so legs that need execution must be decided from the files alone.

Findings to synthesise:
${items}

${REPLY}${FENCE}json block as your final message, with one entry for every id listed above. ${NO_FILES}
{"findings":[{"id":"<id as listed>","verdict":"HIGH|MEDIUM|DROP","as":"<T3|T4|T5|T7|S1|S2 for blocking findings, or Clutter|Conventions|Design|Practice|Scope|Stale callers for code quality>","failed_leg":"<leg name or none>","promise_citation":"<verbatim problem.md text or none>","load_bearing_check":"<quoted line>","why":"<one line>"}]}
`;
}
