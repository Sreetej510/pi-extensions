import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix as posixPath } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSolverPrompt } from "./prompts.js";
import { TaskResourceUsageSampler } from "./resource-usage.js";
import type {
  FargateResourceProfile,
  FargateResourceUsage,
  PatchPrecheckPhase,
  PatchPrecheckResult,
  PatchTestRunResult,
  SolverRunResult,
  ThinkingLevel,
} from "./types.js";

type DockerPlan = {
  baseImage: string;
  workdir: string;
  env: Record<string, string>;
  runtimeCommands: string[];
};

type WorkerSolverResult = SolverRunResult & { trajectory?: unknown[] };

type WorkerMode = "solver" | "patch-precheck";

type WorkerPayload = {
  complete: boolean;
  results: WorkerSolverResult[];
  precheck?: PatchPrecheckResult;
  resourceUsage?: FargateResourceUsage;
  error?: string;
};

let activeResourceUsage: TaskResourceUsageSampler | undefined;

// The standalone worker cannot resolve pi-ai's lazy OAuth modules relative to
// /tmp after esbuild bundles this file. Register them statically instead.
registerBunOAuthFlows();

const AGENT_DIR = "/opt/shipd-agent";
const SOLVERS_DIR = "/work/solvers";
const TAIL_CHARS = 4000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker environment variable ${name}.`);
  return value;
}

function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text;
}

function loadBootstrap(): WorkerMode {
  const bootstrap = JSON.parse(readFileSync("/tmp/shipd-bootstrap.json", "utf-8")) as Record<string, unknown>;
  const mode = bootstrap.mode;
  if (mode !== "solver" && mode !== "patch-precheck") throw new Error("Invalid Fargate bootstrap mode.");
  process.env.SHIPD_MODE = mode;

  const directKeys =
    mode === "solver"
      ? ["bucket", "region", "sourceKey", "authKey", "resultKey"]
      : ["bucket", "region", "sourceKey", "resultKey"];
  const directS3 = directKeys.every((key) => typeof bootstrap[key] === "string" && bootstrap[key]);
  const stringValues = [
    "planB64",
    "resourceProfile",
    ...(mode === "solver" ? ["provider", "modelId", "thinkingLevel"] : []),
  ];
  const envNames: Record<string, string> = {
    planB64: "SHIPD_PLAN_B64",
    provider: "SHIPD_PROVIDER",
    modelId: "SHIPD_MODEL_ID",
    thinkingLevel: "SHIPD_THINKING_LEVEL",
    resourceProfile: "SHIPD_RESOURCE_PROFILE",
  };
  if (directS3) {
    const directFields = [
      ["bucket", "SHIPD_S3_BUCKET"],
      ["region", "SHIPD_S3_REGION"],
      ["sourceKey", "SHIPD_S3_SOURCE_KEY"],
      ...(mode === "solver" ? [["authKey", "SHIPD_S3_AUTH_KEY"]] : []),
      ["resultKey", "SHIPD_S3_RESULT_KEY"],
    ] as const;
    for (const [key, envName] of directFields) {
      const value = bootstrap[key];
      if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid Fargate bootstrap field: ${key}.`);
      process.env[envName] = value;
    }
  } else {
    const transportFields = [
      ["sourceUrl", "SHIPD_SOURCE_URL"],
      ...(mode === "solver" ? [["authUrl", "SHIPD_AUTH_URL"]] : []),
      ["resultPutUrl", "SHIPD_RESULT_PUT_URL"],
      ["resultGetUrl", "SHIPD_RESULT_GET_URL"],
    ] as const;
    for (const [key, envName] of transportFields) {
      const value = bootstrap[key];
      if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid Fargate bootstrap field: ${key}.`);
      process.env[envName] = value;
    }
  }
  for (const key of stringValues) {
    const value = bootstrap[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid Fargate bootstrap field: ${key}.`);
    process.env[envNames[key] as string] = value;
  }
  const numericFields = [
    ["timeoutMinutes", "SHIPD_TIMEOUT_MINUTES"],
    ...(mode === "solver" ? [["solverCount", "SHIPD_SOLVER_COUNT"]] : []),
  ] as const;
  for (const [key, envName] of numericFields) {
    const value = bootstrap[key];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`Invalid Fargate bootstrap field: ${key}.`);
    process.env[envName] = String(value);
  }
  return mode;
}

