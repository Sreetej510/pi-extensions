/**
 * The `auditor` tool's engine: a local replica of the hosted Auto Review for the tests and the solution, ported from
 * the shipd-workflow rulebook (shipd-v5/rulebook). Read-only Codex CLI reviewers run on this machine:
 *   round 1: typed agents run in parallel: test agents own test.patch (unfair tests, missing coverage, test code
 *            quality) and solution agents own solution.patch (wrong outputs, solution code quality). How many of each
 *            type run depends on the size of each patch; each agent gets its own slice;
 *   round 2: one combined synthesis sees every finding and all of the change and applies the proof legs.
 * Findings come back grouped as unfair tests, test gaps, test improvements, solution gaps and solution improvements. A finding gates
 * the verdict only when synthesis keeps it HIGH. Counter-tests are reported, not executed. test.sh is out of scope: it is
 * stripped from test.patch and the snapshot before any reviewer sees them. The report gives one line per finding.
 * Reviewer prompts and answers live in the temp workspace and are deleted with it.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ASSETS_DIR,
  buildSolutionAgentPrompt,
  buildSynthesisPrompt,
  buildTestAgentPrompt,
  type PromptInputs,
  QUALITY_CATEGORIES,
  REPO_DIR,
  type SolutionUnit,
  type SynthesisCandidate,
} from "./auditor-prompts.js";
import { extractJsonAnswer, runCodex } from "./codex-cli.js";
import { loadAuditorConfig } from "./config.js";
import { requirePatchesCreated, runCreatePatches, snapshotGitHead } from "./git.js";
import { extractNewFilesFromPatch, splitPatchFiles, splitPatchHunks } from "./patch.js";
import { formatLocalTimestamp } from "./report.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import type { AuditorConfig, TokenUsage } from "./types.js";

/** Needed before the audit starts; create_patches.sh then creates test.patch and solution.patch. */
export const AUDITOR_REQUIRED_FILES = ["create_patches.sh", "agent_prompt.md"] as const;
const PATCH_SCRIPT_TIMEOUT_MS = 5 * 60_000;
/** One test agent per this much test.patch, up to MAX_AGENTS_PER_TYPE. */
const TEST_CHARS_PER_AGENT = 70_000;
/** One solution agent per this much solution.patch, up to MAX_AGENTS_PER_TYPE. */
const SOLUTION_CHARS_PER_AGENT = 50_000;
const MAX_AGENTS_PER_TYPE = 4;
const SYNTH_CHUNK = 60;
const CANDIDATE_TEXT_LIMIT = 1_600;
const REPORT_SUMMARY_LIMIT = 160;
const REPORT_LOCATION_LIMIT = 100;

type ReviewerStatus = "ok" | "timedOut" | "cancelled" | "error" | "noAnswer";

interface ReviewerTask {
  name: string;
  kind: "test" | "solution" | "synthesis";
  prompt: string;
}

