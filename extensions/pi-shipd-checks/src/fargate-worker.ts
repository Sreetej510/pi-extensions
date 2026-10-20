import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix as posixPath } from "node:path";
import { gzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { XMLParser } from "fast-xml-parser";
import { TaskResourceUsageSampler } from "./resource-usage.js";
import type {
  FargateResourceProfile,
  FargateResourceUsage,
  PatchPrecheckPhase,
  PatchPrecheckResult,
  PatchTestRunResult,
  SolverRunResult,
  SolverTestResult,
  TokenUsage,
} from "./types.js";

type DockerPlan = {
  baseImage: string;
  workdir: string;
  env: Record<string, string>;
  runtimeCommands: string[];
};

type WorkerSolverResult = SolverRunResult & {
  /** Compressed JSONL event stream, transferred to the host for artifact persistence. */
  agentStepsGzipBase64?: string;
};

type WorkerMode = "solver" | "patch-precheck";

type WorkerPayload = {
  complete: boolean;
  results: WorkerSolverResult[];
  phase?: string;
  precheck?: PatchPrecheckResult;
  resourceUsage?: FargateResourceUsage;
  error?: string;
};

let activeResourceUsage: TaskResourceUsageSampler | undefined;
let taskPrompt = "";
let testPatchSource: { kind: "url"; value: string } | { kind: "s3"; bucket: string; key: string } | undefined;
let testPatchContent: Promise<string> | undefined;

const CLAUDE_CONFIG_DIR = "/opt/shipd-claude";
const SOLVERS_DIR = "/work/solvers";
const TAIL_CHARS = 4000;
const WORKSPACE_PYTHON_WRAPPER = [
  "#!/usr/bin/env bash",
  'if [[ -d "$SHIPD_WORKSPACE_ROOT/src" ]]; then',
  '  export PYTHONPATH="$SHIPD_WORKSPACE_ROOT/src$' + '{PYTHONPATH:+:$PYTHONPATH}"',
  "fi",
  'exec /usr/local/bin/python "$@"',
].join("\n");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker environment variable ${name}.`);
  return value;
}

function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text;
}

function loadBootstrap(): WorkerMode {
  chmodSync("/tmp/shipd-bootstrap.json", 0o600);
  const bootstrap = JSON.parse(readFileSync("/tmp/shipd-bootstrap.json", "utf-8")) as Record<string, unknown>;
  rmSync("/tmp/shipd-bootstrap.json", { force: true });
  delete process.env.SHIPD_BOOTSTRAP_URL;
  const mode = bootstrap.mode;
  if (mode !== "solver" && mode !== "patch-precheck") throw new Error("Invalid Fargate bootstrap mode.");
  process.env.SHIPD_MODE = mode;

  const directKeys =
    mode === "solver"
      ? ["bucket", "region", "sourceKey", "authKey", "testPatchKey", "resultKey"]
      : ["bucket", "region", "sourceKey", "resultKey"];
  const directS3 = directKeys.every((key) => typeof bootstrap[key] === "string" && bootstrap[key]);
  if (mode === "solver") {
    if (typeof bootstrap.taskPrompt !== "string" || bootstrap.taskPrompt.length === 0)
      throw new Error("Invalid Fargate bootstrap field: taskPrompt.");
    taskPrompt = bootstrap.taskPrompt;
    if (directS3) {
      testPatchSource = {
        kind: "s3",
        bucket: String(bootstrap.bucket),
        key: String(bootstrap.testPatchKey),
      };
    } else if (typeof bootstrap.testPatchUrl === "string" && bootstrap.testPatchUrl.length > 0) {
      testPatchSource = { kind: "url", value: bootstrap.testPatchUrl };
    } else {
      throw new Error("Missing Fargate bootstrap testPatchUrl.");
    }
  }
  const stringValues = ["planB64", "resourceProfile", ...(mode === "solver" ? ["modelId", "thinkingLevel"] : [])];
  const envNames: Record<string, string> = {
    planB64: "SHIPD_PLAN_B64",
    resourceProfile: "SHIPD_RESOURCE_PROFILE",
    modelId: "SHIPD_CLAUDE_MODEL",
    thinkingLevel: "SHIPD_CLAUDE_EFFORT",
  };
  if (directS3) {
    const directFields = [
      ["bucket", "SHIPD_S3_BUCKET"],
      ["region", "SHIPD_S3_REGION"],
      ["sourceKey", "SHIPD_S3_SOURCE_KEY"],
      ...(mode === "solver" ? [["authKey", "SHIPD_S3_AUTH_KEY"]] : []),
      ...(mode === "solver" ? [["testPatchKey", "SHIPD_S3_TEST_PATCH_KEY"]] : []),
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
  if (mode === "solver" && !["low", "medium", "high", "xhigh", "max"].includes(requiredEnv("SHIPD_CLAUDE_EFFORT")))
    throw new Error("Invalid Claude CLI thinking level.");
  const numericFields = [
    ["timeoutMinutes", "SHIPD_TIMEOUT_MINUTES"],
    ...(mode === "solver"
      ? [
          ["agentTimeoutMinutes", "SHIPD_AGENT_TIMEOUT_MINUTES"],
          ["solverCount", "SHIPD_SOLVER_COUNT"],
        ]
      : []),
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

async function loadTestPatch(): Promise<string> {
  const source = testPatchSource;
  if (!source) throw new Error("The harness test patch is unavailable.");
  testPatchContent ??= (async () => {
    if (source.kind === "s3") {
      const response = await workerS3().send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
      const text = await response.Body?.transformToString();
      if (!text) throw new Error("The harness test patch was empty.");
      return text;
    }
    const response = await fetch(source.value);
    if (!response.ok) throw new Error(`Downloading the harness test patch failed (${response.status}).`);
    const text = await response.text();
    if (!text) throw new Error("The harness test patch was empty.");
    return text;
  })();
  return await testPatchContent;
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
  identity?: { uid: number; gid: number },
  stdinInput?: string,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    });
    child.stdin?.end(stdinInput);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { code: number; stdout: string; stderr: string; timedOut: boolean }) => {
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
    child.once("close", (code) => finish({ code: code ?? 1, stdout, stderr, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
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
  stdinInput?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runCommand(command, cwd, env, timeoutMs, undefined, stdinInput);
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
  passedTestcases: number | null;
  errors: number | null;
  erroredTestcases: number | null;
  suiteErrors: number | null;
  collectionErrors: number | null;
  skipped: number | null;
  skippedTestcases: number | null;
  skippedTestNames: string[];
  failedTestNames: string[];
  erroredTestNames: string[];
  failureDetails: string[];
  passedTestNames: string[];
  collectionErrorNames: string[];
}

type XmlNode = Record<string, unknown>;

const junitParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
});

function asXmlNode(value: unknown): XmlNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as XmlNode) : undefined;
}

function asXmlNodes(value: unknown): XmlNode[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (item === undefined || item === null) return [];
    const node = asXmlNode(item);
    return node ? [node] : [{ "#text": String(item) }];
  });
}

function xmlChildNodes(node: XmlNode | undefined, name: string): XmlNode[] {
  return asXmlNodes(node?.[name]);
}

function xmlAttribute(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

function xmlNumber(node: XmlNode | undefined, name: string): number | null {
  const value = xmlAttribute(node, name);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectSuiteNodes(node: XmlNode): XmlNode[] {
  return xmlChildNodes(node, "testsuite").flatMap((suite) => [suite, ...collectSuiteNodes(suite)]);
}

function testCaseName(caseNode: XmlNode, index: number): string {
  const name = xmlAttribute(caseNode, "name") ?? `testcase-${index + 1}`;
  const classname = xmlAttribute(caseNode, "classname");
  return classname ? `${classname}::${name}` : name;
}

function isCollectionError(caseNode: XmlNode): boolean {
  const errors = xmlChildNodes(caseNode, "error");
  if (errors.length === 0) return false;
  const classname = xmlAttribute(caseNode, "classname");
  return (
    errors.some((error) => {
      const message = `${xmlAttribute(error, "message") ?? ""} ${String(error["#text"] ?? "")}`;
      return /collection\s+failure/i.test(message);
    }) ||
    classname === undefined ||
    classname.trim().length === 0
  );
}

function xmlDiagnostic(node: XmlNode): string {
  const message = xmlAttribute(node, "message")?.trim();
  if (message) return message.slice(0, 500);
  const text = String(node["#text"] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return (text ?? "unknown failure").slice(0, 500);
}

function normalizePytestNodeId(nodeId: string): string {
  const separator = nodeId.indexOf("::");
  if (separator < 0) return nodeId;
  const file = nodeId
    .slice(0, separator)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.py$/, "")
    .replace(/\//g, ".");
  return `${file}::${nodeId.slice(separator + 2)}`;
}

function parsePassedTestNames(output: string): string[] {
  const names = [
    ...output.matchAll(/^\s*(.+?)\s+PASSED(?:\s+\[[^\]]+\])?\s*$/gim),
    ...output.matchAll(/^\s*\[gw\d+\]\s+(?:\[[^\]]+\]\s+)?PASSED\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/gim),
    ...output.matchAll(/^\s*PASSED\s+(.+?)\s*$/gim),
  ].map((match) => normalizePytestNodeId(match[1]?.trim() ?? ""));
  return [...new Set(names.filter((name) => name.includes("::")))];
}

function parsePassedSubtestNames(output: string): string[] {
  const names = [
    ...output.matchAll(/^\s*\[gw\d+\]\s+(?:\[[^\]]+\]\s+)?SUBPASSED\([^)]*\)\s+(.+?)\s*$/gim),
    ...output.matchAll(/^\s*SUBPASSED\([^)]*\)\s+(.+?)\s*$/gim),
  ].map((match) => normalizePytestNodeId(match[1]?.trim() ?? ""));
  return [...new Set(names.filter((name) => name.includes("::")))];
}

function testNodeIdsEquivalent(first: string, second: string): boolean {
  if (first === second) return true;
  const firstParts = first.split("::");
  const secondParts = second.split("::");
  if (firstParts.length >= 3 && secondParts.length === 2) {
    const classPath = firstParts.slice(1, -1).join(".");
    return secondParts[0] === `${firstParts[0]}.${classPath}` && secondParts[1] === firstParts.at(-1);
  }
  if (firstParts.length === 2 && secondParts.length === 3) return testNodeIdsEquivalent(second, first);
  return false;
}

function readJUnitCounts(path: string): JUnitCounts {
  try {
    const xml = readFileSync(path, "utf-8");
    const document = junitParser.parse(xml) as XmlNode;
    const reportRoot = asXmlNodes(document.testsuites)[0];
    const directSuiteRoot = asXmlNodes(document.testsuite)[0];
    const suites = reportRoot
      ? collectSuiteNodes(reportRoot)
      : directSuiteRoot
        ? [directSuiteRoot, ...collectSuiteNodes(directSuiteRoot)]
        : [];
    const testcases = suites.flatMap((suite) => xmlChildNodes(suite, "testcase"));
    if (testcases.length === 0 && reportRoot) testcases.push(...xmlChildNodes(reportRoot, "testcase"));
    const testcaseCount = testcases.length;
    const failedTestNames = testcases.flatMap((caseNode, index) =>
      xmlChildNodes(caseNode, "failure").length > 0 ? [testCaseName(caseNode, index)] : [],
    );
    const erroredTestNames = testcases.flatMap((caseNode, index) =>
      xmlChildNodes(caseNode, "error").length > 0 ? [testCaseName(caseNode, index)] : [],
    );
    const failureDetails = [
      ...testcases.flatMap((caseNode) => xmlChildNodes(caseNode, "failure").map(xmlDiagnostic)),
      ...testcases.flatMap((caseNode) => xmlChildNodes(caseNode, "error").map(xmlDiagnostic)),
      ...suites.flatMap((suite) => xmlChildNodes(suite, "failure").map(xmlDiagnostic)),
      ...suites.flatMap((suite) => xmlChildNodes(suite, "error").map(xmlDiagnostic)),
      ...(reportRoot ? xmlChildNodes(reportRoot, "failure").map(xmlDiagnostic) : []),
      ...(reportRoot ? xmlChildNodes(reportRoot, "error").map(xmlDiagnostic) : []),
    ];
    const passedTestNames = testcases.flatMap((caseNode, index) =>
      xmlChildNodes(caseNode, "failure").length === 0 &&
      xmlChildNodes(caseNode, "error").length === 0 &&
      xmlChildNodes(caseNode, "skipped").length === 0
        ? [testCaseName(caseNode, index)]
        : [],
    );
    const skippedTestNames = testcases.flatMap((caseNode, index) =>
      xmlChildNodes(caseNode, "skipped").length > 0 ? [testCaseName(caseNode, index)] : [],
    );
    const failedCases = failedTestNames.length;
    const errorCases = erroredTestNames.length;
    const collectionErrorNames = testcases.flatMap((caseNode, index) =>
      isCollectionError(caseNode) ? [testCaseName(caseNode, index)] : [],
    );
    const collectionErrors = collectionErrorNames.length;
    const skippedCases = skippedTestNames.length;
    const testcaseFailureTags = testcases.reduce(
      (count, caseNode) => count + xmlChildNodes(caseNode, "failure").length,
      0,
    );
    const testcaseErrorTags = testcases.reduce((count, caseNode) => count + xmlChildNodes(caseNode, "error").length, 0);
    const testcaseSkippedTags = testcases.reduce(
      (count, caseNode) => count + xmlChildNodes(caseNode, "skipped").length,
      0,
    );
    const suiteFailureTags = suites.reduce((count, suite) => count + xmlChildNodes(suite, "failure").length, 0);
    const suiteErrorTags = suites.reduce((count, suite) => count + xmlChildNodes(suite, "error").length, 0);
    const suiteSkippedTags = suites.reduce((count, suite) => count + xmlChildNodes(suite, "skipped").length, 0);
    const reportFailureTags = reportRoot ? xmlChildNodes(reportRoot, "failure").length : 0;
    const reportErrorTags = reportRoot ? xmlChildNodes(reportRoot, "error").length : 0;
    const reportSkippedTags = reportRoot ? xmlChildNodes(reportRoot, "skipped").length : 0;
    const failureTags = testcaseFailureTags + suiteFailureTags + reportFailureTags;
    const errorTags = testcaseErrorTags + suiteErrorTags + reportErrorTags;
    const skippedTags = testcaseSkippedTags + suiteSkippedTags + reportSkippedTags;
    const sumSuite = (name: string, fallback: number) => {
      const values = suites.map((suite) => xmlNumber(suite, name)).filter((value): value is number => value !== null);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : fallback;
    };
    const aggregate = (name: string, tags: number, fallback: number) =>
      Math.max(xmlNumber(reportRoot, name) ?? sumSuite(name, fallback), tags);
    const tests = xmlNumber(reportRoot, "tests") ?? sumSuite("tests", testcaseCount);
    const failures = aggregate("failures", failureTags, failedCases);
    const errors = aggregate("errors", errorTags, errorCases);
    const skipped = aggregate("skipped", skippedTags, skippedCases);
    // Derive passes from report totals for all-pass suites. For the
    // pre-solution all-fail invariant, runPatchTest replaces this with the
    // explicit passed testcase/subtest records so pytest subtest totals cannot
    // manufacture passing tests.
    const passedCases = tests >= failures + errors + skipped ? tests - failures - errors - skipped : null;
    return {
      tests,
      testcases: testcaseCount,
      failures,
      failedTestcases: failedCases,
      passedTestcases: passedCases,
      errors,
      erroredTestcases: errorCases,
      suiteErrors: Math.max(0, errorTags - testcaseErrorTags),
      collectionErrors,
      skipped,
      skippedTestcases: skippedCases,
      skippedTestNames,
      failedTestNames,
      erroredTestNames,
      failureDetails: [...new Set(failureDetails)],
      passedTestNames,
      collectionErrorNames,
    };
  } catch {
    return {
      tests: null,
      testcases: null,
      failures: null,
      failedTestcases: null,
      passedTestcases: null,
      errors: null,
      erroredTestcases: null,
      suiteErrors: null,
      collectionErrors: null,
      skipped: null,
      skippedTestcases: null,
      skippedTestNames: [],
      failedTestNames: [],
      erroredTestNames: [],
      failureDetails: [],
      passedTestNames: [],
      collectionErrorNames: [],
    };
  }
}

function patchTestPassed(counts: JUnitCounts, expectation: "all-pass" | "all-fail", allowSkipped: boolean): boolean {
  if (
    counts.tests === null ||
    counts.testcases === null ||
    counts.failures === null ||
    counts.failedTestcases === null ||
    counts.passedTestcases === null ||
    counts.errors === null ||
    counts.erroredTestcases === null ||
    counts.suiteErrors === null ||
    counts.collectionErrors === null ||
    counts.skipped === null ||
    counts.skippedTestcases === null ||
    counts.tests <= 0 ||
    counts.testcases <= 0 ||
    // pytest's junitxml counts pytest-subtests in the declared suite total but
    // does not emit one <testcase> node for every subtest. Parsed testcase
    // records may therefore be fewer than the declared total, but never more.
    counts.testcases > counts.tests ||
    (!allowSkipped && (counts.skipped !== 0 || counts.skippedTestcases !== 0)) ||
    counts.suiteErrors !== 0 ||
    counts.collectionErrors !== 0
  ) {
    return false;
  }
  if (expectation === "all-pass") {
    return (
      counts.failures === 0 &&
      counts.failedTestcases === 0 &&
      counts.errors === 0 &&
      counts.erroredTestcases === 0 &&
      counts.suiteErrors === 0 &&
      counts.failures + counts.errors + counts.skipped + counts.passedTestcases === counts.tests
    );
  }
  // Pytest can add subtest records to suite-level totals while still emitting
  // one failed <testcase> node for the enclosing method. For the pre-solution
  // invariant, trust the emitted testcase statuses and explicit SUBPASSED lines
  // rather than deriving passes from aggregate totals.
  return (
    counts.passedTestcases === 0 &&
    counts.failedTestcases + counts.erroredTestcases === counts.testcases &&
    counts.failedTestcases + counts.erroredTestcases > 0 &&
    counts.failures + counts.errors > 0
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
  const testEnv: NodeJS.ProcessEnv = {
    ...env,
    SHIPD_WORKSPACE_ROOT: workdir,
    PATH: `${join(workdir, ".shipd-bin")}:${env.PATH ?? ""}`,
  };
  await runCommand(`rm -f ${quote(outputPath)}`, workdir, testEnv, 30_000);
  const result = await runCommand(command, workdir, testEnv, timeoutMs);
  const counts = readJUnitCounts(outputPath);
  const output = `${result.stdout}\n${result.stderr}`;
  const reportedPassedTestNames = [...new Set([...counts.passedTestNames, ...parsePassedTestNames(output)])];
  const passedSubtestNames = parsePassedSubtestNames(output);
  const nonPassingTestNames = [...counts.failedTestNames, ...counts.erroredTestNames];
  const partiallyPassedTestNames = reportedPassedTestNames.filter((name) =>
    nonPassingTestNames.some((failedName) => testNodeIdsEquivalent(name, failedName)),
  );
  const passedTestNames = [
    ...new Set([
      ...reportedPassedTestNames.filter((name) => !partiallyPassedTestNames.includes(name)),
      ...passedSubtestNames,
    ]),
  ];
  const passedTestcases = expectation === "all-fail" ? passedTestNames.length : counts.passedTestcases;
  const effectiveCounts = expectation === "all-fail" ? { ...counts, passedTestcases } : counts;
  return {
    phase,
    exitCode: result.code,
    tests: counts.tests,
    testcases: counts.testcases,
    failures: counts.failures,
    failedTestcases: counts.failedTestcases,
    passedTestcases,
    errors: counts.errors,
    erroredTestcases: counts.erroredTestcases,
    suiteErrors: counts.suiteErrors,
    collectionErrors: counts.collectionErrors,
    skipped: counts.skipped,
    skippedTestcases: counts.skippedTestcases,
    skippedTestNames: counts.skippedTestNames,
    failedTestNames: counts.failedTestNames,
    erroredTestNames: counts.erroredTestNames,
    failureDetails: counts.failureDetails,
    passedTestNames,
    partiallyPassedTestNames,
    collectionErrorNames: counts.collectionErrorNames,
    passed: patchTestPassed(effectiveCounts, expectation, mode === "base"),
  };
}

function patchPhaseLabel(phase: PatchPrecheckPhase): string {
  switch (phase) {
    case "base-before-solution":
      return "base tests before solution";
    case "new-before-solution":
      return "new tests before solution";
    case "base-after-solution":
      return "base tests after solution";
    case "new-after-solution":
      return "new tests after solution";
  }
}

function patchPrecheckInstruction(result: PatchTestRunResult): string {
  if (result.skippedTestcases !== null && result.skippedTestcases > 0) {
    if (result.phase === "new-before-solution") {
      return "Fix test.patch so every new test executes and fails or errors individually before the solution. Do not skip, xfail, deselect, or remove tests.";
    }
    if (result.phase === "new-after-solution") {
      return "Fix solution.patch so every new test executes and passes after the solution. Do not skip, xfail, deselect, or remove tests.";
    }
    return "Fix test.sh or solution.patch so every base test passes or skips with no failures or errors.";
  }

  if (result.phase === "new-before-solution") {
    if (result.passedTestcases !== null && result.passedTestcases > 0) {
      return "Fix test.patch: add an assertion inside each passing new test case or subtest for behavior introduced by the solution, so it fails before the solution and passes only after it. Do not remove tests.";
    }
    if (result.collectionErrors !== null && result.collectionErrors > 0) {
      return "Fix test.patch: each new test must fail or error individually before the solution. Do not rely on a whole-file, module, or import error; move solution-dependent imports or setup into each test (lazy import) so every testcase is collected and reports its own failure or error. Do not remove tests.";
    }
    if (result.passedTestcases === 0 && result.failedTestcases === 0 && result.erroredTestcases === 0) {
      return "Fix test.patch: each new test must fail or error individually before the solution. Do not rely on a whole-file, module, or import error; move solution-dependent imports or setup into each test (lazy import) so every testcase is collected and reports its own failure or error. Do not remove tests.";
    }
    return "Fix test.patch so every collected new test fails or errors individually before the solution; no new test may pass. Do not remove tests.";
  }

  switch (result.phase) {
    case "base-before-solution":
      return "Modify test.sh to exclude the pre solution failing tests, so every base test passes before the solution with no failures or errors.";
    case "base-after-solution":
      return "Base-test regression: fix solution.patch so every existing base test still passes after the solution. Do not delete, skip, deselect, weaken, or exclude base tests.";
    case "new-after-solution":
      if (result.skippedTestcases !== null && result.skippedTestcases > 0) {
        return "Fix solution.patch so every new test executes and passes after the solution. Do not skip, xfail, deselect, delete, or weaken new tests.";
      }
      return "Fix solution.patch so every new test passes after the solution with no failures or errors.";
  }
}

function patchPrecheckFailure(result: PatchTestRunResult): string {
  return [
    `phase: ${patchPhaseLabel(result.phase)}`,
    `instruction: ${patchPrecheckInstruction(result)}`,
    `passed tests: ${result.passedTestcases ?? "unknown"}`,
    `skipped tests: ${result.skippedTestcases ?? "unknown"}`,
    ...((result.skippedTestcases ?? 0) > 0
      ? [`skipped test names: ${result.skippedTestNames.length > 0 ? result.skippedTestNames.join(", ") : "unknown"}`]
      : []),
    ...(result.phase !== "new-before-solution" && result.failureDetails.length > 0
      ? [`failure details: ${result.failureDetails.join(" | ")}`]
      : []),
    ...(result.phase === "new-before-solution" && result.partiallyPassedTestNames.length > 0
      ? [`reported passed tests that also failed: ${result.partiallyPassedTestNames.join(", ")}`]
      : []),
    ...(result.phase === "new-before-solution" && (result.passedTestcases ?? 0) > 0
      ? [
          `passing tests: ${result.passedTestNames.length > 0 ? result.passedTestNames.join(", ") : "none"}`,
          `failed tests: ${result.failedTestNames.length > 0 ? result.failedTestNames.join(", ") : "none"}`,
          `errored tests: ${result.erroredTestNames.length > 0 ? result.erroredTestNames.join(", ") : "none"}`,
        ]
      : [
          `failed tests: ${result.failedTestNames.length > 0 ? result.failedTestNames.join(", ") : "none"}`,
          `errored tests: ${result.erroredTestNames.length > 0 ? result.erroredTestNames.join(", ") : "none"}`,
        ]),
    `collection errors: ${result.collectionErrorNames.length > 0 ? result.collectionErrorNames.join(", ") : "none"}`,
  ].join("\n");
}

async function applyPrecheckPatch(
  patchPath: string,
  label: "test" | "solution",
  workdir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await requiredCommand(`git -C ${quote(workdir)} apply --recount ${quote(patchPath)}`, "/work", env, 15 * 60_000);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} patch could not be applied.${detail ? `\n${detail}` : ""}`);
  }
}

