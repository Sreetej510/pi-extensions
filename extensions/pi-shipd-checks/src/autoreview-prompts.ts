/**
 * Reviewer prompts for `/checks --autoreview`, ported from the shipd-workflow Auto Review replica
 * (shipd-v5/rulebook/rulebook_agents.py and shipd-v5/tq_local.py). Only the test and solution reviewers are kept, one
 * read each, with overlapping reviewers folded in: Local Test Quality per-test fairness (+ judge-tests' fixture rules)
 * and coverage (+ judge-tests' discrimination rules), the solution audit lenses (+ the lifecycle walk),
 * per-unit Solution Quality, and the synthesis step with its proof legs. The fairness ledger is dropped: per-test
 * Test Quality already sources every assertion. The test runner (test.sh) is out of scope: it is stripped from
 * test.patch and the snapshot, and no reviewer grades it.
 *
 * Every reviewer runs as a read-only Claude CLI session in a workspace laid out as:
 *   repo/            clean git HEAD (the pinned base; patches NOT applied)
 *   review_assets/   problem.md (agent_prompt.md), test.patch (without test.sh), solution.patch, proposed_tests/
 * Reviewers cannot write files, so each prompt asks for one final ```json block; counter-tests travel inline.
 * Hosted calibration is distilled into general patterns (autoreview-data.ts), never quotes from past tasks.
 */

import {
  SOLUTION_FINDING_FAMILIES,
  SYNTH_DEMOTION_PATTERNS,
  SYNTH_HIGH_PATTERNS,
  SYNTH_MEDIUM_PATTERNS,
  TEST_FINDING_FAMILIES,
  TQ_FAIR_PATTERNS,
  TQ_PROCEDURE,
  TQ_UNFAIR_FAMILIES,
  TQ_UNFAIR_PATTERNS,
} from "./autoreview-data.js";

const FENCE = "```";
export const REPO_DIR = "repo";
export const ASSETS_DIR = "review_assets";
const PROBLEM = `${ASSETS_DIR}/problem.md`;
const TEST_PATCH = `${ASSETS_DIR}/test.patch`;
const SOLUTION_PATCH = `${ASSETS_DIR}/solution.patch`;
/** Patches above this size are referenced by path instead of being inlined. */
const INLINE_LIMIT = 150_000;

export const TQ_CONCERNS = [
  "timing_sensitivity",
  "internal_coupling",
  "overfit_single_point",
  "brittle_message_matching",
  "unseeded_randomness",
  "hidden_setup",
  "environment_assumption",
  "ordering_dependence",
] as const;
/** Concerns hosted pairs with unfair verdicts far above their base rate; they gate as REVIEW (tq_local.GATING_CONCERNS). */
export const TQ_GATING_CONCERNS = new Set([
  "brittle_message_matching",
  "internal_coupling",
  "unseeded_randomness",
  "hidden_setup",
]);

const RUBRIC = `T1 tests fail at base and pass with the solution. T2 deterministic: no timing, randomness or ordering. T3 strong: not permissive enough to let inaccurate solutions pass. T4 extensive coverage of the requested behaviour and all obvious edge cases. T5 no unspecified or undiscoverable behaviour. T6 no network. T7 do not over-pin output (exact error text, messages, wording, formatting) unless the prompt says so or it is obvious from the repo's existing patterns.
S1 the solution meets all requirements. S2 no regressions, follows existing code patterns. S3 no irrelevant changes. S4 no AI-generated artefacts (weird comments, unexplained defensive code, new coding patterns).`;

const WORKSPACE = `Workspace (your current directory; you have read-only tools):
- ${REPO_DIR}/ is the pinned repository at its base commit. Neither patch is applied there: reconstruct patched code from the diffs.
- ${PROBLEM} is the task description given to solvers (problem.md).
- ${TEST_PATCH} holds the hidden tests; ${SOLUTION_PATCH} is the reference solution.
- ${ASSETS_DIR}/proposed_tests/ holds standalone copies of files test.patch adds.
- The test runner (test.sh) is out of scope for this review: do not look for it, grade it, or report findings about it.
Read the repository's working tree only: only files present in ${REPO_DIR}/ count as repository evidence; a file a patch adds does not.`;

const REPLY = "Reply with exactly one ";
const NO_FILES =
  "You cannot write files: put everything in that final json block (counter-test patches and commands inline as strings).";

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

