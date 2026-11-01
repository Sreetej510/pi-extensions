/**
 * The `auditor` tool's engine: a local replica of the hosted Auto Review for the tests and the solution, ported from
 * the shipd-workflow rulebook (shipd-v5/rulebook). Read-only Claude CLI reviewers run on this machine:
 *   round 1: Local Test Quality (per-file fairness batches + one coverage read), the solution audit over every lens
 *            (including the solution-betterment lens), and per-unit Solution Quality; one read each;
 *   round 2: synthesis applies the proof legs to every finding.
 * Findings come back grouped as unfair tests, test gaps, solution gaps and solution improvements. A finding gates
 * (BLOCK) only when synthesis keeps it HIGH. Counter-tests are reported, not executed. test.sh is out of scope: it is
 * stripped from test.patch and the snapshot before any reviewer sees them. Only the final report is kept: reviewer
 * prompts and answers live in the temp workspace and are deleted with it.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
} from "./auditor-prompts.js";
import { extractJsonAnswer, runClaude } from "./claude-cli.js";
import { getShellExecutable, loadAuditorConfig } from "./config.js";
import { snapshotGitHead } from "./git.js";
import { extractNewFilesFromPatch, splitPatchFiles, splitPatchHunks } from "./patch.js";
import { formatDuration, formatLocalTimestamp } from "./report.js";
import { SOLVER_ARTIFACTS_DIRNAME } from "./solvergap.js";
import type { AuditorConfig, TokenUsage } from "./types.js";

export const AUDITOR_REQUIRED_FILES = ["agent_prompt.md", "test.patch", "solution.patch"] as const;
const PATCH_SCRIPT_TIMEOUT_MS = 5 * 60_000;
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
  kind: "tq-unit" | "tq-coverage" | "audit" | "sq-unit" | "synthesis";
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
  const batches: Array<Array<{ path: string; text: string }>> = [];
  for (const file of splitPatchFiles(inputs.testPatch)) {
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

export type FindingGroup = "unfairTests" | "testGaps" | "solutionGaps" | "solutionImprovements";

interface Candidate extends SynthesisCandidate {
  source: string;
  /** The sub-reviewer's own severity, before synthesis. */
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
const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

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
            add(
              `${result.name}.${index}`,
              result.name,
              "HIGH",
              "unfairTests",
              `[test-quality T5 Not fair] ${name}: pinned ${pinned}; evidence: ${str(test.evidence)}; fix: ${str(test.fix)}`,
            );
          }
          const gating = asArray(test.concerns).filter((concern: unknown) => TQ_GATING_CONCERNS.has(str(concern)));
          if (gating.length) {
            add(
              `${result.name}.${index}c`,
              result.name,
              "MEDIUM",
              "unfairTests",
              `[test-quality concern ${gating.join(", ")}] ${name}: ${str(test.qualityCheck)}`,
            );
          }
        });
        break;
      }
      case "tq-coverage": {
        asArray(answer.coverageSuggestions).forEach((gap: Json, index: number) => {
          add(
            `${result.name}.${index}`,
            result.name,
            str(gap.severity) || "HIGH",
            "testGaps",
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
          const betterment = str(violation.lens) === "quality";
          add(
            `audit.${str(violation.id) || index}`,
            result.name,
            betterment ? "MEDIUM" : "HIGH",
            betterment ? "solutionImprovements" : "solutionGaps",
            `[audit ${str(violation.lens)} ${str(violation.dimension)} reach=${str(violation.reach)}${violation.reading === "conflict" ? " reading=conflict" : ""}] "${str(violation.quote)}": ${str(violation.claim)}${violation.oracle ? ` (oracle: ${str(violation.oracle)})` : ""}${violation.recommendation ? `; recommendation: ${str(violation.recommendation)}` : ""}`,
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
              "solutionGaps",
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
        "testGaps",
        `[test-quality requirement ${untested ? "UNTESTED" : "PARTIAL"} T4] "${row.quote}" (tests: ${[...new Set(row.tests)].join(", ") || "none"})`,
      );
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
  failedLeg?: string;
  loadBearing?: string;
  promise?: string;
}

interface GradedFinding extends AuditFinding {
  group: FindingGroup;
  dropped: boolean;
}

function gradeFindings(candidates: Candidate[], synthesis: ReviewerResult[]): GradedFinding[] {
  const votes = new Map<string, Json>();
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
    // reference_pass: a test finding the reference itself would fail is a solution defect ("as":"S1")
    if (/^S\d/i.test(criterion) && (group === "testGaps" || group === "unfairTests")) group = "solutionGaps";
    if (group === "solutionGaps" && /^S[234]/i.test(criterion)) group = "solutionImprovements";
    const failedLeg = str(vote?.failed_leg);
    return {
      id: candidate.id,
      group,
      dropped: verdict === "DROP",
      level: !vote ? "UNSYNTHESISED" : verdict === "HIGH" ? "HIGH" : "MEDIUM",
      criterion,
      finding: candidate.text,
      why: str(vote?.why),
      ...(failedLeg && failedLeg !== "none" ? { failedLeg } : {}),
      ...(vote?.load_bearing_check ? { loadBearing: str(vote.load_bearing_check) } : {}),
      ...(vote?.promise_citation && vote.promise_citation !== "none" ? { promise: str(vote.promise_citation) } : {}),
    };
  });
}

export interface AuditResult {
  verdict: "PASS" | "REVIEW" | "BLOCK" | "INCOMPLETE";
  testQuality: "PASS" | "FAIL" | "REVIEW";
  solutionQuality: "PASS" | "FAIL" | "REVIEW";
  unfairTests: AuditFinding[];
  testGaps: AuditFinding[];
  solutionGaps: AuditFinding[];
  solutionImprovements: AuditFinding[];
  /** Findings synthesis rejected as wrong. */
  droppedCount: number;
  testsGraded: number;
  counterTests: CounterTest[];
  reviewers: Array<{ name: string; status: ReviewerStatus; durationMs: number; error?: string }>;
  tokenUsage: TokenUsage;
  durationMs: number;
  reportPath: string;
}

const LEVEL_ORDER = { HIGH: 0, MEDIUM: 1, UNSYNTHESISED: 2 } as const;

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
      .map(({ group: _group, dropped: _dropped, ...finding }) => finding);
  const groups = {
    unfairTests: pick("unfairTests"),
    testGaps: pick("testGaps"),
    solutionGaps: pick("solutionGaps"),
    solutionImprovements: pick("solutionImprovements"),
  };
  const areaVerdict = (findings: AuditFinding[]) =>
    findings.some((finding) => finding.level === "HIGH") ? "FAIL" : findings.length ? "REVIEW" : "PASS";
  const failed = opts.reviewers.filter((result) => result.status !== "ok");
  const synthesis = opts.reviewers.filter((result) => result.kind === "synthesis");
  const synthesisMissing = opts.collected.candidates.length > 0 && synthesis.every((result) => result.status !== "ok");
  const high = kept.some((finding) => finding.level === "HIGH");
  const verdict = high
    ? "BLOCK"
    : synthesisMissing || failed.length === opts.reviewers.length
      ? "INCOMPLETE"
      : kept.length || failed.length
        ? "REVIEW"
        : "PASS";
  return {
    verdict,
    testQuality: areaVerdict([...groups.unfairTests, ...groups.testGaps]),
    solutionQuality: areaVerdict([...groups.solutionGaps, ...groups.solutionImprovements]),
    ...groups,
    droppedCount: opts.graded.length - kept.length,
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

export const GROUP_TITLES: Record<FindingGroup, string> = {
  unfairTests: "Unfair tests",
  testGaps: "Test gaps",
  solutionGaps: "Solution gaps",
  solutionImprovements: "Solution improvements",
};

function renderMarkdown(result: AuditResult, config: AuditorConfig): string {
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\r?\n/g, " ");
  const count = (group: FindingGroup) => result[group].length;
  const md = [
    `# Auditor: ${result.verdict}`,
    "",
    `Test Quality ${result.testQuality} · Solution Quality ${result.solutionQuality} · ${count("unfairTests")} unfair-test, ${count("testGaps")} test-gap, ${count("solutionGaps")} solution-gap, ${count("solutionImprovements")} improvement findings · ${result.testsGraded} tests graded · ${formatDuration(result.durationMs)} · claude ${config.modelId} effort ${config.thinkingLevel}`,
    "",
    "A finding gates only when synthesis keeps it HIGH. No counter-test or mutant was executed: legs that need execution were decided from the files.",
  ];
  for (const group of Object.keys(GROUP_TITLES) as FindingGroup[]) {
    md.push("", `## ${GROUP_TITLES[group]}`, "");
    if (!result[group].length) {
      md.push("none");
      continue;
    }
    md.push("| level | criterion | finding | synthesis |", "|---|---|---|---|");
    for (const finding of result[group]) {
      const synthesis = [
        finding.why,
        finding.failedLeg ? `failed leg: ${finding.failedLeg}` : "",
        finding.loadBearing ? `load-bearing: \`${cell(finding.loadBearing).slice(0, 300)}\`` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      md.push(
        `| ${finding.level} | ${finding.criterion} | ${cell(finding.finding)} | ${cell(synthesis) || "not synthesised"} |`,
      );
    }
  }
  md.push("", `${result.droppedCount} findings were dropped by synthesis as wrong.`);
  md.push("", "## Reviewers", "", "| reviewer | status | time | error |", "|---|---|---|---|");
  for (const reviewer of result.reviewers) {
    md.push(
      `| ${reviewer.name} | ${reviewer.status} | ${formatDuration(reviewer.durationMs)} | ${cell(reviewer.error ?? "").slice(0, 160)} |`,
    );
  }
  if (result.counterTests.length) {
    md.push("", "## Counter-tests (not executed)", "");
    md.push("Apply after solution.patch and test.patch, then run the command in the repo root.", "");
    for (const test of result.counterTests) {
      md.push(`### ${test.id}`, "");
      if (test.cmd) md.push(`Run: \`${test.cmd}\``, "");
      md.push("````diff", test.patch.trimEnd(), "````", "");
    }
  }
  return `${md.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------

/** Refreshes test.patch and solution.patch from the working tree with the project's create_patches.sh, when present. */
async function refreshPatches(pi: ExtensionAPI, cwd: string, signal: AbortSignal): Promise<void> {
  if (!existsSync(join(cwd, "create_patches.sh"))) return;
  const run = await pi.exec(getShellExecutable(), ["create_patches.sh"], {
    cwd,
    timeout: PATCH_SCRIPT_TIMEOUT_MS,
    signal,
  });
  if (run.killed || run.code !== 0) {
    const output = (run.stderr || run.stdout || "").trim().slice(-2_000);
    throw new Error(
      `create_patches.sh failed${run.killed ? " or timed out" : ` (exit ${run.code})`}.${output ? `\n${output}` : ""}`,
    );
  }
}

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
  progress("Refreshing patches...");
  await refreshPatches(pi, cwd, signal);
  cancelled();
  const missing = AUDITOR_REQUIRED_FILES.filter((file) => !existsSync(join(cwd, file)));
  if (missing.length) throw new Error(`Missing required file(s) in the project root: ${missing.join(", ")}`);
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
    progress(`Reviewers: 0/${tasks.length} done`);
    const reviewers = await runPool(tasks, config.concurrency, async (task) => {
      const result = await runReviewer(task, workspace, config, signal);
      done += 1;
      progress(`Reviewers: ${done}/${tasks.length} done`);
      return result;
    });
    cancelled();

    const collected = collectFindings(reviewers);
    const synthTasks: ReviewerTask[] = chunk(collected.candidates, SYNTH_CHUNK).map((part, index) => ({
      name: `synthesis-${String(index).padStart(2, "0")}`,
      kind: "synthesis",
      prompt: buildSynthesisPrompt(part),
    }));
    progress(`Synthesis of ${collected.candidates.length} findings...`);
    const synthesis = await runPool(synthTasks, config.concurrency, (task) =>
      runReviewer(task, workspace, config, signal),
    );
    cancelled();

    const runId = `${formatLocalTimestamp().replace(/[:.]/g, "-")}-auditor`;
    const reportPath = join(cwd, SOLVER_ARTIFACTS_DIRNAME, `${runId}.md`);
    const result = summarize({
      graded: gradeFindings(collected.candidates, synthesis),
      collected,
      reviewers: [...reviewers, ...synthesis],
      durationMs: Date.now() - startedAt,
      reportPath,
    });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderMarkdown(result, config), "utf-8");
    return result;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
