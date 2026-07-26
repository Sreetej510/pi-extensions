import { ANTHROPIC_PROVIDER_ID, CODEX_PROVIDER_ID } from "./constants.js";
import type { PiModel, UsageReport } from "./types.js";

export function isOpenAICodexModel(model: Pick<PiModel, "provider"> | undefined): boolean {
  return model?.provider === CODEX_PROVIDER_ID;
}

export function isAnthropicModel(model: Pick<PiModel, "provider"> | undefined): boolean {
  return model?.provider === ANTHROPIC_PROVIDER_ID;
}

export function isUsageSupportedModel(model: Pick<PiModel, "provider"> | undefined): boolean {
  return isOpenAICodexModel(model) || isAnthropicModel(model);
}

export function reportMatchesModel(report: UsageReport, model: Pick<PiModel, "provider"> | undefined): boolean {
  if (!model) return false;
  return (
    (report.provider === "codex" && isOpenAICodexModel(model)) ||
    (report.provider === "anthropic" && isAnthropicModel(model))
  );
}

export function providerKeyForModel(model: Pick<PiModel, "provider"> | undefined): "codex" | "anthropic" {
  if (isAnthropicModel(model)) return "anthropic";
  return "codex";
}

type AuthCandidateContext = {
  model?: PiModel;
  modelRegistry: {
    getAvailable: () => PiModel[];
  };
};

export function codexAuthCandidateModels(ctx: AuthCandidateContext): PiModel[] {
  return providerAuthCandidateModels(ctx, CODEX_PROVIDER_ID);
}

export function anthropicAuthCandidateModels(ctx: AuthCandidateContext): PiModel[] {
  return providerAuthCandidateModels(ctx, ANTHROPIC_PROVIDER_ID);
}

export function filterReportsForConfiguredProviders(ctx: AuthCandidateContext, reports: UsageReport[]): UsageReport[] {
  const hasCodex = codexAuthCandidateModels(ctx).length > 0;
  const hasAnthropic = anthropicAuthCandidateModels(ctx).length > 0;
  return reports.filter(
    (report) => (report.provider === "codex" && hasCodex) || (report.provider === "anthropic" && hasAnthropic),
  );
}

function providerAuthCandidateModels(ctx: AuthCandidateContext, providerId: string): PiModel[] {
  const available = ctx.modelRegistry.getAvailable();
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== providerId) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  // Prefer the active model, but only when Pi says its auth is configured.
  if (ctx.model) {
    add(available.find((model) => model.provider === ctx.model?.provider && model.id === ctx.model.id));
  }
  for (const model of available) add(model);
  return candidates;
}
