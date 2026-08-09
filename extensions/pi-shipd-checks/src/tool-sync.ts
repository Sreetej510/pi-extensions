/** Keeps the `analyze_task_tests` tool's active/inactive state in sync with /checks config. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANALYZE_TOOL_NAME, registerAnalyzeGapsTool } from "./analyze.js";
import { isAnalyzeProjectEnabled, setAnalyzeProjectEnabled } from "./config.js";

const LEGACY_ANALYZE_TOOL_NAME = "analyze_test_gaps";

let analyzeEnabled = false;
let toolsRegistered = false;
/** Sync the tool after pi has populated/restored its built-in active tools. */
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
  return active.includes(LEGACY_ANALYZE_TOOL_NAME) || wantAnalyzeEnabled() !== active.includes(ANALYZE_TOOL_NAME);
}

function ensureAnalyzeToolRegistered(pi: ExtensionAPI): void {
  if (toolsRegistered) return;
  registerAnalyzeGapsTool(pi);
  toolsRegistered = true;
}

/**
 * Toggle only analyze_task_tests on the current active set.
 * ON adds it to the existing tools; OFF removes it without changing anything else.
 */
function applyAnalyzeToolVisibility(pi: ExtensionAPI, enabled: boolean): void {
  const current = getActiveToolNames(pi);

  if (enabled && current.length === 0) {
    pendingToolSync = true;
    return;
  }

  const withoutLegacy = current.filter((name) => name !== LEGACY_ANALYZE_TOOL_NAME);
  const next = enabled
    ? [...new Set([...withoutLegacy, ANALYZE_TOOL_NAME])]
    : withoutLegacy.filter((name) => name !== ANALYZE_TOOL_NAME);
  const changed = next.length !== current.length || next.some((name, index) => name !== current[index]);
  if (changed) pi.setActiveTools(next);

  pendingToolSync = isAnalyzeSyncNeeded(pi);
}

/** Apply the in-memory enabled state to pi's active tool list. */
export function syncAnalyzeTool(pi: ExtensionAPI): void {
  const want = wantAnalyzeEnabled();
  if (want) ensureAnalyzeToolRegistered(pi);
  applyAnalyzeToolVisibility(pi, want);
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
      if (pendingToolSync || isAnalyzeSyncNeeded(pi)) {
        syncAnalyzeTool(pi);
      }
    }, delayMs);
  }
}

/** Whether a previous sync was deferred while pi was restoring its active tools. */
export function isAnalyzeSyncPending(): boolean {
  return pendingToolSync;
}

/** Persist and apply the per-project setting, just like /hpc:on and /hpc:off. */
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
