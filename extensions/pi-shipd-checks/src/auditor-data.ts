/**
 * Hosted Auto Review calibration for the `auditor` tool reviewers, distilled from the shipd-workflow corpus
 * (shipd-v5/rulebook/rulebook.json families, autoreview-corpus/tq, autoreview-corpus/synth-examples.json).
 * Each entry states the general pattern hosted reviewers raise, not a quote from a past task, so no task under review
 * (or an earlier round of it) leaks into the prompts.
 */

/** Test findings hosted raises most often (rulebook U1, U2, U3, U6), with the question that finds each. */
export const TEST_FINDING_FAMILIES = `- T5-SHAPE, undiscoverable API or representation shape (most frequent): a test compiles against or compares a method name, enum variant, error type, field layout, result nesting, pointer identity or row schema that problem.md does not give and the repo does not already expose. Ask: would a competent solution with a different name or shape fail to compile or fail the assertion?
- T5-POLICY, open policy pinned: problem.md is silent or qualitative and the test picks one reasonable policy: reject vs accept or clamp, validation at set time vs use time, deduplicate vs append vs replace, escalation formula, threshold, default, NULL or zero-length semantics, whether extra safe work (more pruning, more caching) is allowed. Ask: name another implementation that satisfies every sentence and fails the test.
- T5-OUT-OF-SCOPE: the test exercises an input, type or mode the prompt explicitly excludes, calls unspecified, or lists exhaustively without it, or expects a value contrary to the repo semantics the prompt invokes.
- T7-TEXT-PINNED: exact error or log text, message substrings, field names inside messages, EXPLAIN or plan text, byte-for-byte serialization or canonical layout where problem.md promises only an error or an equivalent result.
- T5-MECHANISM: the test asserts a private mechanism (which timer is cancelled, which hook is reached, exact call counts, internal placement of validation, exact plan shape, exact counts on hidden data) instead of the observable outcome the prompt states.
- T2-TIMING-NONDET: wall-clock deadlines, sleeps racing timers, random load balancing expected to hit a case, holding private locks, anything that flakes across repeated runs.
- T5-FIXTURE: the fixture rejects a correct implementation: the test does not compile, a client follows redirects, data cannot discriminate, the baseline already fails on the clean repo, a needed tool is absent.
- T4-STATED-UNTESTED: a requirement problem.md states (including an explicit exclusion that an over-broad implementation would violate, or stated public types) has no test.
- T4-BOUNDARY: an obvious boundary of a stated rule is never exercised: infinities or NaN where valid, exactly-one-succeeds, an explicitly configured limit, zero, negative or fractional values on a non-negative integer field.
- T3-DISCRIM: an assertion or fixture cannot tell the correct behaviour from a wrong one: a set hides duplicates, one provider per group hides merging, a value compared to itself, success and "ignored" not distinguished, a proxy check instead of the promised property.
- S1-PROXY (found through tests): the solution checks a cheap surrogate (a profile key, a count, a flag, outstanding-work presence) instead of the semantic property, and the tests do not catch it.
- T3-INTERACTION: the feature is never combined with lifecycle, sequence or multi-instance events: updates after an early emission, one client reused for several calls, delete on a new index, cached failure paths, a later viable sibling after a bad one.`;

/** Solution findings hosted raises (rulebook U4, U5, U7). */
export const SOLUTION_FINDING_FAMILIES = `- S1-DOMAIN-ENUM (most frequent): the input or state domain is only partly handled: empty, NULL or nil members, multi or nested forms, other join or plan shapes, missing matches; a legal input errors or panics, or an illegal one slips through.
- S1-ALT-PATH: the rule is wired into the main path but a sibling path bypasses it: a single-result fast path, another query engine or stage, an unbound or prepared variant, a registry versus direct route.
- T3-ALT-PATH (tests side of the same gap): no test drives the alternate route, backend or fallback, so a main-path-only implementation passes.
- T3-EQUIV-CLASS: one representative where several classes exist: only inner joins, only array arguments, only a one-endpoint cluster.
- S1-IDENTITY: an identity, equality or ordering key is not the full key: an ID change ignored on reload, one token resetting accounting for every connection, ties left in random map order.
- S1-ORDER: a rule applied at the wrong pipeline step: validation after dispatch, a cursor advanced before the response is sent, a restriction checked before its precondition.
- S1-STATE-SCOPE: state at the wrong scope or lifetime: mutable values shared across concurrent calls, a value read back differently after a unit or config change, a node-local check on replicated state.
- S1-NUMERIC: precision, rounding or boundary arithmetic: approximate-zero checks swallowing real values, silent rounding instead of rejection, large offsets pushing a value into the next cell.
- S1-CONCURRENCY: check-then-act races, out-of-order or duplicate delivery, persistence before rollback, a mutex held while blocking on a full channel.
- S1-FAILURE-PATH: dependency failure, cancellation or exceptions not designed: a lost leader blocking writes despite quorum, cancellation skipping rollback, an early return after a transient fetch error.
- S1-INCOMPLETE: the patch does not compile, or silently omits a stated requirement.`;

