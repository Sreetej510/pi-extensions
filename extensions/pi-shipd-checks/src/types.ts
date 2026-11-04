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

export interface AuditorConfig {
  /** Claude Code CLI model alias or model ID used by the `auditor` tool's reviewers. */
  modelId: string;
  /** Claude Code CLI reviewer effort passed through as `--effort`. */
  thinkingLevel: ClaudeThinkingLevel;
  /** Timeout for each reviewer invocation. */
  timeoutMinutes: number;
  /** Number of reviewer invocations run at the same time. */
  concurrency: number;
}

export interface SolverReviewConfig {
  /** Claude Code CLI model alias or model ID used by the local `/checks --solve` fairness reviewer. */
  modelId: string;
  /** Claude Code CLI reviewer effort passed through as `--effort`. */
  thinkingLevel: ClaudeThinkingLevel;
  /** Timeout for the reviewer invocation. */
  timeoutMinutes: number;
}

export type QualityTestSolutionMode = "sequential" | "parallel";

export interface QualityCheckConfig {
  /** `sequential` runs Solution Quality only after Test Quality passes; `parallel` starts both together. */
  testSolutionMode: QualityTestSolutionMode;
}

export interface PromptHumanizerConfig {
  /** Number of humanizer drafts to request from CoreWeave (1–10). */
  candidateCount?: number;
  /** Maximum number of cutoff-passing drafts to return (1–10, capped at candidateCount). */
  topCount?: number;
  /** Optional path to a local CoreWeave API-key file; the secret itself is never stored in this config. */
  coreweaveApiKeyFile?: string;
}

/** Single combined `checks-config.json`: Claude benchmark/review settings and local analysis-tool settings. */
export interface ChecksConfig {
  /** Optional local file containing a Claude setup-token for Fargate solver runs. */
  claudeOAuthTokenFile?: string;
  fargate?: FargateConfig;
  solverGap?: SolverGapConfig;
  /** Local Claude CLI settings for the `/checks --solve` fairness reviewer. */
  solverReview?: SolverReviewConfig;
  /** Local Claude CLI settings for the `auditor` tool. */
  auditor?: AuditorConfig;
  /** Settings for the `quality-check` tool. */
  qualityCheck?: QualityCheckConfig;
  /** Project folders where the agent-callable analysis tools are enabled. */
  enabledProjects?: string[];
  /** Candidate-count settings for the opt-in agent-prompt humanizer. */
  promptHumanizer?: PromptHumanizerConfig;
}

export interface ReviewReport {
  verdict: Verdict;
  summary: string;
  /** Blocking justifications. Required (non-empty) when verdict is FAIL, empty when PASS. */
  reasons: string[];
  /** Non-blocking, optional/minor suggestions — present regardless of verdict. */
  notes: string[];
}

/** A behavioral test gap, as recorded in shipd_report.json by older gap-finder runs. */
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
  totalTests?: number | null;
  passedTests?: number | null;
  failedTests?: number | null;
  erroredTests?: number | null;
  skippedTests?: number | null;
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

/** Read-only Claude CLI reviewer assessment of all agent solutions and the repository's tests. */
export interface SolverReviewResult {
  status: "ok" | "timedOut" | "cancelled" | "error";
  text: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tokenUsage?: TokenUsage;
  error?: string;
}
