/**
 * Shared types for the shipd-checks extension. Kept dependency-free (no
 * imports from pi/typebox) so every other module can import from here
 * without pulling in extra runtime surface.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";

export type Verdict = "PASS" | "FAIL";

/** Model/thinking-level settings for the solver-gap-finder's solver agents (they write code + run shell, a heavier job than the read-only reviewers), plus their own timeout/parallelism knobs. Kept nested under `solverGap` in the same config file rather than a separate one. */
export interface SolverGapConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  timeoutMinutes: number;
  /** Number of parallel solver agents to run. */
  solverCount: number;
  /** Whether to persist trajectory.json/solution.patch/test output to `.pi/shipd-checks/<runId>/` per run. */
  saveArtifacts: boolean;
}

/** Single combined `checks-config.json`: reviewer settings at the top level, solver-gap-finder settings nested. */
export interface ChecksConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  solverGap?: SolverGapConfig;
}

export interface ReviewReport {
  verdict: Verdict;
  summary: string;
  /** Blocking justifications. Required (non-empty) when verdict is FAIL, empty when PASS. */
  reasons: string[];
  /** Non-blocking, optional/minor suggestions — present regardless of verdict. */
  notes: string[];
}

/** A candidate behavioral test gap proposed for one sentence in the task prompt. */
export interface TestGapCandidate {
  description: string;
  risk: string;
}

/** The finder must account for every prompt sentence, including sentences with no gaps. */
export interface StatementGapReport {
  statement: string;
  gaps: TestGapCandidate[];
}

/** A gap that survived the strict fairness-filter agent — goes into the final report. */
export interface TestGapFinal {
  description: string;
  justification: string;
}

export type ReviewerRoleKey = "description" | "tests" | "solution";

export interface ReviewerRole {
  key: ReviewerRoleKey;
  label: string;
  rubricHeading: RegExp;
}

/** `ok` means the agent actually finished and submitted (possibly an empty list on purpose). */
export interface GapStageResult<T> {
  status: "ok" | "timedOut" | "cancelled" | "error" | "noSubmission";
  gaps: T[];
}

export interface CommandOption {
  value: string;
  label: string;
  description: string;
}

/** Outcome of one solver-gap-finder solver agent (writes code + runs shell; sees agent_prompt.md + test.patch, never solution.patch). */
export interface SolverRunResult {
  index: number;
  status: "ok" | "timedOut" | "cancelled" | "error" | "patchFailed";
  passed: boolean;
  diff: string;
  testOutputTail: string;
  /** Wall-clock time the solver agent + verification took, in ms. */
  durationMs: number;
  /** Test totals parsed from the verifier's JUnit XML output; null when no report was produced. */
  totalTests: number | null;
  failedTests: number | null;
  /** Dir under `.pi/shipd-checks/<runId>/solver_<index>/` where trajectory.json/solution.patch/test output were saved, if any. */
  artifactsDir?: string;
}

/** A behavioral gap surfaced by comparing solver diffs against the real prompt/solution. */
export interface SolverGap {
  description: string;
  justification: string;
  /** Which solver(s) and what part of their diff grounds this gap. */
  evidence: string;
}
