import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAnthropicUsagePayload } from "../src/normalize-anthropic.js";

void test("normalizes account and model-scoped Anthropic rolling windows", () => {
  const report = normalizeAnthropicUsagePayload(
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
    Date.parse("2026-09-12T13:00:00Z"),
  );

  assert.deepEqual(report.windows, [
    {
      id: "five_hour",
      label: "5h",
      usedPercent: 23,
      resetsAt: Date.parse("2026-09-12T16:00:00Z") / 1000,
      windowMinutes: 5 * 60,
      scope: { kind: "account" },
    },
    {
      id: "seven_day",
      label: "7d",
      usedPercent: 12,
      resetsAt: Date.parse("2026-09-18T12:00:00Z") / 1000,
      windowMinutes: 7 * 24 * 60,
      scope: { kind: "account" },
    },
    {
      id: "fable:five_hour",
      label: "5h",
      usedPercent: 75,
      resetsAt: Date.parse("2026-09-12T15:00:00Z") / 1000,
      windowMinutes: 5 * 60,
      scope: { kind: "model", modelIds: ["fable"], label: "Fable" },
    },
    {
      id: "fable:seven_day",
      label: "7d",
      usedPercent: 41,
      resetsAt: Date.parse("2026-09-18T00:00:00Z") / 1000,
      windowMinutes: 7 * 24 * 60,
      scope: { kind: "model", modelIds: ["fable"], label: "Fable" },
    },
  ]);
  assert.equal(
    report.summaryLines.some((line) => line.includes("Enterprise budget windows")),
    false,
  );
});
