import { randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  type ContainerOverride,
  CreateClusterCommand,
  DescribeTasksCommand,
  ECSClient,
  ListClustersCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FARGATE_PREQUALITY_PROFILE,
  HUMANIZER_MAX_CANDIDATE_COUNT,
  HUMANIZER_MIN_CANDIDATE_COUNT,
  resolveFargateResources,
} from "./config.js";
import { type FargateDockerPlan, parseFargateDockerfile } from "./fargate-docker.js";
import { bashQuote, toSlashPath } from "./git.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import type {
  ChecksConfig,
  FargateConfig,
  FargateResourceUsage,
  PatchPrecheckResult,
  SolverGapConfig,
  SolverRunResult,
} from "./types.js";

const TASK_CONTAINER_NAME = "shipd-worker";
const WORKER_S3_NAME = "fargate-worker.mjs";
const URL_EXPIRY_SECONDS = 55 * 60;
const POLL_MS = 5000;

type WorkerSolverResult = SolverRunResult & {
  agentStepsGzipBase64?: string;
};

type WorkerMode = "solver" | "patch-precheck";

interface WorkerPayload {
  complete: boolean;
  results: WorkerSolverResult[];
  phase?: string;
  precheck?: PatchPrecheckResult;
  resourceUsage?: FargateResourceUsage;
  error?: string;
}

