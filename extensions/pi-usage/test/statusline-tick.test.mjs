import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/statusline.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@earendil-works/*"],
});
const { applyCurrentProviderStatusline, clearUsageStatusline, setSessionActive, setStatuslineChecking } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

const NOW = Date.parse("2026-10-31T19:04:34Z");
let statuses;
let ctx;

beforeEach(() => {
  // Fake clock and timers; the 3-minute refresh (which would hit the network) is never reached.
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  statuses = [];
  ctx = {
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    ui: { setStatus: (_key, text) => statuses.push(text) },
  };
  setSessionActive(true);
});
afterEach(() => {
  clearUsageStatusline(ctx);
  setSessionActive(false);
  mock.timers.reset();
});

function report() {
  return {
    provider: "anthropic",
    source: "anthropic-oauth",
    capturedAt: NOW,
    summaryLines: [],
    statusline: "claude 5h 5% ↻2h15m",
    statusWindows: [{ text: "5h 5%", resetsAt: "2026-10-31T21:20:00Z" }],
  };
}

test("the statusline is re-rendered each wall-clock minute between fetches", () => {
  applyCurrentProviderStatusline(ctx, [report()]);
  assert.deepEqual(statuses, ["claude 5h 5% ↻2h15m"]);

  mock.timers.tick(26_100); // 19:05:00.1
  assert.deepEqual(statuses.at(-1), "claude 5h 5% ↻2h14m");

  mock.timers.tick(60_000); // 19:06:00.1
  assert.deepEqual(statuses.at(-1), "claude 5h 5% ↻2h13m");
  assert.equal(statuses.length, 3);
});

test("the minute tick stops once the statusline shows something else", () => {
  applyCurrentProviderStatusline(ctx, [report()]);
  setStatuslineChecking(ctx);
  mock.timers.tick(90_000);
  assert.deepEqual(statuses, ["claude 5h 5% ↻2h15m", "checking"]);
});

test("reports without a countdown are not re-rendered", () => {
  const { statusWindows: _windows, ...legacy } = report();
  applyCurrentProviderStatusline(ctx, [legacy]);
  mock.timers.tick(90_000);
  assert.equal(statuses.length, 1);
});