/** Local Test Quality: the families of unfair tests hosted Test Quality reports, each with its question and usual fix. */
export const TQ_UNFAIR_FAMILIES = `- TQF-01 exact error or log text: the test matches a message, prefix, substring, reason token or log line where the prompt says only that an error happens. Ask: does the prompt or an existing repo test quote that text? Fix: assert only the error, or name the text in problem.md.
- TQF-02 error versus success, error kind, status or stage: the test pins whether an input is rejected, which kind or status is returned, or at which call (setter versus execute) rejection happens. Ask: would accepting, clamping, ignoring or rejecting later still satisfy the prompt? Fix: state the rejection and kind, or assert only "not a success".
- TQF-03 unstated default, fallback or interpretation: the test relies on a default, a NULL-means-default rule, or one reading of an ambiguous word. Fix: state the default, or pass the value explicitly.
- TQF-04 threshold or boundary choice: the test sits exactly on a limit or edge the prompt does not define. Fix: state the limit, or test clearly above and clearly below it.
- TQF-05 output names and identifier values: field names, JSON keys, labels, command names or ids the prompt never spells. Fix: name them in problem.md, or reach the value through structure.
- TQF-06 exact wire or output layout: a response envelope, JSON key set, field numbers, an exact success line or formatter layout. Fix: round-trip or reparse, or state the format.
- TQF-07 public API shape: method names, signatures, field and return types, Result nesting or helper names the prompt does not give (the most frequent family). Ask: would a different name, pointer versus value, or nesting fail to compile? Fix: put the signature in problem.md, or go through a representation-neutral surface.
- TQF-08 internal coupling: private fields, timers, locks, mock call counts, argument forms, pointer identity or which helper runs. Fix: assert the stated effect through public behaviour.
- TQF-09 intermediate form: an IR, AST snapshot, generated names, state numbering, child order or alias names inside the pipeline. Ask: could another valid lowering differ here while the final behaviour is the same? Fix: compare membership or run the result.
- TQF-10 plan text and metrics: EXPLAIN text, metric strings, residual filters, or exact counters or result rows on fixtures only the author's design produces. Fix: assert results and a stated floor.
- TQF-11 state reset or carry-over on a transition: whether state survives an id or address change, a late result, a reload or a pause when the prompt covers only the unchanged case. Fix: state one rule per transition, or drop the transition.
- TQF-12 ordering and uniqueness for output the prompt leaves unordered. Fix: compare as sets, or sort.
- TQF-13 author-chosen numbers: escalation factors, tolerance windows, call counts, version integers, sentinels. Fix: assert the direction, or state the value.
- TQF-14 precedence between two stated rules that fire together. Fix: trigger one condition at a time, or state the order.
- TQF-15 scope extension: a join type, data type, nested case, empty or NULL input or mode the prompt never mentions (or excludes by an exhaustive list). Fix: drop it, or name it in problem.md.
- TQF-16 empty representation: nil versus empty, an empty batch versus none, zero calls versus some. Fix: assert emptiness, or state the representation.
- TQF-17 atomicity, repeats and aliasing: no side effects after a failure, the response to a repeated request, deduplication, snapshotting caller data. Fix: state the rule, or assert only the state outcome.
- TQF-18 hidden setup or broken harness: a missing package or tool, an implicit working directory, a shared fixture step, or a test that does not compile. These are unfair for every submission.
- TQF-19 contradicts the prompt or the repo: the test asserts what the prompt calls unspecified or excludes, or conflicts with repo or external semantics.
- TQF-20 documentation prose: a docs check requiring particular words, spellings, proximity or fenced blocks. Fix: check existence, links and prompt-named items only.
- TQF-21 compiled-output bytes: generated object or binary bytes compared for equality or inequality. Fix: compare a semantic projection.`;