function planFromEnv(): DockerPlan {
  const encoded = requiredEnv("SHIPD_PLAN_B64");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8")) as DockerPlan;
}

function resolvedEnvironment(plan: DockerPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(plan.env)) {
    env[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, simple) => {
      const variable = braced ?? simple;
      return env[variable] ?? "";
    });
  }
  return env;
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${destination}.`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function directS3Enabled(): boolean {
  return Boolean(process.env.SHIPD_S3_BUCKET);
}

function workerS3(): S3Client {
  return new S3Client({ region: requiredEnv("SHIPD_S3_REGION"), credentials: defaultProvider() });
}

async function downloadObject(bucket: string, key: string, destination: string): Promise<void> {
  const response = await workerS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToByteArray();
  if (!body) throw new Error(`S3 object was empty: s3://${bucket}/${key}`);
  writeFileSync(destination, Buffer.from(body));
}

async function upload(url: string, payload: WorkerPayload): Promise<void> {
  const body = JSON.stringify(payload);
  if (directS3Enabled()) {
    await workerS3().send(
      new PutObjectCommand({
        Bucket: requiredEnv("SHIPD_S3_BUCKET"),
        Key: requiredEnv("SHIPD_S3_RESULT_KEY"),
        Body: body,
        ContentType: "application/json",
      }),
    );
    return;
  }
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`Result upload failed (${response.status})${detail ? `: ${detail.slice(0, 1000)}` : "."}`);
  }
}

async function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(
        new Error(`${error instanceof Error ? error.message : String(error)} (cwd=${cwd} exists=${existsSync(cwd)})`),
      );
    });
    child.once("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    timer = setTimeout(() => {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);
  });
}

async function requiredCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runCommand(command, cwd, env, timeoutMs);
  if (result.code !== 0) {
    throw new Error(
      [result.stderr.trim(), result.stdout.trim(), `Remote command: ${command}`].filter(Boolean).join("\n"),
    );
  }
  return result;
}

interface JUnitCounts {
  tests: number | null;
  testcases: number | null;
  failures: number | null;
  failedTestcases: number | null;
  errors: number | null;
  erroredTestcases: number | null;
  suiteErrors: number | null;
  skipped: number | null;
  skippedTestcases: number | null;
  failedTestNames: string[];
  erroredTestNames: string[];
}

function xmlNumber(tag: string | undefined, name: string): number | null {
  if (!tag) return null;
  const value = tag.match(new RegExp(`\\b${name}=["']([0-9]+(?:\\.[0-9]+)?)["']`, "i"))?.[1];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function xmlString(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1];
}

function testCaseName(caseXml: string, index: number): string {
  const name = xmlString(caseXml, "name") ?? `testcase-${index + 1}`;
  const classname = xmlString(caseXml, "classname");
  return classname ? `${classname}::${name}` : name;
}

