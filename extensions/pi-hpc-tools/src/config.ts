/** hpc-config.json load/save + per-project enable state + shell/plink resolution. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_DIR, CONFIG_PATHS, DEFAULT_PLINK } from "./constants.js";
import { getCurrentConfig, setCurrentConfig } from "./state.js";
import type { HPCConfig } from "./types.js";

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function isProjectEnabled(config: HPCConfig, cwd: string): boolean {
  return (config.enabledProjects ?? []).includes(cwd);
}

export function setProjectEnabled(cwd: string, enabled: boolean): void {
  const config = getHPCConfig();
  if (!config) return;
  const projects = new Set(config.enabledProjects ?? []);
  if (enabled) {
    projects.add(cwd);
  } else {
    projects.delete(cwd);
  }
  saveConfig({ ...config, enabledProjects: [...projects] });
}

export function loadConfig(): HPCConfig | null {
  const username = process.env.HPC_USERNAME || process.env.HPC_USER;
  const host = process.env.HPC_HOST;
  const password = process.env.HPC_PASSWORD;
  if (username && host && password) {
    return { username, host, password };
  }

  for (const configPath of CONFIG_PATHS) {
    try {
      if (!existsSync(configPath)) continue;
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as HPCConfig;
      if (config.username && config.host && config.password) {
        return config;
      }
    } catch {
      // try next path
    }
  }
  return null;
}

export function saveConfig(config: HPCConfig): void {
  const configPath = CONFIG_PATHS[0];
  ensureDir(configPath);
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  setCurrentConfig(config);
}

export function getHPCConfig(): HPCConfig | null {
  if (!getCurrentConfig()) {
    setCurrentConfig(loadConfig());
  }
  return getCurrentConfig();
}

/** Forward-slash path for Git Bash (C:/Users/...). */
export function toSlashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function getAgentSettings(): { shellPath?: string } {
  try {
    const settingsPath = join(AGENT_DIR, "settings.json");
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, "utf-8")) as { shellPath?: string };
    }
  } catch {
    // ignore
  }
  return {};
}

/** Shell from settings.json shellPath — must match user bash (Git Bash on Windows). */
export function getShellExecutable(): string {
  const fromSettings = getAgentSettings().shellPath;
  if (fromSettings) return fromSettings;
  return process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
}

export function getPlinkCommand(): string {
  if (process.env.PLINK_PATH) return toSlashPath(process.env.PLINK_PATH);
  const cfg = getHPCConfig();
  if (cfg?.plinkPath) return toSlashPath(cfg.plinkPath);
  if (existsSync(DEFAULT_PLINK)) return DEFAULT_PLINK;
  return "plink";
}

export const HPC_CONFIG_USAGE = "Usage: /hpc:config username@host password (password may contain spaces)";

export type ParsedHpcConfigArgs =
  | { ok: true; username: string; host: string; password: string }
  | { ok: false; reason: "empty" | "invalid" };

/** Parse `/hpc:config` args. Primary form: `username@host password…` */
export function parseHpcConfigArgs(args: string): ParsedHpcConfigArgs {
  const trimmed = args.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const parts = trimmed.split(/\s+/);
  const userHost = parts[0];
  const at = userHost.indexOf("@");

  if (at > 0 && at < userHost.length - 1) {
    if (parts.length < 2) return { ok: false, reason: "invalid" };
    return {
      ok: true,
      username: userHost.slice(0, at),
      host: userHost.slice(at + 1),
      password: parts.slice(1).join(" "),
    };
  }

  if (parts.length >= 3) {
    return {
      ok: true,
      username: parts[0],
      host: parts[1],
      password: parts.slice(2).join(" "),
    };
  }

  return { ok: false, reason: "invalid" };
}
