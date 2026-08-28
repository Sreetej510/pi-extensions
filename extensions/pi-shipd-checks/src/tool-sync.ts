/** Keeps the gap-finder and solution-precheck tools active only when enabled for the project. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GAP_FINDER_TOOL_NAME, registerAnalysisTools, SOLUTION_PRECHECK_TOOL_NAME } from "./analyze.js";
import { isAnalyzeProjectEnabled, setAnalyzeProjectEnabled } from "./config.js";
import { QUALITY_CHECK_TOOL_NAME } from "./submit.js";

const ANALYSIS_TOOL_NAMES = [GAP_FINDER_TOOL_NAME, SOLUTION_PRECHECK_TOOL_NAME] as const;
const LEGACY_TOOL_NAMES = ["analyze_task_tests", "analyze_test_gaps", "submit_shipd"] as const;

let analyzeEnabled = false;
let toolsRegistered = false;
/** Sync the tools after pi has populated/restored its built-in active tools. */
let pendingToolSync = false;

/** pi.getActiveTools() normally returns strings; accept names too for compatibility. */
function getActiveToolNames(pi: ExtensionAPI): string[] {
  const active = pi.getActiveTools() as Array<string | { name: string }>;
  return active.map((tool) => (typeof tool === "string" ? tool : tool.name));
}

function wantAnalyzeEnabled(): boolean {
  return analyzeEnabled;
}

export function isAnalyzeSyncNeeded(pi: ExtensionAPI): boolean {
  const active = getActiveToolNames(pi);
  const hasLegacy = LEGACY_TOOL_NAMES.some((name) => active.includes(name));
  const hasAllCurrent = ANALYSIS_TOOL_NAMES.every((name) => active.includes(name));
  const hasAnyCurrent = ANALYSIS_TOOL_NAMES.some((name) => active.includes(name));
  return hasLegacy || (wantAnalyzeEnabled() ? !hasAllCurrent : hasAnyCurrent);
}

function ensureAnalysisToolsRegistered(pi: ExtensionAPI): void {
  if (toolsRegistered) return;
  registerAnalysisTools(pi);
  toolsRegistered = true;
}

/** Toggle both read-only analysis tools on the current active set. */
function applyAnalysisToolVisibility(pi: ExtensionAPI, enabled: boolean): void {
  const current = getActiveToolNames(pi);

  if (enabled && current.length === 0) {
    pendingToolSync = true;
    return;
  }

  const hadLegacyQualityTool = current.includes("submit_shipd");
  const withoutLegacy = current.filter((name) => !LEGACY_TOOL_NAMES.includes(name as never));
  const withoutAnalysis = withoutLegacy.filter((name) => !ANALYSIS_TOOL_NAMES.includes(name as never));
  const next = enabled ? [...withoutAnalysis, ...ANALYSIS_TOOL_NAMES] : [...withoutAnalysis];
  if (hadLegacyQualityTool && !next.includes(QUALITY_CHECK_TOOL_NAME)) next.push(QUALITY_CHECK_TOOL_NAME);
  const changed = next.length !== current.length || next.some((name, index) => name !== current[index]);
  if (changed) pi.setActiveTools(next);

  pendingToolSync = isAnalyzeSyncNeeded(pi);
}

/** Apply the in-memory enabled state to pi's active tool list. */
export function syncAnalyzeTool(pi: ExtensionAPI): void {
  const want = wantAnalyzeEnabled();
  if (want) ensureAnalysisToolsRegistered(pi);
  applyAnalysisToolVisibility(pi, want);
}

/** Load the persisted per-project setting for the current session and synchronize immediately. */
export function onAnalyzeProjectContext(pi: ExtensionAPI, cwd: string): void {
  analyzeEnabled = isAnalyzeProjectEnabled(cwd);
  pendingToolSync = true;
  scheduleAnalyzeSync(pi);
}

/** Retry until pi has populated its active tool list. */
export function scheduleAnalyzeSync(pi: ExtensionAPI, attempt = 0): void {
  const want = wantAnalyzeEnabled();
  const active = getActiveToolNames(pi);

  if (want && active.length === 0 && attempt < 8) {
    queueMicrotask(() => scheduleAnalyzeSync(pi, attempt + 1));
    return;
  }

  syncAnalyzeTool(pi);
}

/** Resume/reload restores active tools from the session file after session_start. */
export function scheduleDelayedAnalyzeSync(pi: ExtensionAPI): void {
  for (const delayMs of [0, 50, 150, 400]) {
    setTimeout(() => {
      if (pendingToolSync || isAnalyzeSyncNeeded(pi)) syncAnalyzeTool(pi);
    }, delayMs);
  }
}

/** Whether a previous sync was deferred while pi was restoring its active tools. */
export function isAnalyzeSyncPending(): boolean {
  return pendingToolSync;
}

/** Persist and apply the per-project setting, just like HPC tools. */
export function setAnalyzeEnabled(pi: ExtensionAPI, cwd: string, enabled: boolean): void {
  analyzeEnabled = enabled;
  setAnalyzeProjectEnabled(cwd, enabled);
  pendingToolSync = true;
  syncAnalyzeTool(pi);
}

/** Called after the settings menu changes the current project's enable flag. */
export function analyzeToolSettingChanged(pi: ExtensionAPI, cwd: string): void {
  analyzeEnabled = isAnalyzeProjectEnabled(cwd);
  pendingToolSync = true;
  syncAnalyzeTool(pi);
}