function readJUnitCounts(path: string): JUnitCounts {
  try {
    const xml = readFileSync(path, "utf-8");
    const root = xml.match(/<testsuites\b[^>]*>/i)?.[0];
    const suites = [...xml.matchAll(/<testsuite\b[^>]*>/gi)].map((match) => match[0]);
    const testcases = [...xml.matchAll(/<testcase\b[^>]*(?:\/>|>[\s\S]*?<\/testcase\s*>)/gi)].map((match) => match[0]);
    const testcaseCount = testcases.length;
    const failedTestNames = testcases.flatMap((caseXml, index) =>
      /<failure\b/i.test(caseXml) ? [testCaseName(caseXml, index)] : [],
    );
    const erroredTestNames = testcases.flatMap((caseXml, index) =>
      /<error\b/i.test(caseXml) ? [testCaseName(caseXml, index)] : [],
    );
    const failedCases = failedTestNames.length;
    const errorCases = erroredTestNames.length;
    const skippedCases = testcases.filter((caseXml) => /<skipped\b/i.test(caseXml)).length;
    const failureTags = [...xml.matchAll(/<failure\b/gi)].length;
    const errorTags = [...xml.matchAll(/<error\b/gi)].length;
    const testcaseErrorTags = testcases.reduce(
      (count, caseXml) => count + [...caseXml.matchAll(/<error\b/gi)].length,
      0,
    );
    const skippedTags = [...xml.matchAll(/<skipped\b/gi)].length;
    const sumSuite = (name: string, fallback: number) => {
      const values = suites.map((suite) => xmlNumber(suite, name)).filter((value): value is number => value !== null);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : fallback;
    };
    const aggregate = (name: string, tags: number, fallback: number) =>
      Math.max(xmlNumber(root, name) ?? sumSuite(name, fallback), tags);
    return {
      tests: xmlNumber(root, "tests") ?? sumSuite("tests", testcaseCount),
      testcases: testcaseCount,
      failures: aggregate("failures", failureTags, failedCases),
      failedTestcases: failedCases,
      errors: aggregate("errors", errorTags, errorCases),
      erroredTestcases: errorCases,
      suiteErrors: Math.max(0, errorTags - testcaseErrorTags),
      skipped: aggregate("skipped", skippedTags, skippedCases),
      skippedTestcases: skippedCases,
      failedTestNames,
      erroredTestNames,
    };
  } catch {
    return {
      tests: null,
      testcases: null,
      failures: null,
      failedTestcases: null,
      errors: null,
      erroredTestcases: null,
      suiteErrors: null,
      skipped: null,
      skippedTestcases: null,
      failedTestNames: [],
      erroredTestNames: [],
    };
  }
}

function patchTestPassed(result: { code: number }, counts: JUnitCounts, expectation: "all-pass" | "all-fail"): boolean {
  if (
    counts.tests === null ||
    counts.testcases === null ||
    counts.failures === null ||
    counts.failedTestcases === null ||
    counts.errors === null ||
    counts.erroredTestcases === null ||
    counts.suiteErrors === null ||
    counts.skipped === null ||
    counts.skippedTestcases === null ||
    counts.tests <= 0 ||
    counts.testcases <= 0 ||
    counts.testcases !== counts.tests ||
    counts.skipped !== 0 ||
    counts.skippedTestcases !== 0
  ) {
    return false;
  }
  if (expectation === "all-pass") {
    return (
      result.code === 0 &&
      counts.failures === 0 &&
      counts.failedTestcases === 0 &&
      counts.errors === 0 &&
      counts.erroredTestcases === 0 &&
      counts.suiteErrors === 0
    );
  }
  return (
    result.code !== 0 &&
    counts.suiteErrors === 0 &&
    counts.failedTestcases + counts.erroredTestcases === counts.testcases
  );
}