interface AwsContext {
  region: string;
  bucket: string;
  cluster: string;
  subnets: string[];
  securityGroup: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function awsClients(region: string, profile?: string) {
  const credentials = defaultProvider({ profile: process.env.AWS_PROFILE ?? profile });
  const clientOptions = { region, credentials, maxAttempts: 5 };
  return {
    ecs: new ECSClient(clientOptions),
    ec2: new EC2Client(clientOptions),
    s3: new S3Client(clientOptions),
    sts: new STSClient(clientOptions),
  };
}

async function runFargateWorker(opts: {
  pi: ExtensionAPI;
  repoDir: string;
  snapshotDir: string;
  taskPrompt?: string;
  config: ChecksConfig;
  mode: WorkerMode;
  solverConfig?: SolverGapConfig;
  precheckTimeoutMinutes?: number;
  cancelSignal: AbortSignal;
  runId: string;
  onSolverCompleted?: (result: SolverRunResult) => void;
  onSolverProgress?: (results: SolverRunResult[]) => void;
  onResourceUsage?: (usage: FargateResourceUsage) => void;
  onPhase?: (phase: string) => void;
}): Promise<WorkerPayload> {
  if (opts.cancelSignal.aborted) throw new Error("Cancelled by user.");
  let lastReportedPhase: string | undefined;
  const reportPhase = (phase: string | undefined) => {
    if (!phase || phase === lastReportedPhase) return;
    lastReportedPhase = phase;
    opts.onPhase?.(phase);
  };
  reportPhase("preparing image");
  const dockerfilePath = join(opts.repoDir, "Dockerfile");
  if (!existsSync(dockerfilePath))
    throw new Error(
      `Fargate ${opts.mode === "solver" ? "Claude benchmark" : "patch precheck"} requires Dockerfile in the project root.`,
    );
  const plan = parseFargateDockerfile(readFileSync(dockerfilePath, "utf-8"));
  const fargateConfig = loadFargateConfigFromChecks(opts.config, opts.repoDir, opts.mode);
  const region = process.env.AWS_REGION ?? fargateConfig.region ?? "us-east-1";
  const clients = awsClients(region, fargateConfig.awsProfile);
  const resources = resolveFargateResources(opts.repoDir, fargateConfig);
  const archivePath = join(tmpdir(), `.shipd-fargate-source-${randomUUID()}.tar.gz`);
  const workerPath = findWorkerPath();
  const solverConfig = opts.solverConfig;
  const claudeTokenPath = opts.mode === "solver" ? findClaudeOAuthTokenPath(solverConfig) : undefined;
  const workerClaudeTokenPath = claudeTokenPath
    ? join(tmpdir(), `.shipd-fargate-claude-token-${randomUUID()}.txt`)
    : undefined;

  let taskArn: string | undefined;
  let taskCluster: string | undefined;
  let cleanupBucket: string | undefined;
  let bootstrapPath: string | undefined;
  let stoppedByUs = false;
  const onAbort = () => {
    if (taskArn) {
      stoppedByUs = true;
      void clients.ecs
        .send(new StopTaskCommand({ cluster: taskCluster, task: taskArn, reason: "shipd checks cancelled" }))
        .catch(() => undefined);
    }
  };
  opts.cancelSignal.addEventListener("abort", onAbort, { once: true });

  const keys = {
    source: `runs/${opts.runId}/source.tar.gz`,
    testPatch: `runs/${opts.runId}/test.patch`,
    worker: `runs/${opts.runId}/${WORKER_S3_NAME}`,
    claudeToken: `runs/${opts.runId}/claude-oauth-token.txt`,
    bootstrap: `runs/${opts.runId}/bootstrap.json`,
    result: `runs/${opts.runId}/result.json`,
  };
  try {
    if (opts.mode === "solver" && !solverConfig) throw new Error("Fargate solver configuration is missing.");
    if (opts.mode === "solver" && !opts.taskPrompt) throw new Error("The task prompt is empty or unavailable.");
    const testPatchPath = join(opts.repoDir, "test.patch");
    if (opts.mode === "solver" && !existsSync(testPatchPath))
      throw new Error("Missing test.patch; it is applied only after each solver finishes.");
    if (!claudeTokenPath && opts.mode === "solver")
      throw new Error(
        "Missing Claude OAuth token file path. Set solverGap.claudeOAuthTokenFile in checks-config.json or CLAUDE_CODE_OAUTH_TOKEN_FILE.",
      );
    if (claudeTokenPath && !existsSync(claudeTokenPath))
      throw new Error(`Claude OAuth token file not found: ${claudeTokenPath}. Check the configured path.`);
    const context = await resolveAwsContext(clients, fargateConfig, region);
    cleanupBucket = context.bucket;
    taskCluster = context.cluster;
    await createSourceArchive(opts.pi, opts.snapshotDir, archivePath, opts.cancelSignal, opts.mode === "solver");
    await putFile(clients.s3, context.bucket, keys.source, archivePath, "application/gzip");
    if (opts.mode === "solver") await putFile(clients.s3, context.bucket, keys.testPatch, testPatchPath, "text/plain");
    await putFile(clients.s3, context.bucket, keys.worker, workerPath, "text/javascript");
    if (claudeTokenPath && workerClaudeTokenPath) {
      prepareClaudeOAuthToken(claudeTokenPath, workerClaudeTokenPath);
      await putFile(clients.s3, context.bucket, keys.claudeToken, workerClaudeTokenPath, "text/plain");
    }

    bootstrapPath = join(tmpdir(), `.shipd-fargate-bootstrap-${randomUUID()}.json`);
    const taskDefinition = await registerTaskDefinition(
      clients.ecs,
      plan,
      resources.cpu,
      resources.memoryMiB,
      region,
      fargateConfig,
    );
    const agentTimeoutMinutes =
      opts.mode === "solver" ? Math.max(1, Math.floor(solverConfig?.timeoutMinutes ?? 20)) : 0;
    const timeoutMinutes =
      opts.mode === "solver"
        ? Math.max(10, agentTimeoutMinutes * 4 + 15)
        : Math.max(1, Math.floor(opts.precheckTimeoutMinutes ?? 20));
    const solverCount = opts.mode === "solver" ? Math.max(1, Math.floor(solverConfig?.solverCount ?? 1)) : 0;
    const directS3 = Boolean(fargateConfig.taskRoleArn);
    const maxRetries = Math.min(3, Math.max(0, Math.floor(fargateConfig.maxRetries ?? 1)));
    let lastFailure = "Fargate task did not produce a result.";
    reportPhase("requesting sandbox");
    let recoveredResults: WorkerSolverResult[] = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (opts.cancelSignal.aborted) throw new Error("Cancelled by user.");
      reportPhase("requesting sandbox");
      // Re-sign every URL for every Spot attempt. AWS login credentials are
      // temporary, so a URL created for an interrupted attempt may expire
      // before the replacement task starts.
      const workerUrl = await getSignedUrl(
        clients.s3,
        new GetObjectCommand({ Bucket: context.bucket, Key: keys.worker }),
        { expiresIn: URL_EXPIRY_SECONDS },
      );
      const sourceUrl = directS3
        ? undefined
        : await getSignedUrl(clients.s3, new GetObjectCommand({ Bucket: context.bucket, Key: keys.source }), {
            expiresIn: URL_EXPIRY_SECONDS,
          });
      const claudeTokenUrl =
        directS3 || !claudeTokenPath
          ? undefined
          : await getSignedUrl(clients.s3, new GetObjectCommand({ Bucket: context.bucket, Key: keys.claudeToken }), {
              expiresIn: URL_EXPIRY_SECONDS,
            });
      const testPatchUrl =
        opts.mode !== "solver" || directS3
          ? undefined
          : await getSignedUrl(clients.s3, new GetObjectCommand({ Bucket: context.bucket, Key: keys.testPatch }), {
              expiresIn: URL_EXPIRY_SECONDS,
            });
      const resultPutUrl = directS3
        ? undefined
        : await getSignedUrl(
            clients.s3,
            new PutObjectCommand({ Bucket: context.bucket, Key: keys.result, ContentType: "application/json" }),
            { expiresIn: URL_EXPIRY_SECONDS },
          );
      const resultGetUrl = directS3
        ? undefined
        : await getSignedUrl(clients.s3, new GetObjectCommand({ Bucket: context.bucket, Key: keys.result }), {
            expiresIn: URL_EXPIRY_SECONDS,
          });
      writeFileSync(
        bootstrapPath,
        `${JSON.stringify({
          workerUrl,
          sourceUrl,
          claudeTokenUrl,
          testPatchUrl,
          resultPutUrl,
          resultGetUrl,
          ...(directS3
            ? {
                bucket: context.bucket,
                region,
                sourceKey: keys.source,
                ...(claudeTokenPath ? { claudeTokenKey: keys.claudeToken } : {}),
                ...(opts.mode === "solver" ? { testPatchKey: keys.testPatch } : {}),
                resultKey: keys.result,
              }
            : {}),
          mode: opts.mode,
          planB64: Buffer.from(JSON.stringify(plan), "utf-8").toString("base64url"),
          ...(opts.mode === "solver"
            ? {
                modelId: solverConfig?.modelId ?? "sonnet",
                thinkingLevel: solverConfig?.thinkingLevel ?? "low",
                agentTimeoutMinutes,
                taskPrompt: opts.taskPrompt,
              }
            : {}),
          timeoutMinutes,
          ...(opts.mode === "solver" ? { solverCount } : {}),
          resourceProfile: resources.profile,
        })}\n`,
        "utf-8",
      );
      await putFile(clients.s3, context.bucket, keys.bootstrap, bootstrapPath, "application/json");
      const bootstrapUrl = await getSignedUrl(
        clients.s3,
        new GetObjectCommand({ Bucket: context.bucket, Key: keys.bootstrap }),
        { expiresIn: URL_EXPIRY_SECONDS },
      );
      const override: ContainerOverride = {
        name: TASK_CONTAINER_NAME,
        environment: [{ name: "SHIPD_BOOTSTRAP_URL", value: bootstrapUrl }],
      };
      const run = await clients.ecs.send(
        new RunTaskCommand({
          cluster: context.cluster,
          capacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }],
          taskDefinition,
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: context.subnets,
              securityGroups: [context.securityGroup],
              assignPublicIp: "ENABLED",
            },
          },
          overrides: { containerOverrides: [override] },
        }),
      );
      const failure = run.failures?.[0]?.reason;
      taskArn = run.tasks?.[0]?.taskArn;
      taskCluster = context.cluster;
      if (!taskArn) {
        lastFailure = failure ?? "Fargate could not place the Spot task.";
        reportPhase("requesting sandbox");
        continue;
      }
      reportPhase("sandbox created");
      const payload = await waitForTask(
        clients.ecs,
        context.cluster,
        taskArn,
        () => readResultObject(clients.s3, context.bucket, keys.result),
        timeoutMinutes,
        opts.cancelSignal,
        (results, resourceUsage, phase) => {
          if (opts.mode === "solver") opts.onSolverProgress?.(results);
          if (resourceUsage) opts.onResourceUsage?.(resourceUsage);
          reportPhase(phase);
        },
        () => reportPhase(opts.mode === "solver" ? "running agents" : "running patch prechecks"),
        () => {
          stoppedByUs = true;
        },
      );
      taskArn = undefined;
      if (payload?.resourceUsage) opts.onResourceUsage?.(payload.resourceUsage);
      if (opts.mode === "patch-precheck") {
        if (payload?.complete && !payload.error && payload.precheck) {
          reportPhase("finalizing");
          return payload;
        }
        lastFailure = payload?.error ?? lastFailure;
      } else {
        recoveredResults = mergeSolverResults(recoveredResults, payload?.results ?? []);
        opts.onSolverProgress?.(recoveredResults);
        if (payload?.complete && !payload.error && recoveredResults.length >= solverCount) {
          reportPhase("finalizing");
          return { ...payload, results: recoveredResults };
        }
        lastFailure = payload?.error ?? lastFailure;
      }
      if (opts.cancelSignal.aborted) throw new Error("Cancelled by user.");
    }
    if (opts.mode === "patch-precheck") return { complete: false, results: [], error: lastFailure };
    return {
      complete: false,
      results: fillMissingSolverResults(solverCount, recoveredResults, lastFailure),
      error: lastFailure,
    };
  } finally {
    opts.cancelSignal.removeEventListener("abort", onAbort);
    if (taskArn) {
      if (!stoppedByUs) {
        await clients.ecs
          .send(new StopTaskCommand({ cluster: taskCluster, task: taskArn, reason: "shipd checks cleanup" }))
          .catch(() => undefined);
      }
      // Do not delete bootstrap/worker objects while a pending task could still
      // be starting and attempting to download them.
      await waitUntilTaskStopped(clients.ecs, taskCluster, taskArn);
    }
    await deleteObjects(clients.s3, cleanupBucket, keys).catch(() => undefined);
    clients.ecs.destroy();
    clients.ec2.destroy();
    clients.s3.destroy();
    clients.sts.destroy();
    try {
      rmSync(archivePath, { force: true });
      if (bootstrapPath) rmSync(bootstrapPath, { force: true });
      if (workerClaudeTokenPath) rmSync(workerClaudeTokenPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

export async function runFargateClaudeBenchmark(opts: {
  pi: ExtensionAPI;
  repoDir: string;
  snapshotDir: string;
  taskPrompt: string;
  config: ChecksConfig;
  solverConfig: SolverGapConfig;
  cancelSignal: AbortSignal;
  runId: string;
  onSolverCompleted?: (result: SolverRunResult) => void;
  onSolverProgress?: (results: SolverRunResult[]) => void;
  onResourceUsage?: (usage: FargateResourceUsage) => void;
  onPhase?: (phase: string) => void;
}): Promise<{ results: SolverRunResult[]; resourceUsage?: FargateResourceUsage }> {
  const payload = await runFargateWorker({ ...opts, mode: "solver" });
  const results = await persistResults(opts, payload.results);
  for (const result of results) opts.onSolverCompleted?.(result);
  return { results, resourceUsage: payload.resourceUsage };
}

function enforcePreSolutionPassInvariant(precheck: PatchPrecheckResult): PatchPrecheckResult {
  const phase = precheck.phases.find((item) => item.phase === "new-before-solution");
  if (!phase || phase.passedTestcases === null || phase.passedTestcases <= 0) return precheck;

  const error =
    precheck.error ??
    [
      "phase: new tests before solution",
      "instruction: Fix test.patch so every new test case or subtest fails or errors individually before the solution; no new case may pass. Do not remove tests.",
      `passed tests: ${phase.passedTestcases}`,
      `skipped tests: ${phase.skippedTestcases ?? "unknown"}`,
      `passing tests: ${phase.passedTestNames.length > 0 ? phase.passedTestNames.join(", ") : "none"}`,
      `reported passed tests that also failed: ${
        phase.partiallyPassedTestNames.length > 0 ? phase.partiallyPassedTestNames.join(", ") : "none"
      }`,
      `failed tests: ${phase.failedTestNames.length > 0 ? phase.failedTestNames.join(", ") : "none"}`,
      `errored tests: ${phase.erroredTestNames.length > 0 ? phase.erroredTestNames.join(", ") : "none"}`,
    ].join("\n");
  return { ...precheck, status: "failed", passed: false, error };
}

export async function runFargatePatchPrecheck(opts: {
  pi: ExtensionAPI;
  repoDir: string;
  snapshotDir: string;
  config: ChecksConfig;
  cancelSignal: AbortSignal;
  runId: string;
  precheckTimeoutMinutes?: number;
  onResourceUsage?: (usage: FargateResourceUsage) => void;
  onPhase?: (phase: string) => void;
}): Promise<PatchPrecheckResult> {
  try {
    const payload = await runFargateWorker({ ...opts, mode: "patch-precheck" });
    if (!payload.precheck) throw new Error(payload.error ?? "no result was returned");
    return enforcePreSolutionPassInvariant(payload.precheck);
  } catch (error) {
    throw new Error(
      `Fargate patch precheck task failed.\nplatform: linux\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const DETECTOR_TASK_DEFINITION = "shipd-humanizer-detector-spot";
const DETECTOR_CONTAINER_NAME = "detector";
const DETECTOR_TASK_TIMEOUT_MS = 15 * 60 * 1000;

/** Run one on-demand Spot task to score all drafts from a humanizer invocation. */
export async function runFargateDetectorBatch(opts: {
  texts: string[];
  fargateConfig: FargateConfig;
  cancelSignal?: AbortSignal;
  onPhase?: (phase: string) => void;
}): Promise<unknown[]> {
  if (
    opts.texts.length < HUMANIZER_MIN_CANDIDATE_COUNT ||
    opts.texts.length > HUMANIZER_MAX_CANDIDATE_COUNT ||
    opts.texts.some((text) => !text.trim())
  ) {
    throw new Error("The Fargate detector expects one to ten non-empty candidate texts.");
  }
  if (opts.cancelSignal?.aborted) throw new Error("Humanization cancelled.");

  const region = process.env.AWS_REGION ?? opts.fargateConfig.region ?? "us-east-1";
  const clients = awsClients(region, opts.fargateConfig.awsProfile);
  const runId = randomUUID();
  const keys: Record<string, string> = { input: `runs/${runId}/humanizer-input.json` };
  let bucket: string | undefined;
  let cluster: string | undefined;
  let taskArn: string | undefined;
  let stoppedByUs = false;
  const stopActiveTask = async (reason: string) => {
    if (!taskArn || !cluster) return;
    await clients.ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason })).catch(() => undefined);
    await waitUntilTaskStopped(clients.ecs, cluster, taskArn);
    taskArn = undefined;
  };
  const onAbort = () => {
    if (taskArn) {
      stoppedByUs = true;
      void stopActiveTask("humanization cancelled");
    }
  };
  opts.cancelSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    opts.onPhase?.("preparing detector task");
    const context = await resolveAwsContext(clients, opts.fargateConfig, region);
    bucket = context.bucket;
    cluster = context.cluster;
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keys.input,
        Body: JSON.stringify({ texts: opts.texts }),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }),
    );

    const maxRetries = Math.min(3, Math.max(0, Math.floor(opts.fargateConfig.maxRetries ?? 1)));
    let lastFailure = "Fargate Spot detector task did not return scores.";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (opts.cancelSignal?.aborted) throw new Error("Humanization cancelled.");
      const resultKey = `runs/${runId}/humanizer-result-${attempt}.json`;
      keys[`result${attempt}`] = resultKey;
      const inputUrl = await getSignedUrl(clients.s3, new GetObjectCommand({ Bucket: bucket, Key: keys.input }), {
        expiresIn: URL_EXPIRY_SECONDS,
      });
      const resultPutUrl = await getSignedUrl(
        clients.s3,
        new PutObjectCommand({ Bucket: bucket, Key: resultKey, ContentType: "application/json" }),
        { expiresIn: URL_EXPIRY_SECONDS },
      );
      opts.onPhase?.("starting Spot detector");
      const run = await clients.ecs.send(
        new RunTaskCommand({
          cluster,
          capacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }],
          taskDefinition: DETECTOR_TASK_DEFINITION,
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: context.subnets,
              securityGroups: [context.securityGroup],
              assignPublicIp: "ENABLED",
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: DETECTOR_CONTAINER_NAME,
                environment: [
                  { name: "SHIPD_DETECTOR_INPUT_URL", value: inputUrl },
                  { name: "SHIPD_DETECTOR_RESULT_URL", value: resultPutUrl },
                ],
              },
            ],
          },
        }),
      );
      taskArn = run.tasks?.[0]?.taskArn;
      if (!taskArn) {
        lastFailure = run.failures?.[0]?.reason ?? "ECS could not place the FARGATE_SPOT detector task.";
        continue;
      }

      opts.onPhase?.("waiting for detector scores");
      const deadline = Date.now() + DETECTOR_TASK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (opts.cancelSignal?.aborted) {
          stoppedByUs = true;
          await stopActiveTask("humanization cancelled");
          throw new Error("Humanization cancelled.");
        }
        const result = await readJsonObject(clients.s3, bucket, resultKey);
        if (isRecord(result)) {
          if (typeof result.error === "string") {
            lastFailure = result.error;
            await stopActiveTask("detector returned an error");
            break;
          }
          if (!Array.isArray(result.scores) || result.scores.length !== opts.texts.length) {
            lastFailure = "Fargate detector returned an invalid score batch.";
            await stopActiveTask("detector returned an invalid result");
            break;
          }
          const scores = result.scores;
          await stopActiveTask("detector batch completed");
          return scores;
        }
        const described = await clients.ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
        const task = described.tasks?.[0];
        if (task?.lastStatus === "STOPPED") {
          lastFailure =
            task.stoppedReason ??
            task.containers?.find((container) => container.exitCode !== 0)?.reason ??
            "Fargate detector task stopped before returning a result.";
          taskArn = undefined;
          break;
        }
        await sleep(POLL_MS);
      }
      if (taskArn) {
        lastFailure = "Fargate Spot detector task timed out.";
        await stopActiveTask("detector task timed out");
      }
      if (opts.cancelSignal?.aborted) throw new Error("Humanization cancelled.");
    }
    throw new Error(`Fargate Spot detector task failed: ${lastFailure}`);
  } finally {
    opts.cancelSignal?.removeEventListener("abort", onAbort);
    if (taskArn) {
      if (!stoppedByUs) await stopActiveTask("humanization task cleanup");
      else await waitUntilTaskStopped(clients.ecs, cluster, taskArn);
    }
    await deleteObjects(clients.s3, bucket, keys).catch(() => undefined);
    clients.ecs.destroy();
    clients.ec2.destroy();
    clients.s3.destroy();
    clients.sts.destroy();
  }
}

function loadFargateConfigFromChecks(config: ChecksConfig, repoDir: string, mode: WorkerMode): FargateConfig {
  const fargate = config.fargate ?? {};
  if (mode === "patch-precheck") {
    return {
      ...fargate,
      resourceProfile: FARGATE_PREQUALITY_PROFILE,
      adaptiveResourceProfile: false,
      projectProfiles: {},
    };
  }
  const projectProfile = fargate.projectProfiles?.[repoDir];
  return projectProfile ? { ...fargate, resourceProfile: projectProfile } : fargate;
}

function findClaudeOAuthTokenPath(solverConfig?: SolverGapConfig): string | undefined {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE?.trim() || solverConfig?.claudeOAuthTokenFile?.trim() || undefined;
}

function findWorkerPath(): string {
  const candidates = [
    fileURLToPath(new URL("./fargate-worker.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/fargate-worker.mjs", import.meta.url)),
    join(process.cwd(), "dist", "fargate-worker.mjs"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Missing dist/fargate-worker.mjs. Build pi-shipd-checks first.");
  return found;
}

async function createSourceArchive(
  pi: ExtensionAPI,
  sourceDir: string,
  archivePath: string,
  cancelSignal: AbortSignal,
  excludeBenchmarkPatches: boolean,
): Promise<void> {
  const forceLocal = process.platform === "win32" ? "--force-local " : "";
  const patchExclusions = excludeBenchmarkPatches
    ? "--exclude=./solution.patch --exclude=./test.patch --exclude=./agent_prompt.md "
    : "";
  const command = `tar ${forceLocal}${patchExclusions}-czf ${bashQuote(toSlashPath(archivePath))} -C ${bashQuote(toSlashPath(sourceDir))} .`;
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const result = await pi.exec(shell, ["-c", command], { cwd: sourceDir, timeout: 120_000, signal: cancelSignal });
  if (cancelSignal.aborted) throw new Error("Cancelled by user.");
  if (result.code !== 0) throw new Error(result.stderr?.trim() || "Could not create the Fargate source archive.");
}

function prepareClaudeOAuthToken(sourcePath: string, destinationPath: string): void {
  let token: string;
  try {
    token = readFileSync(sourcePath, "utf-8").trim();
  } catch (error) {
    throw new Error(
      `Could not read the configured Claude OAuth token file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!token) throw new Error(`The configured Claude OAuth token file is empty: ${sourcePath}.`);
  if (/\s/.test(token))
    throw new Error(`The configured Claude OAuth token file must contain only the token: ${sourcePath}.`);
  writeFileSync(destinationPath, token, { encoding: "utf-8", mode: 0o600 });
  chmodSync(destinationPath, 0o600);
}

async function putFile(s3: S3Client, bucket: string, key: string, path: string, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(path),
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }),
  );
}

async function resolveAwsContext(
  clients: ReturnType<typeof awsClients>,
  config: FargateConfig,
  region: string,
): Promise<AwsContext> {
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) throw new Error("Could not determine AWS account identity.");
  const bucket = config.bucket ?? `shipd-checks-${identity.Account}-${region}`;
  await ensureBucket(clients.s3, bucket, region);

  let cluster = config.cluster;
  if (!cluster) {
    const listed = await clients.ecs.send(new ListClustersCommand({ maxResults: 1 }));
    cluster = listed.clusterArns?.[0];
  }
  if (!cluster)
    cluster = (await clients.ecs.send(new CreateClusterCommand({ clusterName: "pi-shipd-checks" }))).cluster
      ?.clusterArn;
  if (!cluster) throw new Error("Could not find or create an ECS cluster.");

  const vpcs = await clients.ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }));
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error("No default VPC found. Configure Fargate subnetIds/securityGroupId explicitly.");
  const subnets = config.subnetIds?.length
    ? config.subnetIds
    : ((
        await clients.ec2.send(
          new DescribeSubnetsCommand({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "map-public-ip-on-launch", Values: ["true"] },
            ],
          }),
        )
      ).Subnets?.map((subnet) => subnet.SubnetId).filter((id): id is string => Boolean(id)) ?? []);
  if (subnets.length === 0) throw new Error("No public subnet found for the Fargate task.");
  let securityGroup = config.securityGroupId;
  if (!securityGroup) {
    securityGroup = (
      await clients.ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: "vpc-id", Values: [vpcId] },
            { Name: "group-name", Values: ["default"] },
          ],
        }),
      )
    ).SecurityGroups?.[0]?.GroupId;
  }
  if (!securityGroup) throw new Error("No default security group found.");
  return { region, bucket, cluster, subnets, securityGroup };
}

