/**
 * Global config (~/.pi/agent/checks-config.json) for the reviewer model +
 * thinking level, plus the nested solver-gap-finder settings, plus helpers for
 * reading pi's own settings.json (enabled models, shell path) that the
 * config flow and git snapshot step need.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ChecksConfig, SolverGapConfig, ThinkingLevel } from "./types.js";

export const CONFIG_PATH = join(getAgentDir(), "checks-config.json");
export const SETTINGS_PATH = join(getAgentDir(), "settings.json");

export const SOLVER_GAP_TIMEOUT_MIN_MINUTES = 10;
export const SOLVER_GAP_TIMEOUT_MAX_MINUTES = 60;
export const SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES = 20;

export const SOLVER_GAP_SOLVER_COUNT_MIN = 1;
export const SOLVER_GAP_SOLVER_COUNT_MAX = 5;
export const SOLVER_GAP_DEFAULT_SOLVER_COUNT = 3;

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

/** The nested `solverGap` section, normalized with sane defaults if partially missing/invalid. */
export function loadSolverGapConfig(): SolverGapConfig | null {
  const solverGap = loadChecksConfig()?.solverGap;
  if (!solverGap?.provider || !solverGap.modelId || !solverGap.thinkingLevel) return null;
  return {
    ...solverGap,
    timeoutMinutes: solverGap.timeoutMinutes > 0 ? solverGap.timeoutMinutes : SOLVER_GAP_DEFAULT_TIMEOUT_MINUTES,
    solverCount: solverGap.solverCount > 0 ? solverGap.solverCount : SOLVER_GAP_DEFAULT_SOLVER_COUNT,
  };
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
