/**
 * HPC Tools Extension for pi
 *
 * Remote file exploration via plink:
 *   plink -batch -pw "password" username@host "command"
 *
 * Commands: /hpc:on, /hpc:off, /hpc:config
 * Tools (active only after /hpc:on in this project): ls_hpc, read_file_hpc, grep_hpc
 * On/off state is stored in hpc-config.json as enabledProjects: ["/path/to/project", ...]
 *
 * File layout:
 *   index.ts        extension entry point (this file) — commands + lifecycle events
 *   constants.ts    tool names, timeouts, config file paths
 *   types.ts        shared TypeScript types
 *   state.ts        shared mutable module state (enabled flag, config cache, sync flags)
 *   config.ts       hpc-config.json load/save, per-project enable state, shell/plink resolution
 *   exec.ts         plink invocation + shell quoting helpers
 *   grep-options.ts grep_hpc option-string building heuristics
 *   render.ts       tool call/result rendering
 *   tool-sync.ts    keeps HPC tools' active/inactive state in sync with /hpc:on|off
 *   tools.ts        registers ls_hpc / read_file_hpc / grep_hpc
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHPCConfig, loadConfig, saveConfig } from "./config.js";
import { getHpcEnabled, getPendingToolSync, setCurrentConfig } from "./state.js";
import { isHpcSyncNeeded, onProjectContext, scheduleDelayedHpcSync, setHpcEnabled, syncHpcTools } from "./tool-sync.js";

export default function hpcToolsExtension(pi: ExtensionAPI) {
  setCurrentConfig(loadConfig());

  pi.registerCommand("hpc:on", {
    description: "Enable HPC tools for this project folder",
    handler: async (_args, ctx) => {
      const config = getHPCConfig();
      if (!config) {
        ctx.ui.notify("HPC not configured. Use /hpc:config username@host password", "error");
        return;
      }
      setHpcEnabled(pi, ctx.cwd, true);
      ctx.ui.notify(`HPC tools ON in this project (${config.username}@${config.host})`, "info");
      ctx.ui.setStatus("hpc", `HPC: ON`);
    },
  });

  pi.registerCommand("hpc:off", {
    description: "Disable HPC tools for this project folder (other tools unchanged)",
    handler: async (_args, ctx) => {
      setHpcEnabled(pi, ctx.cwd, false);
      ctx.ui.notify("HPC tools OFF in this project", "info");
      ctx.ui.setStatus("hpc", `HPC: OFF`);
    },
  });

  pi.registerCommand("hpc:config", {
    description: "Set HPC credentials: /hpc:config username@host password",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /hpc:config username@host password", "info");
        ctx.ui.notify("   or: /hpc:config username host password", "info");
        return;
      }

      const parts = args.trim().split(/\s+/);
      let username: string;
      let host: string;
      let password: string;

      if (parts.length === 2) {
        const at = parts[0].indexOf("@");
        if (at === -1) {
          ctx.ui.notify("Use username@host password", "error");
          return;
        }
        username = parts[0].slice(0, at);
        host = parts[0].slice(at + 1);
        password = parts[1];
      } else if (parts.length >= 3) {
        username = parts[0];
        host = parts[1];
        password = parts.slice(2).join(" ");
      } else {
        ctx.ui.notify("Usage: /hpc:config username@host password", "error");
        return;
      }

      saveConfig({ username, host, password });
      ctx.ui.notify(`HPC configured: ${username}@${host}`, "info");
      ctx.ui.setStatus("hpc", `HPC: ${getHpcEnabled() ? "ON" : "OFF"}`);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    // New, resume, reload, fork — re-apply per-project hpc-state.json
    onProjectContext(pi, ctx.cwd);
    if (event.reason === "resume" || event.reason === "reload" || event.reason === "startup") {
      scheduleDelayedHpcSync(pi);
    }

    const config = getHPCConfig();
    if (config) {
      ctx.ui.setStatus("hpc", `HPC: ${getHpcEnabled() ? "ON" : "OFF"}`);
    } else if (getHpcEnabled()) {
      ctx.ui.setStatus("hpc", `HPC: ON (not configured)`);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    // Navigating branches in an existing session — active tools may be restored from history
    onProjectContext(pi, ctx.cwd);
  });

  pi.on("before_agent_start", async () => {
    if (!getPendingToolSync() && !isHpcSyncNeeded(pi)) return;
    syncHpcTools(pi);
  });
}
