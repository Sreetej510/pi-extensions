import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageStatusline } from "../src/format.js";
import { reportMatchesModel } from "../src/models.js";
import { normalizeAnthropicUsagePayload } from "../src/normalize-anthropic.js";
import type { AdapterUsageReport, ProviderUsageModel } from "../src/types.js";

const now = Date.parse("2026-09-12T13:00:00Z");
const anthropicReport = normalizeAnthropicUsagePayload(
  {
    five_hour: { utilization: 23, resets_at: "2026-09-12T16:00:00Z" },
    seven_day: { utilization: 12, resets_at: "2026-09-18T12:00:00Z" },
    model_scoped: {
      fable: {
        five_hour: { utilization: 75, resets_at: "2026-09-12T15:00:00Z" },
        seven_day: { utilization: 41, resets_at: "2026-09-18T00:00:00Z" },
      },
    },
  },
  now,
);
const financialAnthropicReport = normalizeAnthropicUsagePayload(
  {
    cinder_cove: { utilization: 60, used_dollars: 5, limit_dollars: 10 },
    extra_usage: {
      is_enabled: true,
      utilization: 50,
      used_credits: 500,
      monthly_limit: 1000,
      currency: "USD",
    },
    model_scoped: {
      fable: {
        five_hour: { utilization: 75, resets_at: "2026-09-12T15:00:00Z" },
        seven_day: { utilization: 41, resets_at: "2026-09-18T00:00:00Z" },
      },
    },
  },
  now,
);
const codexAdapterReport: AdapterUsageReport = {
  provider: "codex",
  source: "external-adapter",
  capturedAt: now,
  windows: [
    {
      id: "gpt:five_hour",
      label: "5h",
      usedPercent: 32,
      resetsAt: (now + 47 * 60_000) / 1000,
      windowMinutes: 300,
      scope: { kind: "model", modelIds: ["gpt-5.1-codex"], label: "GPT" },
    },
    {
      id: "gpt:seven_day",
      label: "7d",
      usedPercent: 18,
      resetsAt: Date.parse("2026-09-18T00:00:00Z") / 1000,
      windowMinutes: 7 * 24 * 60,
      scope: { kind: "model", modelIds: ["gpt-5.1-codex"], label: "GPT" },
    },
  ],
};

function model(provider: string, id: string, name: string): ProviderUsageModel {
  return { provider, id, name } as ProviderUsageModel;
}

void test("renders matching Anthropic model windows before account windows", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(anthropicReport, model("anthropic", "fable", "Claude Fable")),
      "Fable · 5h 75% ↻2h · 7d 41%",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("preserves native Anthropic financial status while rendering matched model windows compactly", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(financialAnthropicReport.statusline, "claude 60% $5/$10 50% $5/$10 extra");
    assert.equal(
      formatUsageStatusline(financialAnthropicReport, model("anthropic", "claude-sonnet", "Claude Sonnet")),
      financialAnthropicReport.statusline,
    );
    assert.equal(
      formatUsageStatusline(financialAnthropicReport, model("anthropic", "fable", "Claude Fable")),
      "Fable · 5h 75% ↻2h · 7d 41%",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("renders matching external Codex model windows", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(codexAdapterReport, model("openai-codex", "gpt-5.1-codex", "GPT 5.1 Codex")),
      "GPT · 5h 32% ↻47m · 7d 18%",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("falls back to Anthropic account windows for an unmatched Claude model", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(anthropicReport, model("anthropic", "claude-sonnet", "Claude Sonnet")),
      "Claude · 5h 23% ↻3h · 7d 12%",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("does not render a report for an unsupported or different provider", () => {
  const unsupportedModel = model("google", "gemini-pro", "Gemini Pro");
  assert.equal(formatUsageStatusline(anthropicReport, unsupportedModel), undefined);
  assert.equal(formatUsageStatusline(codexAdapterReport, unsupportedModel), undefined);
  assert.equal(reportMatchesModel(codexAdapterReport, unsupportedModel), false);
});
