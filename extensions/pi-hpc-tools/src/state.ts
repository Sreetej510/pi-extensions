/**
 * Shared mutable module state, centralized here so every other file mutates
 * it through explicit getters/setters instead of each holding its own copy.
 */
import type { HPCConfig } from "./types.js";

let hpcEnabled = false;
let currentConfig: HPCConfig | null = null;
let toolsRegistered = false;
/** Sync HPC tool visibility after built-ins are in the active set. */
let pendingToolSync = false;

export function getHpcEnabled(): boolean {
	return hpcEnabled;
}

export function setHpcEnabledFlag(enabled: boolean): void {
	hpcEnabled = enabled;
}

export function getCurrentConfig(): HPCConfig | null {
	return currentConfig;
}

export function setCurrentConfig(config: HPCConfig | null): void {
	currentConfig = config;
}

export function getToolsRegistered(): boolean {
	return toolsRegistered;
}

export function setToolsRegistered(registered: boolean): void {
	toolsRegistered = registered;
}

export function getPendingToolSync(): boolean {
	return pendingToolSync;
}

export function setPendingToolSync(pending: boolean): void {
	pendingToolSync = pending;
}
