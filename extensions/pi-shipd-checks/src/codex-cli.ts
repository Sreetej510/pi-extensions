/** Read-only local Codex CLI sessions, shared by the auditor tool and the `--solve` fairness reviewer. */

import { type ChildProcess, spawn } from "node:child_process";
import type { CodexReasoningEffort, TokenUsage } from "./types.js";

export interface CodexRunConfig {
  /** Codex CLI model ID, passed as `--model`. */
  modelId: string;
  /** Passed through as `-c model_reasoning_effort=<level>`. */
  thinkingLevel: CodexReasoningEffort;
  timeoutMinutes: number;
}

export interface CodexRunResult {
  status: "ok" | "timedOut" | "cancelled" | "error";
  text: string;
  stdout: string;
  tokenUsage?: TokenUsage;
  error?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: CLI event records are untyped JSON
type Json = any;

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

/** Sums the `turn.completed` usage records of a `codex exec --json` event stream. */
export function codexTokenUsage(records: Json[]): TokenUsage | undefined {
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const turns = records.filter((record) => record?.type === "turn.completed" && record.usage);
  if (!turns.length) return undefined;
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoning = 0;
  for (const turn of turns) {
    input += num(turn.usage.input_tokens);
    cached += num(turn.usage.cached_input_tokens);
    output += num(turn.usage.output_tokens);
    reasoning += num(turn.usage.reasoning_output_tokens);
  }
  // Codex reports input_tokens including the cached part, and output_tokens including reasoning.
  return {
    inputTokens: Math.max(0, input - cached),
    cacheReadInputTokens: cached,
    outputTokens: output,
    thinkingTokens: reasoning,
    totalInputTokens: input,
    totalTokens: input + output - Math.min(reasoning, output),
    rawTotalTokens: input + output,
    modelCalls: turns.length,
  };
}

/**
 * Per-request context metrics from a Codex session rollout (`$CODEX_HOME/sessions/**.jsonl`), like the per-iteration
 * usage Claude Code reported: each model request emits a `token_count` event whose `last_token_usage.input_tokens`
 * (cached tokens included) is that request's context size, alongside `model_context_window`.
 */
export function codexRolloutContextUsage(rollout: string): Partial<TokenUsage> | undefined {
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const contexts: number[] = [];
  let contextWindow: number | undefined;
  let lastTotal = -1;
  for (const record of parseCodexEvents(rollout)) {
    const info = record.payload?.type === "token_count" ? record.payload.info : undefined;
    if (!info || typeof info !== "object") continue;
    // token_count is re-emitted (e.g. for rate-limit updates) without a new request; count a request only when the
    // running total grows.
    const total = num(info.total_token_usage?.total_tokens);
    const context = num(info.last_token_usage?.input_tokens);
    if (total === undefined || context === undefined || total <= lastTotal) continue;
    lastTotal = total;
    contexts.push(context);
    contextWindow = num(info.model_context_window) ?? contextWindow;
  }
  const finalContextTokens = contexts.at(-1);
  if (finalContextTokens === undefined) return undefined;
  return {
    finalContextTokens,
    peakContextTokens: Math.max(...contexts),
    ...(contextWindow !== undefined
      ? {
          contextWindow,
          contextWindowUtilizationPercent: Number(((finalContextTokens / contextWindow) * 100).toFixed(2)),
        }
      : {}),
    modelCalls: contexts.length,
  };
}

export function parseCodexEvents(stdout: string): Json[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as Json;
      } catch {
        return undefined;
      }
    })
    .filter((record) => record && typeof record === "object" && !Array.isArray(record));
}

/** The agent's final message: the last completed `agent_message` item. */
export function codexFinalText(records: Json[]): string {
  const message = [...records]
    .reverse()
    .find((record) => record.type === "item.completed" && record.item?.type === "agent_message");
  return typeof message?.item?.text === "string" ? message.item.text : "";
}

/** The first fatal error reported in the stream (`turn.failed` or a top-level `error` event). */
export function codexStreamError(records: Json[]): string | undefined {
  for (const record of records) {
    if (record.type === "turn.failed") return String(record.error?.message ?? "Codex turn failed.");
    if (record.type === "error" && typeof record.message === "string") return record.message;
  }
  return undefined;
}

/** One read-only `codex exec` session; the prompt goes through stdin, the answer is the final agent message. */
export function runCodex(opts: {
  cwd: string;
  prompt: string;
  config: CodexRunConfig;
  signal: AbortSignal;
}): Promise<CodexRunResult> {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--model",
    opts.config.modelId,
    "-c",
    `model_reasoning_effort=${opts.config.thinkingLevel}`,
    "--sandbox",
    "read-only",
    // Offline review, like the former Read/Grep/Glob-only Claude reviewers.
    "-c",
    "web_search=disabled",
    "--skip-git-repo-check",
    "--ephemeral",
  ];
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
    const child = spawn(windows ? `codex ${args.join(" ")}` : "codex", windows ? [] : args, {
      cwd: opts.cwd,
      env: process.env,
      shell: windows,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result: CodexRunResult) => {
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
      const records = parseCodexEvents(stdout);
      const text = codexFinalText(records);
      const tokenUsage = codexTokenUsage(records);
      const streamError = codexStreamError(records);
      const completed = records.some((record) => record.type === "turn.completed");
      if (code !== 0 || streamError || !completed) {
        finish({
          status: "error",
          text,
          stdout,
          ...(tokenUsage ? { tokenUsage } : {}),
          error: (streamError || stderr.trim() || text || `codex exited with code ${code}`).slice(0, 2000),
        });
        return;
      }
      finish({ status: "ok", text, stdout, ...(tokenUsage ? { tokenUsage } : {}) });
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
