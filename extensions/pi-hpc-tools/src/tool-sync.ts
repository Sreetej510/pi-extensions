/** Keeps the ls_hpc/read_file_hpc/grep_hpc tools' active/inactive state in sync with /hpc:on|off. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHPCConfig, isProjectEnabled, loadConfig, setProjectEnabled } from "./config.js";
import { HPC_TOOL_NAMES } from "./constants.js";
import {
  getHpcEnabled,
  getPendingToolSync,
  getToolsRegistered,
  setCurrentConfig,
  setHpcEnabledFlag,
  setPendingToolSync,
} from "./state.js";
import { registerHPCTools } from "./tools.js";

const HPC_TOOL_SET = new Set<string>(HPC_TOOL_NAMES);

function isHpcToolName(name: string): boolean {
  return HPC_TOOL_SET.has(name);
}

/** pi.getActiveTools() returns tool name strings (not { name } objects). */
function getActiveToolNames(pi: ExtensionAPI): string[] {
  const active = pi.getActiveTools() as Array<string | { name: string }>;
  return active.map((t) => (typeof t === "string" ? t : t.name));
}

function wantHpcEnabled(): boolean {
  return getHpcEnabled() && Boolean(getHPCConfig());
}

function hasHpcInActive(pi: ExtensionAPI): boolean {
  return HPC_TOOL_NAMES.some((n) => getActiveToolNames(pi).includes(n));
}

export function isHpcSyncNeeded(pi: ExtensionAPI): boolean {
  return wantHpcEnabled() !== hasHpcInActive(pi);
}

function ensureHpcToolsRegistered(pi: ExtensionAPI): void {
  if (getToolsRegistered()) return;
  registerHPCTools(pi);
}

/**
 * Toggle only the three HPC tools on the current active set.
 * ON: add HPC tools to whatever is already active (keeps all other tools).
 * OFF: remove HPC tools from whatever is active (keeps all other tools).
 */
function applyHpcToolVisibility(pi: ExtensionAPI, enabled: boolean): void {
  const current = getActiveToolNames(pi);

  if (enabled) {
    if (current.length === 0) {
      setPendingToolSync(true);
      return;
    }
    const next = new Set(current);
    for (const name of HPC_TOOL_NAMES) next.add(name);
    pi.setActiveTools([...next]);
  } else {
    const withoutHpc = current.filter((n) => !isHpcToolName(n));
    if (withoutHpc.length !== current.length) {
      pi.setActiveTools(withoutHpc);
    }
  }

  setPendingToolSync(isHpcSyncNeeded(pi));
}

/** Apply project hpc-state.json to the active tool list (resume / session switch). */
export function syncHpcTools(pi: ExtensionAPI): void {
  const want = wantHpcEnabled();
  if (want) {
    ensureHpcToolsRegistered(pi);
  }
  applyHpcToolVisibility(pi, want);
}

export function scheduleHpcSync(pi: ExtensionAPI, attempt = 0): void {
  const want = wantHpcEnabled();
  const active = getActiveToolNames(pi);

  if (want && active.length === 0 && attempt < 8) {
    queueMicrotask(() => scheduleHpcSync(pi, attempt + 1));
    return;
  }

  syncHpcTools(pi);
}

/** Resume/reload restores active tools from the session file after session_start. */
export function scheduleDelayedHpcSync(pi: ExtensionAPI): void {
  for (const delayMs of [0, 50, 150, 400]) {
    setTimeout(() => {
      if (getPendingToolSync() || isHpcSyncNeeded(pi)) {
        syncHpcTools(pi);
      }
    }, delayMs);
  }
}

export function setHpcEnabled(pi: ExtensionAPI, cwd: string, enabled: boolean): void {
  setHpcEnabledFlag(enabled);
  setProjectEnabled(cwd, enabled);
  syncHpcTools(pi);
}

export function onProjectContext(pi: ExtensionAPI, cwd: string): void {
  const config = loadConfig();
  setCurrentConfig(config);
  setHpcEnabledFlag(config ? isProjectEnabled(config, cwd) : false);
  setPendingToolSync(true);
  scheduleHpcSync(pi);
}
