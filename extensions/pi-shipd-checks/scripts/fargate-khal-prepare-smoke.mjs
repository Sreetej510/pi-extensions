import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const packageDir = process.cwd();
const khalDir = "C:/Users/sreet/OneDrive/Desktop/shipd/khal";
const bundlePath = join(packageDir, "dist", "fargate-khal-prepare-smoke.bundle.mjs");
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
    stdin: { contents: source, resolveDir: packageDir, sourcefile: "fargate-khal-prepare-smoke.ts", loader: "ts" },
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/*", "@aws-sdk/*"],
    logLevel: "silent",
  });
  const api = await import(pathToFileURL(bundlePath).href);
  root = mkdtempSync(join(tmpdir(), "shipd-khal-prepare-"));
  const repoDir = join(root, "repo");
  const snapshotDir = join(root, "snapshot");
  mkdirSync(repoDir);
  mkdirSync(snapshotDir);
  writeFileSync(
    join(repoDir, "Dockerfile"),
    "FROM public.ecr.aws/d3j8x8q7/olympus-base-python:latest\nWORKDIR /app\nCOPY . .\n",
  );
  const pi = { exec: async (command, args, options) => exec(command, args, options) };
  const abort = new AbortController();
  const snapshot = await api.snapshotGitHead(pi, khalDir, snapshotDir, abort.signal);
  if (snapshot.status !== "ok") throw new Error(snapshot.error);
  for (const file of ["agent_prompt.md", "solution.patch", "test.patch"]) {
    copyFileSync(join(khalDir, file), join(snapshotDir, file));
  }
  console.log("Starting targeted Khal Fargate Spot workspace-preparation smoke...");
  const results = await api.runFargateSolverGapFinder({
    pi,
    repoDir,
    snapshotDir,
    config: {
      fargate: {
        awsProfile: "shipd-fargate",
        region: "us-east-1",
        resourceProfile: "small",
        maxRetries: 0,
        taskRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-task",
        executionRoleArn: "arn:aws:iam::882781856085:role/pi-shipd-checks-execution",
        logGroup: "/aws/ecs/pi-shipd-checks",
      },
    },
    solverConfig: {
      provider: "__prepare_debug__",
      modelId: "__prepare_debug__",
      thinkingLevel: "off",
      timeoutMinutes: 10,
      solverCount: 1,
      saveArtifacts: false,
    },
    cancelSignal: abort.signal,
    runId: `khal-prepare-${Date.now()}`,
  });
  const result = results[0];
  console.log(JSON.stringify(result));
  if (result?.testOutputTail !== "Could not resolve model __prepare_debug__/__prepare_debug__.") {
    throw new Error(`Workspace preparation smoke failed: ${result?.testOutputTail ?? "no result"}`);
  }
  console.log("Khal workspace preparation passed; solver launch was intentionally skipped.");
} finally {
  rmSync(bundlePath, { force: true });
  if (root) rmSync(root, { recursive: true, force: true });
}