/** The hosted refutation procedure, applied before any Not fair verdict. */
export const TQ_PROCEDURE = `1. Split the test into single assertions. A test is Not fair if one assertion is unfair even when the rest follow the prompt.
2. Write down the literal or choice each assertion pins: a string, number, name, status, order, representation, API symbol or call.
3. Search problem.md for the literal and its synonyms and neighbours (the exact substring, the number, "default", "threshold", "order", "nil", "error", the field name). A requirement stated with that precision makes it fair.
4. Search the repo for the exact literal, the symbol and the surrounding vocabulary in source, tests and docs. A producer, constant, helper or existing test asserting the same form (cite file:line) makes it fair.
5. Check whether an existing helper the solution must reuse already fixes the choice (shared constructor, parser, message producer). If so it is Repo-discoverable.
6. Check standard external semantics (SQL, IEEE 754, HTTP status classes, OGC geometry predicates, opaque-token conventions). Standard meaning makes the result part fair even when an optimisation claim is not.
7. Check arithmetic from the test's own setup: a value derived from rows, sizes or windows the test builds is fair; a figure only the author's design yields is not.
8. Ask the alternative-implementation question: name one competent implementation that satisfies every sentence of problem.md yet fails the assertion. If you can, mark Not fair.
9. Check that the test can pass at all: compile errors, unused variables, broken macros, missing packages or tools are harness defects, unfair for every submission.
10. Check the prompt's exclusions and "unspecified" statements: using them as the setup, or choosing a value the prompt calls unspecified, is Not fair.
11. Record the verdict per test with the searches run and the one competent alternative; keep the fair co-assertions so the fix removes only the unfair one.`;

/** What hosted Test Quality called Not fair, as patterns. */
export const TQ_UNFAIR_PATTERNS = `- A validation-timing choice (rejected at set time versus at execute time) when the prompt says only that the input is invalid.
- A stated property ("distinct lifetimes", "preserves uncanceled effects") checked through one particular encoding, numbering or exact count of internal calls, when a valid design (coalescing duplicates, a different numbering) meets the property differently.
- An internal return type or result struct the repo does not have and the prompt does not name, even when the counted concepts themselves are stated.
- Documentation checks that require exact phrases or safe-word lists.
- Behaviour for inputs outside an exhaustive-looking supported list in the prompt: rejecting them is the more literal reading.
- An exact result-row count on a fixture the solver cannot see, co-asserted with an otherwise prompt-stated property.
- A response envelope (a top-level key wrapping the result) when the prompt says only what is returned.
- Input validation placed in a particular layer (a shared helper rejecting blank ids) when another layer could validate.
- A repeated item treated as a no-op, a non-empty or distinct reason string, or a command name, when the prompt never states it.
- An item kind (struct versus alias versus enum) where the prompt says only "opaque".
- A late event extending a deadline or counting toward escalation when the prompt only says such events do not end the state early.`;

/** What hosted Test Quality accepted only after a repo or standard argument (hard negatives: do not flag these). */
export const TQ_FAIR_PATTERNS = `- A detail the repository's own docs or comments define (what a state means, which replicas come first), cited by file:line.
- Assertions through public APIs that already exist at the pin, under a prompt that says existing behaviour must not change.
- An internal representation the repo already uses for the stated behaviour (a pending-payload field cleared on flush) when the prompt states that behaviour.
- An exact count that the repo's existing semantics fix (an existing test already asserting "only one victim").
- Pre-existing repository suites, or checks that existing public methods keep working, run in base mode.
- Aliasing or identity that the repo's existing reference semantics already require.
- A diagnostic text produced by the repo's existing message producer for exactly the error the prompt names.
- A result fixed by a standard predicate (OGC intersects on distinct points) with the repo performing exact refinement.
- Metadata and traversal order produced by existing repo code that the prompt's guarantee runs through.`;