async function runPatchTest(
  phase: PatchPrecheckPhase,
  mode: "base" | "new",
  expectation: "all-pass" | "all-fail",
  workdir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<PatchTestRunResult> {
  const outputPath = `/tmp/shipd-${phase}.xml`;
  const command = `./test.sh --output_path ${quote(outputPath)} ${mode}`;
  await runCommand(`rm -f ${quote(outputPath)}`, workdir, env, 30_000);
  const result = await runCommand(command, workdir, env, timeoutMs);
  const counts = readJUnitCounts(outputPath);
  return {
    phase,
    command,
    exitCode: result.code,
    tests: counts.tests,
    testcases: counts.testcases,
    failures: counts.failures,
    failedTestcases: counts.failedTestcases,
    errors: counts.errors,
    erroredTestcases: counts.erroredTestcases,
    suiteErrors: counts.suiteErrors,
    skipped: counts.skipped,
    skippedTestcases: counts.skippedTestcases,
    failedTestNames: counts.failedTestNames,
    erroredTestNames: counts.erroredTestNames,
    passed: patchTestPassed(result, counts, expectation),
  };
}

function patchPrecheckFailure(result: PatchTestRunResult): string {
  return [
    `${result.phase} did not meet its expectation.`,
    `command: ${result.command}`,
    `exit code: ${result.exitCode}`,
    `tests: ${result.tests ?? "unknown"}, testcases: ${result.testcases ?? "unknown"}, failures: ${result.failures ?? "unknown"} (${result.failedTestcases ?? "unknown"} testcase failures), errors: ${result.errors ?? "unknown"} (${result.erroredTestcases ?? "unknown"} testcase errors, ${result.suiteErrors ?? "unknown"} suite-level), skipped: ${result.skipped ?? "unknown"} (${result.skippedTestcases ?? "unknown"} testcases)`,
    `failed tests: ${result.failedTestNames.length > 0 ? result.failedTestNames.join(", ") : "none"}`,
    `errored tests: ${result.erroredTestNames.length > 0 ? result.erroredTestNames.join(", ") : "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runPatchPrecheck(
  plan: DockerPlan,
  env: NodeJS.ProcessEnv,
  timeoutMinutes: number,
): Promise<PatchPrecheckResult> {
  const started = Date.now();
  const phases: PatchTestRunResult[] = [];
  const workdir = plan.workdir;
  const testPatch = join(workdir, "test.patch");
  const solutionPatch = join(workdir, "solution.patch");
  const testTimeoutMs = Math.max(60_000, timeoutMinutes * 60_000);
  try {
    await requiredCommand(`git -C ${quote(workdir)} apply --recount ${quote(testPatch)}`, "/work", env, 15 * 60_000);
    await requiredCommand(`chmod +x ${quote(join(workdir, "test.sh"))}`, "/work", env, 30_000);

    const beforeBase = await runPatchTest("base-before-solution", "base", "all-pass", workdir, env, testTimeoutMs);
    phases.push(beforeBase);
    if (!beforeBase.passed) {
      return {
        platform: "linux",
        status: "failed",
        passed: false,
        phases,
        durationMs: Date.now() - started,
        error: patchPrecheckFailure(beforeBase),
      };
    }

    const beforeNew = await runPatchTest("new-before-solution", "new", "all-fail", workdir, env, testTimeoutMs);
    phases.push(beforeNew);
    if (!beforeNew.passed) {
      return {
        platform: "linux",
        status: "failed",
        passed: false,
        phases,
        durationMs: Date.now() - started,
        error: patchPrecheckFailure(beforeNew),
      };
    }

    await requiredCommand(
      `git -C ${quote(workdir)} apply --recount ${quote(solutionPatch)}`,
      "/work",
      env,
      15 * 60_000,
    );

    const afterBase = await runPatchTest("base-after-solution", "base", "all-pass", workdir, env, testTimeoutMs);
    phases.push(afterBase);
    if (!afterBase.passed) {
      return {
        platform: "linux",
        status: "failed",
        passed: false,
        phases,
        durationMs: Date.now() - started,
        error: patchPrecheckFailure(afterBase),
      };
    }

    const afterNew = await runPatchTest("new-after-solution", "new", "all-pass", workdir, env, testTimeoutMs);
    phases.push(afterNew);
    if (!afterNew.passed) {
      return {
        platform: "linux",
        status: "failed",
        passed: false,
        phases,
        durationMs: Date.now() - started,
        error: patchPrecheckFailure(afterNew),
      };
    }

    return { platform: "linux", status: "ok", passed: true, phases, durationMs: Date.now() - started };
  } catch (error) {
    return {
      platform: "linux",
      status: "error",
      passed: false,
      phases,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isTestScriptChmod(command: string): boolean {
  const normalized = command.trim().replace(/["']/g, "");
  return /^chmod\s+\S+\s+(?:\S*\/)?test\.sh$/.test(normalized);
}

async function initializeSource(plan: DockerPlan, env: NodeJS.ProcessEnv): Promise<void> {
  const archive = "/tmp/shipd-source.tar.gz";
  if (directS3Enabled()) {
    await downloadObject(requiredEnv("SHIPD_S3_BUCKET"), requiredEnv("SHIPD_S3_SOURCE_KEY"), archive);
  } else {
    await download(requiredEnv("SHIPD_SOURCE_URL"), archive);
  }
  mkdirSync(plan.workdir, { recursive: true });
  await requiredCommand(`tar -xzf ${quote(archive)} -C ${quote(plan.workdir)}`, plan.workdir, env, 15 * 60 * 1000);
  const git = [
    `git config --global --add safe.directory ${quote(plan.workdir)}`,
    `git -C ${quote(plan.workdir)} init -q`,
    `git -C ${quote(plan.workdir)} config user.email solvergap@shipd-checks.local`,
    `git -C ${quote(plan.workdir)} config user.name shipd-checks-source`,
    `git -C ${quote(plan.workdir)} add -A`,
    `git -C ${quote(plan.workdir)} commit -q -m source --allow-empty`,
  ].join("\n");
  await requiredCommand(`set -eu\n${git}`, "/work", env, 15 * 60 * 1000);
  for (const command of plan.runtimeCommands) {
    if (isTestScriptChmod(command)) continue;
    await requiredCommand(command, plan.workdir, env, 15 * 60 * 1000);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dos2unix(path: string): void {
  const content = readFileSync(path, "utf-8");
  writeFileSync(path, content.replace(/\r\n?/g, "\n"), "utf-8");
}

async function prepareSolver(
  index: number,
  plan: DockerPlan,
  env: NodeJS.ProcessEnv,
): Promise<{
  solverDir: string;
  testsAppliedCommit: string;
  testPatchPaths: string[];
}> {
  const solverDir = posixPath.join(SOLVERS_DIR, `solver_${index}`);
  const patchPath = posixPath.join(solverDir, "test.patch");
  const commands = [
    `mkdir -p ${quote(solverDir)}`,
    `tar --exclude=.git --exclude=solution.patch -cf - -C ${quote(plan.workdir)} . | tar --no-same-owner -xf - -C ${quote(solverDir)}`,
    `rm -rf ${quote(posixPath.join(solverDir, ".git"))} ${quote(posixPath.join(solverDir, "solution.patch"))} ${quote(patchPath)}`,
    `git -C ${quote(solverDir)} init -q`,
    `git -C ${quote(solverDir)} config user.email solvergap@shipd-checks.local`,
    `git -C ${quote(solverDir)} config user.name shipd-checks-solver`,
    `git -C ${quote(solverDir)} add -A`,
    `git -C ${quote(solverDir)} commit -q -m baseline --allow-empty`,
    `cp ${quote(posixPath.join(plan.workdir, "test.patch"))} ${quote(patchPath)}`,
    `git -C ${quote(solverDir)} apply --recount ${quote(patchPath)}`,
    `chmod +x ${quote(posixPath.join(solverDir, "test.sh"))}`,
    `rm -f ${quote(patchPath)}`,
    `git -C ${quote(solverDir)} add -A`,
    `git -C ${quote(solverDir)} commit -q -m tests-applied --allow-empty`,
  ];
  await requiredCommand(`set -eu\n${commands.join("\n")}`, "/work", env, 15 * 60 * 1000);
  const testScriptPath = join(solverDir, "test.sh");
  if (existsSync(testScriptPath)) dos2unix(testScriptPath);
  const rev = await requiredCommand(`git -C ${quote(solverDir)} rev-parse HEAD`, "/work", env, 30_000);
  const patch = readFileSync(join(plan.workdir, "test.patch"), "utf-8");
  return { solverDir, testsAppliedCommit: rev.stdout.trim(), testPatchPaths: extractPatchPaths(patch) };
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/gm;
  for (const match of patch.matchAll(header)) {
    if (match[1]) paths.add(match[1]);
    if (match[2]) paths.add(match[2]);
  }
  return [...paths];
}

async function runSolver(
  index: number,
  workspace: Awaited<ReturnType<typeof prepareSolver>>,
  env: NodeJS.ProcessEnv,
): Promise<WorkerSolverResult> {
  const started = Date.now();
  const provider = requiredEnv("SHIPD_PROVIDER");
  const modelId = requiredEnv("SHIPD_MODEL_ID");
  const thinkingLevel = requiredEnv("SHIPD_THINKING_LEVEL") as ThinkingLevel;
  const timeoutMinutes = Number.parseInt(requiredEnv("SHIPD_TIMEOUT_MINUTES"), 10);
  const model = getModel(provider as never, modelId);
  if (!model) {
    return {
      index,
      status: "error",
      passed: false,
      diff: "",
      testOutputTail: `Could not resolve model ${provider}/${modelId}.`,
      error: `Could not resolve model ${provider}/${modelId}.`,
      durationMs: Date.now() - started,
      totalTests: null,
      failedTests: null,
    };
  }

  let outcome: "done" | "timedOut" | "cancelled" | "error" = "error";
  let trajectory: unknown[] = [];
  try {
    const sessionManager = SessionManager.inMemory();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd: workspace.solverDir,
        agentDir: AGENT_DIR,
        model,
        thinkingLevel: thinkingLevel === "off" ? undefined : (thinkingLevel as never),
        tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
        sessionManager,
      }));
      const prompt = session.prompt(buildSolverPrompt());
      void prompt.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("__SHIPD_SOLVER_TIMEOUT__")), timeoutMinutes * 60 * 1000);
      });
      try {
        await Promise.race([prompt, timeout]);
        outcome = "done";
      } catch (error) {
        if (error instanceof Error && error.message === "__SHIPD_SOLVER_TIMEOUT__") {
          outcome = "timedOut";
          await session.abort().catch(() => undefined);
        } else {
          throw error;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      trajectory = sessionManager.getEntries();
      if (session) {
        try {
          session.dispose();
        } catch {
          // Preserve the solver result.
        }
      }
    }
  } catch (error) {
    return {
      index,
      status: "error",
      passed: false,
      diff: "",
      testOutputTail: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
      totalTests: null,
      failedTests: null,
      trajectory,
    };
  }

  const exclude = [...workspace.testPatchPaths, "agent_prompt.md"].map((path) => `:(exclude)${path}`);
  const diff = await runCommand(
    `git add -A && git diff --cached ${quote(workspace.testsAppliedCommit)} -- . ${exclude.map(quote).join(" ")}`,
    workspace.solverDir,
    env,
    30_000,
  );
  const outputPath = join(workspace.solverDir, "test_output.xml");
  const test = await runCommand(
    `bash test.sh --output_path ${quote(outputPath)} new`,
    workspace.solverDir,
    env,
    (timeoutMinutes + 5) * 60 * 1000,
  );
  const testOutput = `${test.stdout}\n${test.stderr}`.trim();
  writeFileSync(join(workspace.solverDir, "test_output.txt"), testOutput, "utf-8");
  writeFileSync(join(workspace.solverDir, "trajectory.json"), `${JSON.stringify(trajectory, null, 2)}\n`, "utf-8");
  const counts = readTestCounts(outputPath);
  const status: SolverRunResult["status"] = outcome === "done" ? "ok" : outcome;
  return {
    index,
    status,
    passed: status === "ok" && test.code === 0,
    diff: diff.code === 0 ? diff.stdout : "",
    testOutputTail: tail(testOutput),
    durationMs: Date.now() - started,
    totalTests: counts.totalTests,
    failedTests: counts.failedTests,
    trajectory,
  };
}

function readTestCounts(path: string): { totalTests: number | null; failedTests: number | null } {
  try {
    const tag = readFileSync(path, "utf-8").match(/<testsuites\b[^>]*>/i)?.[0];
    if (!tag) return { totalTests: null, failedTests: null };
    const get = (name: string) => Number.parseInt(tag.match(new RegExp(`\\b${name}="(\\d+)"`, "i"))?.[1] ?? "", 10);
    const totalTests = get("tests");
    const failures = get("failures");
    const errors = get("errors");
    return {
      totalTests: Number.isFinite(totalTests) ? totalTests : null,
      failedTests: Number.isFinite(failures) ? failures + (Number.isFinite(errors) ? errors : 0) : null,
    };
  } catch {
    return { totalTests: null, failedTests: null };
  }
}

async function run(): Promise<void> {
  const mode = loadBootstrap();
  const resultUrl = process.env.SHIPD_RESULT_PUT_URL ?? "";
  const resultGetUrl = process.env.SHIPD_RESULT_GET_URL ?? "";
  const resourceProfile = requiredEnv("SHIPD_RESOURCE_PROFILE") as FargateResourceProfile;
  activeResourceUsage = new TaskResourceUsageSampler(resourceProfile);
  activeResourceUsage.start();
  const existing = await readExistingResult(resultGetUrl);
  const completed = new Map((existing?.results ?? []).map((result) => [result.index, result]));
  const plan = planFromEnv();
  const env = resolvedEnvironment(plan);
  if (mode === "solver") {
    mkdirSync(AGENT_DIR, { recursive: true });
    if (directS3Enabled()) {
      await downloadObject(
        requiredEnv("SHIPD_S3_BUCKET"),
        requiredEnv("SHIPD_S3_AUTH_KEY"),
        join(AGENT_DIR, "auth.json"),
      );
    } else {
      await download(requiredEnv("SHIPD_AUTH_URL"), join(AGENT_DIR, "auth.json"));
    }
    // The host settings may point at a Windows shell. Force the Linux shell
    // used by the Fargate task without changing the user's local settings.
    writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ shellPath: "/bin/bash" }), "utf-8");
  }
  mkdirSync("/work", { recursive: true });
  await initializeSource(plan, env);
  const sourcePatchPath = join(plan.workdir, "test.patch");
  const solutionPatchPath = join(plan.workdir, "solution.patch");
  if (existsSync(sourcePatchPath)) dos2unix(sourcePatchPath);
  if (existsSync(solutionPatchPath)) dos2unix(solutionPatchPath);

  if (mode === "patch-precheck") {
    const timeoutMinutes = Number.parseInt(requiredEnv("SHIPD_TIMEOUT_MINUTES"), 10);
    const precheck = await runPatchPrecheck(plan, env, timeoutMinutes);
    const resourceUsage = activeResourceUsage.stop();
    await upload(resultUrl, { complete: true, results: [], precheck, resourceUsage });
    return;
  }

  const solverCount = Math.max(1, Number.parseInt(requiredEnv("SHIPD_SOLVER_COUNT"), 10));
  mkdirSync(SOLVERS_DIR, { recursive: true });
  const pendingIndexes = Array.from({ length: solverCount }, (_, index) => index + 1).filter(
    (index) => !completed.has(index),
  );
  // Prepare the git worktrees serially. Git writes config and object files while
  // initializing each repository; the solver sessions themselves remain concurrent.
  const workspaces: Array<Awaited<ReturnType<typeof prepareSolver>>> = [];
  for (const index of pendingIndexes) workspaces.push(await prepareSolver(index, plan, env));
  let uploadChain = Promise.resolve();
  const record = (result: WorkerSolverResult): Promise<void> => {
    completed.set(result.index, result);
    const snapshot = [...completed.values()].sort((a, b) => a.index - b.index);
    uploadChain = uploadChain.then(() =>
      upload(resultUrl, {
        complete: false,
        results: snapshot,
        resourceUsage: activeResourceUsage?.snapshot(),
      }),
    );
    return uploadChain;
  };
  await Promise.all(
    workspaces.map(async (workspace, index) => {
      const solverIndex = pendingIndexes[index];
      if (solverIndex === undefined) throw new Error("Fargate solver workspace index mismatch.");
      const result = await runSolver(solverIndex, workspace, env);
      await record(result);
    }),
  );
  await uploadChain;
  const results = [...completed.values()].sort((a, b) => a.index - b.index);
  const resourceUsage = activeResourceUsage?.stop();
  await upload(resultUrl, { complete: true, results, resourceUsage });
}

async function readExistingResult(url: string): Promise<WorkerPayload | undefined> {
  try {
    if (directS3Enabled()) {
      const response = await workerS3().send(
        new GetObjectCommand({
          Bucket: requiredEnv("SHIPD_S3_BUCKET"),
          Key: requiredEnv("SHIPD_S3_RESULT_KEY"),
        }),
      );
      const body = await response.Body?.transformToString();
      return body ? (JSON.parse(body) as WorkerPayload) : undefined;
    }
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return (await response.json()) as WorkerPayload;
  } catch {
    return undefined;
  }
}

run().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const resourceUsage = activeResourceUsage?.stop();
  try {
    const url = process.env.SHIPD_RESULT_PUT_URL ?? "";
    const getUrl = process.env.SHIPD_RESULT_GET_URL ?? "";
    const existing = getUrl || directS3Enabled() ? await readExistingResult(getUrl) : undefined;
    if (url || directS3Enabled())
      await upload(url, { complete: true, results: existing?.results ?? [], resourceUsage, error: message });
  } catch {
    // The task exit status still exposes the failure when result upload fails.
  }
  console.error(message);
  process.exitCode = 1;
});
