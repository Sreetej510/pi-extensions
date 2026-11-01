/** Read-only local Claude Code CLI sessions, shared by the auditor tool and the `--solve` fairness reviewer. */

import { type ChildProcess, spawn } from "node:child_process";
import type { ClaudeThinkingLevel, TokenUsage } from "./types.js";

const READ_ONLY_TOOLS = "Read,Grep,Glob";

export interface ClaudeRunConfig {
  /** Claude Code CLI model alias or model ID. */
  modelId: string;
  /** Passed through as `--effort`. */
  thinkingLevel: ClaudeThinkingLevel;
  timeoutMinutes: number;
}

export interface ClaudeRunResult {
  status: "ok" | "timedOut" | "cancelled" | "error";
  text: string;
  stdout: string;
  tokenUsage?: TokenUsage;
  error?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: CLI stream records are untyped JSON
type Json = any;

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function claudeTokenUsage(result: Json): TokenUsage | undefined {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const inputTokens = num(usage.input_tokens);
  const cacheReadInputTokens = num(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const totalInputTokens = (inputTokens ?? 0) + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const costUsd = num(result.total_cost_usd);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalInputTokens,
    totalTokens: totalInputTokens + (outputTokens ?? 0),
    ...(num(result.num_turns) !== undefined ? { modelCalls: num(result.num_turns) } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** One read-only `claude --print` session; the prompt goes through stdin, the answer is the final result record. */
export function runClaude(opts: {
  cwd: string;
  prompt: string;
  config: ClaudeRunConfig;
  signal: AbortSignal;
}): Promise<ClaudeRunResult> {
  const args = [
    "--print",
    "--model",
    opts.config.modelId,
    "--effort",
    opts.config.thinkingLevel,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--allowedTools",
    READ_ONLY_TOOLS,
    "--tools",
    READ_ONLY_TOOLS,
  ];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return new Promise((resolve) => {
    if (opts.signal.aborted) {
      resolve({ status: "cancelled", text: "", stdout: "" });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    // The npm shim is a .cmd on Windows, which Node only launches through a shell; the arguments contain no spaces,
    // so they are joined into the command line rather than passed as shell args (deprecated, DEP0190).
    const windows = process.platform === "win32";
    const child = spawn(windows ? `claude ${args.join(" ")}` : "claude", windows ? [] : args, {
      cwd: opts.cwd,
      env,
      shell: windows,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      killTree(child);
      finish({ status: "cancelled", text: "", stdout });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({
        status: "timedOut",
        text: "",
        stdout,
        error: `Reviewer timed out after ${opts.config.timeoutMinutes} min.`,
      });
    }, opts.config.timeoutMinutes * 60_000);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ status: "error", text: "", stdout, error: error.message }));
    child.on("close", (code) => {
      const records = stdout
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line) as Json;
          } catch {
            return undefined;
          }
        })
        .filter((record) => record && typeof record === "object");
      const result = [...records].reverse().find((record: Json) => record.type === "result");
      const text = typeof result?.result === "string" ? result.result : "";
      if (code !== 0 || !result || result.is_error) {
        finish({
          status: "error",
          text,
          stdout,
          tokenUsage: claudeTokenUsage(result),
          error: (stderr.trim() || text || `claude exited with code ${code}`).slice(0, 2000),
        });
        return;
      }
      finish({ status: "ok", text, stdout, tokenUsage: claudeTokenUsage(result) });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.prompt, "utf-8");
  });
}

/** The reviewer's final ```json block (the last one), else the outermost JSON value in the text. */
export function extractJsonAnswer(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  for (const block of fenced.reverse()) {
    try {
      return JSON.parse(block ?? "");
    } catch {
      // try the next block
    }
  }
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
