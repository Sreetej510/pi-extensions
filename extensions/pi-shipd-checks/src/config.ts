/**
 * Global config (~/.pi/agent/checks-config.json) for the Codex CLI benchmark, reviewer and auditor settings, and Fargate resources, plus helpers for reading
 * pi's own settings.json (enabled models, shell path) used by unrelated tools.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AuditorConfig,
  ChecksConfig,
  CodexReasoningEffort,
  FargateConfig,
  FargateResourceProfile,
  FargateResourceUsage,
  SolverGapConfig,
  SolverReviewConfig,
  ThinkingLevel,
} from "./types.js";

export const CONFIG_PATH = join(getAgentDir(), "checks-config.json");
export const SETTINGS_PATH = join(getAgentDir(), "settings.json");
export const SOLVER_GAP_TIMEOUT_MIN_MINUTES = 10;
export const SOLVER_GAP_TIMEOUT_MAX_MINUTES = 90;
export const SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES = 20;
export const SOLVER_GAP_TEST_TIMEOUT_MIN_MINUTES = 5;
export const SOLVER_GAP_TEST_TIMEOUT_MAX_MINUTES = 60;
export const SOLVER_GAP_DEFAULT_TEST_TIMEOUT_MINUTES = 15;

export const SOLVER_GAP_SOLVER_COUNT_MIN = 1;
export const SOLVER_GAP_SOLVER_COUNT_MAX = 5;
export const SOLVER_GAP_DEFAULT_SOLVER_COUNT = 3;

export const SOLVER_REVIEW_TIMEOUT_MIN_MINUTES = 10;
export const SOLVER_REVIEW_TIMEOUT_MAX_MINUTES = 60;
export const SOLVER_REVIEW_DEFAULT_TIMEOUT_MINUTES = 20;

export const AUDITOR_TIMEOUT_MIN_MINUTES = 10;
export const AUDITOR_TIMEOUT_MAX_MINUTES = 90;
export const AUDITOR_DEFAULT_TIMEOUT_MINUTES = 40;
export const AUDITOR_CONCURRENCY_MIN = 1;
export const AUDITOR_CONCURRENCY_MAX = 8;
export const AUDITOR_DEFAULT_CONCURRENCY = 4;

/** Codex CLI models offered in `/checks --config`; any other saved model ID is passed through unchanged. */
export const CODEX_MODELS = ["gpt-6-luna", "gpt-6.2-sol", "gpt-6.2-astra"] as const;
export const CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_SOLVER_DEFAULT_MODEL = "gpt-6.2-sol";
const CODEX_REVIEWER_DEFAULT_MODEL = "gpt-6.2-astra";
/** Claude aliases saved by earlier versions, mapped to the comparable Codex tier. */
const LEGACY_CLAUDE_MODELS: Record<string, string> = {
  haiku: "gpt-6-luna",
  sonnet: "gpt-6.2-sol",
  opus: "gpt-6.2-astra",
};

function codexModel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const model = value.trim();
  if (LEGACY_CLAUDE_MODELS[model]) return LEGACY_CLAUDE_MODELS[model];
  return /^claude/i.test(model) ? fallback : model;
}

function codexEffort(value: unknown, fallback: CodexReasoningEffort): CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort) ? (value as CodexReasoningEffort) : fallback;
}

export const FARGATE_RESOURCE_PROFILES = {
  small: { cpu: 1, memoryMiB: 2048 },
  medium: { cpu: 2, memoryMiB: 4096 },
  large: { cpu: 4, memoryMiB: 8192 },
} as const satisfies Record<FargateResourceProfile, { cpu: number; memoryMiB: number }>;
export const FARGATE_DEFAULT_PROFILE: FargateResourceProfile = "medium";
/** Quality patch prechecks always use this fixed profile instead of adaptive sizing. */
export const FARGATE_PREQUALITY_PROFILE: FargateResourceProfile = "medium";
export const FARGATE_DEFAULT_MAX_RETRIES = 1;
const FARGATE_CPU_UPGRADE_DURATION_MS = 7 * 60 * 1000;
const FARGATE_CPU_DOWNGRADE_DURATION_MS = 2 * 60 * 1000;

/**
 * Mirrors `getSupportedThinkingLevels` from `@earendil-works/pi-ai` (not part of
 * pi-coding-agent's public export surface, so re-implemented here): a level is
 * available if the model supports reasoning at all, isn't explicitly mapped to
 * `null` in `thinkingLevelMap`, and — for the opt-in `xhigh`/`max` tiers — is
 * explicitly present (non-undefined) in that map.
 */
const EXTENDED_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels(
  model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> } | undefined,
): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function loadChecksConfig(): ChecksConfig {
  return readRawChecksConfig() as ChecksConfig;
}

