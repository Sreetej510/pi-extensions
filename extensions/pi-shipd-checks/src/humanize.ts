/** Agent-callable, read-only humanizer for the current project's agent_prompt.md. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isAnalyzeToolEnabled, loadFargateConfig, loadPromptHumanizerConfig } from "./config.js";
import { runFargateDetectorBatch } from "./fargate-runner.js";
import { formatDuration } from "./report.js";

export const HUMANIZE_AGENT_PROMPT_TOOL_NAME = "humanize-agent-prompt";
const humanizeToolParams = Type.Object({});
const DEFAULT_COREWEAVE_BASE_URL = "https://api.inference.wandb.ai/v1";
const DEFAULT_COREWEAVE_PROJECT = "sreetej510-omega/shipd_humanizer";
const DEFAULT_NEMOTRON_MODEL = "wandb-artifact:///sreetej510-omega/shipd_humanizer/nemotron35_beta_all519_e4:v1";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_COMPLETION_TOKENS = 900;

const HUMANIZER_SYSTEM_PROMPT = `You are rewriting a technical specification in concise, direct language. The source prompt is authoritative; any human-written reference is a style guide only. Fidelity takes priority over style.

Preserve every source requirement and its exact scope, including public API names, methods, arguments, attributes, commands, identifiers, literals, values, defaults, optionality, conditions, negations, exceptions, dependencies, ordering, event flow, outputs, errors, and compatibility behavior. Keep names exactly as specified. Do not split identifiers across formatting boundaries, rename existing APIs, or introduce APIs absent from the source.

Do not omit, weaken, generalize, contradict, or add requirements. Rephrase only when all meanings, constraints, and relationships remain unchanged. If any requirement is ambiguous, contradictory, incomplete, or cannot be verified, return the original source unchanged. Do not claim preservation when uncertain.

Output only the rewritten specification, without commentary.`;

interface DetectorScore {
  input_tokens: number;
  window_count: number;
  document_logit_raw_ai_positive: number;
  oof_scaled_score_approx: number;
  exploratory_triage_label: "AI-like" | "Human-like";
  exploratory_threshold: number;
  threshold_status: string;
  latency_ms: number;
  caveat?: string;
}

interface HumanizedCandidate {
  index: number;
  text: string;
  detector: DetectorScore;
}

type GeneratedCandidate = Omit<HumanizedCandidate, "detector">;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredHttpsUrl(raw: string | undefined, setting: string): URL {
  if (!raw?.trim()) throw new Error(`Configure ${setting} before using ${HUMANIZE_AGENT_PROMPT_TOOL_NAME}.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${setting} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${setting} must use HTTPS.`);
  return url;
}

function parseJson(text: string, service: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${service} returned invalid JSON.`);
  }
}

async function postJson(
  url: URL,
  body: JsonRecord,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  service: string,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${service} request failed (HTTP ${response.status}): ${raw.slice(0, 1_000)}`);
    }
    return parseJson(raw, service);
  } catch (error) {
    if (signal?.aborted) throw new Error("Humanization cancelled.");
    if (timedOut) throw new Error(`${service} request timed out after ${REQUEST_TIMEOUT_MS / 1_000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function readCompletion(response: unknown): { text: string } {
  if (!isRecord(response) || !Array.isArray(response.choices) || !isRecord(response.choices[0])) {
    throw new Error("CoreWeave returned an unexpected chat-completions response.");
  }
  const choice = response.choices[0];
  const message = choice.message;
  if (!isRecord(message) || typeof message.content !== "string" || !message.content.trim()) {
    throw new Error("CoreWeave returned an empty humanizer candidate.");
  }
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown";
  const completionTokens = isRecord(response.usage) ? response.usage.completion_tokens : undefined;
  if (
    finishReason === "length" ||
    (typeof completionTokens === "number" && completionTokens >= MAX_COMPLETION_TOKENS)
  ) {
    throw new Error("CoreWeave may have truncated a humanizer candidate at max_tokens; no candidates were returned.");
  }
  return { text: message.content };
}

function meetsHumanLikeCutoff(candidate: HumanizedCandidate): boolean {
  return (
    candidate.detector.exploratory_triage_label === "Human-like" &&
    candidate.detector.oof_scaled_score_approx < candidate.detector.exploratory_threshold
  );
}

function readDetectorScore(response: unknown): DetectorScore {
  const payload = response;
  if (!isRecord(payload)) throw new Error("Fargate detector returned an unexpected score.");
  const numericFields = [
    "input_tokens",
    "window_count",
    "document_logit_raw_ai_positive",
    "oof_scaled_score_approx",
    "exploratory_threshold",
    "latency_ms",
  ] as const;
  for (const field of numericFields) {
    if (typeof payload[field] !== "number" || !Number.isFinite(payload[field])) {
      throw new Error(`Fargate detector score is missing a valid ${field}.`);
    }
  }
  if (
    (payload.exploratory_triage_label !== "AI-like" && payload.exploratory_triage_label !== "Human-like") ||
    typeof payload.threshold_status !== "string"
  ) {
    throw new Error("Fargate detector score is missing its exploratory label or threshold status.");
  }
  return {
    input_tokens: payload.input_tokens as number,
    window_count: payload.window_count as number,
    document_logit_raw_ai_positive: payload.document_logit_raw_ai_positive as number,
    oof_scaled_score_approx: payload.oof_scaled_score_approx as number,
    exploratory_triage_label: payload.exploratory_triage_label,
    exploratory_threshold: payload.exploratory_threshold as number,
    threshold_status: payload.threshold_status,
    latency_ms: payload.latency_ms as number,
    ...(typeof payload.caveat === "string" ? { caveat: payload.caveat } : {}),
  };
}

async function resolveCoreweaveApiKey(config: ReturnType<typeof loadPromptHumanizerConfig>): Promise<string> {
  const environmentKey = process.env.COREWEAVE_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  const keyFile = process.env.COREWEAVE_API_KEY_FILE ?? config.coreweaveApiKeyFile;
  if (!keyFile) {
    throw new Error("Set COREWEAVE_API_KEY or configure a local key file with COREWEAVE_API_KEY_FILE.");
  }
  try {
    const key = (await readFile(keyFile, "utf8")).trim().replace(/^Bearer\s+/i, "");
    if (key) return key;
  } catch {
    throw new Error("Could not read the configured CoreWeave API-key file; check its path and permissions.");
  }
  throw new Error("The configured CoreWeave API-key file is empty.");
}

async function generateCandidate(
  sourcePrompt: string,
  index: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<GeneratedCandidate> {
  const baseUrl = requiredHttpsUrl(process.env.COREWEAVE_BASE_URL ?? DEFAULT_COREWEAVE_BASE_URL, "COREWEAVE_BASE_URL");
  const project = process.env.COREWEAVE_PROJECT ?? DEFAULT_COREWEAVE_PROJECT;
  const model = process.env.NEMOTRON_MODEL ?? DEFAULT_NEMOTRON_MODEL;
  const endpoint = new URL(`${baseUrl.toString().replace(/\/+$/, "")}/chat/completions`);
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (project) headers["OpenAI-Project"] = project;

  const response = await postJson(
    endpoint,
    {
      model,
      messages: [
        { role: "system", content: HUMANIZER_SYSTEM_PROMPT },
        { role: "user", content: sourcePrompt },
      ],
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: MAX_COMPLETION_TOKENS,
      chat_template_kwargs: { enable_thinking: false },
    },
    headers,
    signal,
    "CoreWeave",
  );
  const completion = readCompletion(response);

  return { index, text: completion.text };
}

export function registerHumanizerTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: HUMANIZE_AGENT_PROMPT_TOOL_NAME,
    label: "Humanizing Prompt",
    description:
      "Humanizes agent_prompt.md and returns only drafts meeting the detector's Human-like cutoff. Never change the source automatically. Use a draft unchanged only if it preserves every requirement; otherwise make only the absolute minimum edits needed to restore fidelity. Lower detector scores rank better in exploratory triage, not confidence or correctness.",
    promptSnippet: "Humanize agent_prompt.md and return candidates",
    promptGuidelines: [
      "Call only when the user asks to humanize agent_prompt.md.",
      "NEVER edit agent_prompt.md automatically or replace it wholesale. Use a candidate unchanged only after confirming it preserves every source requirement.",
      "If a candidate is inaccurate, do not broadly rewrite it. Make only the absolute minimum edits required to restore fidelity. If unsure, keep the original unchanged.",
      "Only return drafts labeled Human-like with a score below the detector's reported cutoff; discard all others.",
      "Lower detector scores rank better in exploratory triage, not confidence or correctness.",
    ],
    parameters: humanizeToolParams,
    renderCall(_args, _theme, context) {
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      text.setText("");
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state;
      state.startedAt ??= Date.now();
      if (options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1_000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const elapsedLabel = options.isPartial ? "Elapsed" : "Took";
      const endTime = state.endedAt ?? Date.now();
      const duration = state.startedAt !== undefined ? formatDuration(endTime - state.startedAt) : "—";
      const header =
        theme.fg("toolTitle", theme.bold("Humanizing Prompt")) + theme.fg("muted", `  ${elapsedLabel} ${duration}`);
      const resultText = (result.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trim();
      const output = resultText || (options.isPartial ? "Generating prompt candidates..." : "(no output)");
      const body = output
        .split("\n")
        .map((line) => `  ${context.isError ? theme.fg("error", line) : line}`)
        .join("\n");
      return new Text(`${header}\n${body}`, 0, 0);
    },
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      if (!isAnalyzeToolEnabled(ctx.cwd)) {
        throw new Error(
          `${HUMANIZE_AGENT_PROMPT_TOOL_NAME} is disabled for this project. Enable the Shipd tools with /analyze:on.`,
        );
      }
      const config = loadPromptHumanizerConfig();
      const apiKey = await resolveCoreweaveApiKey(config);
      requiredHttpsUrl(process.env.COREWEAVE_BASE_URL ?? DEFAULT_COREWEAVE_BASE_URL, "COREWEAVE_BASE_URL");
      const promptPath = join(ctx.cwd, "agent_prompt.md");
      let sourcePrompt: string;
      try {
        sourcePrompt = await readFile(promptPath, "utf8");
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          throw new Error("Missing required file in project root: agent_prompt.md");
        }
        throw error;
      }
      if (!sourcePrompt.trim()) throw new Error("agent_prompt.md is empty; no humanizer candidates were generated.");
      if (signal?.aborted) throw new Error("Humanization cancelled.");

      const generated: GeneratedCandidate[] = [];
      for (let index = 1; index <= config.candidateCount; index += 1) {
        onUpdate?.({
          content: [{ type: "text", text: `Generating humanizer draft ${index}/${config.candidateCount}...` }],
          details: {},
        });
        generated.push(await generateCandidate(sourcePrompt, index, apiKey, signal));
      }
      if (signal?.aborted) throw new Error("Humanization cancelled.");
      const scores = await runFargateDetectorBatch({
        texts: generated.map((candidate) => candidate.text),
        fargateConfig: loadFargateConfig(),
        cancelSignal: signal,
        onPhase: (phase) =>
          onUpdate?.({
            content: [{ type: "text", text: `Fargate Spot detector: ${phase} (${generated.length} drafts).` }],
            details: {},
          }),
      });
      const ranked: HumanizedCandidate[] = generated.map((candidate, index) => ({
        ...candidate,
        detector: readDetectorScore(scores[index]),
      }));
      const generatedCandidates = ranked;
      generatedCandidates.sort(
        (left, right) =>
          left.detector.oof_scaled_score_approx - right.detector.oof_scaled_score_approx || left.index - right.index,
      );
      const selected = generatedCandidates
        .filter(meetsHumanLikeCutoff)
        .slice(0, config.topCount)
        .map((candidate, index) => ({
          rank: index + 1,
          text: candidate.text,
          triage_score: Number(candidate.detector.oof_scaled_score_approx.toFixed(4)),
        }));
      const result = { candidates: selected };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
