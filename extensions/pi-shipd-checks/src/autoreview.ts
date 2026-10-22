/**
 * `/checks --autoreview`: a local replica of the hosted Auto Review for the tests and the solution, ported from the
 * shipd-workflow rulebook (shipd-v5/rulebook). Read-only Claude CLI reviewers run on this machine:
 *   round 1: Local Test Quality (per-file fairness batches + one coverage read), the solution audit over
 *            every lens, and per-unit Solution Quality; one read each, with the redundant reviewers folded into these;
 *   round 2: synthesis applies the proof legs to every finding.
 * A finding gates (BLOCK) only when synthesis keeps it HIGH. Counter-tests are saved, not executed. test.sh is out of
 * scope: it is stripped from test.patch and the snapshot before any reviewer sees them. Only the final report is kept:
 * reviewer prompts, streams and answers live in the temp workspace and are deleted with it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ASSETS_DIR,
  buildAuditPrompt,
  buildSqUnitPrompt,
  buildSynthesisPrompt,
  buildTqCoveragePrompt,
  buildTqUnitPrompt,
  type PromptInputs,
  REPO_DIR,
  type SynthesisCandidate,
  TQ_GATING_CONCERNS,
} from "./autoreview-prompts.js";
import { loadAutoReviewConfig } from "./config.js";
import { snapshotGitHead } from "./git.js";
import { extractNewFilesFromPatch, splitPatchFiles, splitPatchHunks } from "./patch.js";
import { PROGRESS_WIDGET_KEY, renderProgressLines } from "./progress.js";
import { formatDuration, formatLocalTimestamp, loadExistingReport } from "./report.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import { endReview, isReviewInProgress, startReview } from "./state.js";
import type { AutoReviewConfig, TokenUsage } from "./types.js";

export const AUTO_REVIEW_REQUIRED_FILES = ["agent_prompt.md", "test.patch", "solution.patch"] as const;
const REVIEWER_TOOLS = "Read,Grep,Glob";
const TQ_BATCH_CHARS = 60_000;
const SQ_UNITS_PER_BATCH = 12;
const SYNTH_CHUNK = 50;
const CANDIDATE_TEXT_LIMIT = 700;
/** tq_local.CLASS_RX: a requirement about a class is PARTIAL when one coverage read says so. */
const CLASS_RX =
  /\b(?:any|every|each|all|other|others|whatever|either|no matter)\b|\bcounts?\b|\bcount as\b|\bdoes not count\b|\*|\bnumber of\b|\bup to\b|\bat least\b|\bat most\b|\bupper limit\b|\b\w+ checks\b|\bpaths?\b|\bkinds?\b|\bstatus(?:es)?\b|\bcodes\b/i;

type ReviewerStatus = "ok" | "timedOut" | "cancelled" | "error" | "noAnswer";

interface ReviewerTask {
  name: string;
  kind: "tq-unit" | "tq-coverage" | "audit" | "sq-unit";
  prompt: string;
}

interface ReviewerResult {
  name: string;
  kind: ReviewerTask["kind"] | "synthesis";
  status: ReviewerStatus;
  answer?: unknown;
  durationMs: number;
  tokenUsage?: TokenUsage;
  error?: string;
}

