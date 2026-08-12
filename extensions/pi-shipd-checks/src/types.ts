/**
 * Shared types for the shipd-checks extension. Kept dependency-free (no
 * imports from pi/typebox) so every other module can import from here
 * without pulling in extra runtime surface.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";

export type Verdict = "PASS" | "FAIL";

/** Model/thinking-level settings for the solver-gap-finder's solver agents (they write code + run shell, a heavier job than the read-only reviewers), plus their own timeout/parallelism knobs. Kept nested under `solverGap` in the same config file rather than a separate one. */
export type FargateResourceProfile = "small" | "medium" | "large";

/** Task-level resource telemetry captured inside the worker and persisted locally after a run. */
export interface FargateResourceUsage {
  profile: FargateResourceProfile;
  /** CPU capacity used to normalize the task-level CPU percentage. */
  allocatedVcpus: number;
  durationMs: number;
  sampleCount: number;
  maxCpuPercent: number | null;
  /** Observed milliseconds whose normalized CPU utilization was at least 95%. */
  cpuOver95DurationMs: number | null;
  observedAt: string;
}

export interface FargateConfig {
  /** AWS CLI/SDK profile name; environment AWS_PROFILE still takes precedence. */
  awsProfile?: string;
  /** AWS region for ECS, S3, and task networking. */
  region?: string;
  /** Optional existing ECS cluster ARN or name; auto-discovered when absent. */
  cluster?: string;
  /** Optional S3 bucket; an account-scoped bucket is created when absent. */
  bucket?: string;
  /** Optional public subnet IDs. Default-VPC public subnets are discovered when absent. */
  subnetIds?: string[];
  /** Optional security group ID. The default-VPC default group is discovered when absent. */
  securityGroupId?: string;
  /** Resource profile used by the current project when no project override exists. */
  resourceProfile?: FargateResourceProfile;
  /** Automatically select the next profile from per-project resource telemetry. */
  adaptiveResourceProfile?: boolean;
  /** Per-project resource profiles keyed by absolute project path; these override adaptive sizing. */
  projectProfiles?: Record<string, FargateResourceProfile>;
  /** ECS task role ARN used for long-running direct S3 access from the worker. */
  taskRoleArn?: string;
  /** ECS task execution role ARN, needed when CloudWatch logs are enabled. */
  executionRoleArn?: string;
  /** CloudWatch log group used when executionRoleArn is configured. */
  logGroup?: string;
  /** Number of times to retry an interrupted Spot task. */
  maxRetries?: number;
}

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
  fargate?: FargateConfig;
  solverGap?: SolverGapConfig;
  /** Project folders where the agent-callable test-analysis tool is enabled. */
  enabledProjects?: string[];
  /** Legacy global setting retained for migration. */
  enableAnalyzeTool?: boolean;
  /** Dedicated model/thinking-level for the `analyze_task_tests` tool's gap finder + audit agents. */
  analyzeGap?: AnalyzeGapConfig;
}

/** Model/thinking-level settings for one mode of the agent-callable analysis tool. */
export interface AnalyzeAgentConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Maximum time allowed for each read-only analysis agent phase. */
  timeoutMinutes: number;
}

/** Model settings for gap-analysis mode plus a shared Auditor model for both audit modes. */
export interface AnalyzeGapConfig extends AnalyzeAgentConfig {
  /** Shared Auditor model for test-audit and solution-audit; omitted means reuse the gap-analysis model. */
  testAuditProvider?: string;
  testAuditModelId?: string;
  testAuditThinkingLevel?: ThinkingLevel;
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

/** Modes supported by the agent-callable behavioral analysis tool. */
export type AnalyzeMode = "gaps" | "test-audit" | "solution-audit";

/** Kind of actionable problem found by the post-implementation test audit. */
export type TestAuditCategory = "unfair-assertion" | "prompt-ambiguity" | "broken-fixture";

/** Kind of actionable problem found by the post-implementation solution audit. */
export type SolutionAuditCategory =
  | "missing-requirement"
  | "regression"
  | "architecture"
  | "unsafe-failure"
  | "inconsistent-path"
  | "dead-code"
  | "unrelated-change";

/** A concrete fairness, ambiguity, strength, or fixture problem in the current tests. */
export interface TestAuditFinding {
  category: TestAuditCategory;
  /** Test name or short identifier that lets the caller find the affected assertion. */
  testName: string;
  /** What is wrong with the test and why it is actionable. */
  problem: string;
  /** Prompt/repository/test evidence supporting the finding. */
  evidence: string;
  /** The behavioral gap or contract that must remain covered after the repair. */
  requiredBehavior: string;
  /** A fair repair, or a prompt clarification when the contract is genuinely ambiguous. */
  recommendation: string;
}

/** Result of one read-only post-implementation test audit. */
export interface TestAuditStageResult {
  status: "ok" | "timedOut" | "cancelled" | "error" | "noSubmission";
  findings: TestAuditFinding[];
}

/** A concrete quality problem in the current solution implementation. */
export interface SolutionAuditFinding {
  category: SolutionAuditCategory;
  /** Short behavior, symbol, or concern identifier; avoid requiring a source location. */
  subject: string;
  /** What is wrong with the implementation and why it is actionable. */
  problem: string;
  /** Prompt, repository, implementation, or regression evidence supporting the finding. */
  evidence: string;
  /** The requirement, invariant, or quality property the solution must preserve. */
  requiredBehavior: string;
  /** A concrete repair that stays within the prompt and repository conventions. */
  recommendation: string;
}

/** Result of one read-only post-implementation solution audit phase. */
export interface SolutionAuditStageResult {
  status: "ok" | "timedOut" | "cancelled" | "error" | "noSubmission";
  findings: SolutionAuditFinding[];
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
