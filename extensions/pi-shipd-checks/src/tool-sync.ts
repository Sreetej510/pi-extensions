/** Keeps the `analyze_test_gaps` tool's active/inactive state in sync with /checks config. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANALYZE_TOOL_NAME, registerAnalyzeGapsTool } from "./analyze.js";
import { isAnalyzeToolEnabled } from "./config.js";

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

function hasAnalyzeToolInActiveSet(pi: ExtensionAPI): boolean {
  return getActiveToolNames(pi).includes(ANALYZE_TOOL_NAME);
}

export function isAnalyzeSyncNeeded(pi: ExtensionAPI): boolean {
  return wantAnalyzeEnabled() !== hasAnalyzeToolInActiveSet(pi);
}

function ensureAnalyzeToolRegistered(pi: ExtensionAPI): void {
  if (toolsRegistered) return;
  registerAnalyzeGapsTool(pi);
  toolsRegistered = true;
}

/**
 * Toggle only analyze_test_gaps on the current active set.
 * ON adds it to the existing tools; OFF removes it without changing anything else.
 */
function applyAnalyzeToolVisibility(pi: ExtensionAPI, enabled: boolean): void {
  const current = getActiveToolNames(pi);

  if (enabled) {
    if (current.length === 0) {
      pendingToolSync = true;
      return;
    }
    const next = new Set(current);
    next.add(ANALYZE_TOOL_NAME);
    if (next.size !== current.length) {
      pi.setActiveTools([...next]);
    }
  } else {
    const withoutAnalyze = current.filter((name) => name !== ANALYZE_TOOL_NAME);
    if (withoutAnalyze.length !== current.length) {
      pi.setActiveTools(withoutAnalyze);
    }
  }

  pendingToolSync = isAnalyzeSyncNeeded(pi);
}

/** Apply the in-memory enabled state to pi's active tool list. */
export function syncAnalyzeTool(pi: ExtensionAPI): void {
  const want = wantAnalyzeEnabled();
  if (want) ensureAnalyzeToolRegistered(pi);
  applyAnalyzeToolVisibility(pi, want);
}

/** Load the persisted setting for the current session and synchronize immediately. */
export function onAnalyzeProjectContext(pi: ExtensionAPI): void {
  analyzeEnabled = isAnalyzeToolEnabled();
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

/** Called after /checks --config changes the enable flag. */
export function analyzeToolSettingChanged(pi: ExtensionAPI): void {
  analyzeEnabled = isAnalyzeToolEnabled();
  pendingToolSync = true;
  syncAnalyzeTool(pi);
}
