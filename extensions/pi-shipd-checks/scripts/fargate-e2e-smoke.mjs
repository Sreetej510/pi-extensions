import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const packageDir = process.cwd();
const bundlePath = join(packageDir, "dist", "fargate-e2e-smoke.bundle.mjs");
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

function writeGitFile(repo, name, content) {
  writeFileSync(join(repo, name), content, "utf8");
}

const testPatch = `diff --git a/test.sh b/test.sh
new file mode 100644
index 0000000..5e8c3f2
--- /dev/null
+++ b/test.sh
@@ -0,0 +1,21 @@
+#!/usr/bin/env bash
+set -eu
+output=""
+if [ "\${1:-}" = "--output_path" ]; then
+  output="$2"
+  shift 2
+fi
+mode="\${1:-}"
+if [ "$mode" != "new" ]; then
+  echo "unsupported mode" >&2
+  exit 2
+fi
+if [ ! -f README.md ]; then
+  echo "README.md is missing" >&2
+  exit 1
+fi
+grep -Fxq '# Fargate smoke README' README.md
+if [ -n "$output" ]; then
+  printf '<testsuites tests="1" failures="0" errors="0"><testsuite tests="1" failures="0" errors="0"><testcase classname="smoke" name="creates-readme"/></testsuite></testsuites>\\n' > "$output"
+fi
+echo "1 passed"
`;

let root;
try {
  await esbuild.build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: "fargate-e2e-smoke.ts", loader: "ts" },
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/*", "@aws-sdk/*"],
    logLevel: "silent",
  });
  const api = await import(pathToFileURL(bundlePath).href);
  root = mkdtempSync(join(tmpdir(), "shipd-fargate-e2e-"));
  const repo = join(root, "repo");
  const snapshot = join(root, "snapshot");
  mkdirSync(repo);
  mkdirSync(snapshot);
  writeGitFile(
    repo,
    "Dockerfile",
    `FROM public.ecr.aws/d3j8x8q7/olympus-base-python:latest\nWORKDIR /app\nCOPY . .\nCMD ["/bin/bash"]\n`,
  );
  writeGitFile(repo, "agent_prompt.md", "Create README.md with exactly one line: # Fargate smoke README\n");
  writeGitFile(repo, "test.patch", testPatch);
  const init = await exec("git", ["init", "-q"], { cwd: repo });
  if (init.code !== 0) throw new Error(init.stderr);
  await exec("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "shipd smoke"], { cwd: repo });
  await exec("git", ["add", "Dockerfile"], { cwd: repo });
  await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: repo });
  const pi = {
    exec: async (command, args, options) => exec(command, args, options),
  };
  const abort = new AbortController();
  const snapshotResult = await api.snapshotGitHead(pi, repo, snapshot, abort.signal);
  if (snapshotResult.status !== "ok") throw new Error(snapshotResult.error);
  for (const file of ["agent_prompt.md", "test.patch"]) {
    writeFileSync(join(snapshot, file), readFileSync(join(repo, file)));
  }
  writeFileSync(join(snapshot, "solution.patch"), "");
  const config = {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "off",
    fargate: {
      awsProfile: "shipd-fargate",
      region: "us-east-1",
      resourceProfile: "small",
      maxRetries: 0,
      taskRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-task",
      executionRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-execution",
      logGroup: "/aws/ecs/pi-shipd-checks",
    },
  };
  const solverConfig = {
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "off",
    timeoutMinutes: 10,
    solverCount: 1,
    saveArtifacts: false,
  };
  console.log("Starting one-solver Fargate Spot README smoke test...");
  const results = await api.runFargateSolverGapFinder({
    pi,
    repoDir: repo,
    snapshotDir: snapshot,
    config,
    solverConfig,
    cancelSignal: abort.signal,
    runId: `fargate-readme-smoke-${Date.now()}`,
    onSolverCompleted: (result) => console.log(`solver ${result.index}: ${result.status}, passed=${result.passed}`),
  });
  console.log(
    JSON.stringify(
      results.map(({ index, status, passed, totalTests, failedTests, testOutputTail }) => ({
        index,
        status,
        passed,
        totalTests,
        failedTests,
        testOutputTail,
      })),
    ),
  );
  if (results.length !== 1 || results[0]?.status !== "ok" || !results[0].passed) {
    throw new Error(`Fargate README smoke failed: ${results[0]?.testOutputTail ?? "no result"}`);
  }
  console.log("Fargate Spot README smoke test passed.");
} finally {
  rmSync(bundlePath, { force: true });
  if (root) rmSync(root, { recursive: true, force: true });
}