function counterTestRule(idPrefix: string): string {
  return `For each defect write a counter-test: a unified diff (applies after solution.patch and test.patch) that adds ONE new test in the repo's test style which passes on a correct implementation and fails on this solution, as the string "counter_test_patch", and the shell command that runs only that test as "counter_test_cmd" (it runs in the repo root after applying solution.patch, test.patch and this one patch alone; prefer a NEW test file in the same package so it applies on its own, and use fixture names, ports or ids no existing test uses). Name counter-tests ${idPrefix}-<nn>-<slug>.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Local Test Quality (tq_local.py): per-test fairness batches and the coverage reads
// ---------------------------------------------------------------------------------------------------------------------

function tqIndex(hasRepo: boolean): string {
  return `# Local Test Quality (hosted replica)

You review hidden tests exactly as the hosted Test Quality check does. Each test must check something the description (problem.md) states, something a developer would discover in the pinned repository, or standard external semantics (SQL, IEEE 754, HTTP, a language's own library contract). A test that pins a choice the description leaves open is **Not fair**, even when the reference solution makes that choice. One Not fair test fails the whole check.

Fairness classes (pick exactly one per test):
- Prompt-stated: every asserted behaviour follows from a problem.md sentence. Quote the sentence.
- Repo-discoverable: an asserted detail is not in problem.md but an existing file at the pin fixes it (a convention, constant, sibling behaviour, existing error type). Cite the file and line you found. A file the test.patch or solution.patch adds does not count.
- Standard external semantics: the detail follows from an external standard the setup invokes. Name it.
- Not fair: at least one co-asserted detail is none of the above. One unfair assertion inside an otherwise good test makes the test Not fair.

Before you call a test Not fair, run the refutation battery and report it in evidence: search problem.md for the words of the pinned detail and its synonyms, grep the repository for the literal and the concept, and name a second, equally grounded implementation that the assertion would fail. A value the test derives from its own inputs (row counts it inserted, arithmetic on its own setup) is not author-chosen. Before you call a test fair, say which sentence, file or standard grounds each co-asserted detail, including exact strings, names, error kinds, defaults, orderings, counts and tolerances.

Refutation procedure distilled from hosted reviews:
${TQ_PROCEDURE}

Rules the hosted reviewer applies that local reviews missed (backtest 2026-10-12):
1. The API surface is a co-asserted detail only when the repo conflicts with it. A test that compiles against a signature, return shape, container nesting or getter type that problem.md does not give is Not fair when the repo has a same-form API a competent developer would copy and that copy fails to compile against the test (hosted: hiqlite rows as \`Vec<Row>\` where the repo returns \`Result<Row>\` per row; fory \`aliases()\` compared to an array where repo getters return \`&Vec\`). A function problem.md names without a full signature, in code the repo does not have yet, is fair on that ground alone (hosted passed every such kubehound test).
2. A scoped guarantee does not state its converse. "State carries over for hosts that keep their ID and address" says nothing about hosts that change them; a test that requires a reset (or any behaviour) for the excluded case pins an open choice.
3. A co-assertion stronger than the stated property is a pin even when it is likely: stated "differs on every call" does not give "is nonzero"; stated "escalates" does not give "doubles". Judge the strongest assertion, not the typical case.
And the other way, these are fair (do not flag them):
4. Behaviour the repo already has on paths the description keeps ("otherwise behaves as normal", "existing failover") is Repo-discoverable; cite the existing code.
5. Setup calls a test needs to drive a stated behaviour (a reload, a store swap, a flush) are not pins when the stated behaviour cannot be observed without them working.
6. Fixture or harness defects, test-name wording and capitalisation are quality notes, never a fairness verdict. Not fair needs an unstated behavioural choice that a correct implementation could make differently.
8. A general stated rule covers every case it names. "A row shorter than its writer schema is an error" covers fields the reader does not request too; do not narrow it with a different sentence ("other fields are ignored") unless problem.md itself makes that exception. Likewise "state carries over reloads" covers reloads that change only the new settings, and "behaves as normal" credits the repo's existing behaviour on that path.
9. "Only X is supported" / "X is not supported" states that the other inputs fail: a test that requires an error for them is Prompt-stated, and passing them through or falling back is not an equally grounded reading (hosted, dubbo-go merger r6-r9: "Only support unary calls" grounds an error for every streaming call). Likewise "behaves as normal" / "acts as normal" credits the repo's existing behaviour on that path, failover and filtering included (rule 4), and a stated rule about truncated or short input covers values nested inside it (rule 8).
7. When two stated sentences together give the value under the plain reading (a refusal caused by a policy is AccessDenied, and the limit applies under every policy), the test is Prompt-stated. Not fair needs a competent reader who would genuinely pick the other value from the text.
Base rate: hosted marks about 4.5% of tests Not fair (446 of 9,918 graded tests, 332 reports); about 55% of hosted reports FAIL, nearly always on one or two tests. For each Not fair verdict describe, in one or two sentences, a plausible design that satisfies every problem.md sentence and fails this assertion (no code needed: "keep the alias projection above the join, so the children keep their own column names" is enough). If you can describe one, the test is Not fair; do not keep it fair because you cannot write that design out in full. A Not fair verdict here is a warning, not a block: the author drops or loosens the test, so flag every assertion you can describe such a design for.

Concern tags (independent of fairness, list every one that applies): ${TQ_CONCERNS.join(", ")}. brittle_message_matching = asserts human-readable error text; internal_coupling = pins private helpers, call sequences, internal placement or wire details the user cannot observe; overfit_single_point = a single value where the stated rule covers a range; timing_sensitivity = wall-clock bounds or sleeps; hidden_setup = depends on fixtures or state the test does not show; environment_assumption = ports, paths, env vars, tools.

Families of unfair tests seen in hosted reviews:
${TQ_UNFAIR_FAMILIES}

Calibration: patterns hosted Test Quality marked Not fair:
${TQ_UNFAIR_PATTERNS}

Calibration: patterns hosted accepted as fair only after a repo or standard argument (do not flag these):
${TQ_FAIR_PATTERNS}

Inputs: the task description is ${PROBLEM}; the pinned repository is ${hasRepo ? `${REPO_DIR}/` : "(not supplied: you cannot credit Repo-discoverable, say so in evidence)"}; the full test.patch is ${TEST_PATCH}. Read problem.md in full before the first test. Do not read solution.patch: hosted Test Quality grades tests against the description and the repo, not against the solution.`;
}

export function buildTqUnitPrompt(files: Array<{ path: string; text: string }>, inputs: PromptInputs): string {
  const list = files.map((file) => `- ${file.path}`).join("\n");
  const bodies = files.map((file) => `--- ${file.path} (from test.patch)\n${file.text.slice(0, 60_000)}`).join("\n\n");
  return `You are the hosted-style Test Quality reviewer.

${WORKSPACE}

${tqIndex(true)}

problem.md:
<<<
${inputs.problem}
>>>

Review EVERY test (each test function, case or block the runner reports as its own testcase) defined or changed in these test files, and every helper or fixture they reach (their assertions are the test's assertions; judge them too):
${list}

${bodies}

${REPLY}${FENCE}json block as your final message. ${NO_FILES}
{"tests":[{"name":"<test name exactly as in the file>","file":"<path>","fairness":"Prompt-stated|Repo-discoverable|Standard external semantics|Not fair","verifies":"<what the test asserts, concrete values>","assertions":[{"what":"<one assert line or compile-time API use: a type, signature, method name or field the test relies on>","source":"prompt: <quote> | repo: <file:line> | standard: <name> | derived from the test's own setup | NONE"}],"evidence":"<the sentence / file:line / standard that grounds each co-asserted detail; for Not fair: the refutation battery, the pinned detail and the other grounded implementation it fails>","qualityCheck":"<one sentence>","concerns":[<zero or more of ${TQ_CONCERNS.join(", ")}>],"pinned":"<Not fair only: the unstated choice, in a few words>","family":"<Not fair only: the TQF-NN id that fits the pinned choice, or none>","fix":"<Not fair only: state it in problem.md | loosen the assertion to X | drop the test>"}]}
Also apply these hosted rules to every test: a specific number, factor, order or threshold where problem.md only states a direction or quality ("escalates", "longer", "faster", "at least", "grows") is Not fair unless the repo fixes that number; observing the result through one particular surface (one getter, one list, one log line, one internal map) when plausible implementations expose it elsewhere pins representation; simulate each test's own fixture (HTTP clients that follow redirects, default timeouts, shared global state between tests, helpers that silently drop zero, empty or default values): a fixture that rejects a correct implementation makes the test Not fair.
One entry per test, in file order. Judge every concern from the code that runs: a comment that explains a risk away ("no seed is needed", "timing is generous") never removes it; unseeded randomness, a finite random search or a wall-clock window stays a concern until the code makes it deterministic or bounded. List EVERY assertion and every API the test needs to compile in "assertions" (a test with eight asserts has eight rows); the test is Not fair when any row's source is NONE. Hosted unfair verdicts are usually one unsourced co-assertion among many sourced ones: an exact byte or text equality where problem.md promises only an equivalent result, a side effect asserted absent (a counter stays 0, no call made), a helper or method name the repo does not have.
`;
}

export function buildTqCoveragePrompt(inputs: PromptInputs): string {
  return `You are the hosted-style Test Quality reviewer, coverage part.

${WORKSPACE}

${tqIndex(true)}

problem.md:
<<<
${inputs.problem}
>>>

${inline("test.patch", TEST_PATCH, inputs.testPatch)}

FULL DEPTH: read the entire test.patch from its first line to its last and judge every requirement from the test bodies, never from test names. Also check every behaviour the solution settles on its own (redirects, cancellation, retries, other filters): a behaviour the solution implements (see ${SOLUTION_PATCH}) that no hidden test exercises is a gap. List every requirement problem.md states (one row per stated behaviour, default, bound, error case, class or path) and whether the hidden tests pin it. Then list coverage suggestions the way hosted does: gapKind untested (no test touches it), not_discriminating (tests touch it but a wrong implementation still passes, e.g. only one of several paths, a value masked by another setting, a bound checked loosely), single_point (one value where the rule covers a range or a class). For each suggestion name the wrong value or wrong implementation the current tests accept. Walk every stated requirement through the shapes hosted raises most often (722 hosted gaps), in this order: malformed, missing, empty or boundary inputs; wrong results that a weak assertion still accepts (a count where values matter, one item of a combined report or diagnostic, a type or value not preserved); persistence, serialization, cache or lifecycle paths; routing, cancellation or transaction transitions; the public API, type, schema or identity contract called directly rather than only through a higher layer; alternate contexts, routes, backends or compatibility cases the rule names but one test covers; supported type, operator or mode combinations left out; ordering, deduplication, collision or shared-budget boundaries; state isolation proven through the real implementation rather than a double. Gaps block the case (an unfair test only warns), so list every real gap, most discriminating first, each with the wrong value or wrong implementation the current tests accept; leave out a suggestion only when no wrong implementation passes. Also list, in requirements, every test that covers each requirement, so a test that is the sole cover of a requirement is visible. Mark a requirement COVERED only when the tests pin it the way hosted counts it: a sentence about a class (any failed or timed-out send, any other response, health checks, every selection path) is PARTIAL unless the tests hit more than one representative of that class, including members the sentence does not list (another failure phase such as before the request body is sent, a status code outside the listed and already-tested ones such as an unlisted 5xx, another checker or protocol variant); name the missing representatives in the suggestion. Many members along one axis are still one representative on the others: a class spans every axis a wrong implementation could split it on (status code, body framing or length, request method, failure phase, timing against an ejection or other state change, protocol or checker variant), and the row is COVERED only when each axis has more than one representative. A row you list a coverage suggestion for is not COVERED: mark it PARTIAL.

Discrimination rules the hosted reviewer applies (each one is a coverage suggestion when it fails):
1. Outcome categories: if an input can count as failure, count as success (resetting state), or be ignored, a test must tell success from ignored with a mixed sequence (fail, X, fail). Missing that is not_discriminating (T3).
2. Assertions that only run inside a success branch (if let Ok, if err == nil, try without fail) are vacuous for the error case: not_discriminating (T3).
3. Each promise that is explicitly EXCLUDED (a protocol, path or input the feature must not apply to) needs a test that an over-broad implementation fails; missing that is untested (T4).
4. G1: for every sentence of problem.md that states a value, default, threshold, duration, count, an open class ("any other", "all", "every", "each") or a behaviour for the feature in general, set "g1" when the tests accept a wrong implementation:
   a. masked: a default or number only observed together with another field, cap or bound that hides it (a blank field next to a field set to 1s, a cap equal to the base);
   b. loose_bound: a duration, count or ratio asserted with a bound that a materially different value (double, half, off by one, 60s for a 30s default, no upper bound) also satisfies; a tolerance for runner slack is fine;
   c. single_point: an open-ended class covered only by the listed members or one example; one unlisted member is required;
   d. untested_sibling: a behaviour stated for the feature in general exercised on one path while sibling paths (other protocols, proxies, entry points, update routes) can reach it and are untested; if the sibling cannot reach it, do not report it;
   e. unobserved_state: for every piece of state problem.md says persists or carries over and every transition it names (update, swap, reload, restart, re-registration), some test must observe THAT piece AFTER THAT transition through its effect (a carried escalation number only by triggering the next escalation and measuring it). Build the state x transition matrix and report each empty cell.
   Only behaviour problem.md states is a gap: quote the sentence. A missing test for a behaviour problem.md leaves open is not a gap. Severity HIGH when the wrong value or member is something problem.md states; MEDIUM when only a timing tolerance or a redundant path is involved. Every suggestion needs wrong_value_that_passes and test_change (the smallest edit that makes the tests reject it).

Coverage finding families hosted raises most often:
${TEST_FINDING_FAMILIES}

Rubric:
${RUBRIC}
${REPLY}${FENCE}json block as your final message. ${NO_FILES}
{"requirements":[{"requirement":"...","quote":"<verbatim problem.md>","status":"COVERED|PARTIAL|UNTESTED","tests":["..."]}],"coverageSuggestions":[{"area":"...","gapKind":"untested|not_discriminating|single_point","requirement":"...","sourceIfAdded":"Prompt-stated (a problem.md sentence states it; quote it in requirement) | Repo-discoverable (only the repo fixes it; cite file:line in suggestion)","suggestion":"...","g1":"masked|loose_bound|single_point|untested_sibling|unobserved_state|none","severity":"HIGH|MEDIUM","wrong_value_that_passes":"...","test_change":"..."}]}
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Solution audit (rulebook_agents.prompts: audit-all over the lenses)
// ---------------------------------------------------------------------------------------------------------------------

const LENSES: Record<string, [string, string]> = {
  paths: [
    "D-PATH, D-CONSUMER",
    "First list every registered plugin, filter, handler, listener, codec or backend of the same KIND as the ones the solution changes (look up the repo's registries and init/registration calls), and every configuration surface that can set the feature (config file, admin API, xDS/CDS/discovery, env, CLI, hot reload, proto/schema). Then enumerate EVERY entry point that can reach each promise at the pin (alternate APIs and overloads, sync/async, single/batch, builder/config/URL parameters, fallback, retry, reload/hot-reload, recovery/restore, legacy or second implementations of the same interface, other protocols/transports/backends, caches). For each, check the solution enforces the promise there. Silence is not exclusion: a surface or entry point that configures or reaches the same object is in scope unless problem.md explicitly excludes it, and the hosted reviewer flags every such gap (e.g. a discovery/xDS config path that cannot carry the new setting, a legacy handler that never reports). Open the repo files; do not trust the diff alone.",
  ],
  identity: [
    "D-IDENTITY, D-STATE, D-LIFECYCLE, D-REPR",
    "Same logical value in a different representation (domain vs IP, alias vs canonical, case, raw vs normalized, old vs new format) and a change between representations. What identifies each item (every key component: host vs IP, name vs id, type identity incl. package/scope), where state lives (per instance, per key, shared, global; two instances must not leak into each other), and what happens across create/update/delete/reload/restart/rename/re-registration/unit or config change after a value was set.",
  ],
  ordering: [
    "D-ORDER, D-FAILURE, D-CONCURRENCY",
    "Order of steps (validate before or after transform/round/quantise; check enabled before restricting; authorise before side effects), failure paths (partial failure, rollback, state left unchanged, error propagated not swallowed, later items still processed), and concurrent callers.",
  ],
  variants: [
    "D-VARIANT, D-CONFIG, D-PRECEDENCE",
    "Every variant, mode, format, kind and option the promise covers (valid ones accepted, invalid ones rejected), every config combination and default, and precedence when the higher-priority source is present, absent, invalid or incompatible (explicit vs default, per-call vs configured, field-qualified vs global).",
  ],
  numeric: [
    "D-TYPE, D-NUMERIC, D-BOUND, D-CARD",
    "Every type width and signedness, values not exactly representable, overflow, NaN/inf/-0, both sides of every stated boundary, empty/one/many, first vs later element, exact limits.",
  ],
  compose: [
    "D-COMPOSE, D-PROOF, D-OUTCOME",
    "Every call the solution makes into an API with a precondition (ASCII-only, sorted input, non-empty, unique keys, valid UTF-8, bounded size) and whether every input that reaches it meets it; parsers or rewriters of user syntax (quoting, grouping, escaping, nesting) on inputs with groups/quotes/escapes; internal or reserved fields (ids, metadata) leaking into user-visible computation. Combinations with existing features (filters, projections, pagination, transactions, boolean/grouped queries, other plugins), and places where the solution checks a proxy (a flag, a count, presence) instead of the promised property itself.",
  ],
  metadata: [
    "D-CONSUMER, D-COMPOSE",
    "For every new function, operator, option, handler or registration the solution adds, find how the repo's existing items of the same family are registered, documented and wired (flags, metadata keys, planner or optimizer hints, volatility, aliases, doc entries, type-coercion rules, test registration, feature gates, CHANGELOG or docs index) and list every option an analogous existing item sets that the new one omits. For each omitted option say what observable behaviour differs (a query that fails to plan, a path that is not reached, a value not converted).",
  ],
  lifecycle: [
    "D-LIFECYCLE, D-STATE, D-CONCURRENCY",
    "Sequences against every public entry point the solution adds or changes: call twice in a row; call then undo; call on a missing, empty, duplicate or already-in-that-state target; call while a leader change, reload, restart or another caller is in progress; drop or remove then re-create under the same name; read state after a restart. For every user callback or hook the solution invokes, list what state (borrowed pointers, partially written output, cursors, counters, locks) is live around the call and what a callback that retains, frees, mutates, throws or re-enters could do. Then, for every piece of state the solution keys by an identity (ID, name, address, key, path, version) or keeps across events (maps, counters, timers, caches, flags, end times, generations), walk: identity away and back (A -> B -> A, rename and rename back, re-registration under the same key); a result, callback, timer or reply started before a transition (update, swap, reload, expiry, stop/restart) that lands after it; removal then re-add under the same key; concurrent callers around each transition (a read-check-write split across a lock release). A defect is stale data applied to a fresh incarnation, or fresh data dropped or charged to a discarded one, when problem.md states or clearly implies the outcome.",
  ],
  behaviour: [
    "D-OUTCOME, D-CONFIG",
    "List every PRE-EXISTING public method, config key, message flow, default, error shape, count, ordering or persisted field whose observable behaviour the solution alters (including through a shared helper), then check each against problem.md: an alteration the description does not ask for, and that an existing caller or test would see, is a violation. Include persistence and wire formats (a new enum variant, field order, an older client or log entry that must still decode).",
  ],
};

export function buildAuditPrompt(inputs: PromptInputs): string {
  const lensText = Object.entries(LENSES)
    .map(([lens, [dims, ask]]) => `- lens ${lens} (${dims}): ${ask}`)
    .join("\n");
  return `You are the Solution Quality reviewer (S1: the solution meets ALL requirements; S2: no regressions). Audit the solution through EACH of the lenses below in turn, one lens at a time, and do not stop after the first lens that finds something:
${lensText}
Read problem.md, the reference solution, and the pinned repository at ${REPO_DIR}/ (open the files the solution touches and every caller of them). Solution finding families hosted raises most often:
${SOLUTION_FINDING_FAMILIES}

${WORKSPACE}

First derive the promises: every behaviour, default, bound, error case, class or path problem.md states, each with an id P01, P02, ... and its verbatim sentence. Then, for every promise, the entry points (paths) at the pin that can reach it.

Repo oracle rule. Before any claim about identity, equality, sameness, normalisation or "the same X" (address, host, key, name, path, version), find the repo's own definition of it (an Equal/Same/Key/Normalize function, the value the code routes or looks up by) and cite it as path:line in "oracle". Then: (1) a solution that uses a stricter or looser notion than that oracle IS a violation, claim it; (2) a claim whose expected behaviour needs a stricter or looser notion than the oracle is NOT a violation, drop it; (3) when the repo has no oracle and problem.md does not decide between two readings, set "reading":"conflict", give both readings in the claim, and write no counter-test: neither reading may be tested or enforced (such a conflict gates until problem.md settles it).
Unreachable cases. When a case cannot be reproduced in a test (a privileged or default port, a real external host, a platform-only condition), still claim it: set "reach":"reasoned", trace the code path line by line in "claim", and write a counter-test for the nearest reachable variant if one exists. A reasoned claim gates until the solution is fixed or the claim is refuted by citing the code that prevents it.

${counterTestRule("CT-<lens>")} One violation found through two lenses is reported once. When a violation rests on two promises, name the primary one in "promise" and the other in the claim. Report violations a test can show, and reasoned ones on real paths a test cannot reach, each tied to a problem.md sentence (quote it); no style opinions, no inputs no caller can produce.

problem.md:
<<<
${inputs.problem}
>>>

${inline("solution.patch", SOLUTION_PATCH, inputs.solutionPatch)}

${REPLY}${FENCE}json block as your final message. ${NO_FILES}
{"promises":[{"id":"P01","statement":"<verbatim problem.md sentence>"}],"violations":[{"id":"CT-paths-01","lens":"paths","promise":"P02","dimension":"D-...","quote":"<problem.md words>","claim":"<what is wrong, where (file:function)>","oracle":"<repo path:line defining the notion, or none>","reading":"decided|conflict","reach":"testable|reasoned","counter_test":"CT-paths-01-<slug>","test_name":"<added test name>","counter_test_patch":"<unified diff or empty>","counter_test_cmd":"<command or empty>"}]}
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Solution Quality per-unit reads (sq_unit_prompts)
// ---------------------------------------------------------------------------------------------------------------------

/** One changed hunk of solution.patch: the review unit of the per-unit Solution Quality read. */
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

const UNIT_QUESTION =
  "Is there an input a real caller can produce, inside what the description promises, for which this unit as patched returns a wrong result, leaves state inconsistent, or skips a path the description names? Check: branch coverage of every outcome the description lists for this unit, error and empty-input paths, ordering of validation and side effects, values converted or clamped, behaviour on a second call or after reload, and what the unit does for every variant the surrounding code distinguishes.";

export function buildSqUnitPrompt(units: SolutionUnit[], batch: number, inputs: PromptInputs): string {
  const prefix = `CT-sq${String(batch).padStart(2, "0")}`;
  return `You are a hosted-style Solution Quality reviewer. Review exactly these units (changed hunks of the reference solution):

${WORKSPACE}

${unitPackets(units)}

Question for every unit: ${UNIT_QUESTION}

FULL DEPTH, for every unit without exception: open its complete code in ${SOLUTION_PATCH} (the whole hunk, not the excerpt above), open the file it lives in at ${REPO_DIR}/ to see the code around it, and open every caller of it. Then check it against every sentence of problem.md that it can affect, on every path that reaches it (for example: before an answer, while uploading, while reading the body; after an update, a store swap, a reload, a registry change). An excerpt is never enough to call a unit sound.

Report only defects a concrete test could show, each with the verbatim problem.md sentence it breaks and a concrete input.

${counterTestRule(prefix)} Use the repo's own definitions (equality, identity, defaults) as the oracle: a test that demands a stricter or looser notion than the repo's is wrong, so report no defect there. A defect on a path no test can reach (for example a port a non-root user cannot bind) gets "reach":"reasoned" and no counter-test.

problem.md:
<<<
${inputs.problem}
>>>

${REPLY}${FENCE}json block as your final message. ${NO_FILES}
[{"unit":"<unit id>","read":["<path:line-line you opened>"],"defects":[{"id":"${prefix}-<nn>","claim":"<what is wrong, file:function>","promise":"<verbatim problem.md sentence>","input":"<concrete input>","dimension":"D-...","reach":"testable|reasoned","counter_test":"${prefix}-<nn>-<slug>","test_name":"<added test name>","counter_test_patch":"<unified diff or empty>","counter_test_cmd":"<command or empty>"}]}]
with one entry per unit above; "read" lists every file range you opened for that unit (at least the unit's own code and one caller), and an empty defects list when the unit is sound.
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthesis (rulebook_agents.SYNTH_RULES / synth_prompt --severity all)
// ---------------------------------------------------------------------------------------------------------------------

const SYNTH_RULES = `You are the hosted Auto Review SYNTHESIS step. Sub-reviewers proposed the findings below. A finding may stay HIGH (it gates the verdict) only when every proof leg holds; otherwise it is demoted to MEDIUM (a note) or dropped (wrong). Check each leg yourself against the files (problem.md, test.patch, solution.patch, and the repo checkout); do not trust the sub-reviewer's wording.

Proof legs (all must hold for HIGH):
1. failing_case: a concrete input or call sequence, reachable through the public surface a real caller uses (reachability), that shows the problem.
2. wrong_impl (T3/T4/T5 test findings): a named, believable wrong implementation that passes every current test (or, for T5/T7, a correct implementation that fails a test). Executed evidence (a surviving mutant) proves this leg.
3. promise_citation: a verbatim problem.md sentence (or an unmistakable repo contract) that the behaviour violates or the test demands. If problem.md explicitly allows the behaviour, says the case is out of scope, or instructs a usage that avoids it, the leg FAILS (hosted example: two references from one Client demoted because problem.md says "use one client per reference").
4. load_bearing_check: the exact line or assertion that makes the claim true (the test line that is missing or too loose, the solution line that is wrong). Quote it.
5. provenance: the defect is introduced or required by this change, not behaviour the pinned repo already had that problem.md does not ask to change.
6. materiality: the failing input is something a real caller produces. Pathological magnitudes (values beyond i32::MAX for a physics setting, 1e20 iterations, i64::MAX counts), fabricated inconsistent states the real system cannot produce (two different Kubernetes objects with the same kind, name, UID and resourceVersion), or float noise FAIL this leg.
7. reference_pass (test findings that demand a new or stricter check): a fair version of the demanded check must pass the reference solution. If the reference itself would fail it, the finding is a SOLUTION defect: answer verdict HIGH with "as":"S1" when legs 1,3,5,6 hold (hosted raises exactly these as S1, e.g. "loading a legacy state without parameter fields leaves imported bodies using serialized thresholds; the parameter-less branch never invokes restore_params"), MEDIUM otherwise.
8. exercised_environment (offline, non-root, toolchain/PATH, permissions, timeouts: claims about how the environment behaves at run time): an execution log in the evidence must show the failure and its cause. Such a claim inferred only from reading the files, with no log, is demoted.

Severity after the legs hold (hosted calibration):
- T3/T4 coverage gaps are HIGH when the wrong implementation breaks a main stated behaviour for ordinary inputs (a whole stated route, mode, type family, error class or state transition is unverified). A bounded edge of an otherwise covered behaviour (one extra boundary value, one more format of an already-tested family, an empty-string variant of a tested invalid input, bands after the first) is MEDIUM.
- A test that cannot tell apart two behaviours problem.md distinguishes (counts as success vs is ignored, replaces vs multiplies, rejects vs clamps) is HIGH T3: that is a discrimination failure, not a bounded edge.
- T5 (unspecified behaviour) is HIGH when a test pins a choice problem.md does not state and a reasonable solver would choose differently; it is MEDIUM when the repo's existing pattern makes the choice obvious. A test that reads values by parsing Debug/Display/log text, or pins exact internal names, field layout or child names problem.md does not give, is HIGH T5/T7 (representation coupling), even when a derived format would happen to pass.
- S1/S2 solution defects are HIGH when legs 1,3,5,6 hold; style or pattern nits are MEDIUM/LOW.
- Platform-leak findings (comments or text in the tests) are HIGH only for words about the grading process itself: graded, grader, evaluation harness, hidden tests, solver, benchmark, reward, the submission, reference solution. Comments that merely talk about "an implementation" or "any implementation of this feature" are ordinary code comments: MEDIUM at most.
- When a leg cannot be checked from the evidence given, the finding is unproven: demote to MEDIUM. Unproven is not HIGH.
`;

export interface SynthesisCandidate {
  id: string;
  text: string;
}

export function buildSynthesisPrompt(candidates: SynthesisCandidate[]): string {
  const items = candidates.map((candidate) => `- ${candidate.id}: ${candidate.text}`).join("\n");
  return `Each finding below carries the sub-reviewer's own severity. Sub-reviewers under-rate as often as they over-rate: decide every severity yourself from the proof legs and the severity rules (a MEDIUM may become HIGH, a HIGH may become MEDIUM). Report duplicates of one defect under every id they appear with the same verdict.
${SYNTH_RULES}
Patterns hosted kept HIGH/BLOCKER:
${SYNTH_HIGH_PATTERNS}

Patterns hosted rated MEDIUM:
${SYNTH_MEDIUM_PATTERNS}

Why hosted demoted HIGH findings (the leg that failed):
${SYNTH_DEMOTION_PATTERNS}

${WORKSPACE}
Read the repo checkout to check provenance and reachability.
Execution evidence: none. No counter-test, mutant or offline/non-root run was executed for this review, so legs that need execution must be decided from the files alone or demoted.

Findings to synthesise:
${items}

${REPLY}${FENCE}json block as your final message, with one entry for every id listed above. ${NO_FILES}
{"findings":[{"id":"<id as listed>","verdict":"HIGH|MEDIUM|DROP","as":"<criterion it gates under, e.g. T3, T4, T5, T7, S1, S2>","failed_leg":"<leg name or none>","promise_citation":"<verbatim problem.md text or none>","load_bearing_check":"<quoted line>","why":"<one line>"}]}
`;
}