interface ClaudeRunResult {
  status: Exclude<ReviewerStatus, "noAnswer">;
  text: string;
  stdout: string;
  tokenUsage?: TokenUsage;
  error?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: reviewer answers are untyped JSON
type Json = any;

// ---------------------------------------------------------------------------------------------------------------------
// Claude CLI runner
// ---------------------------------------------------------------------------------------------------------------------

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function claudeTokenUsage(result: Json): TokenUsage | undefined {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const inputTokens = num(usage.input_tokens);
  const cacheReadInputTokens = num(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const totalInputTokens = (inputTokens ?? 0) + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const costUsd = num(result.total_cost_usd);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalInputTokens,
    totalTokens: totalInputTokens + (outputTokens ?? 0),
    ...(num(result.num_turns) !== undefined ? { modelCalls: num(result.num_turns) } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** One read-only `claude --print` session; the prompt goes through stdin, the answer is the final result record. */
export function runClaude(opts: {
  cwd: string;
  prompt: string;
  config: AutoReviewConfig;
  signal: AbortSignal;
}): Promise<ClaudeRunResult> {
  const args = [
    "--print",
    "--model",
    opts.config.modelId,
    "--effort",
    opts.config.thinkingLevel,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--allowedTools",
    REVIEWER_TOOLS,
    "--tools",
    REVIEWER_TOOLS,
  ];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return new Promise((resolve) => {
    if (opts.signal.aborted) {
      resolve({ status: "cancelled", text: "", stdout: "" });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    // The npm shim is a .cmd on Windows, which Node only launches through a shell; the arguments contain no spaces,
    // so they are joined into the command line rather than passed as shell args (deprecated, DEP0190).
    const windows = process.platform === "win32";
    const child = spawn(windows ? `claude ${args.join(" ")}` : "claude", windows ? [] : args, {
      cwd: opts.cwd,
      env,
      shell: windows,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      killTree(child);
      finish({ status: "cancelled", text: "", stdout });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({
        status: "timedOut",
        text: "",
        stdout,
        error: `Reviewer timed out after ${opts.config.timeoutMinutes} min.`,
      });
    }, opts.config.timeoutMinutes * 60_000);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ status: "error", text: "", stdout, error: error.message }));
    child.on("close", (code) => {
      const records = stdout
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line) as Json;
          } catch {
            return undefined;
          }
        })
        .filter((record) => record && typeof record === "object");
      const result = [...records].reverse().find((record: Json) => record.type === "result");
      const text = typeof result?.result === "string" ? result.result : "";
      if (code !== 0 || !result || result.is_error) {
        finish({
          status: "error",
          text,
          stdout,
          tokenUsage: claudeTokenUsage(result),
          error: (stderr.trim() || text || `claude exited with code ${code}`).slice(0, 2000),
        });
        return;
      }
      finish({ status: "ok", text, stdout, tokenUsage: claudeTokenUsage(result) });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.prompt, "utf-8");
  });
}

/** The reviewer's final ```json block (the last one), else the outermost JSON value in the text. */
export function extractJsonAnswer(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  for (const block of fenced.reverse()) {
    try {
      return JSON.parse(block ?? "");
    } catch {
      // try the next block
    }
  }
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

async function runReviewer(
  task: { name: string; kind: ReviewerResult["kind"]; prompt: string },
  cwd: string,
  config: AutoReviewConfig,
  signal: AbortSignal,
): Promise<ReviewerResult> {
  const started = Date.now();
  let last: ReviewerResult | undefined;
  // a stalled or unparsable headless answer is retried once (answer_runner.py)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = await runClaude({ cwd, prompt: task.prompt, config, signal });
    const answer = run.status === "ok" ? extractJsonAnswer(run.text) : undefined;
    last = {
      name: task.name,
      kind: task.kind,
      status: run.status === "ok" && answer === undefined ? "noAnswer" : run.status,
      ...(answer !== undefined ? { answer } : {}),
      durationMs: Date.now() - started,
      ...(run.tokenUsage ? { tokenUsage: run.tokenUsage } : {}),
      ...(run.error
        ? { error: run.error }
        : answer === undefined && run.status === "ok"
          ? { error: "No JSON answer." }
          : {}),
    };
    if (last.status !== "error" && last.status !== "noAnswer") break;
  }
  return last as ReviewerResult;
}

async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// Workspace and reviewer plan
// ---------------------------------------------------------------------------------------------------------------------

const isTestSh = (path: string) => /(^|\/)test\.sh$/.test(path);

