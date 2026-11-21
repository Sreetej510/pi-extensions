import { spawn } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix as posixPath } from "node:path";
import { gzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { XMLParser } from "fast-xml-parser";
import {
  codexFinalText,
  codexRolloutContextUsage,
  codexStreamError,
  codexTokenUsage,
  parseCodexEvents,
} from "./codex-cli.js";
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
      ? ["bucket", "region", "sourceKey", "codexAuthKey", "testPatchKey", "resultKey"]
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
    modelId: "SHIPD_CODEX_MODEL",
    thinkingLevel: "SHIPD_CODEX_EFFORT",
  };
  if (directS3) {
    const directFields = [
      ["bucket", "SHIPD_S3_BUCKET"],
      ["region", "SHIPD_S3_REGION"],
      ["sourceKey", "SHIPD_S3_SOURCE_KEY"],
      ...(mode === "solver" ? [["codexAuthKey", "SHIPD_S3_CODEX_AUTH_KEY"]] : []),
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
      ...(mode === "solver" ? [["codexAuthUrl", "SHIPD_CODEX_AUTH_URL"]] : []),
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
  if (mode === "solver" && !["low", "medium", "high", "xhigh", "max"].includes(requiredEnv("SHIPD_CODEX_EFFORT")))
    throw new Error("Invalid Codex CLI reasoning effort.");
  const numericFields = [
    ["timeoutMinutes", "SHIPD_TIMEOUT_MINUTES"],
    ...(mode === "solver"
      ? [
          ["agentTimeoutMinutes", "SHIPD_AGENT_TIMEOUT_MINUTES"],
          ["testTimeoutMinutes", "SHIPD_TEST_TIMEOUT_MINUTES"],
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
  writeFileSync(destination, Buffer.from(body), { mode: 0o600 });
}

/** Downloads the host's (freshly checked) Codex login; each solver gets its own copy in a private CODEX_HOME. */
async function downloadCodexAuth(): Promise<string> {
  const authPath = "/tmp/shipd-codex-auth.json";
  try {
    if (directS3Enabled()) {
      await downloadObject(requiredEnv("SHIPD_S3_BUCKET"), requiredEnv("SHIPD_S3_CODEX_AUTH_KEY"), authPath);
    } else {
      const response = await fetch(requiredEnv("SHIPD_CODEX_AUTH_URL"));
      if (!response.ok) throw new Error(`Codex login download failed (${response.status}).`);
      writeFileSync(authPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    }
    chmodSync(authPath, 0o600);
    const auth = readFileSync(authPath, "utf-8").trim();
    try {
      const parsed = JSON.parse(auth) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    } catch {
      throw new Error("The Codex login file is empty or invalid.");
    }
    return auth;
  } finally {
    rmSync(authPath, { force: true });
  }
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

async function initializeSource(plan: DockerPlan, env: NodeJS.ProcessEnv, installCodexCli: boolean): Promise<void> {
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
  if (installCodexCli) {
    await requiredCommand(`npm install --global @openai/codex@${CODEX_CLI_VERSION}`, plan.workdir, env, 10 * 60 * 1000);
    await requiredCommand("codex --version", plan.workdir, env, 30_000);
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
    `git -C ${quote(solverDir)} config user.email codex-solver@shipd-checks.local`,
    `git -C ${quote(solverDir)} config user.name shipd-checks-codex-solver`,
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

const CODEX_HOMES_DIR = "/work/shipd-codex";
/** Codex CLI version installed on Fargate; the solver tool restrictions below were verified against it. */
const CODEX_CLI_VERSION = "0.171.0";
/** The only tools a solver may see, like Claude's former `--tools Bash`. Verified before every run (fail closed). */
const SOLVER_ALLOWED_TOOLS = ["exec_command", "write_stdin", "update_plan"] as const;
/** Features that add model-visible tools (sub-agents, sleep, images, apps, plugins, goals, suggestions, skills). */
const SOLVER_DISABLED_FEATURES = [
  "multi_agent",
  "collaboration_modes",
  "sleep_tool",
  "view_image",
  "apps",
  "plugins",
  "goals",
  "image_generation",
  "tool_suggest",
  "skill_search",
] as const;
const SOLVER_MODEL_CATALOG_PATH = join(CODEX_HOMES_DIR, "model-catalog.json");

/**
 * Codex runs under the solver's unprivileged UID with a private HOME and CODEX_HOME (no auth.json), so its commands cannot
 * touch root-owned files, the other solvers' workspaces, or the worker's AWS/transport secrets. CODEX_HOME holds this
 * solver's copy of the host's ChatGPT login (auth.json); the host refreshed it beforehand so Codex never has to refresh
 * it here. CODEX_HOME lives outside /tmp because Codex refuses to install its helper binaries under the temp dir.
 */
function codexEnvironment(name: string, authJson: string, identity: { uid: number; gid: number }): NodeJS.ProcessEnv {
  const codexHome = join(CODEX_HOMES_DIR, name);
  const homeDir = join("/tmp", `shipd-home-${name}`);
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(CODEX_HOMES_DIR, { recursive: true, mode: 0o755 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const authPath = join(codexHome, "auth.json");
  writeFileSync(authPath, authJson, { encoding: "utf-8", mode: 0o600 });
  for (const path of [codexHome, homeDir, authPath]) chownSync(path, identity.uid, identity.gid);
  return {
    ...restrictedWorkspaceEnv(process.env),
    HOME: homeDir,
    CODEX_HOME: codexHome,
  };
}

function restrictedWorkspaceEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sourceEnv };
  for (const name of [
    "SHIPD_BOOTSTRAP_URL",
    "SHIPD_SOURCE_URL",
    "SHIPD_CODEX_AUTH_URL",
    "SHIPD_TEST_PATCH_URL",
    "SHIPD_RESULT_PUT_URL",
    "SHIPD_RESULT_GET_URL",
    "SHIPD_S3_BUCKET",
    "SHIPD_S3_REGION",
    "SHIPD_S3_SOURCE_KEY",
    "SHIPD_S3_CODEX_AUTH_KEY",
    "SHIPD_S3_TEST_PATCH_KEY",
    "SHIPD_S3_RESULT_KEY",
    "SHIPD_PLAN_B64",
    "SHIPD_CODEX_MODEL",
    "SHIPD_CODEX_EFFORT",
    "SHIPD_AGENT_TIMEOUT_MINUTES",
    "SHIPD_TEST_TIMEOUT_MINUTES",
    "SHIPD_SOLVER_COUNT",
    "SHIPD_RESOURCE_PROFILE",
    "SHIPD_MODE",
    "SHIPD_TIMEOUT_MINUTES",
    "CODEX_HOME",
    "BASH_ENV",
    "ENV",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_API_KEY",
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

/** Drops reasoning items from the persisted `codex exec --json` event trace, like the old thinking-block scrub. */
function sanitizeCodexStepTrace(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      try {
        const record = JSON.parse(line) as { item?: { type?: unknown } } | null;
        return record?.item?.type !== "reasoning";
      } catch {
        return true;
      }
    })
    .join("\n");
}

function parseCodexOutput(stdout: string, stderr: string): { text: string; tokenUsage?: TokenUsage; error?: string } {
  const records = parseCodexEvents(stdout);
  const outputText = codexFinalText(records) || (records.length ? "" : stdout.trim());
  const error = codexStreamError(records);
  const text = [outputText, error, stderr.trim()].filter(Boolean).join("\n");
  const tokenUsage = codexTokenUsage(records);
  return { text, ...(tokenUsage ? { tokenUsage } : {}), ...(error ? { error } : {}) };
}

/** Credential variables Codex must never pass to the commands it runs (on top of its default KEY, SECRET and TOKEN excludes). */
const CODEX_CREDENTIAL_VARIABLES = [
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "AWS_*",
  "ECS_*",
  "SHIPD_*",
];

/** Config that restricts a solver to SOLVER_ALLOWED_TOOLS: direct (non code-mode) tools from an edited model catalog,
 * no sub-agents/apply_patch/experimental tools, extra features off, update_plan on and request_user_input off. */
function codexToolRestrictionArgs(): string[] {
  return [
    "-c",
    `model_catalog_json=${JSON.stringify(SOLVER_MODEL_CATALOG_PATH)}`,
    // Web search is a hosted tool that prompt-input cannot show, so prepareSolverToolset cannot verify it: disable it here.
    "-c",
    'web_search="disabled"',
    "-c",
    "tools.update_plan={enabled=true}",
    "-c",
    "tools.experimental_request_user_input={enabled=false}",
    ...SOLVER_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ];
}

/** Model-visible tool names in `codex debug prompt-input` output (including any nested in a code-mode `exec` tool). */
function promptInputToolNames(stdout: string): string[] {
  const items = JSON.parse(stdout) as unknown;
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const record = jsonObject(value);
    if (!record) return;
    if (typeof record.name === "string" && ["function", "custom", "namespace"].includes(String(record.type))) {
      if (record.type !== "namespace") names.add(record.name);
      if (record.name === "exec" && typeof record.description === "string")
        for (const match of record.description.matchAll(/\n#+ `([a-z_][a-z0-9_]*)`/g)) names.add(match[1] as string);
    }
    Object.values(record).forEach(walk);
  };
  const list = Array.isArray(items) ? items : [];
  walk(jsonObject(list[0])?.type === "additional_tools" ? list[0] : list);
  return [...names].sort();
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Writes the solver model catalog (Codex's bundled catalog, edited for direct tools only) and then asks Codex which
 * tools a solver would see. Anything other than exactly SOLVER_ALLOWED_TOOLS fails the run before any solver starts.
 */
async function prepareSolverToolset(env: NodeJS.ProcessEnv): Promise<void> {
  const setupHome = join(CODEX_HOMES_DIR, "toolset-check");
  rmSync(setupHome, { recursive: true, force: true });
  mkdirSync(CODEX_HOMES_DIR, { recursive: true, mode: 0o755 });
  mkdirSync(setupHome, { recursive: true, mode: 0o700 });
  const setupEnv = { ...restrictedWorkspaceEnv(env), CODEX_HOME: setupHome };
  try {
    const models = await requiredCommand("codex debug models", "/work", setupEnv, 120_000);
    const catalog = JSON.parse(models.stdout) as { models?: Record<string, unknown>[] };
    if (!Array.isArray(catalog.models) || catalog.models.length === 0)
      throw new Error("Codex returned an empty model catalog.");
    for (const model of catalog.models) {
      model.tool_mode = "direct";
      delete model.multi_agent_version;
      model.apply_patch_tool_type = null;
      model.experimental_supported_tools = [];
      model.supports_search_tool = false;
    }
    writeFileSync(SOLVER_MODEL_CATALOG_PATH, JSON.stringify(catalog), { encoding: "utf-8", mode: 0o644 });
    chmodSync(SOLVER_MODEL_CATALOG_PATH, 0o644);
    const check = await requiredCommand(
      [
        "codex",
        "debug",
        "prompt-input",
        "-c",
        `model=${JSON.stringify(requiredEnv("SHIPD_CODEX_MODEL"))}`,
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        "cli_auth_credentials_store=file",
        ...codexToolRestrictionArgs(),
        "toolset check",
      ]
        .map(quote)
        .join(" "),
      "/work",
      setupEnv,
      120_000,
    );
    const tools = promptInputToolNames(check.stdout);
    const expected = [...SOLVER_ALLOWED_TOOLS].sort();
    if (tools.join(",") !== expected.join(","))
      throw new Error(
        `Codex solver tool restriction failed: expected ${expected.join(", ")} but Codex ${CODEX_CLI_VERSION} exposes ${tools.join(", ") || "no tools"}.`,
      );
  } finally {
    rmSync(setupHome, { recursive: true, force: true });
  }
}

/** Adds final/peak context size and context-window utilization from the solver's Codex session rollout. */
function withRolloutContextUsage(usage: TokenUsage | undefined, codexHome: string | undefined): TokenUsage | undefined {
  if (!codexHome) return usage;
  const rollouts: string[] = [];
  const collect = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".jsonl")) rollouts.push(path);
    }
  };
  collect(join(codexHome, "sessions"));
  if (rollouts.length === 0) return usage;
  const context = codexRolloutContextUsage(
    rollouts
      .sort()
      .map((path) => readFileSync(path, "utf-8"))
      .join("\n"),
  );
  return context ? { ...(usage ?? {}), ...context } : usage;
}

function codexInvocation(model: string, thinkingLevel: string, solverDir: string): string {
  return [
    "codex",
    "exec",
    "--json",
    "--color",
    "never",
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${thinkingLevel}`,
    ...codexToolRestrictionArgs(),
    // Fargate offers neither the user namespaces nor the Landlock support Codex's Linux sandbox needs; the solver is
    // instead confined by its unprivileged UID, private workspace, and scrubbed environment.
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `shell_environment_policy.exclude=${JSON.stringify(CODEX_CREDENTIAL_VARIABLES)}`,
    "-c",
    "cli_auth_credentials_store=file",
    "--skip-git-repo-check",
    // No --ephemeral: the session rollout in the solver's private CODEX_HOME carries the per-request context sizes.
    "--cd",
    solverDir,
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

async function verifySolverIsolation(
  solverDir: string,
  env: NodeJS.ProcessEnv,
  identity: { uid: number; gid: number },
): Promise<void> {
  const checks = [
    `test "$(id -u)" = ${identity.uid}`,
    `test -z "\${CODEX_API_KEY+x}"`,
    `test -z "\${CODEX_ACCESS_TOKEN+x}"`,
    `test -z "\${OPENAI_API_KEY+x}"`,
    `test -z "\${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI+x}"`,
    "command -v codex >/dev/null",
  ].join(" && ");
  const result = await runCommand(checks, solverDir, restrictedWorkspaceEnv(env), 30_000, identity);
  if (result.code !== 0)
    throw new Error("Codex solver failed its unprivileged-UID and credential-isolation preflight.");
}

async function runSolver(
  index: number,
  workspace: Awaited<ReturnType<typeof prepareSolver>>,
  env: NodeJS.ProcessEnv,
  taskPromptText: string,
  codexAuth: string,
): Promise<WorkerSolverResult> {
  const started = Date.now();
  const timeoutMinutes = Number.parseInt(requiredEnv("SHIPD_AGENT_TIMEOUT_MINUTES"), 10);
  const model = requiredEnv("SHIPD_CODEX_MODEL");
  const thinkingLevel = requiredEnv("SHIPD_CODEX_EFFORT");
  const solverEnv = codexEnvironment(`solver-${index}`, codexAuth, workspace.identity);
  let agentOutput = "";
  let agentStepsGzipBase64: string | undefined;
  let tokenUsage: TokenUsage | undefined;
  let status: SolverRunResult["status"] = "error";
  let error: string | undefined;
  try {
    await verifySolverIsolation(workspace.solverDir, solverEnv, workspace.identity);
    const agent = await runCommand(
      codexInvocation(model, thinkingLevel, workspace.solverDir),
      workspace.solverDir,
      solverEnv,
      timeoutMinutes * 60 * 1000,
      workspace.identity,
      taskPromptText,
    );
    if (agent.stdout) agentStepsGzipBase64 = gzipSync(sanitizeCodexStepTrace(agent.stdout)).toString("base64");
    const parsedAgent = parseCodexOutput(agent.stdout, agent.stderr);
    agentOutput = parsedAgent.text;
    tokenUsage = withRolloutContextUsage(parsedAgent.tokenUsage, solverEnv.CODEX_HOME);
    status = agent.timedOut ? "timedOut" : agent.code === 0 && !parsedAgent.error ? "ok" : "error";
    if (agent.timedOut) error = "Codex CLI solver timed out.";
    else if (agent.code !== 0) error = `Codex CLI exited with code ${agent.code}.`;
    else if (parsedAgent.error) error = `Codex CLI turn failed: ${parsedAgent.error}`;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    agentOutput = error;
  } finally {
    rmSync(join(CODEX_HOMES_DIR, `solver-${index}`), { recursive: true, force: true });
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
  // Each suite (base, then new) gets its own limit, separate from the Codex session's.
  const testTimeoutMs = Number.parseInt(requiredEnv("SHIPD_TEST_TIMEOUT_MINUTES"), 10) * 60 * 1000;
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
  const env = resolvedEnvironment(plan);
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
  await prepareSolverToolset(env);
  for (const index of pendingIndexes) workspaces.push(await prepareSolver(index, plan, env));
  const codexAuth = await downloadCodexAuth();
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
      const result = await runSolver(solverIndex, workspace, env, taskPrompt, codexAuth);
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