/** Synthesis calibration: what stayed HIGH, what was MEDIUM, and why HIGH findings were demoted. */
export const SYNTH_HIGH_PATTERNS = `- A hidden test file whose comments or names refer to the grading process or to problem.md: BLOCKER, provable from the quoted line.
- A solution that blames or charges the wrong party on an ordinary path (a healthy endpoint ejected because of a followed redirect's response): HIGH S1.
- A shared token, key or counter that resets every holder when one releases, letting a configured limit be exceeded: HIGH S1.
- A feature that works in tests but fails in the shipped deployment (missing RBAC or registration the real system enforces and the fake does not), named with the exact wrong implementation that passes: HIGH T4.
- A stated rule (any-provider-up availability, a precedence order) verified on one route only while a sibling route keeps base behaviour: HIGH T4 with the base code line that still runs.
- A whole stated route or invocation form never exercised (a rewrite path that replaces masked queries, scalar instead of array arguments): HIGH T3/T4 with the missing call quoted.
- A helper that returns success after the caller's code invalidated its internal state (releasing an older savepoint): HIGH S1 with the exact line that errors.`;

export const SYNTH_MEDIUM_PATTERNS = `- A bounded edge of an otherwise covered behaviour: one more input form of a tested family, the single first invalid ID past a range, a negative value next to a tested zero.
- A timing-dependent positive test with a fixed margin that ordinary host load rarely crosses.
- A second protocol or path that the rule covers when one negative path already is tested.
- A lockfile or generated file not regenerated for a new dependency when the tests still run.
- A syntactic round-trip edge (an explicit empty arm dropped) whose execution is equivalent.`;

export const SYNTH_DEMOTION_PATTERNS = `- promise_citation fails: the case is outside a usage rule the description states (two references from one client when the prompt says one client per reference).
- exercised_environment fails: an environment failure (offline, non-root, toolchain, permissions) is claimed but no log shows it.
- materiality fails: the input is pathological (integers beyond i32::MAX for a physics setting, 1e20 iterations, i64::MAX counts) or a fabricated state the real system cannot produce (two objects identical in every identity key but different in content).
- A test that compiles a private source file into the test crate is representation coupling at MEDIUM unless a correct factoring would actually break it.`;

// ---------------------------------------------------------------------------------------------------------------------
// The newer hosted Test Quality / Solution Quality checks (blocking + non-blocking code quality), distilled from their
// reports as general patterns.
// ---------------------------------------------------------------------------------------------------------------------

/** What the newer hosted Test Quality check blocks on as unfair: a correct, prompt-compliant implementation fails. */
export const HOSTED_UNFAIR_TEST_PATTERNS = `- Suite inconsistency: a test demands a stricter outcome than another test in the same suite accepts for the same kind of input (one test lets an unchanged peer proceed without a second confirmation, another requires that confirmation for an equivalent change). The prompt clause both rely on decides which reading holds; quote it.
- A test asks for more than the prompt clause it rests on: a second confirmation, report or refusal where the prompt asks for it only "before X happens" and X does not happen in the test's scenario.
- Harness and helper coupling: the shared driver finds controls by matching English label or caption regexes, presses a whole caption ("enter/esc") as one key, prefers a hidden list/Select binding over the advertised confirm shortcut, requires a control (an Export button on an empty list) the prompt does not require, or only enters paths through a text input when the prompt does not say how a path is chosen. Report it once per helper and list every test it reaches.
- Representation and layout pins: exact raw snapshots of a whole directory that reject an implementation's own hidden metadata file; a now-invalid item required to stay visible in an updated list; a category decided by a heading word rather than by the item itself.
- Implementation-dependent probes: a fault injected through one particular primitive (one os.rmdir call, one unlink) that a different correct design never reaches, so the test skips or passes vacuously; graders count a skip as a failure, so such a test fails correct work.
- Wording pins: a refusal, conflict or failure report required to contain keywords from the test's own vocabulary when the prompt only says to report it.`;

