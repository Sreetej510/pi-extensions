import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const packageDir = process.cwd();
const repoDir = "C:/Users/sreet/OneDrive/Desktop/shipd/beets";
const bundlePath = join(packageDir, "dist", "full-beets-fargate-smoke.bundle.mjs");
const source = `
import { runFargateSolverGapFinder } from ${JSON.stringify(join(packageDir, "src", "fargate-runner.ts"))};
import { snapshotGitHead } from ${JSON.stringify(join(packageDir, "src", "git.ts"))};
export { runFargateSolverGapFinder, snapshotGitHead };
`;

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

let root;
try {
  await esbuild.build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: "full-beets-fargate-smoke.ts", loader: "ts" },
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/*", "@aws-sdk/*"],
    logLevel: "silent",
  });
  const api = await import(pathToFileURL(bundlePath).href);
  root = mkdtempSync(join(tmpdir(), "shipd-beets-fargate-"));
  const snapshot = join(root, "snapshot");
  mkdirSync(snapshot);
  const abort = new AbortController();
  const pi = { exec: async (command, args, options) => exec(command, args, options) };
  const snapshotResult = await api.snapshotGitHead(pi, repoDir, snapshot, abort.signal);
  if (snapshotResult.status !== "ok") throw new Error(snapshotResult.error);
  for (const file of ["Dockerfile", "agent_prompt.md", "solution.patch", "test.patch"]) {
    copyFileSync(join(repoDir, file), join(snapshot, file));
  }
  const usage = [];
  console.log("Starting one-solver Beets Fargate Spot smoke test...");
  const results = await api.runFargateSolverGapFinder({
    pi,
    repoDir,
    snapshotDir: snapshot,
    config: {
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "high",
      fargate: {
        awsProfile: "shipd-static",
        region: "us-east-1",
        bucket: "shipd-checks-882781856085-us-east-1",
        resourceProfile: "medium",
        adaptiveResourceProfile: true,
        maxRetries: 1,
        taskRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-task",
        executionRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-execution",
        logGroup: "/aws/ecs/pi-shipd-checks",
      },
    },
    solverConfig: {
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "off",
      timeoutMinutes: 30,
      solverCount: 1,
      saveArtifacts: false,
    },
    cancelSignal: abort.signal,
    runId: `beets-fargate-${Date.now()}`,
    onPhase: (phase) => console.log(`phase: ${phase}`),
    onSolverProgress: (partial) =>
      console.log(`solver progress: ${partial.map((r) => `${r.index}:${r.status}`).join(", ")}`),
    onResourceUsage: (value) => {
      usage.push(value);
      console.log(`resource usage: ${JSON.stringify(value)}`);
    },
    onSolverCompleted: (result) => console.log(`solver ${result.index}: ${result.status}, passed=${result.passed}`),
  });
  console.log(
    JSON.stringify(
      results.map(({ index, status, passed, totalTests, failedTests, durationMs, testOutputTail }) => ({
        index,
        status,
        passed,
        totalTests,
        failedTests,
        durationMs,
        testOutputTail,
      })),
      null,
      2,
    ),
  );
  if (results.length !== 1 || results[0]?.status === "error" || results[0]?.status === "cancelled") {
    throw new Error(`Beets Fargate smoke failed: ${results[0]?.testOutputTail ?? "no result"}`);
  }
  console.log("Beets Fargate Spot smoke test completed.");
} finally {
  rmSync(bundlePath, { force: true });
  if (root) rmSync(root, { recursive: true, force: true });
}