export function saveChecksConfig(config: ChecksConfig): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Load Fargate settings and normalize values that affect task retries/profile selection. */
export function loadFargateConfig(): FargateConfig {
  const raw = readRawChecksConfig().fargate;
  const fargate = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as FargateConfig) : {};
  const resourceProfile = Object.hasOwn(FARGATE_RESOURCE_PROFILES, fargate.resourceProfile ?? "")
    ? fargate.resourceProfile
    : FARGATE_DEFAULT_PROFILE;
  const maxRetries = Number.isFinite(fargate.maxRetries)
    ? Math.min(3, Math.max(0, Math.floor(fargate.maxRetries as number)))
    : FARGATE_DEFAULT_MAX_RETRIES;
  return {
    ...fargate,
    resourceProfile,
    adaptiveResourceProfile: fargate.adaptiveResourceProfile === true,
    maxRetries,
  };
}

export function resolveFargateResources(
  cwd: string,
  config = loadFargateConfig(),
): {
  profile: FargateResourceProfile;
  cpu: number;
  memoryMiB: number;
} {
  const explicitProfile = config.projectProfiles?.[cwd];
  const profile = explicitProfile ?? selectAdaptiveResourceProfile(cwd, config);
  const normalized = Object.hasOwn(FARGATE_RESOURCE_PROFILES, profile) ? profile : FARGATE_DEFAULT_PROFILE;
  return { profile: normalized, ...FARGATE_RESOURCE_PROFILES[normalized] };
}

export function selectAdaptiveResourceProfile(cwd: string, config: FargateConfig): FargateResourceProfile {
  return config.projectProfiles?.[cwd] ?? config.resourceProfile ?? FARGATE_DEFAULT_PROFILE;
}

export function recordFargateResourceUsage(
  config: ChecksConfig,
  cwd: string,
  usage: FargateResourceUsage,
): ChecksConfig {
  const fargate = config.fargate ?? {};
  if (fargate.adaptiveResourceProfile !== true) return config;
  const profiles = Object.keys(FARGATE_RESOURCE_PROFILES) as FargateResourceProfile[];
  const currentIndex = profiles.indexOf(usage.profile);
  const cpuOverloaded = (usage.cpuOver95DurationMs ?? 0) > FARGATE_CPU_UPGRADE_DURATION_MS;
  const safeToDowngrade =
    typeof usage.cpuOver95DurationMs === "number" && usage.cpuOver95DurationMs < FARGATE_CPU_DOWNGRADE_DURATION_MS;
  let nextProfile = usage.profile;
  if (cpuOverloaded && currentIndex < profiles.length - 1)
    nextProfile = profiles[currentIndex + 1] as FargateResourceProfile;
  else if (safeToDowngrade && currentIndex > 0) nextProfile = profiles[currentIndex - 1] as FargateResourceProfile;
  const projectProfiles = { ...(fargate.projectProfiles ?? {}), [cwd]: nextProfile };
  return { ...config, fargate: { ...fargate, projectProfiles } };
}

/** Persist adaptive Fargate sizing after a solver-gap run. */
export function persistFargateResourceUsage(cwd: string, usage: FargateResourceUsage): void {
  const config = loadChecksConfig();
  const next = recordFargateResourceUsage(config, cwd, usage);
  if (next !== config) saveChecksConfig(next);
}

/** Solver settings are independent of Pi model configuration because solvers use Codex CLI. */
export function loadSolverGapConfig(): SolverGapConfig {
  const raw = readRawChecksConfig().solverGap;
  const solverGap = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<SolverGapConfig>) : {};
  const timeoutMinutes = Number.isFinite(solverGap.timeoutMinutes)
    ? Math.min(
        SOLVER_GAP_TIMEOUT_MAX_MINUTES,
        Math.max(SOLVER_GAP_TIMEOUT_MIN_MINUTES, solverGap.timeoutMinutes as number),
      )
    : SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES;
  const testTimeoutMinutes = solverGapTestTimeoutMinutes(solverGap.testTimeoutMinutes);
  const solverCount = Number.isInteger(solverGap.solverCount)
    ? Math.min(SOLVER_GAP_SOLVER_COUNT_MAX, Math.max(SOLVER_GAP_SOLVER_COUNT_MIN, solverGap.solverCount as number))
    : SOLVER_GAP_DEFAULT_SOLVER_COUNT;
  return {
    modelId: codexModel(solverGap.modelId, CODEX_SOLVER_DEFAULT_MODEL),
    thinkingLevel: codexEffort(solverGap.thinkingLevel, "low"),
    timeoutMinutes,
    testTimeoutMinutes,
    solverCount,
  };
}

