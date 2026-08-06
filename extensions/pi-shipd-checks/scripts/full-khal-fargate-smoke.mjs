import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const packageDir = process.cwd();
const repoDir = "C:/Users/sreet/OneDrive/Desktop/shipd/khal";
const bundlePath = join(packageDir, "dist", "full-khal-fargate-smoke.bundle.mjs");
const source = `
import { runFargateSolverGapFinder } from ${JSON.stringify(join(packageDir, "src", "fargate-runner.ts"))};
import { snapshotGitHead } from ${JSON.stringify(join(packageDir, "src", "git.ts"))};
import { writeSolverSolutionsToDisk } from ${JSON.stringify(join(packageDir, "src", "solvergap.ts"))};
import { runSolverComparisonReviewer } from ${JSON.stringify(join(packageDir, "src", "agents.ts"))};
import { loadFairnessRules, loadTestGuidelines } from ${JSON.stringify(join(packageDir, "src", "rubric.ts"))};
import { getModel } from "@earendil-works/pi-ai/compat";
export { runFargateSolverGapFinder, snapshotGitHead, writeSolverSolutionsToDisk, runSolverComparisonReviewer, loadFairnessRules, loadTestGuidelines, getModel };
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
    stdin: { contents: source, resolveDir: packageDir, sourcefile: "full-khal-fargate-smoke.ts", loader: "ts" },
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/*", "@aws-sdk/*"],
    logLevel: "silent",
  });
  const api = await import(pathToFileURL(bundlePath).href);
  root = mkdtempSync(join(tmpdir(), "shipd-khal-fargate-"));
  const snapshot = join(root, "snapshot");
  mkdirSync(snapshot);
  const abort = new AbortController();
  const pi = { exec: async (command, args, options) => exec(command, args, options) };
  const snapshotResult = await api.snapshotGitHead(pi, repoDir, snapshot, abort.signal);
  if (snapshotResult.status !== "ok") throw new Error(snapshotResult.error);
  for (const file of ["Dockerfile", "agent_prompt.md", "solution.patch", "test.patch"]) {
    copyFileSync(join(repoDir, file), join(snapshot, file));
  }
  const config = {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "high",
    fargate: {
      awsProfile: "shipd-fargate",
      region: "us-east-1",
      resourceProfile: "medium",
      maxRetries: 1,
      taskRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-task",
      executionRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-execution",
      logGroup: "/aws/ecs/pi-shipd-checks",
    },
  };
  const solverConfig = {
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "off",
    timeoutMinutes: 30,
    solverCount: 1,
    saveArtifacts: true,
  };
  console.log("Starting one-solver Khal Fargate Spot Khal run...");
  const results = await api.runFargateSolverGapFinder({
    pi,
    repoDir,
    snapshotDir: snapshot,
    config,
    solverConfig,
    cancelSignal: abort.signal,
    runId: `khal-fargate-${Date.now()}`,
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
    ),
  );
  api.writeSolverSolutionsToDisk(snapshot, results);
  const reviewerModel = api.getModel(config.provider, config.modelId);
  if (!reviewerModel) throw new Error(`Could not resolve ${config.provider}/${config.modelId}`);
  console.log("Starting local solver comparison reviewer...");
  const comparison = await api.runSolverComparisonReviewer({
    tempDir: snapshot,
    model: reviewerModel,
    thinkingLevel: config.thinkingLevel,
    solverResults: results,
    testRubric: api.loadTestGuidelines(),
    fairnessRules: api.loadFairnessRules(),
    cancelSignal: abort.signal,
  });
  console.log(JSON.stringify({ comparisonStatus: comparison.status, gaps: comparison.gaps }));
  if (
    results.length !== solverConfig.solverCount ||
    results.some((result) => result.status === "error" || result.status === "cancelled")
  ) {
    throw new Error("One or more Khal Fargate solver runs failed.");
  }
  console.log("Khal Fargate Spot run and local comparison completed.");
} finally {
  rmSync(bundlePath, { force: true });
  if (root) rmSync(root, { recursive: true, force: true });
}
