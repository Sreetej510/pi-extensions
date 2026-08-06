import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { CONFIG_PATH, resolveFargateResources } from "./config.js";
import { type FargateDockerPlan, parseFargateDockerfile } from "./fargate-docker.js";
import { bashQuote, toSlashPath } from "./git.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import type { ChecksConfig, FargateConfig, SolverGapConfig, SolverRunResult } from "./types.js";

const TASK_CONTAINER_NAME = "shipd-worker";
const WORKER_S3_NAME = "fargate-worker.mjs";
const URL_EXPIRY_SECONDS = 55 * 60;
const POLL_MS = 5000;

interface WorkerSolverResult extends SolverRunResult {
  trajectory?: unknown[];
}

interface WorkerPayload {
  complete: boolean;
  results: WorkerSolverResult[];
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

export async function runFargateSolverGapFinder(opts: {
  pi: ExtensionAPI;
  repoDir: string;
  snapshotDir: string;
  config: ChecksConfig;
  solverConfig: SolverGapConfig;
  cancelSignal: AbortSignal;
  runId: string;
  onSolverCompleted?: (result: SolverRunResult) => void;
  onSolverProgress?: (results: SolverRunResult[]) => void;
  onPhase?: (phase: string) => void;
}): Promise<SolverRunResult[]> {
  if (opts.cancelSignal.aborted) throw new Error("Cancelled by user.");
  opts.onPhase?.("preparing image");
  const dockerfilePath = join(opts.repoDir, "Dockerfile");
  if (!existsSync(dockerfilePath))
    throw new Error("Fargate solver gap finder requires Dockerfile in the project root.");
  const plan = parseFargateDockerfile(readFileSync(dockerfilePath, "utf-8"));
  const fargateConfig = loadFargateConfigFromChecks(opts.config, opts.repoDir);
  const region = process.env.AWS_REGION ?? fargateConfig.region ?? "us-east-1";
  const clients = awsClients(region, fargateConfig.awsProfile);
  const resources = resolveFargateResources(opts.repoDir, fargateConfig);
  const archivePath = join(tmpdir(), `.shipd-fargate-source-${randomUUID()}.tar.gz`);
  const workerPath = findWorkerPath();
  const authPath = join(dirnameOfConfig(), "auth.json");
  if (!existsSync(authPath)) throw new Error(`Missing Pi auth file: ${authPath}`);

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
    worker: `runs/${opts.runId}/${WORKER_S3_NAME}`,
    auth: `runs/${opts.runId}/auth.json`,
    bootstrap: `runs/${opts.runId}/bootstrap.json`,
    result: `runs/${opts.runId}/result.json`,
  };
  try {
    const context = await resolveAwsContext(clients, fargateConfig, region);
    cleanupBucket = context.bucket;
    taskCluster = context.cluster;
    await createSourceArchive(opts.pi, opts.snapshotDir, archivePath, opts.cancelSignal);
    await putFile(clients.s3, context.bucket, keys.source, archivePath, "application/gzip");
    await putFile(clients.s3, context.bucket, keys.worker, workerPath, "text/javascript");
    await putFile(clients.s3, context.bucket, keys.auth, authPath, "application/json");

    bootstrapPath = join(tmpdir(), `.shipd-fargate-bootstrap-${randomUUID()}.json`);
    const taskDefinition = await registerTaskDefinition(
      clients.ecs,
      plan,
      resources.cpu,
      resources.memoryMiB,
      region,
      fargateConfig,
    );
    const solverCount = Math.max(1, Math.floor(opts.solverConfig.solverCount));
    const directS3 = Boolean(fargateConfig.taskRoleArn);
    const maxRetries = Math.min(3, Math.max(0, Math.floor(fargateConfig.maxRetries ?? 1)));
    let lastFailure = "Fargate task did not produce a result.";
    opts.onPhase?.("requesting sandbox");
    let recoveredResults: WorkerSolverResult[] = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (opts.cancelSignal.aborted) throw new Error("Cancelled by user.");
      opts.onPhase?.("requesting sandbox");
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
      const authUrl = directS3
        ? undefined
        : await getSignedUrl(clients.s3, new GetObjectCommand({ Bucket: context.bucket, Key: keys.auth }), {
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
          authUrl,
          resultPutUrl,
          resultGetUrl,
          ...(directS3
            ? {
                bucket: context.bucket,
                region,
                sourceKey: keys.source,
                authKey: keys.auth,
                resultKey: keys.result,
              }
            : {}),
          planB64: Buffer.from(JSON.stringify(plan), "utf-8").toString("base64url"),
          provider: opts.solverConfig.provider,
          modelId: opts.solverConfig.modelId,
          thinkingLevel: opts.solverConfig.thinkingLevel,
          timeoutMinutes: opts.solverConfig.timeoutMinutes,
          solverCount,
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
        opts.onPhase?.("requesting sandbox");
        continue;
      }
      opts.onPhase?.("sandbox created");
      const payload = await waitForTask(
        clients.ecs,
        context.cluster,
        taskArn,
        () => readResultObject(clients.s3, context.bucket, keys.result),
        opts.solverConfig.timeoutMinutes,
        opts.cancelSignal,
        (results) => opts.onSolverProgress?.(results),
        () => opts.onPhase?.("running agents"),
        () => {
          stoppedByUs = true;
        },
      );
      taskArn = undefined;
      recoveredResults = mergeSolverResults(recoveredResults, payload?.results ?? []);
      opts.onSolverProgress?.(recoveredResults);
      if (payload?.complete && !payload.error && recoveredResults.length >= solverCount) {
        opts.onPhase?.("finalizing");
        const results = await persistResults(opts, recoveredResults, opts.solverConfig.saveArtifacts);
        for (const result of results) opts.onSolverCompleted?.(result);
        return results;
      }
      lastFailure = payload?.error ?? lastFailure;
      if (opts.cancelSignal.aborted) throw new Error("Cancelled by user.");
    }
    const results = await persistResults(
      opts,
      fillMissingSolverResults(solverCount, recoveredResults, lastFailure),
      opts.solverConfig.saveArtifacts,
    );
    for (const result of results) opts.onSolverCompleted?.(result);
    return results;
  } finally {
    opts.cancelSignal.removeEventListener("abort", onAbort);
    if (taskArn && !stoppedByUs) {
      await clients.ecs
        .send(new StopTaskCommand({ cluster: taskCluster, task: taskArn, reason: "shipd checks cleanup" }))
        .catch(() => undefined);
    }
    await deleteObjects(clients.s3, cleanupBucket, keys).catch(() => undefined);
    clients.ecs.destroy();
    clients.ec2.destroy();
    clients.s3.destroy();
    clients.sts.destroy();
    try {
      rmSync(archivePath, { force: true });
      if (bootstrapPath) rmSync(bootstrapPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

function loadFargateConfigFromChecks(config: ChecksConfig, repoDir: string): FargateConfig {
  const fargate = config.fargate ?? {};
  const projectProfile = fargate.projectProfiles?.[repoDir];
  return projectProfile ? { ...fargate, resourceProfile: projectProfile } : fargate;
}

function dirnameOfConfig(): string {
  const slash = Math.max(CONFIG_PATH.lastIndexOf("/"), CONFIG_PATH.lastIndexOf("\\"));
  return slash >= 0 ? CONFIG_PATH.slice(0, slash) : ".";
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
): Promise<void> {
  const forceLocal = process.platform === "win32" ? "--force-local " : "";
  const command = `tar ${forceLocal}--exclude=./solution.patch -czf ${bashQuote(toSlashPath(archivePath))} -C ${bashQuote(toSlashPath(sourceDir))} .`;
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const result = await pi.exec(shell, ["-c", command], { cwd: sourceDir, timeout: 120_000, signal: cancelSignal });
  if (cancelSignal.aborted) throw new Error("Cancelled by user.");
  if (result.code !== 0) throw new Error(result.stderr?.trim() || "Could not create the Fargate source archive.");
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
          command: [
            "bash",
            "-lc",
            "python -c \"import os,urllib.request; urllib.request.urlretrieve(os.environ['SHIPD_BOOTSTRAP_URL'],'/tmp/shipd-bootstrap.json')\" && python -c \"import json,urllib.request; b=json.load(open('/tmp/shipd-bootstrap.json')); urllib.request.urlretrieve(b['workerUrl'],'/tmp/shipd-fargate-worker.mjs')\" && exec node /tmp/shipd-fargate-worker.mjs",
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

async function waitForTask(
  ecs: ECSClient,
  cluster: string,
  taskArn: string,
  getResult: () => Promise<WorkerPayload | undefined>,
  timeoutMinutes: number,
  cancelSignal: AbortSignal,
  onPayload: (results: SolverRunResult[]) => void,
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
      onPayload(payload.results);
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
        onPayload(final.results);
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

async function persistResults(
  opts: { repoDir: string; runId: string },
  remoteResults: WorkerSolverResult[],
  saveArtifacts: boolean,
): Promise<SolverRunResult[]> {
  return remoteResults.map((remote) => {
    const { trajectory, ...result } = remote;
    if (saveArtifacts) {
      const dir = join(opts.repoDir, SOLVER_ARTIFACTS_DIRNAME, opts.runId, `solver_${remote.index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "trajectory.json"), `${JSON.stringify(trajectory ?? [], null, 2)}\n`, "utf-8");
      writeFileSync(join(dir, "solution.patch"), remote.diff, "utf-8");
      writeFileSync(join(dir, "test_output.txt"), remote.testOutputTail, "utf-8");
      result.artifactsDir = dir;
    }
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
