import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queryAnthropicUsage } from "./anthropic-query.js";
import { queryViaCodexAppServer } from "./codex-app-server.js";
import { queryCodexUsageWithFallback, queryViaPiAuth } from "./codex-query.js";
import { STATUSLINE_RETRY_ATTEMPTS, STATUSLINE_RETRY_DELAY_MS } from "./constants.js";
import { isRateLimitErrorMessage, isStaleExtensionContextError } from "./errors.js";
import {
  anthropicAuthCandidateModels,
  codexAuthCandidateModels,
  isAnthropicModel,
  isOpenAICodexModel,
} from "./models.js";
import type { QueryUsageOptions, QueryUsageResult, UsageQueryError, UsageReport, UsageSource } from "./types.js";
import { delay, errorMessage } from "./utils.js";

export async function queryAllUsage(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
): Promise<{ reports: UsageReport[]; errors: UsageQueryError[] }> {
  const hasCodex = codexAuthCandidateModels(ctx).length > 0;
  const hasAnthropic = anthropicAuthCandidateModels(ctx).length > 0;

  type ProviderResult = { report?: UsageReport; errors: UsageQueryError[] };
  const empty: ProviderResult = { errors: [] };

  const [codexSettled, anthropicSettled] = await Promise.allSettled([
    hasCodex ? queryCodexUsageWithFallback(ctx, options.timeoutMs) : Promise.resolve<ProviderResult>(empty),
    hasAnthropic
      ? queryAnthropicUsage(ctx, options.timeoutMs).then((report): ProviderResult => ({ report, errors: [] }))
      : Promise.resolve<ProviderResult>(empty),
  ]);

  const reports: UsageReport[] = [];
  const errors: UsageQueryError[] = [];

  const collect = (
    settled: PromiseSettledResult<{ report?: UsageReport; errors: UsageQueryError[] }>,
    source: UsageSource,
  ) => {
    if (settled.status === "rejected") {
      if (isStaleExtensionContextError(settled.reason)) throw settled.reason;
      errors.push({ source, message: errorMessage(settled.reason), cause: settled.reason });
    } else {
      if (settled.value.report) reports.push(settled.value.report);
      errors.push(...settled.value.errors);
    }
  };
  collect(codexSettled, "pi-auth");
  collect(anthropicSettled, "anthropic-oauth");

  return { reports, errors };
}

export async function queryUsageWithRetries(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
): Promise<QueryUsageResult> {
  let lastResult: QueryUsageResult | undefined;
  for (let attempt = 1; attempt <= STATUSLINE_RETRY_ATTEMPTS; attempt += 1) {
    lastResult = await queryUsage(ctx, options);
    if (lastResult.ok) return lastResult;
    // Retrying a 429 seconds later only makes the rate limiting worse.
    if (lastResult.errors.some((error) => isRateLimitErrorMessage(error.message))) {
      return lastResult;
    }
    if (attempt < STATUSLINE_RETRY_ATTEMPTS) {
      await delay(STATUSLINE_RETRY_DELAY_MS);
    }
  }
  return (
    lastResult ?? {
      ok: false,
      errors: [{ source: "pi-auth", message: "Usage query failed." }],
    }
  );
}

export async function queryUsage(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
): Promise<QueryUsageResult> {
  if (isAnthropicModel(ctx.model)) {
    try {
      const report = await queryAnthropicUsage(ctx, options.timeoutMs);
      return { ok: true, report };
    } catch (cause) {
      if (isStaleExtensionContextError(cause)) throw cause;
      return {
        ok: false,
        errors: [{ source: "anthropic-oauth", message: errorMessage(cause), cause }],
      };
    }
  }

  if (!isOpenAICodexModel(ctx.model)) {
    return {
      ok: false,
      errors: [{ source: "pi-auth", message: "Current model provider is not supported." }],
    };
  }

  const errors: UsageQueryError[] = [];

  try {
    const report = await queryViaPiAuth(ctx, options.timeoutMs);
    return { ok: true, report };
  } catch (cause) {
    if (isStaleExtensionContextError(cause)) throw cause;
    errors.push({ source: "pi-auth", message: errorMessage(cause), cause });
  }

  try {
    const report = await queryViaCodexAppServer(options.timeoutMs);
    return { ok: true, report };
  } catch (cause) {
    if (isStaleExtensionContextError(cause)) throw cause;
    errors.push({ source: "codex-app-server", message: errorMessage(cause), cause });
  }

  return { ok: false, errors };
}
