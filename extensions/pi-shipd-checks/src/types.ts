/**
 * Shared types for the shipd-checks extension. Kept dependency-free (no
 * imports from pi/typebox) so every other module can import from here
 * without pulling in extra runtime surface.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
export type ClaudeThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type Verdict = "PASS" | "FAIL";

/** Claude CLI model and execution settings for Fargate solvers, retained under `solverGap` for config compatibility. */
export type FargateResourceProfile = "small" | "medium" | "large";

export type PatchPrecheckPhase =
  | "base-before-solution"
  | "new-before-solution"
  | "base-after-solution"
  | "new-after-solution";

export interface PatchTestRunResult {
  phase: PatchPrecheckPhase;
  exitCode: number;
  tests: number | null;
  testcases: number | null;
  failures: number | null;
  failedTestcases: number | null;
  passedTestcases: number | null;
  errors: number | null;
  erroredTestcases: number | null;
  suiteErrors: number | null;
  collectionErrors: number | null;
  skipped: number | null;
  skippedTestcases: number | null;
  skippedTestNames: string[];
  failedTestNames: string[];
  erroredTestNames: string[];
  failureDetails: string[];
  passedTestNames: string[];
  partiallyPassedTestNames: string[];
  collectionErrorNames: string[];
  passed: boolean;
}

export interface PatchPrecheckResult {
  platform: "linux";
  status: "ok" | "failed" | "error" | "cancelled" | "timedOut";
  passed: boolean;
  phases: PatchTestRunResult[];
  durationMs: number;
  error?: string;
}

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
  /** Claude Code CLI model alias or model ID used by the Fargate solvers. */
  modelId: string;
  /** Claude Code CLI solver effort passed explicitly through as `--effort`. */
  thinkingLevel: ClaudeThinkingLevel;
  timeoutMinutes: number;
  /** Number of parallel solver agents to run. */
  solverCount: number;
}

export interface PromptHumanizerConfig {
  /** Number of humanizer drafts to request from CoreWeave (1–10). */
  candidateCount?: number;
  /** Maximum number of cutoff-passing drafts to return (1–10, capped at candidateCount). */
  topCount?: number;
  /** Optional path to a local CoreWeave API-key file; the secret itself is never stored in this config. */
  coreweaveApiKeyFile?: string;
}

/** Single combined `checks-config.json`: local analysis reviewer settings and Claude benchmark settings. */
export interface ChecksConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  fargate?: FargateConfig;
  solverGap?: SolverGapConfig;
  /** Project folders where the agent-callable analysis tools are enabled. */
  enabledProjects?: string[];
  /** Legacy global setting retained for migration. */
  enableAnalyzeTool?: boolean;
  /** Model/thinking-level settings for the agent-callable gap-finder and solution-precheck tools. */
  analyzeGap?: AnalyzeGapConfig;
  /** Candidate-count settings for the opt-in agent-prompt humanizer. */
  promptHumanizer?: PromptHumanizerConfig;
}

/** Model settings shared by the read-only gap-finder and solution-precheck tools. */
export interface AnalyzeAgentConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Maximum time allowed for each read-only analysis agent phase. */
  timeoutMinutes: number;
}

export interface AnalyzeGapConfig extends AnalyzeAgentConfig {}

export interface ReviewReport {
  verdict: Verdict;
  summary: string;
  /** Blocking justifications. Required (non-empty) when verdict is FAIL, empty when PASS. */
  reasons: string[];
  /** Non-blocking, optional/minor suggestions — present regardless of verdict. */
  notes: string[];
}

/** A fair, public behavioral test gap found by the gap-finder. */
export interface TestGapFinal {
  description: string;
  justification: string;
}

/** Kind of actionable problem found by the solution-precheck. */
export type SolutionAuditCategory =
  | "missing-requirement"
  | "regression"
  | "architecture"
  | "unsafe-failure"
  | "inconsistent-path"
  | "dead-code"
  | "unrelated-change";

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

/** Result of the single read-only solution-precheck. */
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

/** A test-suite run performed by the harness after one Claude CLI solver invocation. */
export interface SolverTestResult {
  exitCode: number;
  passed: boolean;
  durationMs: number;
  output: string;
  timedOut?: boolean;
}

/** Aggregate token metrics reported by Claude Code or a local Pi model session. */
export interface TokenUsage {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  /** Explicitly reported reasoning/thinking tokens, when the provider exposes them. */
  thinkingTokens?: number;
  totalInputTokens?: number;
  /** Total excluding explicit thinking tokens; otherwise the raw input-plus-output total. */
  totalTokens?: number;
  /** Raw input-plus-output total, included when thinking tokens were explicitly reported. */
  rawTotalTokens?: number;
  /** Token count in the final API request context, when per-iteration usage is available. */
  finalContextTokens?: number;
  peakContextTokens?: number;
  contextWindow?: number;
  contextWindowUtilizationPercent?: number;
  modelCalls?: number;
  costUsd?: number;
}

/** Outcome of one isolated Claude CLI solver run; base/new tests are independently verified afterward. */
export interface SolverRunResult {
  index: number;
  status: "ok" | "timedOut" | "cancelled" | "error";
  passed: boolean;
  diff: string;
  testOutputTail: string;
  agentOutput?: string;
  tokenUsage?: TokenUsage;
  baseTests?: SolverTestResult;
  newTests?: SolverTestResult;
  /** Wall-clock time for the one-shot agent invocation and both verification suites, in ms. */
  durationMs: number;
  totalTests: number | null;
  failedTests: number | null;
  /** Diagnostic for setup, execution, transport, or other non-test failures. */
  error?: string;
  /** Dir under `.pi/shipd-checks/<runId>/solver_<index>/` where diffs and logs were saved, if any. */
  artifactsDir?: string;
}

/** Read-only Pi reviewer assessment of all agent solutions and the repository's tests. */
export interface SolverReviewResult {
  status: "ok" | "timedOut" | "cancelled" | "error";
  text: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tokenUsage?: TokenUsage;
  error?: string;
}
