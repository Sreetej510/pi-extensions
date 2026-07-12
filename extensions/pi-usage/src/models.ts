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

export function codexAuthCandidateModels(ctx: {
  model?: PiModel;
  modelRegistry: {
    getAvailable: () => PiModel[];
    getAll: () => PiModel[];
  };
}): PiModel[] {
  return providerAuthCandidateModels(ctx, CODEX_PROVIDER_ID);
}

export function anthropicAuthCandidateModels(ctx: {
  model?: PiModel;
  modelRegistry: {
    getAvailable: () => PiModel[];
    getAll: () => PiModel[];
  };
}): PiModel[] {
  return providerAuthCandidateModels(ctx, ANTHROPIC_PROVIDER_ID);
}

function providerAuthCandidateModels(
  ctx: {
    model?: PiModel;
    modelRegistry: {
      getAvailable: () => PiModel[];
      getAll: () => PiModel[];
    };
  },
  providerId: string,
): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== providerId) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}