/** What the newer hosted Test Quality check blocks on as missing coverage: a wrong implementation still passes. */
export const HOSTED_TEST_GAP_PATTERNS = `- Interrupted processes: the prompt promises cleanup of partial work or behaviour "even after restarting", but every test only raises exceptions inside the running process. A transfer, write or undo killed mid-way (os._exit, SIGKILL, closing the app) leaves state that only startup or next-run recovery can clean; no test kills a child process and restarts.
- Existing lifecycle operations of the repo (rename, move, reload, delete through the existing UI or store API) applied to the new persistent state: the new state is lost or stranded and every test still passes because none runs the existing operation followed by the new feature.
- Mirror cases: the suite applies a rule in one direction (export into a folder that contains protected roots) but never the mirror (import from that folder), so an implementation that checks only equality or containment one way passes.
- Conditional assertions: checks wrapped in "if the file still exists" or similar, so the stated outcome (removal, rejection) is never required and the opposite passes.
- A stated class covered by one representative, a default observed only behind another setting, a bound checked loosely: name the wrong value that passes.`;

/** Non-blocking test code-quality findings, by the hosted categories. */
export const TEST_QUALITY_CATEGORIES = `- Clutter: fixtures that repeat another fixture or helper line for line (and miss its teardown); alias fixtures that only return another fixture; a helper imported under another helper's name; function-level imports of modules already imported at the top; comments or docstrings addressed to whoever grades an implementation ("without prescribing ...", "a passing integrity outcome", "not a required call") instead of the behaviour; seeds or names derived from the task id; undocumented environment overrides.
- Conventions: building the app or services by hand when the repo's existing tests use a shared helper (name the helper and the existing test that uses it).
- Design: a navigation layer that finds the feature's controls by matching label regexes, captions and headings because the task never names them (describe how a reasonable UI is missed or the wrong control is pressed); assumptions about the input widget (a text field) when the task allows another (a picker).
- Practice: polling the UI against wall-clock deadlines instead of awaiting the app's workers; negative "nothing changed" checks taken without first waiting for background workers, so a late write is not caught; long timeouts that make a run without the solution take minutes.`;

/** What the newer hosted Solution Quality check blocks on: a concrete call sequence with a wrong output. */
export const HOSTED_WRONG_OUTPUT_PATTERNS = `- Crash and restart at every step of a multi-step persistent operation: kill the process between "create scratch folder" and "record it", between "move into quarantine" and "unlink", between "publish" and "journal". After restart, the operation's own scratch files or folders stay behind, a created folder is never removed, the undo or recovery record is cleared while leftovers remain, and the retry reports success with no failures.
- One missing piece aborts the rest: a missing root, a deleted file or one failing path makes the whole cleanup or undo return early, contrary to "continue with the other eligible files".
- Portability against the project's declared platform support (packaging classifiers such as "Operating System :: OS Independent"): a primitive available only on some platforms (renameat2, a Darwin call) raises on others and the caller catches only one error type, so an ordinary nested import or export fails there.
- Regressions of existing public operations: a new step inside an existing method (a rename) can now fail and roll the operation back or return False where the existing test and callers expect success.
- Results that report success while the stated outcome did not happen (nothing undone, no failures, files still present).`;

/** Non-blocking solution code-quality findings, by the hosted categories. */
export const SOLUTION_QUALITY_CATEGORIES = `- Practice: work that grows with the square of the input (rewriting a whole journal or record per item, re-listing and re-resolving every root per file); give the counts that show it (n items -> time or calls). Swallowed exceptions (except ...: pass) that hide a stuck recovery. Results that show only counts and drop the per-item paths and reasons the user needs. The same source read or hashed several times for one operation, including files that can never be used. Expensive lookups repeated on every call (ctypes/libc resolution). Methods that break the project's own lint configuration (for example a configured max-complexity).
- Clutter: dead branches for record formats or legacy shapes this change never wrote; one-line wrappers with a single caller; a hardcoded value or message that duplicates an existing module constant; re-validation of values the same code just produced; duplicated consecutive checks.
- Design: two mechanisms that duplicate the same bookkeeping and copy each other's records; implementation flags leaking into a public signature; a rule re-implemented in a second place that can drift from the original; behaviour that depends on what happens to exist on disk; scans or writes outside the application's own directories.
- Conventions: new signatures formatted unlike every other signature in the file; calls to another module's or class's underscore helpers; bypassing an existing widget or service API (setting a display flag instead of calling show/hide).
- Scope: edits to existing code the task does not need (reformatting, removed comments, changed preconditions); special cases for inputs the task does not ask about.
- Stale callers: existing callers that ignore a changed return value or contract (a method that can now return False), with the consequence.`;