async function ensureBucket(s3: S3Client, bucket: string, region: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: region as import("@aws-sdk/client-s3").BucketLocationConstraint,
              },
            }),
      }),
    );
  }
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
}

async function registerTaskDefinition(
  ecs: ECSClient,
  plan: FargateDockerPlan,
  cpu: number,
  memoryMiB: number,
  region: string,
  config: FargateConfig,
): Promise<string> {
  const response = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: "pi-shipd-checks-fargate",
      ...(config.taskRoleArn ? { taskRoleArn: config.taskRoleArn } : {}),
      ...(config.executionRoleArn ? { executionRoleArn: config.executionRoleArn } : {}),
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: String(cpu * 1024),
      memory: String(memoryMiB),
      containerDefinitions: [
        {
          name: TASK_CONTAINER_NAME,
          image: plan.baseImage,
          essential: true,
          linuxParameters: { initProcessEnabled: true },
          command: [
            "bash",
            "-lc",
            "python -c \"import os,urllib.request; urllib.request.urlretrieve(os.environ['SHIPD_BOOTSTRAP_URL'],'/tmp/shipd-bootstrap.json')\" && chmod 600 /tmp/shipd-bootstrap.json && python -c \"import json,urllib.request; b=json.load(open('/tmp/shipd-bootstrap.json')); urllib.request.urlretrieve(b['workerUrl'],'/tmp/shipd-fargate-worker.mjs')\" && exec node /tmp/shipd-fargate-worker.mjs",
          ],
          ...(config.executionRoleArn
            ? {
                logConfiguration: {
                  logDriver: "awslogs" as const,
                  options: {
                    "awslogs-group": config.logGroup ?? "/aws/ecs/pi-shipd-checks",
                    "awslogs-region": region,
                    "awslogs-stream-prefix": "solver",
                  },
                },
              }
            : {}),
        },
      ],
    }),
  );
  if (!response.taskDefinition?.taskDefinitionArn) throw new Error("ECS did not return a task definition ARN.");
  return response.taskDefinition.taskDefinitionArn;
}