async function runPatchTestsInParallel(
  first: Promise<PatchTestRunResult>,
  second: Promise<PatchTestRunResult>,
): Promise<[PatchTestRunResult, PatchTestRunResult]> {
  const results = await Promise.allSettled([first, second]);
  const firstResult = results[0];
  const secondResult = results[1];
  if (firstResult.status === "rejected") throw firstResult.reason;
  if (secondResult.status === "rejected") throw secondResult.reason;
  return [firstResult.value, secondResult.value];
}

async function clonePrecheckWorkspace(
  sourceWorkdir: string,
  destination: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const wrapperDir = join(destination, ".shipd-bin");
  const pythonWrapper = join(wrapperDir, "python");
  await requiredCommand(
    [
      "set -euo pipefail",
      `rm -rf ${quote(destination)}`,
      `mkdir -p ${quote(destination)} ${quote(wrapperDir)}`,
      `tar -cf - -C ${quote(sourceWorkdir)} . | tar --no-same-owner -xf - -C ${quote(destination)}`,
      `git config --global --add safe.directory ${quote(destination)}`,
      `chmod +x ${quote(join(destination, "test.sh"))}`,
      `printf %s ${quote(WORKSPACE_PYTHON_WRAPPER)} > ${quote(pythonWrapper)}`,
      `cp ${quote(pythonWrapper)} ${quote(join(wrapperDir, "python3"))}`,
      `cp ${quote(pythonWrapper)} ${quote(join(wrapperDir, "python3.12"))}`,
      `chmod +x ${quote(pythonWrapper)} ${quote(join(wrapperDir, "python3"))} ${quote(join(wrapperDir, "python3.12"))}`,
    ].join("\n"),
    "/work",
    env,
    15 * 60_000,
  );
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
  const withoutSolutionWorkdir = "/tmp/shipd-precheck-without-solution";
  const withSolutionWorkdir = "/tmp/shipd-precheck-with-solution";
  const testTimeoutMs = Math.max(60_000, timeoutMinutes * 60_000);
  const failedResult = (failed: PatchTestRunResult, phases: PatchTestRunResult[]): PatchPrecheckResult => ({
    platform: "linux",
    status: "failed",
    passed: false,
    phases,
    durationMs: Date.now() - started,
    error: patchPrecheckFailure(failed),
  });

  try {
    await applyPrecheckPatch(testPatch, "test", workdir, env);
    await requiredCommand(`chmod +x ${quote(join(workdir, "test.sh"))}`, "/work", env, 30_000);
    await clonePrecheckWorkspace(workdir, withoutSolutionWorkdir, env);
    await clonePrecheckWorkspace(workdir, withSolutionWorkdir, env);
    await applyPrecheckPatch(join(withSolutionWorkdir, "solution.patch"), "solution", withSolutionWorkdir, env);

    // Keep the two repository states isolated: base and new are run in the
    // same state-specific directory, while the two states run concurrently.
    const [beforeBase, afterBase] = await runPatchTestsInParallel(
      runPatchTest("base-before-solution", "base", "all-pass", withoutSolutionWorkdir, env, testTimeoutMs),
      runPatchTest("base-after-solution", "base", "all-pass", withSolutionWorkdir, env, testTimeoutMs),
    );
    phases.push(beforeBase, afterBase);
    if (!beforeBase.passed) return failedResult(beforeBase, phases);
    if (!afterBase.passed) return failedResult(afterBase, phases);

    const [beforeNew, afterNew] = await runPatchTestsInParallel(
      runPatchTest("new-before-solution", "new", "all-fail", withoutSolutionWorkdir, env, testTimeoutMs),
      runPatchTest("new-after-solution", "new", "all-pass", withSolutionWorkdir, env, testTimeoutMs),
    );
    phases.length = 0;
    phases.push(beforeBase, beforeNew, afterBase, afterNew);
    if (!beforeNew.passed) return failedResult(beforeNew, phases);
    if (!afterNew.passed) return failedResult(afterNew, phases);

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
  } finally {
    await runCommand(
      `rm -rf ${quote(withoutSolutionWorkdir)} ${quote(withSolutionWorkdir)}`,
      "/work",
      env,
      30_000,
    ).catch(() => undefined);
  }
}