/** test.patch without its test.sh section: the runner is out of scope for this review. */
function stripTestSh(testPatch: string): string {
  return splitPatchFiles(testPatch)
    .filter((file) => !isTestSh(file.path))
    .map((file) => file.text)
    .join("");
}

function prepareAssets(repoDir: string, workspace: string): PromptInputs {
  const repo = join(workspace, REPO_DIR);
  for (const file of [
    "agent_prompt.md",
    "test.patch",
    "solution.patch",
    "Dockerfile",
    "shipd_report.json",
    "test.sh",
  ]) {
    rmSync(join(repo, file), { recursive: true, force: true });
  }
  const assets = join(workspace, ASSETS_DIR);
  mkdirSync(assets, { recursive: true });
  const problem = readFileSync(join(repoDir, "agent_prompt.md"), "utf-8");
  const testPatch = stripTestSh(readFileSync(join(repoDir, "test.patch"), "utf-8"));
  const solutionPatch = readFileSync(join(repoDir, "solution.patch"), "utf-8");
  writeFileSync(join(assets, "problem.md"), problem, "utf-8");
  writeFileSync(join(assets, "test.patch"), testPatch, "utf-8");
  writeFileSync(join(assets, "solution.patch"), solutionPatch, "utf-8");
  for (const file of extractNewFilesFromPatch(testPatch)) {
    const path = join(assets, "proposed_tests", file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, "utf-8");
  }
  return { problem, testPatch, solutionPatch };
}

