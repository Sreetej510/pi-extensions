import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiAnthropicAuth } from "./anthropic-auth.js";
import { resolvePiCodexAuth } from "./codex-auth.js";
import { ANTHROPIC_OAUTH_USAGE_URL, CODEX_USAGE_URL } from "./constants.js";
import { isStaleExtensionContextError, throwUsageEndpointError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";
import { anthropicAuthCandidateModels, codexAuthCandidateModels } from "./models.js";
import { normalizeAnthropicUsagePayload } from "./normalize-anthropic.js";
import type { AnthropicOAuthUsagePayload, AnthropicUsageReport } from "./types.js";
import { errorMessage, parseJsonObject, prettyJson } from "./utils.js";

export async function queryAnthropicUsage(ctx: ExtensionContext, timeoutMs: number): Promise<AnthropicUsageReport> {
  const auth = await resolvePiAnthropicAuth(ctx);
  if (!auth) {
    throw new Error(
      "No Pi Anthropic subscription auth was available. Use a Pi Anthropic model and run /login for Anthropic.",
    );
  }

  const response = await fetchWithTimeout(
    ANTHROPIC_OAUTH_USAGE_URL,
    { headers: auth.headers },
    timeoutMs,
    "Anthropic usage",
  );
  const text = await response.text();
  if (!response.ok) {
    throwUsageEndpointError("Anthropic", response, text);
  }

  const payload = parseJsonObject(text, "Anthropic usage endpoint response");
  return normalizeAnthropicUsagePayload(payload as AnthropicOAuthUsagePayload, Date.now());
}

/** Fetch and pretty-print the raw usage API responses for debugging (/usage --raw). */
export async function fetchRawUsagePayloads(ctx: ExtensionContext, timeoutMs: number): Promise<string> {
  const sections: string[] = [];

  if (anthropicAuthCandidateModels(ctx).length > 0) {
    try {
      const auth = await resolvePiAnthropicAuth(ctx);
      if (!auth) throw new Error("No Anthropic auth available.");
      const response = await fetchWithTimeout(
        ANTHROPIC_OAUTH_USAGE_URL,
        { headers: auth.headers },
        timeoutMs,
        "Anthropic usage",
      );
      const text = await response.text();
      sections.push(`>_ Anthropic raw (${response.status}):\n${prettyJson(text)}`);
    } catch (error) {
      if (isStaleExtensionContextError(error)) throw error;
      sections.push(`>_ Anthropic raw: error \u2014 ${errorMessage(error)}`);
    }
  }

  if (codexAuthCandidateModels(ctx).length > 0) {
    try {
      const auth = await resolvePiCodexAuth(ctx);
      if (!auth) throw new Error("No Codex auth available.");
      const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers: auth.headers }, timeoutMs, "Codex usage");
      const text = await response.text();
      sections.push(`>_ Codex raw (${response.status}):\n${prettyJson(text)}`);
    } catch (error) {
      if (isStaleExtensionContextError(error)) throw error;
      sections.push(`>_ Codex raw: error \u2014 ${errorMessage(error)}`);
    }
  }

  if (sections.length === 0) return "No providers with usable auth found.";
  return sections.join("\n\n");
}