function isTestScriptChmod(command: string): boolean {
  const normalized = command.trim().replace(/["']/g, "");
  return /^chmod\s+\S+\s+(?:\S*\/)?test\.sh$/.test(normalized);
}

async function initializeSource(plan: DockerPlan, env: NodeJS.ProcessEnv, installClaudeCli: boolean): Promise<void> {
  const archive = "/tmp/shipd-source.tar.gz";
  if (directS3Enabled()) {
    await downloadObject(requiredEnv("SHIPD_S3_BUCKET"), requiredEnv("SHIPD_S3_SOURCE_KEY"), archive);
  } else {
    await download(requiredEnv("SHIPD_SOURCE_URL"), archive);
  }
  mkdirSync(plan.workdir, { recursive: true });
  const cleanWorkdir =
    plan.workdir === "/" ? ":" : `find ${quote(plan.workdir)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`;
  await requiredCommand(
    `set -eu\n${cleanWorkdir}\ntar --overwrite -xzf ${quote(archive)} -C ${quote(plan.workdir)}`,
    "/work",
    env,
    15 * 60 * 1000,
  );
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
  if (installClaudeCli) {
    await requiredCommand("npm install --global @anthropic-ai/claude-code", plan.workdir, env, 10 * 60 * 1000);
    await requiredCommand("claude --version", plan.workdir, env, 30_000);
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
): Promise<{ solverDir: string; baselineCommit: string; identity: { uid: number; gid: number } }> {
  const solverDir = posixPath.join(SOLVERS_DIR, `solver_${index}`);
  const commands = [
    `mkdir -p ${quote(solverDir)}`,
    `tar --exclude=.git --exclude=solution.patch --exclude=test.patch -cf - -C ${quote(plan.workdir)} . | tar --no-same-owner -xf - -C ${quote(solverDir)}`,
    `rm -rf ${quote(posixPath.join(solverDir, ".git"))}`,
    `rm -f ${quote(posixPath.join(solverDir, "solution.patch"))} ${quote(posixPath.join(solverDir, "test.patch"))}`,
    `git -C ${quote(solverDir)} init -q`,
    `git config --global --add safe.directory ${quote(solverDir)}`,
    `git -C ${quote(solverDir)} config user.email claude-solver@shipd-checks.local`,
    `git -C ${quote(solverDir)} config user.name shipd-checks-claude-solver`,
    `if [ -f ${quote(posixPath.join(solverDir, "test.sh"))} ]; then sed -i 's/\\r$//' ${quote(posixPath.join(solverDir, "test.sh"))}; fi`,
    `git -C ${quote(solverDir)} add -A`,
    `git -C ${quote(solverDir)} commit -q -m baseline --allow-empty`,
  ];
  await requiredCommand(`set -eu\n${commands.join("\n")}`, "/work", env, 15 * 60 * 1000);
  const testScriptPath = join(solverDir, "test.sh");
  if (existsSync(testScriptPath)) dos2unix(testScriptPath);
  const identity = findUnprivilegedIdentity(index);
  await requiredCommand(
    `chown -R ${identity.uid}:${identity.gid} ${quote(solverDir)} && chmod 700 ${quote(solverDir)}`,
    "/work",
    env,
    60_000,
  );
  const rev = await requiredCommand(`git -C ${quote(solverDir)} rev-parse HEAD`, "/work", env, 30_000);
  return { solverDir, baselineCommit: rev.stdout.trim(), identity };
}

function findUnprivilegedIdentity(index: number): { uid: number; gid: number } {
  const users = readFileSync("/etc/passwd", "utf-8")
    .split(/\r?\n/)
    .map((line) => {
      const [name, , uidText, gidText] = line.split(":");
      return { name, uid: Number(uidText), gid: Number(gidText) };
    })
    .filter((user) => Number.isInteger(user.uid) && Number.isInteger(user.gid) && user.uid > 0);
  const ordered = [
    ...users.filter((user) => user.name === "nobody"),
    ...users.filter((user) => user.name !== "nobody").sort((first, second) => first.uid - second.uid),
  ];
  const unique = [...new Map(ordered.map((user) => [user.uid, user])).values()];
  const user = unique[index - 1];
  if (!user) throw new Error(`Solver ${index} requires a distinct unprivileged account in the Fargate image.`);
  return { uid: user.uid, gid: user.gid };
}

function claudeEnvironment(
  name: string,
  projectDir: string,
  identity?: { uid: number; gid: number },
): NodeJS.ProcessEnv {
  const sourceCredential = join(CLAUDE_CONFIG_DIR, ".credentials.json");
  const configDir = join("/tmp", `shipd-claude-${name}`);
  const homeDir = join("/tmp", `shipd-home-${name}`);
  rmSync(configDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const credentialPath = join(configDir, ".credentials.json");
  copyFileSync(sourceCredential, credentialPath);
  chmodSync(credentialPath, 0o600);
  writeFileSync(
    join(homeDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      hasTrustDialogAccepted: true,
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  if (identity) {
    const ownership = `${identity.uid}:${identity.gid}`;
    for (const path of [configDir, homeDir]) {
      const status = spawnSync("chown", ["-R", ownership, path], { stdio: "ignore" });
      if (status.status !== 0) throw new Error(`Could not grant Claude access to its isolated ${path} config.`);
    }
  }
  const agentEnv = restrictedWorkspaceEnv(process.env);
  return {
    ...agentEnv,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    CLAUDE_CODE_DISABLE_NON_ESSENTIAL_TRAFFIC: "1",
  };
}

function restrictedWorkspaceEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sourceEnv };
  for (const name of [
    "SHIPD_BOOTSTRAP_URL",
    "SHIPD_SOURCE_URL",
    "SHIPD_AUTH_URL",
    "SHIPD_TEST_PATCH_URL",
    "SHIPD_RESULT_PUT_URL",
    "SHIPD_RESULT_GET_URL",
    "SHIPD_S3_BUCKET",
    "SHIPD_S3_REGION",
    "SHIPD_S3_SOURCE_KEY",
    "SHIPD_S3_AUTH_KEY",
    "SHIPD_S3_TEST_PATCH_KEY",
    "SHIPD_S3_RESULT_KEY",
    "SHIPD_PLAN_B64",
    "SHIPD_CLAUDE_MODEL",
    "SHIPD_CLAUDE_EFFORT",
    "SHIPD_AGENT_TIMEOUT_MINUTES",
    "SHIPD_SOLVER_COUNT",
    "SHIPD_RESOURCE_PROFILE",
    "SHIPD_MODE",
    "SHIPD_TIMEOUT_MINUTES",
    "CLAUDE_CONFIG_DIR",
    "BASH_ENV",
    "ENV",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "ECS_CONTAINER_METADATA_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
  ]) {
    delete env[name];
  }
  return env;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumUsageField(records: Record<string, unknown>[], field: string): number | undefined {
  const values = records
    .map((record) => numericValue(record[field]))
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function extractClaudeTokenUsage(result: Record<string, unknown>): TokenUsage | undefined {
  const usage = jsonRecord(result.usage);
  if (!usage) return undefined;
  const modelUsage = jsonRecord(result.modelUsage);
  const models = modelUsage
    ? Object.values(modelUsage)
        .map(jsonRecord)
        .filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
  const inputTokens = numericValue(usage.input_tokens) ?? sumUsageField(models, "inputTokens");
  const cacheReadInputTokens =
    numericValue(usage.cache_read_input_tokens) ?? sumUsageField(models, "cacheReadInputTokens");
  const cacheCreationInputTokens =
    numericValue(usage.cache_creation_input_tokens) ?? sumUsageField(models, "cacheCreationInputTokens");
  const outputTokens = numericValue(usage.output_tokens) ?? sumUsageField(models, "outputTokens");
  const outputTokenDetails = jsonRecord(usage.output_tokens_details);
  const iterations = Array.isArray(usage.iterations)
    ? usage.iterations.map(jsonRecord).filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
  const thinkingTokens =
    numericValue(outputTokenDetails?.thinking_tokens) ??
    numericValue(outputTokenDetails?.thinkingTokens) ??
    numericValue(usage.thinking_tokens) ??
    numericValue(usage.thinkingTokens) ??
    sumUsageField(iterations, "thinking_tokens") ??
    sumUsageField(iterations, "thinkingTokens") ??
    sumUsageField(models, "thinkingTokens") ??
    sumUsageField(models, "thinking_tokens") ??
    numericValue(result.thinking_tokens) ??
    numericValue(result.thinkingTokens);
  const hasUsage = [inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens, thinkingTokens].some(
    (value) => value !== undefined,
  );
  if (!hasUsage) return undefined;

  const input = inputTokens ?? 0;
  const cacheRead = cacheReadInputTokens ?? 0;
  const cacheCreation = cacheCreationInputTokens ?? 0;
  const output = outputTokens ?? 0;
  const totalInputTokens = input + cacheRead + cacheCreation;
  const rawTotalTokens = totalInputTokens + output;
  const deductibleThinkingTokens =
    outputTokens !== undefined && thinkingTokens !== undefined ? Math.min(thinkingTokens, output) : 0;
  const totalTokens = rawTotalTokens - deductibleThinkingTokens;
  const iterationContextSizes = iterations.map(
    (iteration) =>
      (numericValue(iteration.input_tokens) ?? 0) +
      (numericValue(iteration.cache_read_input_tokens) ?? 0) +
      (numericValue(iteration.cache_creation_input_tokens) ?? 0),
  );
  const finalContextTokens = iterationContextSizes.at(-1);
  const contextWindowValues = models
    .map((model) => numericValue(model.contextWindow))
    .filter((value): value is number => value !== undefined);
  const contextWindow = contextWindowValues.length > 0 ? Math.max(...contextWindowValues) : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    totalInputTokens,
    totalTokens,
    ...(thinkingTokens !== undefined && outputTokens !== undefined ? { rawTotalTokens } : {}),
    ...(finalContextTokens !== undefined ? { finalContextTokens } : {}),
    ...(iterationContextSizes.length > 0 ? { peakContextTokens: Math.max(...iterationContextSizes) } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(finalContextTokens !== undefined && contextWindow !== undefined
      ? { contextWindowUtilizationPercent: Number(((finalContextTokens / contextWindow) * 100).toFixed(2)) }
      : {}),
    ...(iterations.length > 0 ? { modelCalls: iterations.length } : {}),
    ...(numericValue(result.total_cost_usd) !== undefined ? { costUsd: numericValue(result.total_cost_usd) } : {}),
  };
}

function parseClaudeStreamRecords(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        return jsonRecord(JSON.parse(line));
      } catch {
        return undefined;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== undefined);
}

function streamAssistantText(records: Record<string, unknown>[]): string | undefined {
  const text = records.flatMap((record) => {
    if (record.type !== "assistant") return [];
    const message = jsonRecord(record.message);
    if (!Array.isArray(message?.content)) return [];
    return message.content
      .map(jsonRecord)
      .filter((content): content is Record<string, unknown> => content?.type === "text")
      .map((content) => (typeof content.text === "string" ? content.text : ""));
  });
  const joined = text.join("").trim();
  return joined || undefined;
}

function sanitizeClaudeStepTrace(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        const record = jsonRecord(JSON.parse(line));
        if (record?.type !== "assistant") return line;
        const message = jsonRecord(record.message);
        if (!Array.isArray(message?.content)) return line;
        const content = message.content.filter((block) => {
          const type = jsonRecord(block)?.type;
          return type !== "thinking" && type !== "redacted_thinking";
        });
        return content.length === message.content.length
          ? line
          : JSON.stringify({ ...record, message: { ...message, content } });
      } catch {
        return line;
      }
    })
    .join("\n");
}

function parseClaudeOutput(stdout: string, stderr: string): { text: string; tokenUsage?: TokenUsage } {
  let parsed: Record<string, unknown> | undefined;
  const trimmed = stdout.trim();
  try {
    parsed = jsonRecord(JSON.parse(trimmed));
  } catch {
    const records = parseClaudeStreamRecords(stdout);
    parsed =
      records
        .slice()
        .reverse()
        .find((record) => record.type === "result") ?? records.at(-1);
    if (!parsed) {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          parsed = jsonRecord(JSON.parse(trimmed.slice(start, end + 1)));
        } catch {
          parsed = undefined;
        }
      }
    }
    if (!parsed) return { text: `${stdout}\n${stderr}`.trim() };
    const outputText = typeof parsed.result === "string" ? parsed.result : (streamAssistantText(records) ?? trimmed);
    const text = [outputText, stderr.trim()].filter(Boolean).join("\n");
    return { text, tokenUsage: extractClaudeTokenUsage(parsed) };
  }
  if (!parsed) return { text: `${stdout}\n${stderr}`.trim() };
  const outputText = typeof parsed.result === "string" ? parsed.result : stdout.trim();
  const text = [outputText, stderr.trim()].filter(Boolean).join("\n");
  return { text, tokenUsage: extractClaudeTokenUsage(parsed) };
}

