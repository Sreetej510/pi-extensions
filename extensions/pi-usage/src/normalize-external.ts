import type { AdapterUsageReport, NormalizedUsageWindow, ProviderUsageSnapshotV1, UsageScopeV1 } from "./types.js";
import { clampPercent } from "./utils.js";

export function normalizeExternalUsageSnapshot(
  snapshot: ProviderUsageSnapshotV1,
  modelProviders: readonly string[],
): AdapterUsageReport {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("External usage snapshot must be an object.");
  }
  if (snapshot.version !== 1) {
    throw new Error(`Unsupported external usage snapshot version: ${String(snapshot.version)}.`);
  }
  if (snapshot.provider !== "anthropic" && snapshot.provider !== "codex") {
    throw new Error("External usage snapshot provider must be anthropic or codex.");
  }
  if (!isFiniteNonNegativeNumber(snapshot.capturedAt)) {
    throw new Error("External usage snapshot capturedAt must be a finite epoch-millisecond value.");
  }
  if (!Array.isArray(snapshot.windows)) {
    throw new Error("External usage snapshot windows must be an array.");
  }
  if (!Array.isArray(modelProviders) || !modelProviders.every((provider) => typeof provider === "string")) {
    throw new Error("External adapter modelProviders must be an array of strings.");
  }

  return {
    provider: snapshot.provider,
    source: "external-adapter",
    modelProviders: [...modelProviders],
    capturedAt: snapshot.capturedAt,
    windows: snapshot.windows.map(normalizeExternalWindow),
  };
}

function normalizeExternalWindow(window: NormalizedUsageWindow, index: number): NormalizedUsageWindow {
  if (!window || typeof window !== "object") {
    throw new Error(`External usage window ${index} must be an object.`);
  }
  if (typeof window.id !== "string") {
    throw new Error(`External usage window ${index} id must be a string.`);
  }
  if (typeof window.label !== "string") {
    throw new Error(`External usage window ${index} label must be a string.`);
  }
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    throw new Error(`External usage window ${index} usedPercent must be finite.`);
  }
  if (window.resetsAt !== undefined && !isFiniteNonNegativeNumber(window.resetsAt)) {
    throw new Error(`External usage window ${index} resetsAt must be a finite epoch-second value.`);
  }
  if (window.windowMinutes !== undefined && !isFinitePositiveNumber(window.windowMinutes)) {
    throw new Error(`External usage window ${index} windowMinutes must be finite and positive.`);
  }

  return {
    id: window.id,
    label: window.label,
    usedPercent: clampPercent(window.usedPercent),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    ...(window.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
    scope: normalizeExternalScope(window.scope, index),
  };
}

function normalizeExternalScope(scope: UsageScopeV1, index: number): UsageScopeV1 {
  if (!scope || typeof scope !== "object") {
    throw new Error(`External usage window ${index} scope must be an object.`);
  }
  if (scope.kind === "account") return { kind: "account" };
  if (scope.kind !== "model") {
    throw new Error(`External usage window ${index} has an unsupported scope kind.`);
  }
  if (!Array.isArray(scope.modelIds) || !scope.modelIds.every((modelId) => typeof modelId === "string")) {
    throw new Error(`External usage window ${index} modelIds must be an array of strings.`);
  }
  if (typeof scope.label !== "string") {
    throw new Error(`External usage window ${index} model scope label must be a string.`);
  }
  return { kind: "model", modelIds: [...scope.modelIds], label: scope.label };
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
