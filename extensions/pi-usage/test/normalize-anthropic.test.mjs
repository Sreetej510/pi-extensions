import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Pin the zone so wall-clock reset times are deterministic.
process.env.TZ = "UTC";

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@earendil-works/*"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

const { normalizeAnthropicUsagePayload } = await load("../src/normalize-anthropic.ts");
const { formatUsageReport, formatUsageStatusline } = await load("../src/format.ts");

const NOW = Date.parse("2026-10-31T19:04:34Z");
const WEEKLY_RESET = "2026-11-01T06:00:00.453060+00:00";
const NOV = new Date(WEEKLY_RESET).toLocaleDateString(undefined, { month: "short" });

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: NOW }));
afterEach(() => mock.timers.reset());

/** Trimmed copy of a real /api/oauth/usage response for a Max account. */
function maxPayload() {
  return {
    five_hour: {
      utilization: 5,
      resets_at: "2026-10-31T21:20:00.453042+00:00",
      limit_dollars: null,
      used_dollars: null,
    },
    seven_day: { utilization: 18, resets_at: WEEKLY_RESET, limit_dollars: null, used_dollars: null },
    seven_day_opus: null,
    cinder_cove: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 5,
        resets_at: "2026-10-31T21:20:00.453042+00:00",
        scope: null,
      },
      { kind: "weekly_all", group: "weekly", percent: 18, resets_at: WEEKLY_RESET, scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 7,
        resets_at: "2026-11-01T06:00:00.453231+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 4, allowance_percent_of_weekly: 50 }],
  };
}

test("/usage lists model-scoped weekly limits with reset time and allowance", () => {
  const report = normalizeAnthropicUsagePayload(maxPayload(), NOW);
  const text = formatUsageReport(report);

  assert.match(text, /5h: \[[█░]+\] 5% used \(resets 21:20\)/);
  assert.ok(text.includes(`18% used (resets 06:00 on 1 ${NOV})`));
  assert.match(text, /Fable 7d: \[[█░]+\] 7% used/);
  assert.ok(text.includes(`7% used (resets 06:00 on 1 ${NOV}), up to 50% of weekly limit`));
  // Account-wide entries of `limits` duplicate five_hour/seven_day and must not be listed twice.
  assert.equal(text.match(/% used/g).length, 3);
});

test("statusline always shows the scoped limit and prints a shared time left once", () => {
  const report = normalizeAnthropicUsagePayload(maxPayload(), NOW);
  // 7d and Fable reset at the same minute, so the time left follows the pair once.
  assert.equal(report.statusline, "claude 5h 5% ↻2h15m / 7d 18% fable 7% ↻10h55m");
  assert.equal(formatUsageStatusline(report), report.statusline);
});

test("statusline keeps separate times left when a scoped limit resets at another time", () => {
  const payload = maxPayload();
  payload.limits[2].resets_at = "2026-11-02T06:00:00Z";
  const report = normalizeAnthropicUsagePayload(payload, NOW);
  assert.equal(report.statusline, "claude 5h 5% ↻2h15m / 7d 18% ↻10h55m / fable 7% ↻1d10h");
});

test("statusline labels scoped limits that are not weekly", () => {
  const payload = maxPayload();
  payload.limits[2].group = "session";
  payload.limits[2].resets_at = "2026-10-31T21:20:00Z";
  const report = normalizeAnthropicUsagePayload(payload, NOW);
  assert.equal(report.statusline, "claude 5h 5% ↻2h15m / 7d 18% ↻10h55m / fable 5h 7% ↻2h15m");
});

test("payloads without a limits array are unaffected", () => {
  const { limits: _limits, weekly_scoped_shares: _shares, ...payload } = maxPayload();
  const report = normalizeAnthropicUsagePayload(payload, NOW);
  assert.equal(report.statusline, "claude 5h 5% ↻2h15m / 7d 18% ↻10h55m");
  assert.doesNotMatch(formatUsageReport(report), /Fable/);
});

test("malformed limits entries are ignored", () => {
  const payload = {
    ...maxPayload(),
    limits: [null, "x", [], { scope: { model: { display_name: "Fable" } } }, { percent: 3, scope: {} }],
    weekly_scoped_shares: "nope",
  };
  const report = normalizeAnthropicUsagePayload(payload, NOW);
  assert.equal(report.statusline, "claude 5h 5% ↻2h15m / 7d 18% ↻10h55m");
  assert.doesNotMatch(formatUsageReport(report), /Fable/);
});

test("time left: minutes under an hour, hours and minutes under a day, then days and hours", () => {
  const cases = [
    ["2026-10-31T19:50:00Z", "45m"],
    ["2026-10-31T21:05:00Z", "2h"],
    ["2026-11-01T18:17:00Z", "23h12m"],
    ["2026-11-02T06:00:00Z", "1d10h"],
    ["2026-11-07T06:00:00Z", "6d10h"],
  ];
  for (const [resetsAt, expected] of cases) {
    const payload = maxPayload();
    payload.five_hour.resets_at = resetsAt;
    const report = normalizeAnthropicUsagePayload(payload, NOW);
    assert.ok(report.statusline.startsWith(`claude 5h 5% ↻${expected} / `), `${resetsAt}: ${report.statusline}`);
  }
});

test("reset times are rounded to the nearest minute, so jittered resets still group", () => {
  const payload = maxPayload();
  payload.five_hour.resets_at = "2026-10-31T21:19:59.981Z";
  payload.seven_day.resets_at = "2026-11-01T05:59:59.902Z";
  payload.limits[2].resets_at = "2026-11-01T06:00:00.453Z";
  const report = normalizeAnthropicUsagePayload(payload, NOW);
  assert.equal(report.statusline, "claude 5h 5% ↻2h15m / 7d 18% fable 7% ↻10h55m");
});

test("time left is computed when the statusline is shown, not when usage was fetched", () => {
  const report = normalizeAnthropicUsagePayload(maxPayload(), NOW);
  mock.timers.tick(30 * 60_000);
  assert.equal(formatUsageStatusline(report), "claude 5h 5% ↻1h45m / 7d 18% fable 7% ↻10h25m");
});

test("reports cached by older versions (no statusWindows) render their stored statusline", () => {
  const legacy = {
    provider: "anthropic",
    source: "anthropic-oauth",
    capturedAt: NOW,
    summaryLines: ["  >_ Anthropic Usage"],
    statusline: "claude 5% 5h 18% 7d",
  };
  assert.equal(formatUsageStatusline(legacy), legacy.statusline);
});
