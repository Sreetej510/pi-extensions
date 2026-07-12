import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { anthropicAuthCandidateModels } from "./models.js";
import { hasHeader } from "./utils.js";

export async function resolvePiAnthropicAuth(
  ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
  const models = anthropicAuthCandidateModels(ctx);
  const errors: string[] = [];

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }

    const headers = { ...(auth.headers ?? {}) };
    if (!hasHeader(headers, "Authorization") && auth.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    if (!hasHeader(headers, "Accept")) headers.Accept = "application/json";
    if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage";
    if (hasHeader(headers, "Authorization")) {
      return { headers };
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return undefined;
}
