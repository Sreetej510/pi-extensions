/**
 * Global config (~/.pi/agent/checks-config.json) for local analysis-agent models,
 * Claude CLI benchmark settings, and Fargate resources, plus helpers for reading
 * pi's own settings.json (enabled models, shell path) used by unrelated tools.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AnalyzeGapConfig,
  ChecksConfig,
  ClaudeThinkingLevel,
  FargateConfig,
  FargateResourceProfile,
  FargateResourceUsage,
  PromptHumanizerConfig,
  SolverGapConfig,
  ThinkingLevel,
} from "./types.js";

export const CONFIG_PATH = join(getAgentDir(), "checks-config.json");
export const SETTINGS_PATH = join(getAgentDir(), "settings.json");
export const SOLVER_GAP_TIMEOUT_MIN_MINUTES = 10;
export const SOLVER_GAP_TIMEOUT_MAX_MINUTES = 60;
export const SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES = 20;

export const SOLVER_GAP_SOLVER_COUNT_MIN = 1;
export const SOLVER_GAP_SOLVER_COUNT_MAX = 5;
export const SOLVER_GAP_DEFAULT_SOLVER_COUNT = 3;

export const ANALYZE_GAP_DEFAULT_ENABLED = false;
export const ANALYZE_TIMEOUT_MIN_MINUTES = 10;
export const ANALYZE_TIMEOUT_MAX_MINUTES = 30;
export const ANALYZE_DEFAULT_TIMEOUT_MINUTES = 15;
export const HUMANIZER_MIN_CANDIDATE_COUNT = 1;
export const HUMANIZER_MAX_CANDIDATE_COUNT = 10;
export const HUMANIZER_DEFAULT_CANDIDATE_COUNT = 3;
export const HUMANIZER_DEFAULT_TOP_COUNT = 2;

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

export function loadChecksConfig(): ChecksConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ChecksConfig;
    if (parsed.provider && parsed.modelId && parsed.thinkingLevel) return parsed;
  } catch {
    // fall through
  }
  return null;
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
  if (config) {
    saveChecksConfig(recordFargateResourceUsage(config, cwd, usage));
    return;
  }

  // Quality checks can be used without configuring a reviewer model. Preserve
  // that supported setup instead of dropping the Fargate-only configuration.
  const raw = readRawChecksConfig();
  const rawFargate = raw.fargate;
  if (!rawFargate || typeof rawFargate !== "object" || Array.isArray(rawFargate)) return;
  const next = recordFargateResourceUsage(
    {
      provider: "patch-precheck",
      modelId: "patch-precheck",
      thinkingLevel: "off",
      fargate: rawFargate as FargateConfig,
    },
    cwd,
    usage,
  );
  if (next.fargate?.adaptiveResourceProfile !== true) return;
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, fargate: next.fargate }, null, 2), "utf-8");
}

/** Solver settings are independent of Pi model configuration because solvers now use Claude CLI. */
export function loadSolverGapConfig(): SolverGapConfig {
  const raw = readRawChecksConfig().solverGap;
  const solverGap = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<SolverGapConfig>) : {};
  const timeoutMinutes = Number.isFinite(solverGap.timeoutMinutes)
    ? Math.min(
        SOLVER_GAP_TIMEOUT_MAX_MINUTES,
        Math.max(SOLVER_GAP_TIMEOUT_MIN_MINUTES, solverGap.timeoutMinutes as number),
      )
    : SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES;
  const solverCount = Number.isInteger(solverGap.solverCount)
    ? Math.min(SOLVER_GAP_SOLVER_COUNT_MAX, Math.max(SOLVER_GAP_SOLVER_COUNT_MIN, solverGap.solverCount as number))
    : SOLVER_GAP_DEFAULT_SOLVER_COUNT;
  const thinkingLevels: ClaudeThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
  const claudeOAuthTokenFile =
    typeof solverGap.claudeOAuthTokenFile === "string" && solverGap.claudeOAuthTokenFile.trim()
      ? solverGap.claudeOAuthTokenFile.trim()
      : undefined;
  return {
    modelId: ["haiku", "sonnet", "opus"].includes(solverGap.modelId ?? "") ? (solverGap.modelId as string) : "sonnet",
    thinkingLevel:
      solverGap.thinkingLevel && thinkingLevels.includes(solverGap.thinkingLevel) ? solverGap.thinkingLevel : "low",
    timeoutMinutes,
    solverCount,
    ...(claudeOAuthTokenFile ? { claudeOAuthTokenFile } : {}),
  };
}

