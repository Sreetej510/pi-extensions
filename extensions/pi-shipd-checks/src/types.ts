/**
 * Shared types for the shipd-checks extension. Kept dependency-free (no
 * imports from pi/typebox) so every other module can import from here
 * without pulling in extra runtime surface.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";

export type Verdict = "PASS" | "FAIL";

export interface ChecksConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface ReviewReport {
  verdict: Verdict;
  summary: string;
  /** Blocking justifications. Required (non-empty) when verdict is FAIL, empty when PASS. */
  reasons: string[];
  /** Non-blocking, optional/minor suggestions — present regardless of verdict. */
  notes: string[];
}

/** A candidate behavioral test gap proposed by the (unfiltered) gap-finder researcher agent. */
export interface TestGapCandidate {
  description: string;
  risk: string;
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