function solutionUnits(solutionPatch: string) {
  return splitPatchHunks(solutionPatch).map((hunk, index) => ({
    id: `unit-${String(index + 1).padStart(2, "0")}`,
    name: hunk.context || `hunk ${index + 1}`,
    file: hunk.file,
    header: hunk.header,
    text: hunk.text,
  }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function planReviewers(inputs: PromptInputs): ReviewerTask[] {
  const tasks: ReviewerTask[] = [];
  const testFiles = splitPatchFiles(inputs.testPatch);
  const batches: Array<Array<{ path: string; text: string }>> = [];
  for (const file of testFiles) {
    const current = batches.at(-1);
    const size = current?.reduce((total, item) => total + item.text.length, 0) ?? 0;
    if (current && size + file.text.length <= TQ_BATCH_CHARS) current.push(file);
    else batches.push([{ path: file.path, text: file.text }]);
  }
  batches.forEach((files, index) => {
    tasks.push({
      name: `tq-unit-${String(index).padStart(2, "0")}`,
      kind: "tq-unit",
      prompt: buildTqUnitPrompt(files, inputs),
    });
  });
  tasks.push({ name: "tq-coverage", kind: "tq-coverage", prompt: buildTqCoveragePrompt(inputs) });
  tasks.push({ name: "audit-all", kind: "audit", prompt: buildAuditPrompt(inputs) });
  chunk(solutionUnits(inputs.solutionPatch), SQ_UNITS_PER_BATCH).forEach((part, index) => {
    tasks.push({
      name: `sq-unit-${String(index).padStart(2, "0")}`,
      kind: "sq-unit",
      prompt: buildSqUnitPrompt(part, index, inputs),
    });
  });
  return tasks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings: normalise every reviewer answer into synthesis candidates
// ---------------------------------------------------------------------------------------------------------------------

interface Candidate extends SynthesisCandidate {
  source: string;
  /** The sub-reviewer's own severity, before synthesis. */
  severity: string;
  area: "tests" | "solution";
}

interface CounterTest {
  id: string;
  patch: string;
  cmd: string;
}

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));
const clip = (text: string) => (text.length > CANDIDATE_TEXT_LIMIT ? `${text.slice(0, CANDIDATE_TEXT_LIMIT)}…` : text);
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value : []);
const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

interface NotFairTest {
  name: string;
  file: string;
  pinned: string;
  fix: string;
  evidence: string;
}

interface CollectedFindings {
  candidates: Candidate[];
  counterTests: CounterTest[];
  notFair: NotFairTest[];
  testsGraded: number;
  coverageGaps: Json[];
}

export function collectFindings(results: ReviewerResult[]): CollectedFindings {
  const candidates: Candidate[] = [];
  const counterTests: CounterTest[] = [];
  const notFair: NotFairTest[] = [];
  const coverageGaps: Json[] = [];
  let testsGraded = 0;
  const add = (id: string, source: string, severity: string, area: Candidate["area"], text: string) =>
    candidates.push({ id, source, severity, area, text: clip(text) });
  const keepCounter = (defect: Json) => {
    const patch = str(defect.counter_test_patch);
    if (!patch.trim()) return;
    counterTests.push({
      id: str(defect.counter_test || defect.id) || `CT-${counterTests.length + 1}`,
      patch,
      cmd: str(defect.counter_test_cmd),
    });
  };
  const coverageRows = new Map<string, { quote: string; statuses: string[]; tests: string[] }>();

  for (const result of results) {
    const answer: Json = result.answer;
    if (answer === undefined) continue;
    switch (result.kind) {
      case "tq-unit": {
        asArray(answer.tests).forEach((test: Json, index: number) => {
          testsGraded += 1;
          const unsourced = asArray(test.assertions).filter((row: Json) => /^\s*none\b/i.test(str(row.source)));
          const name = `${str(test.file)} ${str(test.name)}`.trim();
          if (test.fairness === "Not fair" || unsourced.length) {
            const pinned = str(test.pinned) || unsourced.map((row: Json) => str(row.what)).join("; ");
            notFair.push({
              name: str(test.name),
              file: str(test.file),
              pinned,
              fix: str(test.fix),
              evidence: str(test.evidence),
            });
            add(
              `${result.name}.${index}`,
              result.name,
              "HIGH",
              "tests",
              `[test-quality T5 Not fair] ${name}: pinned ${pinned}; evidence: ${str(test.evidence)}; fix: ${str(test.fix)}`,
            );
          }
          const gating = asArray(test.concerns).filter((concern: unknown) => TQ_GATING_CONCERNS.has(str(concern)));
          if (gating.length) {
            add(
              `${result.name}.${index}c`,
              result.name,
              "MEDIUM",
              "tests",
              `[test-quality concern ${gating.join(", ")}] ${name}: ${str(test.qualityCheck)}`,
            );
          }
        });
        break;
      }
      case "tq-coverage": {
        asArray(answer.coverageSuggestions).forEach((gap: Json, index: number) => {
          coverageGaps.push(gap);
          add(
            `${result.name}.${index}`,
            result.name,
            str(gap.severity) || "HIGH",
            "tests",
            `[test-quality coverage ${str(gap.gapKind)}${gap.g1 && gap.g1 !== "none" ? ` G1 ${str(gap.g1)}` : ""} T3/T4] ${str(gap.area)}: requirement "${str(gap.requirement)}"; wrong value that passes: ${str(gap.wrong_value_that_passes)}; suggestion: ${str(gap.suggestion)}${gap.test_change ? `; test change: ${str(gap.test_change)}` : ""}`,
          );
        });
        for (const row of asArray(answer.requirements)) {
          const key = norm(str(row.quote) || str(row.requirement));
          if (!key) continue;
          const entry = coverageRows.get(key) ?? {
            quote: str(row.quote) || str(row.requirement),
            statuses: [],
            tests: [],
          };
          entry.statuses.push(str(row.status).toUpperCase());
          entry.tests.push(...asArray(row.tests).map(str));
          coverageRows.set(key, entry);
        }
        break;
      }
      case "audit": {
        asArray(answer.violations).forEach((violation: Json, index: number) => {
          keepCounter(violation);
          add(
            `audit.${str(violation.id) || index}`,
            result.name,
            "HIGH",
            "solution",
            `[audit ${str(violation.lens)} ${str(violation.dimension)} reach=${str(violation.reach)}${violation.reading === "conflict" ? " reading=conflict" : ""}] "${str(violation.quote)}": ${str(violation.claim)}${violation.oracle ? ` (oracle: ${str(violation.oracle)})` : ""}`,
          );
        });
        break;
      }
      case "sq-unit": {
        const units = Array.isArray(answer) ? answer : asArray(answer?.units);
        for (const unit of units) {
          asArray(unit?.defects).forEach((defect: Json, index: number) => {
            keepCounter(defect);
            add(
              `${result.name}.${str(defect.id) || `${str(unit.unit)}-${index}`}`,
              result.name,
              str(defect.severity) || "HIGH",
              "solution",
              `[solution-quality unit ${str(defect.dimension)} reach=${str(defect.reach)}] ${str(unit.unit)}: ${str(defect.claim)}; promise "${str(defect.promise)}"${defect.input ? `; input: ${str(defect.input)}` : ""}`,
            );
          });
        }
        break;
      }
    }
  }
  // tq_local.partial_gates with one read: a class sentence marked PARTIAL, or any requirement marked UNTESTED
  let rowIndex = 0;
  for (const row of coverageRows.values()) {
    const partial = row.statuses.filter((status) => status === "PARTIAL").length;
    const untested = row.statuses.includes("UNTESTED");
    if (untested || (partial >= 1 && CLASS_RX.test(row.quote))) {
      add(
        `tq-coverage.row${rowIndex++}`,
        "tq-coverage",
        "HIGH",
        "tests",
        `[test-quality requirement ${untested ? "UNTESTED" : "PARTIAL"} T4] "${row.quote}" (tests: ${[...new Set(row.tests)].join(", ") || "none"})`,
      );
    }
  }
  return { candidates, counterTests, notFair, testsGraded, coverageGaps };
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthesis votes and the verdict
// ---------------------------------------------------------------------------------------------------------------------

interface SynthVerdict {
  verdict: string;
  as: string;
  failedLeg: string;
  why: string;
  loadBearing: string;
  promise: string;
}

interface GradedFinding {
  id: string;
  area: Candidate["area"];
  source: string;
  text: string;
  reviewerSeverity: string;
  reads: SynthVerdict[];
  /** Synthesis kept it HIGH. */
  gating: boolean;
  level: "HIGH" | "MEDIUM" | "DROP" | "UNSYNTHESISED";
  as: string;
}

function gradeFindings(candidates: Candidate[], synth: ReviewerResult[]): GradedFinding[] {
  const votes = new Map<string, SynthVerdict[]>();
  for (const result of synth) {
    for (const finding of asArray((result.answer as Json)?.findings)) {
      const id = str(finding.id);
      votes.set(id, [
        ...(votes.get(id) ?? []),
        {
          verdict: str(finding.verdict).toUpperCase(),
          as: str(finding.as),
          failedLeg: str(finding.failed_leg),
          why: str(finding.why),
          loadBearing: str(finding.load_bearing_check),
          promise: str(finding.promise_citation),
        },
      ]);
    }
  }
  return candidates.map((candidate) => {
    const reads = votes.get(candidate.id) ?? [];
    const gating = reads.length > 0 && reads.every((read) => read.verdict === "HIGH");
    const level: GradedFinding["level"] = !reads.length
      ? "UNSYNTHESISED"
      : gating
        ? "HIGH"
        : reads.every((read) => read.verdict === "DROP")
          ? "DROP"
          : "MEDIUM";
    const as = reads.find((read) => read.as)?.as ?? "";
    // a synthesis read can relabel a test finding as a solution defect ("as":"S1")
    const area: Candidate["area"] = /^S\d/i.test(as) ? "solution" : /^T\d|^G1/i.test(as) ? "tests" : candidate.area;
    return {
      id: candidate.id,
      area,
      source: candidate.source,
      text: candidate.text,
      reviewerSeverity: candidate.severity,
      reads,
      gating,
      level,
      as,
    };
  });
}

export interface AutoReviewSummary {
  verdict: "PASS" | "REVIEW" | "BLOCK" | "INCOMPLETE";
  testQuality: "PASS" | "FAIL" | "REVIEW";
  solutionQuality: "PASS" | "FAIL" | "REVIEW";
  high: Array<{ id: string; as: string; area: string; text: string; why: string }>;
  mediumCount: number;
  notFairCount: number;
  testsGraded: number;
  reviewersOk: number;
  reviewersTotal: number;
  counterTests: number;
  durationMs: number;
  reportPath: string;
}

function summarize(opts: {
  graded: GradedFinding[];
  collected: CollectedFindings;
  reviewers: ReviewerResult[];
  synthesis: ReviewerResult[];
  durationMs: number;
  reportPath: string;
}): AutoReviewSummary {
  const high = opts.graded.filter((finding) => finding.gating);
  const medium = opts.graded.filter((finding) => finding.level === "MEDIUM" || finding.level === "UNSYNTHESISED");
  const all = [...opts.reviewers, ...opts.synthesis];
  const failed = all.filter((result) => result.status !== "ok");
  const synthesisMissing =
    opts.collected.candidates.length > 0 && opts.synthesis.every((result) => result.status !== "ok");
  const areaVerdict = (area: Candidate["area"]) =>
    high.some((finding) => finding.area === area)
      ? "FAIL"
      : medium.some((finding) => finding.area === area)
        ? "REVIEW"
        : "PASS";
  const testQuality = opts.collected.notFair.length ? "FAIL" : areaVerdict("tests");
  const solutionQuality = areaVerdict("solution");
  const verdict = high.length
    ? "BLOCK"
    : synthesisMissing || failed.length === all.length
      ? "INCOMPLETE"
      : medium.length || failed.length || testQuality !== "PASS"
        ? "REVIEW"
        : "PASS";
  return {
    verdict,
    testQuality,
    solutionQuality,
    high: high.map((finding) => ({
      id: finding.id,
      as: finding.as,
      area: finding.area,
      text: finding.text,
      why: finding.reads.map((read) => read.why).find(Boolean) ?? "",
    })),
    mediumCount: medium.length,
    notFairCount: opts.collected.notFair.length,
    testsGraded: opts.collected.testsGraded,
    reviewersOk: all.length - failed.length,
    reviewersTotal: all.length,
    counterTests: opts.collected.counterTests.length,
    durationMs: opts.durationMs,
    reportPath: opts.reportPath,
  };
}

function sumUsage(results: ReviewerResult[]): TokenUsage {
  const total: TokenUsage = { totalInputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  for (const result of results) {
    const usage = result.tokenUsage;
    if (!usage) continue;
    total.totalInputTokens = (total.totalInputTokens ?? 0) + (usage.totalInputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    total.totalTokens = (total.totalTokens ?? 0) + (usage.totalTokens ?? 0);
    total.costUsd = (total.costUsd ?? 0) + (usage.costUsd ?? 0);
  }
  return total;
}

function renderMarkdown(opts: {
  summary: AutoReviewSummary;
  graded: GradedFinding[];
  collected: CollectedFindings;
  reviewers: ReviewerResult[];
  synthesis: ReviewerResult[];
  config: AutoReviewConfig;
}): string {
  const { summary, graded, collected } = opts;
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\r?\n/g, " ");
  const md = [
    `# Auto Review (local): ${summary.verdict}`,
    "",
    `Test Quality ${summary.testQuality} · Solution Quality ${summary.solutionQuality} · ${summary.high.length} gating HIGH · ${summary.mediumCount} MEDIUM · reviewers ${summary.reviewersOk}/${summary.reviewersTotal} ok · ${formatDuration(summary.durationMs)} · claude ${opts.config.modelId} effort ${opts.config.thinkingLevel}`,
    "",
    "A finding gates only when synthesis keeps it HIGH. No counter-test or mutant was executed: legs that need execution were decided from the files.",
    "",
    "## Gating findings (synthesis HIGH)",
    "",
  ];
  const high = graded.filter((finding) => finding.gating);
  md.push(
    ...(high.length
      ? high.flatMap((finding) => [
          `### ${finding.id} (${finding.as || finding.area})`,
          "",
          finding.text,
          "",
          ...finding.reads.map(
            (read, index) =>
              `- synthesis${index ? ` (${index + 1})` : ""}: ${read.verdict} — ${read.why}${read.loadBearing ? ` · load-bearing: \`${cell(read.loadBearing).slice(0, 300)}\`` : ""}`,
          ),
          "",
        ])
      : ["none", ""]),
  );
  md.push(
    "## MEDIUM / unproven (fix-before-upload list)",
    "",
    "| id | as | finding | synthesis |",
    "|---|---|---|---|",
  );
  for (const finding of graded.filter((item) => item.level === "MEDIUM" || item.level === "UNSYNTHESISED")) {
    md.push(
      `| ${finding.id} | ${finding.as} | ${cell(finding.text)} | ${cell(finding.reads.map((read) => `${read.verdict}${read.failedLeg && read.failedLeg !== "none" ? ` (${read.failedLeg})` : ""}: ${read.why}`).join(" / ") || "not synthesised")} |`,
    );
  }
  md.push(
    "",
    "## Test Quality (hosted replica)",
    "",
    `${collected.testsGraded} tests graded, ${collected.notFair.length} Not fair.`,
    "",
  );
  for (const test of collected.notFair)
    md.push(`- **${test.file} ${test.name}**: pinned ${test.pinned}. Fix: ${test.fix}`);
  md.push("", "### Coverage suggestions", "");
  for (const gap of collected.coverageGaps) {
    md.push(
      `- [${str(gap.gapKind)}${gap.g1 && gap.g1 !== "none" ? ` / ${str(gap.g1)}` : ""}] ${str(gap.area)}: ${str(gap.suggestion)} (wrong value that passes: ${str(gap.wrong_value_that_passes)})`,
    );
  }
  md.push("", "## Dropped by synthesis", "");
  for (const finding of graded.filter((item) => item.level === "DROP"))
    md.push(`- ${finding.id}: ${finding.reads[0]?.why ?? ""}`);
  md.push("", "## Reviewers", "", "| reviewer | status | time | error |", "|---|---|---|---|");
  for (const result of [...opts.reviewers, ...opts.synthesis]) {
    md.push(
      `| ${result.name} | ${result.status} | ${formatDuration(result.durationMs)} | ${cell(result.error ?? "").slice(0, 160)} |`,
    );
  }
  if (collected.counterTests.length) {
    md.push("", "## Counter-tests (not executed)", "");
    md.push("Apply after solution.patch and test.patch, then run the command in the repo root.", "");
    for (const test of collected.counterTests) {
      md.push(`### ${test.id}`, "");
      if (test.cmd) md.push(`Run: \`${test.cmd}\``, "");
      md.push("````diff", test.patch.trimEnd(), "````", "");
    }
  }
  return `${md.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------------------------------

export async function runAutoReviewCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (isReviewInProgress()) {
    ctx.ui.notify("A checks run is already in progress.", "warning");
    return;
  }
  const missing = AUTO_REVIEW_REQUIRED_FILES.filter((file) => !existsSync(join(ctx.cwd, file)));
  if (missing.length) {
    ctx.ui.notify(`Missing required file(s): ${missing.join(", ")}`, "error");
    return;
  }
  const config = loadAutoReviewConfig();
  const abort = startReview();
  const startedAt = Date.now();
  let label = "preparing workspace";
  let done = 0;
  let total = 1;
  const render = () =>
    ctx.ui.setWidget(PROGRESS_WIDGET_KEY, renderProgressLines(label, done, total, { showBar: total > 1, startedAt }));
  const timer = setInterval(render, 1000);
  render();
  ctx.ui.notify("checks (autoreview) started. Press Ctrl+Shift+X to cancel.", "info");
  const workspace = join(tmpdir(), `checks-autoreview-${randomUUID()}`);
  try {
    mkdirSync(join(workspace, REPO_DIR), { recursive: true });
    const snapshot = await snapshotGitHead(pi, ctx.cwd, join(workspace, REPO_DIR), abort.signal);
    if (snapshot.status === "error") {
      ctx.ui.notify(`checks: ${snapshot.error}`, "error");
      return;
    }
    const inputs = prepareAssets(ctx.cwd, workspace);
    const runId = `${formatLocalTimestamp().replace(/[:.]/g, "-")}-autoreview`;
    const reportFile = join(ctx.cwd, SOLVER_ARTIFACTS_DIRNAME, `${runId}.md`);

    const tasks = planReviewers(inputs);
    total = tasks.length + 2;
    label = `reviewers (${tasks.length})`;
    render();
    const reviewers = await runPool(tasks, config.concurrency, async (task) => {
      const result = await runReviewer(task, workspace, config, abort.signal);
      done += 1;
      render();
      return result;
    });
    if (abort.signal.aborted) {
      ctx.ui.notify("checks: cancelled.", "warning");
      return;
    }

    const collected = collectFindings(reviewers);

    const synthTasks = chunk(collected.candidates, SYNTH_CHUNK).map((part, index) => ({
      name: `synthesis-${String(index).padStart(2, "0")}`,
      kind: "synthesis" as const,
      prompt: buildSynthesisPrompt(part),
    }));
    total = tasks.length + synthTasks.length;
    label = `synthesis (${collected.candidates.length} findings)`;
    render();
    const synthesis = await runPool(synthTasks, config.concurrency, async (task) => {
      const result = await runReviewer(task, workspace, config, abort.signal);
      done += 1;
      render();
      return result;
    });
    if (abort.signal.aborted) {
      ctx.ui.notify("checks: cancelled.", "warning");
      return;
    }

    label = "finalizing";
    render();
    const graded = gradeFindings(collected.candidates, synthesis);
    const summary = summarize({
      graded,
      collected,
      reviewers,
      synthesis,
      durationMs: Date.now() - startedAt,
      reportPath: reportFile,
    });
    const markdown = renderMarkdown({ summary, graded, collected, reviewers, synthesis, config });
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, markdown, "utf-8");

    const reportPath = join(ctx.cwd, "shipd_report.json");
    const merged = {
      ...loadExistingReport(reportPath),
      autoReview: {
        timestamp: formatLocalTimestamp(),
        model: `claude-cli/${config.modelId}`,
        effort: config.thinkingLevel,
        ...summary,
        tokenUsage: sumUsage([...reviewers, ...synthesis]),
      },
    };
    writeFileSync(reportPath, JSON.stringify(merged, null, 2), "utf-8");

    pi.sendMessage({
      customType: "shipd_autoreview_report",
      content: `Auto Review (local): ${summary.verdict}. Test Quality ${summary.testQuality}, Solution Quality ${summary.solutionQuality}; ${summary.high.length} gating HIGH, ${summary.mediumCount} MEDIUM. Full report: ${reportFile}\n${summary.high.map((finding) => `- ${finding.id} (${finding.as || finding.area}): ${finding.text}`).join("\n")}`,
      display: true,
      details: summary,
    });
    ctx.ui.notify(`checks: wrote Auto Review report to ${reportFile}`, "info");
  } catch (error) {
    ctx.ui.notify(`checks --autoreview failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    clearInterval(timer);
    ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
    rmSync(workspace, { recursive: true, force: true });
    endReview();
  }
}