/** Save solver-only settings even when no Pi reviewer model is configured. */
export function saveSolverGapConfig(solverGap: SolverGapConfig): void {
  const raw = readRawChecksConfig();
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, solverGap }, null, 2), "utf-8");
}

/** Candidate counts for the humanizer can be configured even when reviewer models are unset. */
export function loadPromptHumanizerConfig(): {
  candidateCount: number;
  topCount: number;
  coreweaveApiKeyFile?: string;
} {
  const raw = readRawChecksConfig().promptHumanizer;
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PromptHumanizerConfig) : {};
  const isHumanizerCount = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HUMANIZER_MIN_CANDIDATE_COUNT &&
    value <= HUMANIZER_MAX_CANDIDATE_COUNT;
  const candidateCount = isHumanizerCount(config.candidateCount)
    ? config.candidateCount
    : HUMANIZER_DEFAULT_CANDIDATE_COUNT;
  const configuredTopCount = isHumanizerCount(config.topCount) ? config.topCount : HUMANIZER_DEFAULT_TOP_COUNT;
  const coreweaveApiKeyFile =
    typeof config.coreweaveApiKeyFile === "string" && config.coreweaveApiKeyFile.trim()
      ? config.coreweaveApiKeyFile.trim()
      : undefined;
  return {
    candidateCount,
    topCount: Math.min(configuredTopCount, candidateCount),
    coreweaveApiKeyFile,
  };
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

export function isAnalyzeProjectEnabled(cwd: string): boolean {
  const raw = readRawChecksConfig();
  if (Array.isArray(raw.enabledProjects)) {
    return raw.enabledProjects.some((project) => project === cwd);
  }
  // Backward compatibility for the old global setting until /analyze:on|off is used.
  return loadChecksConfig()?.enableAnalyzeTool ?? ANALYZE_GAP_DEFAULT_ENABLED;
}

export function setAnalyzeProjectEnabled(cwd: string, enabled: boolean): void {
  const projects = new Set(loadAnalyzeEnabledProjects());
  if (enabled) projects.add(cwd);
  else projects.delete(cwd);
  const nextProjects = [...projects];
  const current = loadChecksConfig();
  if (current) {
    saveChecksConfig({ ...current, enabledProjects: nextProjects });
    return;
  }

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...readRawChecksConfig(), enabledProjects: nextProjects }, null, 2),
    "utf-8",
  );
}

/** Whether the agent-callable analysis tools are enabled for a project. */
export function isAnalyzeToolEnabled(cwd?: string): boolean {
  if (cwd !== undefined) return isAnalyzeProjectEnabled(cwd);
  return loadChecksConfig()?.enableAnalyzeTool ?? ANALYZE_GAP_DEFAULT_ENABLED;
}

/** The shared model settings for the agent-callable gap-finder and solution-precheck tools. */
export function loadAnalyzeGapConfig(): AnalyzeGapConfig | null {
  const analyzeGap = loadChecksConfig()?.analyzeGap;
  if (!analyzeGap?.provider || !analyzeGap.modelId || !analyzeGap.thinkingLevel) return null;
  const timeoutMinutes = Number.isFinite(analyzeGap.timeoutMinutes)
    ? Math.min(ANALYZE_TIMEOUT_MAX_MINUTES, Math.max(ANALYZE_TIMEOUT_MIN_MINUTES, analyzeGap.timeoutMinutes))
    : ANALYZE_DEFAULT_TIMEOUT_MINUTES;
  return { ...analyzeGap, timeoutMinutes };
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