async function waitUntilTaskStopped(ecs: ECSClient, cluster: string | undefined, taskArn: string): Promise<void> {
  if (!cluster) return;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
      if (described.tasks?.[0]?.lastStatus === "STOPPED") return;
    } catch {
      return;
    }
    await sleep(2_000);
  }
}

async function waitForTask(
  ecs: ECSClient,
  cluster: string,
  taskArn: string,
  getResult: () => Promise<WorkerPayload | undefined>,
  timeoutMinutes: number,
  cancelSignal: AbortSignal,
  onPayload: (results: SolverRunResult[], resourceUsage?: FargateResourceUsage, phase?: string) => void,
  onRunning: () => void,
  markStopped: () => void,
): Promise<WorkerPayload | undefined> {
  const deadline = Date.now() + (Math.max(10, timeoutMinutes) + 20) * 60 * 1000;
  let lastPayload: WorkerPayload | undefined;
  let reportedRunning = false;
  while (Date.now() < deadline) {
    if (cancelSignal.aborted) {
      markStopped();
      await ecs
        .send(new StopTaskCommand({ cluster, task: taskArn, reason: "shipd checks cancelled" }))
        .catch(() => undefined);
      throw new Error("Cancelled by user.");
    }
    const payload = await getResult();
    if (payload) {
      lastPayload = payload;
      onPayload(payload.results, payload.resourceUsage, payload.phase);
      if (payload.complete) return payload;
    }
    const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
    const task = described.tasks?.[0];
    if (task?.lastStatus === "RUNNING" && !reportedRunning) {
      reportedRunning = true;
      onRunning();
    }
    if (task?.lastStatus === "STOPPED") {
      const final = await getResult();
      if (final) {
        onPayload(final.results, final.resourceUsage, final.phase);
        return final;
      }
      const reason = task.stoppedReason ?? task.containers?.[0]?.reason ?? "Fargate task stopped without a result.";
      return lastPayload ?? { complete: false, results: [], error: reason };
    }
    await sleep(POLL_MS);
  }
  markStopped();
  await ecs
    .send(new StopTaskCommand({ cluster, task: taskArn, reason: "shipd checks timeout" }))
    .catch(() => undefined);
  return lastPayload ?? { complete: false, results: [], error: "Fargate task timed out." };
}

