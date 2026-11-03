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
// One module for several sessions, as pi's extension cache gives sessions with the same cwd.
const { createUsageStatusline } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

const NOW = Date.parse("2026-11-02T18:31:00Z");
let a;
let b;

function session() {
  const statuses = [];
  const ctx = {
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    ui: { setStatus: (_key, text) => statuses.push(text) },
  };
  const statusline = createUsageStatusline();
  statusline.setSessionActive(true); // session_start
  return { statuses, ctx, statusline };
}

function report() {
  return {
    provider: "anthropic",
    source: "anthropic-oauth",
    capturedAt: NOW,
    summaryLines: [],
    statusline: "claude 5h 32% ↻39m",
    statusWindows: [{ text: "5h 32%", resetsAt: "2026-11-02T19:10:00Z" }],
  };
}

function shutdown({ ctx, statusline }) {
  // As the session_shutdown handler in index.ts.
  statusline.setSessionActive(false);
  statusline.clearUsageStatusline(ctx);
}

beforeEach(() => {
  // Fake clock and timers; the 3-minute refresh (which would hit the network) is never reached.
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  a = session();
  b = session();
});
afterEach(() => {
  shutdown(a);
  shutdown(b);
  mock.timers.reset();
});

test("another session's shutdown does not freeze this session's statusline", () => {
  a.statusline.applyCurrentProviderStatusline(a.ctx, [report()]);
  shutdown(b); // e.g. Pi Web's idle timeout on another tab
  mock.timers.tick(60_100); // 18:32:00.1
  assert.deepEqual(a.statuses, ["claude 5h 32% ↻39m", "claude 5h 32% ↻37m"]);
});

test("another session's statusline update does not stop this session's ticks", () => {
  a.statusline.applyCurrentProviderStatusline(a.ctx, [report()]);
  b.statusline.applyCurrentProviderStatusline(b.ctx, [report()]);
  mock.timers.tick(60_100);
  assert.equal(a.statuses.at(-1), "claude 5h 32% ↻37m");
  assert.equal(b.statuses.at(-1), "claude 5h 32% ↻37m");
});

test("a session's own shutdown still stops its statusline", () => {
  a.statusline.applyCurrentProviderStatusline(a.ctx, [report()]);
  shutdown(a);
  mock.timers.tick(5 * 60_000);
  assert.deepEqual(a.statuses, ["claude 5h 32% ↻39m", undefined]);
});