function claudeInvocation(tools: string, model: string, thinkingLevel: string): string {
  return [
    "claude",
    "--print",
    "--model",
    model,
    "--effort",
    thinkingLevel,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--tools",
    tools,
  ]
    .map(quote)
    .join(" ");
}

async function runTestSuite(
  solverDir: string,
  suite: "base" | "new",
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  identity?: { uid: number; gid: number },
): Promise<SolverTestResult> {
  const started = Date.now();
  let testHome = "";
  try {
    testHome = mkdtempSync(join("/tmp", `shipd-test-home-${identity?.uid ?? "root"}-${suite}-`));
    chmodSync(testHome, 0o700);
    if (identity) chownSync(testHome, identity.uid, identity.gid);
    const testCache = join(testHome, ".cache");
    mkdirSync(testCache, { recursive: true, mode: 0o700 });
    if (identity) chownSync(testCache, identity.uid, identity.gid);
    const testEnv: NodeJS.ProcessEnv = { ...env, HOME: testHome, TMPDIR: "/tmp", XDG_CACHE_HOME: testCache };
    delete testEnv.BASH_ENV;
    delete testEnv.ENV;
    const outputPath = join(solverDir, `.shipd-test-${suite}.xml`);
    const result = await runCommand(
      `bash test.sh --output_path ${quote(outputPath)} ${suite}`,
      solverDir,
      testEnv,
      timeoutMs,
      identity,
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const counts = readJUnitCounts(outputPath);
    return {
      exitCode: result.code,
      passed: result.code === 0 && !result.timedOut,
      durationMs: Date.now() - started,
      output: result.timedOut ? `Test command timed out.\n${output}` : output,
      totalTests: counts.tests,
      passedTests: counts.passedTestcases,
      failedTests: counts.failures,
      erroredTests: counts.errors,
      skippedTests: counts.skipped,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      passed: false,
      durationMs: Date.now() - started,
      output,
      totalTests: null,
      passedTests: null,
      failedTests: null,
      erroredTests: null,
      skippedTests: null,
    };
  } finally {
    if (testHome) rmSync(testHome, { recursive: true, force: true });
  }
}

function sumKnownTestCounts(values: Array<number | null | undefined>): number | null {
  if (values.length === 0 || values.some((value) => typeof value !== "number")) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function isTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  return (
    basename === "test.sh" ||
    basename === "conftest.py" ||
    parts.some((part) => ["test", "tests", "spec", "specs", "__tests__", "testing"].includes(part)) ||
    /(^|[._-])test([._-]|$)/.test(basename) ||
    /(^|[._-])spec([._-]|$)/.test(basename)
  );
}

async function applyTestPatch(workdir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const patch = await loadTestPatch();
  await requiredCommand("git apply --whitespace=nowarn -", workdir, env, 60_000, patch);
  const testScriptPath = join(workdir, "test.sh");
  if (existsSync(testScriptPath)) dos2unix(testScriptPath);
}

async function restoreChangedTests(solverDir: string, baselineCommit: string, env: NodeJS.ProcessEnv): Promise<void> {
  const changed = await requiredCommand(
    `git diff --cached --name-only -z ${quote(baselineCommit)}`,
    solverDir,
    env,
    30_000,
  );
  for (const path of changed.stdout.split("\0").filter(isTestPath)) {
    const existsInBaseline = await runCommand(
      `git cat-file -e ${quote(`${baselineCommit}:${path}`)}`,
      solverDir,
      env,
      30_000,
    );
    if (existsInBaseline.code === 0) {
      await requiredCommand(
        `git restore --source ${quote(baselineCommit)} --staged --worktree -- ${quote(path)}`,
        solverDir,
        env,
        30_000,
      );
    } else {
      await runCommand(`git rm -f --cached --ignore-unmatch -- ${quote(path)}`, solverDir, env, 30_000);
      rmSync(join(solverDir, path), { recursive: true, force: true });
    }
  }
}

async function runSolver(
  index: number,
  workspace: Awaited<ReturnType<typeof prepareSolver>>,
  env: NodeJS.ProcessEnv,
  taskPromptText: string,
): Promise<WorkerSolverResult> {
  const started = Date.now();
  const timeoutMinutes = Number.parseInt(requiredEnv("SHIPD_AGENT_TIMEOUT_MINUTES"), 10);
  const model = requiredEnv("SHIPD_CLAUDE_MODEL");
  const thinkingLevel = requiredEnv("SHIPD_CLAUDE_EFFORT");
  const solverEnv = claudeEnvironment(`solver-${index}`, workspace.solverDir, workspace.identity);
  let agentOutput = "";
  let agentStepsGzipBase64: string | undefined;
  let tokenUsage: TokenUsage | undefined;
  let status: SolverRunResult["status"] = "error";
  let error: string | undefined;
  try {
    const agent = await runCommand(
      claudeInvocation("Bash", model, thinkingLevel),
      workspace.solverDir,
      solverEnv,
      timeoutMinutes * 60 * 1000,
      workspace.identity,
      taskPromptText,
    );
    if (agent.stdout) agentStepsGzipBase64 = gzipSync(sanitizeClaudeStepTrace(agent.stdout)).toString("base64");
    const parsedAgent = parseClaudeOutput(agent.stdout, agent.stderr);
    agentOutput = parsedAgent.text;
    tokenUsage = parsedAgent.tokenUsage;
    status = agent.timedOut ? "timedOut" : agent.code === 0 ? "ok" : "error";
    if (agent.code !== 0)
      error = agent.timedOut ? "Claude CLI solver timed out." : `Claude CLI exited with code ${agent.code}.`;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    agentOutput = error;
  } finally {
    rmSync(join("/tmp", `shipd-claude-solver-${index}`), { recursive: true, force: true });
    rmSync(join("/tmp", `shipd-home-solver-${index}`), { recursive: true, force: true });
  }

  const diffResult = await runCommand(
    `git add -A && git diff --cached ${quote(workspace.baselineCommit)} -- . ${quote(":(exclude)agent_prompt.md")}`,
    workspace.solverDir,
    env,
    30_000,
  );
  const diff = diffResult.code === 0 ? diffResult.stdout : "";
  if (diffResult.code !== 0)
    error = error ?? `Could not capture solver diff: ${diffResult.stderr || diffResult.stdout}`;
  await restoreChangedTests(workspace.solverDir, workspace.baselineCommit, env);
  const testTimeoutMs = timeoutMinutes * 60 * 1000;
  const testEnv = restrictedWorkspaceEnv(env);
  let baseTests: SolverTestResult;
  let newTests: SolverTestResult;
  try {
    await applyTestPatch(workspace.solverDir, env);
    baseTests = await runTestSuite(workspace.solverDir, "base", testEnv, testTimeoutMs, workspace.identity);
    newTests = await runTestSuite(workspace.solverDir, "new", testEnv, testTimeoutMs, workspace.identity);
  } catch (caught) {
    const output = `Could not apply or execute the harness tests: ${caught instanceof Error ? caught.message : String(caught)}`;
    error = error ?? output;
    baseTests = {
      exitCode: 1,
      passed: false,
      durationMs: 0,
      output,
      totalTests: null,
      passedTests: null,
      failedTests: null,
      erroredTests: null,
      skippedTests: null,
    };
    newTests = {
      exitCode: 1,
      passed: false,
      durationMs: 0,
      output,
      totalTests: null,
      passedTests: null,
      failedTests: null,
      erroredTests: null,
      skippedTests: null,
    };
  }
  const testOutput = `=== base (exit ${baseTests.exitCode}) ===\n${baseTests.output}\n\n=== new (exit ${newTests.exitCode}) ===\n${newTests.output}`;
  writeFileSync(join(workspace.solverDir, "agent_output.txt"), agentOutput, "utf-8");
  writeFileSync(join(workspace.solverDir, "base_test_output.txt"), baseTests.output, "utf-8");
  writeFileSync(join(workspace.solverDir, "new_test_output.txt"), newTests.output, "utf-8");
  writeFileSync(join(workspace.solverDir, "solution.diff"), diff, "utf-8");

  return {
    index,
    status,
    passed: status === "ok" && baseTests.passed && newTests.passed,
    diff,
    testOutputTail: tail(testOutput),
    agentOutput,
    ...(agentStepsGzipBase64 ? { agentStepsGzipBase64 } : {}),
    tokenUsage,
    baseTests,
    newTests,
    durationMs: Date.now() - started,
    totalTests: sumKnownTestCounts([baseTests.totalTests, newTests.totalTests]),
    failedTests: sumKnownTestCounts([baseTests.failedTests, newTests.failedTests]),
    error,
  };
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
  if (mode === "solver") process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  const env = resolvedEnvironment(plan);
  if (mode === "solver") {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const credentialPath = join(CLAUDE_CONFIG_DIR, ".credentials.json");
    if (directS3Enabled()) {
      await downloadObject(requiredEnv("SHIPD_S3_BUCKET"), requiredEnv("SHIPD_S3_AUTH_KEY"), credentialPath);
    } else {
      await download(requiredEnv("SHIPD_AUTH_URL"), credentialPath);
    }
    chmodSync(credentialPath, 0o600);
    env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  }
  mkdirSync("/work", { recursive: true });
  await initializeSource(plan, env, mode === "solver");

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
      const result = await runSolver(solverIndex, workspace, env, taskPrompt);
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
