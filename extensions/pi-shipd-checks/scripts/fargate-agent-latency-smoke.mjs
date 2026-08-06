import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const packageDir = process.cwd();
const bundlePath = join(packageDir, "dist", "fargate-agent-latency-smoke.bundle.mjs");
const prompt = "Do not read files or run tools. Respond with exactly READY and make no edits.";
const source = `
import { runFargateSolverGapFinder } from ${JSON.stringify(join(packageDir, "src", "fargate-runner.ts"))};
import { snapshotGitHead } from ${JSON.stringify(join(packageDir, "src", "git.ts"))};
import { buildSolverPrompt } from ${JSON.stringify(join(packageDir, "src", "prompts.ts"))};
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
export { runFargateSolverGapFinder, snapshotGitHead, buildSolverPrompt, createAgentSession, SessionManager, getModel };
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

const testPatch = `diff --git a/test.sh b/test.sh
new file mode 100755
index 0000000..d3b07384
--- /dev/null
+++ b/test.sh
@@ -0,0 +1 @@
+#!/usr/bin/env bash
`;
const summarize = (trajectory) => {
  const times = trajectory
    .map((entry) => Date.parse(entry.timestamp ?? ""))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const seconds = (times[i] - times[i - 1]) / 1000;
    if (seconds >= 5) gaps.push(Math.round(seconds));
  }
  return { entries: trajectory.length, first: times[0], last: times.at(-1), gapsSeconds: gaps };
};

let root;
try {
  await esbuild.build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: "fargate-agent-latency-smoke.ts", loader: "ts" },
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/*", "@aws-sdk/*"],
    logLevel: "silent",
  });
  const api = await import(pathToFileURL(bundlePath).href);
  root = mkdtempSync(join(tmpdir(), "shipd-agent-latency-"));
  const repoDir = join(root, "repo");
  const snapshotDir = join(root, "snapshot");
  mkdirSync(repoDir);
  mkdirSync(snapshotDir);
  writeFileSync(
    join(repoDir, "Dockerfile"),
    "FROM public.ecr.aws/d3j8x8q7/olympus-base-python:latest\nWORKDIR /app\nCOPY . .\n",
  );
  writeFileSync(join(repoDir, "agent_prompt.md"), `${prompt}\n`);
  writeFileSync(join(repoDir, "test.patch"), testPatch);
  const init = await exec("git", ["init", "-q"], { cwd: repoDir });
  if (init.code !== 0) throw new Error(init.stderr);
  await exec("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "shipd smoke"], { cwd: repoDir });
  await exec("git", ["add", "Dockerfile"], { cwd: repoDir });
  await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: repoDir });
  const pi = { exec: async (command, args, options) => exec(command, args, options) };
  const abort = new AbortController();
  const snapshot = await api.snapshotGitHead(pi, repoDir, snapshotDir, abort.signal);
  if (snapshot.status !== "ok") throw new Error(snapshot.error);
  for (const file of ["agent_prompt.md", "test.patch"])
    writeFileSync(join(snapshotDir, file), readFileSync(join(repoDir, file)));
  writeFileSync(join(snapshotDir, "solution.patch"), "");
  const solverConfig = {
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "off",
    timeoutMinutes: 10,
    solverCount: 1,
    saveArtifacts: true,
  };
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
  const runId = `agent-latency-${Date.now()}`;
  const started = Date.now();
  const results = await api.runFargateSolverGapFinder({
    pi,
    repoDir,
    snapshotDir,
    config,
    solverConfig,
    cancelSignal: abort.signal,
    runId,
  });
  const remoteMs = Date.now() - started;
  const remoteTrajectory = JSON.parse(
    readFileSync(join(repoDir, ".pi", "shipd-checks", runId, "solver_1", "trajectory.json"), "utf8"),
  );
  console.log(
    JSON.stringify({ remoteMs, resultDurationMs: results[0]?.durationMs, remote: summarize(remoteTrajectory) }),
  );

  const localCwd = join(root, "local");
  mkdirSync(localCwd);
  writeFileSync(join(localCwd, "agent_prompt.md"), `${prompt}\n`);
  writeFileSync(join(localCwd, "test.sh"), "#!/usr/bin/env bash\n");
  const model = api.getModel(solverConfig.provider, solverConfig.modelId);
  if (!model) throw new Error("Could not resolve local latency model.");
  const sessionManager = api.SessionManager.inMemory();
  const localStarted = Date.now();
  const { session } = await api.createAgentSession({
    cwd: localCwd,
    model,
    thinkingLevel: undefined,
    tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
    sessionManager,
  });
  try {
    await session.prompt(api.buildSolverPrompt());
  } finally {
    session.dispose();
  }
  const localTrajectory = sessionManager.getEntries();
  console.log(JSON.stringify({ localMs: Date.now() - localStarted, local: summarize(localTrajectory) }));
} finally {
  rmSync(bundlePath, { force: true });
  if (root) rmSync(root, { recursive: true, force: true });
}