async function readResultObject(s3: S3Client, bucket: string, key: string): Promise<WorkerPayload | undefined> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as WorkerPayload) : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonObject(s3: S3Client, bucket: string, key: string): Promise<unknown | undefined> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

async function persistResults(
  opts: { repoDir: string; runId: string },
  remoteResults: WorkerSolverResult[],
): Promise<SolverRunResult[]> {
  return remoteResults.map((remote) => {
    const { agentStepsGzipBase64, ...result } = remote;
    const dir = join(opts.repoDir, SOLVER_ARTIFACTS_DIRNAME, opts.runId, `solver_${remote.index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "solution.diff"), remote.diff, "utf-8");
    writeFileSync(join(dir, "agent_output.txt"), remote.agentOutput ?? "", "utf-8");
    if (agentStepsGzipBase64) {
      try {
        writeFileSync(join(dir, "agent_steps.jsonl"), gunzipSync(Buffer.from(agentStepsGzipBase64, "base64")));
      } catch (error) {
        writeFileSync(
          join(dir, "agent_steps_error.txt"),
          `Could not decompress the agent-step trace: ${error instanceof Error ? error.message : String(error)}`,
          "utf-8",
        );
      }
    }
    writeFileSync(join(dir, "base_test_output.txt"), remote.baseTests?.output ?? "not run", "utf-8");
    writeFileSync(join(dir, "new_test_output.txt"), remote.newTests?.output ?? "not run", "utf-8");
    result.artifactsDir = dir;
    return result;
  });
}

function mergeSolverResults(current: WorkerSolverResult[], incoming: WorkerSolverResult[]): WorkerSolverResult[] {
  const byIndex = new Map(current.map((result) => [result.index, result]));
  for (const result of incoming) byIndex.set(result.index, result);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function fillMissingSolverResults(count: number, completed: WorkerSolverResult[], error: string): WorkerSolverResult[] {
  const byIndex = new Map(completed.map((result) => [result.index, result]));
  for (let index = 1; index <= count; index += 1) {
    if (!byIndex.has(index)) {
      byIndex.set(index, {
        index,
        status: "error",
        passed: false,
        diff: "",
        testOutputTail: error,
        error,
        durationMs: 0,
        totalTests: null,
        failedTests: null,
      });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

async function deleteObjects(s3: S3Client, bucket: string | undefined, keys: Record<string, string>): Promise<void> {
  if (!bucket) return;
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: Object.values(keys).map((Key) => ({ Key })) },
    }),
  );
}
