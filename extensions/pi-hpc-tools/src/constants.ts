import { homedir } from "node:os";
import { join } from "node:path";

export const HPC_TOOL_NAMES = ["ls_hpc", "read_file_hpc", "grep_hpc"] as const;
export const MAX_READ_LINES = 1000;
export const GREP_TIMEOUT_MS = 120_000;
export const UI_PREVIEW_LINES = 10;

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const CONFIG_PATHS = [join(AGENT_DIR, ".pi", "hpc-config.json"), join(homedir(), ".pi", "hpc-config.json")];

/** Default plink on this machine (Git bash path). Override via PLINK_PATH or hpc-config.json plinkPath. */
export const DEFAULT_PLINK = "C:/Users/sreet/plink/plink.exe";