/** Per-suite solver test timeout, clamped to the configurable range (default when unset or invalid). */
export function solverGapTestTimeoutMinutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(SOLVER_GAP_TEST_TIMEOUT_MAX_MINUTES, Math.max(SOLVER_GAP_TEST_TIMEOUT_MIN_MINUTES, Math.floor(value)))
    : SOLVER_GAP_DEFAULT_TEST_TIMEOUT_MINUTES;
}

/** Save solver settings without touching the rest of the config. */
export function saveSolverGapConfig(solverGap: SolverGapConfig): void {
  const raw = readRawChecksConfig();
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, solverGap }, null, 2), "utf-8");
}

/** Local Codex CLI settings for the `/checks --solve` fairness reviewer; independent of Pi model configuration. */
export function loadSolverReviewConfig(): SolverReviewConfig {
  const raw = readRawChecksConfig().solverReview;
  const solverReview =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<SolverReviewConfig>) : {};
  const timeoutMinutes = Number.isFinite(solverReview.timeoutMinutes)
    ? Math.min(
        SOLVER_REVIEW_TIMEOUT_MAX_MINUTES,
        Math.max(SOLVER_REVIEW_TIMEOUT_MIN_MINUTES, solverReview.timeoutMinutes as number),
      )
    : SOLVER_REVIEW_DEFAULT_TIMEOUT_MINUTES;
  return {
    modelId: codexModel(solverReview.modelId, CODEX_REVIEWER_DEFAULT_MODEL),
    thinkingLevel: codexEffort(solverReview.thinkingLevel, "high"),
    timeoutMinutes,
  };
}

export function saveSolverReviewConfig(solverReview: SolverReviewConfig): void {
  const raw = readRawChecksConfig();
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, solverReview }, null, 2), "utf-8");
}

/** Local Codex CLI settings for the `auditor` tool; a saved `autoReview` block from earlier versions still applies. */
export function loadAuditorConfig(): AuditorConfig {
  const config = readRawChecksConfig();
  const raw = config.auditor ?? config.autoReview;
  const auditor = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<AuditorConfig>) : {};
  const timeoutMinutes = Number.isFinite(auditor.timeoutMinutes)
    ? Math.min(AUDITOR_TIMEOUT_MAX_MINUTES, Math.max(AUDITOR_TIMEOUT_MIN_MINUTES, auditor.timeoutMinutes as number))
    : AUDITOR_DEFAULT_TIMEOUT_MINUTES;
  const concurrency = Number.isInteger(auditor.concurrency)
    ? Math.min(AUDITOR_CONCURRENCY_MAX, Math.max(AUDITOR_CONCURRENCY_MIN, auditor.concurrency as number))
    : AUDITOR_DEFAULT_CONCURRENCY;
  return {
    modelId: codexModel(auditor.modelId, CODEX_REVIEWER_DEFAULT_MODEL),
    thinkingLevel: codexEffort(auditor.thinkingLevel, "high"),
    timeoutMinutes,
    concurrency,
  };
}

export function saveAuditorConfig(auditor: AuditorConfig): void {
  const { autoReview: _legacy, ...raw } = readRawChecksConfig();
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, auditor }, null, 2), "utf-8");
}

/** Read the existing checks config without requiring model settings to be configured yet. */
function readRawChecksConfig(): Record<string, unknown> {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Project folders where the agent-callable test-analysis tool is enabled. */
export function loadAnalyzeEnabledProjects(): string[] {
  const projects = readRawChecksConfig().enabledProjects;
  return Array.isArray(projects) ? projects.filter((project): project is string => typeof project === "string") : [];
}

/** Whether the agent-callable analysis tools are enabled for a project. */
export function isAnalyzeProjectEnabled(cwd: string): boolean {
  return loadAnalyzeEnabledProjects().includes(cwd);
}

export function setAnalyzeProjectEnabled(cwd: string, enabled: boolean): void {
  const projects = new Set(loadAnalyzeEnabledProjects());
  if (enabled) projects.add(cwd);
  else projects.delete(cwd);
  saveChecksConfig({ ...loadChecksConfig(), enabledProjects: [...projects] });
}

export function loadEnabledModelRefs(): string[] {
  try {
    if (!existsSync(SETTINGS_PATH)) return [];
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as { enabledModels?: string[] };
    return settings.enabledModels ?? [];
  } catch {
    return [];
  }
}

export function splitProviderModel(ref: string): { provider: string; modelId: string } | null {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

function getAgentSettings(): { shellPath?: string } {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as { shellPath?: string };
    }
  } catch {
    // ignore
  }
  return {};
}

export function getShellExecutable(): string {
  const fromSettings = getAgentSettings().shellPath;
  if (fromSettings) return fromSettings;
  return process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
}