interface ReviewerResult {
  name: string;
  kind: ReviewerTask["kind"];
  status: ReviewerStatus;
  answer?: unknown;
  durationMs: number;
  tokenUsage?: TokenUsage;
  error?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: reviewer answers are untyped JSON
type Json = any;

async function runReviewer(
  task: ReviewerTask,
  cwd: string,
  config: AuditorConfig,
  signal: AbortSignal,
): Promise<ReviewerResult> {
  const started = Date.now();
  let last: ReviewerResult | undefined;
  // a stalled or unparsable headless answer is retried once (answer_runner.py)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = await runCodex({ cwd, prompt: task.prompt, config, signal });
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

function solutionUnits(solutionPatch: string): SolutionUnit[] {
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

/** How many agents of one type the work needs: one per `charsPerAgent`, at least 1, at most the items or the cap. */
function agentCount(chars: number, charsPerAgent: number, items: number): number {
  return Math.max(1, Math.min(MAX_AGENTS_PER_TYPE, Math.max(1, items), Math.ceil(chars / charsPerAgent)));
}

/** Largest-first into the lightest bin, so each test agent gets a similar amount of test code. */
function balance<T extends { text: string }>(items: T[], bins: number): T[][] {
  const out: T[][] = Array.from({ length: bins }, () => []);
  const sizes = new Array<number>(bins).fill(0);
  for (const item of [...items].sort((a, b) => b.text.length - a.text.length)) {
    const lightest = sizes.indexOf(Math.min(...sizes));
    out[lightest]?.push(item);
    sizes[lightest] = (sizes[lightest] ?? 0) + item.text.length;
  }
  return out;
}

/** Contiguous slices of similar size, so hunks of one file tend to stay with one solution agent. */
function contiguous<T extends { text: string }>(items: T[], bins: number): T[][] {
  const total = items.reduce((sum, item) => sum + item.text.length, 0);
  const target = total / bins;
  const out: T[][] = [[]];
  let size = 0;
  for (const item of items) {
    const current = out.at(-1) as T[];
    if (current.length && size + item.text.length / 2 > target && out.length < bins) {
      out.push([item]);
      size = item.text.length;
    } else {
      current.push(item);
      size += item.text.length;
    }
  }
  return out;
}

/** problem.md's requirement sentences, the unit test agents divide coverage by. */
function requirementSentences(problem: string): string[] {
  return problem
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[-*#>\s]+/, "").trim())
    .filter((sentence) => sentence.length > 15);
}

export function planReviewers(inputs: PromptInputs): ReviewerTask[] {
  const testFiles = splitPatchFiles(inputs.testPatch).map((file) => ({ path: file.path, text: file.text }));
  const units = solutionUnits(inputs.solutionPatch);
  const testAgents = agentCount(inputs.testPatch.length, TEST_CHARS_PER_AGENT, testFiles.length);
  const solutionAgents = agentCount(inputs.solutionPatch.length, SOLUTION_CHARS_PER_AGENT, units.length);
  const fileSlices = balance(testFiles, testAgents);
  const sentences = requirementSentences(inputs.problem);
  const tasks: ReviewerTask[] = [];
  for (let index = 0; index < testAgents; index++) {
    tasks.push({
      name: `test-agent-${index + 1}`,
      kind: "test",
      prompt: buildTestAgentPrompt({
        inputs,
        files: fileSlices[index] ?? [],
        requirements: sentences.filter((_, position) => position % testAgents === index),
        index,
        total: testAgents,
      }),
    });
  }
  contiguous(units, solutionAgents).forEach((slice, index, slices) => {
    tasks.push({
      name: `solution-agent-${index + 1}`,
      kind: "solution",
      prompt: buildSolutionAgentPrompt({ inputs, units: slice, index, total: slices.length }),
    });
  });
  return tasks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings: normalise every reviewer answer into synthesis candidates
// ---------------------------------------------------------------------------------------------------------------------

export type FindingGroup = "unfairTests" | "testGaps" | "testImprovements" | "solutionGaps" | "solutionImprovements";

interface Candidate extends SynthesisCandidate {
  source: string;
  /** The proposing agent's own severity, before synthesis. */
  severity: string;
  group: FindingGroup;
}

export interface CounterTest {
  id: string;
  patch: string;
  cmd: string;
}

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));
const clip = (text: string) => (text.length > CANDIDATE_TEXT_LIMIT ? `${text.slice(0, CANDIDATE_TEXT_LIMIT)}…` : text);
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value : []);
const sentence = (label: string, value: unknown) => (str(value) ? ` ${label}: ${str(value)}` : "");

interface CollectedFindings {
  candidates: Candidate[];
  counterTests: CounterTest[];
  testsGraded: number;
}

export function collectFindings(results: ReviewerResult[]): CollectedFindings {
  const candidates: Candidate[] = [];
  const counterTests: CounterTest[] = [];
  let testsGraded = 0;
  const add = (id: string, source: string, severity: string, group: FindingGroup, text: string) =>
    candidates.push({ id, source, severity, group, text: clip(text) });
  const quality = (item: Json) =>
    `[${str(item.category) || "Practice"}] ${str(item.location)}: ${str(item.finding)}${sentence("Suggested change", item.suggestedChange)}`;

  for (const result of results) {
    const answer: Json = result.answer;
    if (answer === undefined) continue;
    if (result.kind === "test") {
      testsGraded += asArray(answer.tests).length;
      asArray(answer.unfairTests).forEach((item: Json, index: number) => {
        add(
          `${result.name}.unfair${index}`,
          result.name,
          "HIGH",
          "unfairTests",
          `[unfair test] ${str(item.test)} (${str(item.file)}): ${str(item.finding)}${sentence("Details", item.details)}${sentence("Why", item.why)}${sentence("Suggested change", item.suggestedChange)}`,
        );
      });
      asArray(answer.testGaps).forEach((item: Json, index: number) => {
        add(
          `${result.name}.gap${index}`,
          result.name,
          str(item.severity) || "HIGH",
          "testGaps",
          `[test gap] "${str(item.requirement)}": ${str(item.finding)}${sentence("Proposed public check", item.suggestedChange)}${sentence("Compliant alternative", item.why)}${sentence("Wrong implementation that passes", item.details)}`,
        );
      });
      asArray(answer.testImprovements).forEach((item: Json, index: number) => {
        add(`${result.name}.quality${index}`, result.name, "MEDIUM", "testImprovements", quality(item));
      });
    } else if (result.kind === "solution") {
      asArray(answer.solutionGaps).forEach((item: Json, index: number) => {
        const patch = str(item.counter_test_patch);
        if (patch.trim()) {
          counterTests.push({
            id: str(item.id) || `${result.name}-CT${index + 1}`,
            patch,
            cmd: str(item.counter_test_cmd),
          });
        }
        add(
          `${result.name}.${str(item.id) || `wrong${index}`}`,
          result.name,
          "HIGH",
          "solutionGaps",
          `[wrong output] Input: ${str(item.input)}${sentence("Expected", item.expectedOutput)}${sentence("Received", item.received)}${sentence("Why", item.why)}${sentence("Suggested change", item.suggestedChange)}`,
        );
      });
      asArray(answer.solutionImprovements).forEach((item: Json, index: number) => {
        add(`${result.name}.quality${index}`, result.name, "MEDIUM", "solutionImprovements", quality(item));
      });
    }
  }
  return { candidates, counterTests, testsGraded };
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthesis and grading
// ---------------------------------------------------------------------------------------------------------------------

export interface AuditFinding {
  id: string;
  /** HIGH gates; MEDIUM and UNSYNTHESISED are the fix-before-upload list. */
  level: "HIGH" | "MEDIUM" | "UNSYNTHESISED";
  /** Criterion synthesis assigned (T3, T5, S1, S2, ...), or empty. */
  criterion: string;
  finding: string;
  why: string;
  summary?: string;
  location?: string;
  failedLeg?: string;
  loadBearing?: string;
  promise?: string;
}

interface GradedFinding extends AuditFinding {
  group: FindingGroup;
  dropped: boolean;
  testGapReviewPending: boolean;
}

function gradeFindings(candidates: Candidate[], synthesis: ReviewerResult[], problem: string): GradedFinding[] {
  const votes = new Map<string, Json>();
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const proofText = (value: unknown) =>
    typeof value === "string" && !/^none$/i.test(value.trim()) ? value.trim() : "";
  const requirementText = normalize(problem);
  for (const result of synthesis) {
    for (const finding of asArray((result.answer as Json)?.findings)) {
      const id = str(finding.id);
      if (!votes.has(id)) votes.set(id, finding);
    }
  }
  return candidates.map((candidate) => {
    const vote = votes.get(candidate.id);
    const verdict = str(vote?.verdict).toUpperCase();
    const criterion = str(vote?.as);
    let group = candidate.group;
    const isQuality = (QUALITY_CATEGORIES as readonly string[]).includes(criterion);
    // reference_pass: a test finding the reference itself would fail is a solution defect ("as":"S1")
    if (/^S[12]$/i.test(criterion) && (group === "testGaps" || group === "unfairTests")) group = "solutionGaps";
    if (isQuality && group === "solutionGaps") group = "solutionImprovements";
    if (isQuality && group === "unfairTests") group = "testImprovements";
    if (/^T[34]$/i.test(criterion)) group = "testGaps";
    const improvement = group === "testImprovements" || group === "solutionImprovements";
    const failedLeg = str(vote?.failed_leg);
    const promise = proofText(vote?.promise_citation);
    const publicCheck = proofText(vote?.gap_fairness?.public_check);
    const alternative = proofText(vote?.gap_fairness?.compliant_alternative);
    const testGapReviewPending =
      group === "testGaps" &&
      verdict !== "DROP" &&
      !(
        /^(HIGH|MEDIUM)$/.test(verdict) &&
        /^T[34]$/i.test(criterion) &&
        !/^(failing_case|wrong_impl|promise_citation|reference_pass)$/i.test(failedLeg.trim()) &&
        vote?.gap_fairness?.reference_passes === true &&
        promise &&
        requirementText.includes(normalize(promise)) &&
        publicCheck &&
        alternative
      );
    const summary = group === "testGaps" ? "" : str(vote?.summary).trim();
    const location = str(vote?.location).trim();
    return {
      id: candidate.id,
      group,
      dropped: verdict === "DROP" || testGapReviewPending,
      testGapReviewPending,
      // code-quality findings are the hosted checks' non-blocking list: they never gate
      level: !vote ? "UNSYNTHESISED" : verdict === "HIGH" && !improvement ? "HIGH" : "MEDIUM",
      criterion,
      finding: group === "testGaps" ? publicCheck : candidate.text,
      why: str(vote?.why),
      ...(summary ? { summary } : {}),
      ...(location ? { location } : {}),
      ...(failedLeg && failedLeg !== "none" ? { failedLeg } : {}),
      ...(vote?.load_bearing_check ? { loadBearing: str(vote.load_bearing_check) } : {}),
      ...(promise ? { promise } : {}),
    };
  });
}

type AuditVerdict = "PASS" | "FAIL";

export interface AuditResult {
  verdict: AuditVerdict;
  testQuality: AuditVerdict;
  solutionQuality: AuditVerdict;
  unfairTests: AuditFinding[];
  testGaps: AuditFinding[];
  testImprovements: AuditFinding[];
  solutionGaps: AuditFinding[];
  solutionImprovements: AuditFinding[];
  /** Findings synthesis rejected as wrong. */
  droppedCount: number;
  unverifiedTestGaps: number;
  testsGraded: number;
  counterTests: CounterTest[];
  reviewers: Array<{ name: string; status: ReviewerStatus; durationMs: number; error?: string }>;
  tokenUsage: TokenUsage;
  durationMs: number;
  reportPath: string;
}

const LEVEL_ORDER = { HIGH: 0, UNSYNTHESISED: 1, MEDIUM: 2 } as const;

function summarize(opts: {
  graded: GradedFinding[];
  collected: CollectedFindings;
  reviewers: ReviewerResult[];
  durationMs: number;
  reportPath: string;
}): AuditResult {
  const kept = opts.graded.filter((finding) => !finding.dropped);
  const pick = (group: FindingGroup): AuditFinding[] =>
    kept
      .filter((finding) => finding.group === group)
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
      .map(({ group: _group, dropped: _dropped, testGapReviewPending: _testGapReviewPending, ...finding }) => finding);
  const groups = {
    unfairTests: pick("unfairTests"),
    testGaps: pick("testGaps"),
    testImprovements: pick("testImprovements"),
    solutionGaps: pick("solutionGaps"),
    solutionImprovements: pick("solutionImprovements"),
  };
  const failed = opts.reviewers.filter((result) => result.status !== "ok");
  const unverifiedTestGaps = opts.graded.filter((finding) => finding.testGapReviewPending).length;
  const areaVerdict = (kind: "test" | "solution", findings: AuditFinding[]): AuditVerdict =>
    failed.some((result) => result.kind === kind) ||
    (kind === "test" && unverifiedTestGaps > 0) ||
    findings.some((finding) => finding.level === "HIGH" || finding.level === "UNSYNTHESISED")
      ? "FAIL"
      : "PASS";
  const testQuality = areaVerdict("test", [...groups.unfairTests, ...groups.testGaps, ...groups.testImprovements]);
  const solutionQuality = areaVerdict("solution", [...groups.solutionGaps, ...groups.solutionImprovements]);
  return {
    verdict: failed.length || testQuality === "FAIL" || solutionQuality === "FAIL" ? "FAIL" : "PASS",
    testQuality,
    solutionQuality,
    ...groups,
    droppedCount: opts.graded.length - kept.length - unverifiedTestGaps,
    unverifiedTestGaps,
    testsGraded: opts.collected.testsGraded,
    counterTests: opts.collected.counterTests,
    reviewers: opts.reviewers.map((result) => ({
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    })),
    tokenUsage: sumUsage(opts.reviewers),
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

const GROUP_TITLES: Record<FindingGroup, string> = {
  unfairTests: "Unfair tests",
  testGaps: "Test gaps",
  testImprovements: "Test improvements",
  solutionGaps: "Solution gaps",
  solutionImprovements: "Solution improvements",
};

function renderReport(result: AuditResult): string {
  const shorten = (text: string, limit = REPORT_SUMMARY_LIMIT) => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  };
  const findings = (Object.keys(GROUP_TITLES) as FindingGroup[]).flatMap((group) =>
    result[group].map((finding) => ({ group, ...finding })),
  );
  const failedReviewers = result.reviewers.filter((reviewer) => reviewer.status !== "ok");
  const md = [`# Auditor: ${result.verdict}`, "", `Tests: ${result.testQuality} | Solution: ${result.solutionQuality}`];
  if (result.unverifiedTestGaps) {
    md.push("", `Test-gap fairness review incomplete for ${result.unverifiedTestGaps} candidate(s).`);
  }
  if (failedReviewers.length) {
    md.push("", "## Reviewer failures", "");
    for (const { name, status, error } of failedReviewers) {
      md.push(`- ${name}: ${status}${error ? ` (${shorten(error)})` : ""}`);
    }
  }

  if (!findings.length) md.push("", "No findings.");
  for (const level of Object.keys(LEVEL_ORDER) as AuditFinding["level"][]) {
    const entries = findings.filter((finding) => finding.level === level);
    if (!entries.length) continue;
    md.push("", `## ${level} (${entries.length})`, "");
    for (const finding of entries) {
      const tag = finding.criterion ? ` [${shorten(finding.criterion, 24)}]` : "";
      const location = finding.location ? ` ${shorten(finding.location, REPORT_LOCATION_LIMIT)}` : "";
      const summary =
        finding.group === "testGaps"
          ? finding.finding.replace(/\s+/g, " ").trim()
          : shorten(finding.summary || finding.why || finding.finding);
      md.push(`- ${GROUP_TITLES[finding.group]}${tag}${location}: ${summary}`);
    }
  }
  return `${md.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------

/** Runs the whole audit on `cwd` and writes the final report; throws on missing inputs or cancellation. */
export async function runAudit(opts: {
  pi: ExtensionAPI;
  cwd: string;
  signal: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<AuditResult> {
  const { pi, cwd, signal } = opts;
  const progress = opts.onProgress ?? (() => {});
  const cancelled = () => {
    if (signal.aborted) throw new Error("Cancelled by user.");
  };
  const startedAt = Date.now();
  const missing = AUDITOR_REQUIRED_FILES.filter((file) => !existsSync(join(cwd, file)));
  if (missing.length) throw new Error(`Missing required file(s) in the project root: ${missing.join(", ")}`);
  progress("Running create_patches.sh...");
  await runCreatePatches(pi, cwd, signal, PATCH_SCRIPT_TIMEOUT_MS);
  cancelled();
  requirePatchesCreated(cwd, ["test.patch", "solution.patch"]);
  const config = loadAuditorConfig();
  const workspace = join(tmpdir(), `checks-auditor-${randomUUID()}`);
  try {
    progress("Preparing a clean HEAD snapshot...");
    mkdirSync(join(workspace, REPO_DIR), { recursive: true });
    const snapshot = await snapshotGitHead(pi, cwd, join(workspace, REPO_DIR), signal);
    if (snapshot.status === "error") throw new Error(snapshot.error);
    cancelled();
    const inputs = prepareAssets(cwd, workspace);

    const tasks = planReviewers(inputs);
    let done = 0;
    const typed = `${tasks.filter((task) => task.kind === "test").length} test + ${tasks.filter((task) => task.kind === "solution").length} solution agents`;
    progress(`${typed}: 0/${tasks.length} done`);
    const reviewers = await runPool(tasks, config.concurrency, async (task) => {
      const result = await runReviewer(task, workspace, config, signal);
      done += 1;
      progress(`${typed}: ${done}/${tasks.length} done`);
      return result;
    });
    cancelled();

    const collected = collectFindings(reviewers);
    const synthTasks: ReviewerTask[] = chunk(collected.candidates, SYNTH_CHUNK).map((part, index) => ({
      name: `synthesis-${String(index).padStart(2, "0")}`,
      kind: "synthesis",
      prompt: buildSynthesisPrompt(part),
    }));
    progress(`Combined synthesis of ${collected.candidates.length} findings...`);
    const synthesis = await runPool(synthTasks, config.concurrency, (task) =>
      runReviewer(task, workspace, config, signal),
    );
    cancelled();

    const runId = `${formatLocalTimestamp().replace(/[:.]/g, "-")}-auditor`;
    const reportPath = join(cwd, SOLVER_ARTIFACTS_DIRNAME, `${runId}.md`);
    const result = summarize({
      graded: gradeFindings(collected.candidates, synthesis, inputs.problem),
      collected,
      reviewers: [...reviewers, ...synthesis],
      durationMs: Date.now() - startedAt,
      reportPath,
    });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderReport(result), "utf-8");
    return result;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
