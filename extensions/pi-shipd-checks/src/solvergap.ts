/**
 * Workspace lifecycle for the solver-gap-finder's TDD solver agents: each solver gets its own throwaway
 * git repo with the pristine HEAD snapshot, `test.patch` applied, and `agent_prompt.md` copied in (never
 * `solution.patch`), plus a symlinked `node_modules`. The extension independently re-verifies `./test.sh new`
 * and captures the diff afterward, rather than trusting the agent's self-report.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellExecutable } from "./config.js";
import { bashQuote, snapshotGitHead, toSlashPath } from "./git.js";
import type { SolverRunResult } from "./types.js";

const GIT_TIMEOUT_MS = 30_000;
/** Tail length (chars) of test.sh output kept in the report — enough context without bloating shipd_report.json. */
const TEST_OUTPUT_TAIL_CHARS = 4000;

/** Subdirectory (inside the project's `.pi/shipd-checks/`) where each solver run's trajectory/solution/test output are saved. */
export const SOLVER_ARTIFACTS_DIRNAME = ".pi/shipd-checks";

/** Subdirectory (inside the shared snapshot dir) where each solver's diff/test-output is written for the comparison reviewer to read on demand. */
export const SOLVER_GAP_SOLUTIONS_DIRNAME = "solver_gap_solutions";

export interface SolverWorkspace {
  solverDir: string;
  /** Commit hash right after `test.patch` was applied — the baseline the solver's own diff is captured against. */
  testsAppliedCommit: string;
  /** File paths touched by test.patch — excluded from the solver's captured diff (see extractPatchPaths). */
  testPatchPaths: string[];
}

/**
 * Extracts every file path touched by a unified diff, by reading `diff --git a/<old> b/<new>` header lines.
 * Used so the solver's own diff can exclude the hidden-test files that `test.patch` added/modified — those
 * aren't the solver's work, and including them would make its "solution.patch" equivalent misleading.
 */
export function extractPatchPaths(patchContent: string): string[] {
  const paths = new Set<string>();
  const headerRegex = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/gm;
  for (const match of patchContent.matchAll(headerRegex)) {
    if (match[1]) paths.add(match[1]);
    if (match[2]) paths.add(match[2]);
  }
  return [...paths];
}

export type SetupSolverWorkspaceResult =
  | ({ status: "ok" } & SolverWorkspace)
  | { status: "patchFailed"; solverDir: string; error: string }
  | { status: "error"; solverDir: string; error: string };

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** Sets up one solver's isolated workspace: snapshot, real git repo, node_modules symlink, test.patch applied. */
export async function setupSolverWorkspace(opts: {
  pi: ExtensionAPI;
  repoDir: string;
  solverDir: string;
  testPatchPath: string;
  agentPromptPath: string;
}): Promise<SetupSolverWorkspaceResult> {
  const { pi, repoDir, solverDir, testPatchPath, agentPromptPath } = opts;

  const snapshot = await snapshotGitHead(pi, repoDir, solverDir);
  if (snapshot.status === "error") {
    return { status: "error", solverDir, error: snapshot.error };
  }

  const gitCwd = { cwd: solverDir, timeout: GIT_TIMEOUT_MS };
  const init = await pi.exec("git", ["init"], gitCwd);
  if (init.code !== 0) {
    return { status: "error", solverDir, error: init.stderr?.trim() || "git init failed" };
  }
  // Local, throwaway repo — a real identity isn't meaningful here, just needed for commits to succeed.
  await pi.exec("git", ["config", "user.email", "solvergap@shipd-checks.local"], gitCwd);
  await pi.exec("git", ["config", "user.name", "shipd-checks solver-gap-finder"], gitCwd);

  const addBaseline = await pi.exec("git", ["add", "-A"], gitCwd);
  if (addBaseline.code !== 0) {
    return { status: "error", solverDir, error: addBaseline.stderr?.trim() || "git add (baseline) failed" };
  }
  const commitBaseline = await pi.exec("git", ["commit", "-m", "baseline", "--allow-empty"], gitCwd);
  if (commitBaseline.code !== 0) {
    return { status: "error", solverDir, error: commitBaseline.stderr?.trim() || "git commit (baseline) failed" };
  }

  const gitignorePath = join(solverDir, ".gitignore");
  const existingGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (!existingGitignore.split(/\r?\n/).some((line) => line.trim() === "node_modules")) {
    const withNewline = existingGitignore.length > 0 && !existingGitignore.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, `${existingGitignore}${withNewline}node_modules\n`, "utf-8");
  }

  const sourceNodeModules = join(repoDir, "node_modules");
  const destNodeModules = join(solverDir, "node_modules");
  if (existsSync(sourceNodeModules) && !existsSync(destNodeModules)) {
    try {
      symlinkSync(sourceNodeModules, destNodeModules, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Best effort — solver still has bash access to install its own dependencies if this fails.
    }
  }

  try {
    copyFileSync(agentPromptPath, join(solverDir, "agent_prompt.md"));
  } catch {
    // Best effort — solver prompt still works purely from the tests.
  }

  const testPatchContent = readFileSync(testPatchPath, "utf-8");
  const testPatchPaths = extractPatchPaths(testPatchContent);

  const tempPatchPath = join(solverDir, "test.patch");
  writeFileSync(tempPatchPath, testPatchContent, "utf-8");
  const apply = await pi.exec("git", ["apply", "test.patch"], gitCwd);
  // Remove the raw patch file regardless of outcome — the solver's tree should never contain it, only its effects.
  try {
    unlinkSync(tempPatchPath);
  } catch {
    // ignore
  }
  if (apply.code !== 0) {
    return { status: "patchFailed", solverDir, error: apply.stderr?.trim() || "git apply test.patch failed" };
  }

  const addTests = await pi.exec("git", ["add", "-A"], gitCwd);
  if (addTests.code !== 0) {
    return { status: "error", solverDir, error: addTests.stderr?.trim() || "git add (tests applied) failed" };
  }
  const commitTests = await pi.exec("git", ["commit", "-m", "tests applied", "--allow-empty"], gitCwd);
  if (commitTests.code !== 0) {
    return { status: "error", solverDir, error: commitTests.stderr?.trim() || "git commit (tests applied) failed" };
  }
  const rev = await pi.exec("git", ["rev-parse", "HEAD"], gitCwd);
  if (rev.code !== 0 || !rev.stdout.trim()) {
    return { status: "error", solverDir, error: "Could not resolve tests-applied commit hash." };
  }

  return { status: "ok", solverDir, testsAppliedCommit: rev.stdout.trim(), testPatchPaths };
}

/** Extract test totals from Vitest's JUnit `<testsuites>` element. Errors count as failed tests. */
function readTestCounts(xmlPath: string): { totalTests: number | null; failedTests: number | null } {
  try {
    const tag = readFileSync(xmlPath, "utf-8").match(/<testsuites\b[^>]*>/i)?.[0];
    if (!tag) return { totalTests: null, failedTests: null };
    const attribute = (name: string) =>
      Number.parseInt(tag.match(new RegExp(`\\b${name}="(\\d+)"`, "i"))?.[1] ?? "", 10);
    const totalTests = attribute("tests");
    const failures = attribute("failures");
    const errors = attribute("errors");
    return {
      totalTests: Number.isFinite(totalTests) ? totalTests : null,
      failedTests: Number.isFinite(failures) ? failures + (Number.isFinite(errors) ? errors : 0) : null,
    };
  } catch {
    return { totalTests: null, failedTests: null };
  }
}

/** Independently verifies the solver's work: captures its diff and re-runs `./test.sh new` from scratch. */
export async function finalizeSolverRun(opts: {
  pi: ExtensionAPI;
  index: number;
  workspace: SolverWorkspace;
  status: SolverRunResult["status"];
  durationMs: number;
}): Promise<SolverRunResult & { testOutputXmlPath: string }> {
  const { pi, index, workspace, status, durationMs } = opts;
  const { solverDir, testsAppliedCommit, testPatchPaths } = workspace;
  const gitCwd = { cwd: solverDir, timeout: GIT_TIMEOUT_MS };

  await pi.exec("git", ["add", "-A"], gitCwd);
  // Exclude hidden test files and the copied-in agent_prompt.md from the solver's captured diff.
  const excludePathspecs = [...testPatchPaths, "agent_prompt.md"].map((p) => `:(exclude)${p}`);
  const diffResult = await pi.exec(
    "git",
    ["diff", "--cached", testsAppliedCommit, "--", ".", ...excludePathspecs],
    gitCwd,
  );
  const diff = diffResult.code === 0 ? diffResult.stdout : "";

  const testOutputXmlPath = join(solverDir, "test_output.xml");
  const testCmd = `bash test.sh --output_path ${bashQuote(toSlashPath(testOutputXmlPath))} new`;
  const shell = getShellExecutable();
  const testRun = await pi.exec(shell, ["-c", `cd ${bashQuote(toSlashPath(solverDir))} && ${testCmd}`], {
    timeout: GIT_TIMEOUT_MS * 10,
  });
  const passed = testRun.code === 0;
  const testOutputTail = tail(`${testRun.stdout}\n${testRun.stderr}`.trim(), TEST_OUTPUT_TAIL_CHARS);
  const { totalTests, failedTests } = readTestCounts(testOutputXmlPath);

  return {
    index,
    status,
    passed,
    diff,
    testOutputTail,
    durationMs,
    totalTests,
    failedTests,
    testOutputXmlPath,
  };
}

/**
 * Persists one solver's full artifacts — `trajectory.json` (the raw session entries), `solution.patch`, and
 * the full `./test.sh new --output_path ...` output (falling back to the captured stdout/stderr tail if the
 * script didn't write an XML file) — under `<repoDir>/.pi/shipd-checks/<runId>/solver_<index>/`.
 */
export function saveSolverArtifacts(opts: {
  repoDir: string;
  runId: string;
  index: number;
  trajectory: unknown;
  solutionPatch: string;
  testOutputXmlPath: string;
  testOutputTail: string;
}): string {
  const { repoDir, runId, index, trajectory, solutionPatch, testOutputXmlPath, testOutputTail } = opts;
  const dir = join(repoDir, SOLVER_ARTIFACTS_DIRNAME, runId, `solver_${index}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trajectory.json"), JSON.stringify(trajectory, null, 2), "utf-8");
  writeFileSync(join(dir, "solution.patch"), solutionPatch, "utf-8");
  try {
    const xml = readFileSync(testOutputXmlPath, "utf-8");
    writeFileSync(join(dir, "test_output.xml"), xml, "utf-8");
  } catch {
    writeFileSync(join(dir, "test_output.txt"), testOutputTail, "utf-8");
  }
  return dir;
}

/**
 * Writes each solver's diff + test output to disk under `<snapshotDir>/solver_gap_solutions/solver_<index>/`,
 * plus a top-level `manifest.json` summarizing status/passed per solver — so the comparison reviewer can read
 * only what it needs via its normal read/grep/find/ls tools instead of having every solver's full diff and
 * test-output tail embedded directly in its prompt (which scales linearly with solver count and diff size).
 */
export function writeSolverSolutionsToDisk(snapshotDir: string, solverResults: SolverRunResult[]): string {
  const solutionsDir = join(snapshotDir, SOLVER_GAP_SOLUTIONS_DIRNAME);
  mkdirSync(solutionsDir, { recursive: true });

  const manifest = solverResults.map((r) => {
    const solverSubdir = join(solutionsDir, `solver_${r.index}`);
    mkdirSync(solverSubdir, { recursive: true });
    writeFileSync(join(solverSubdir, "solution.diff"), r.diff, "utf-8");
    writeFileSync(join(solverSubdir, "test_output.txt"), r.testOutputTail, "utf-8");
    return { index: r.index, status: r.status, passed: r.passed };
  });
  writeFileSync(join(solutionsDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  return solutionsDir;
}

/**
 * Removes a solver's temp directory. Safety-critical: the `node_modules`
 * entry is a symlink/junction into the REAL project's dependencies, so it
 * is detected and removed on its own — without following it — before the
 * general recursive delete, guaranteeing the user's actual `node_modules`
 * is never touched even if a given platform's recursive `rm` has
 * symlink-following quirks.
 */
export function cleanupSolverWorkspace(solverDir: string): void {
  const nodeModulesPath = join(solverDir, "node_modules");
  try {
    if (lstatSync(nodeModulesPath).isSymbolicLink()) {
      rmSync(nodeModulesPath, { force: true });
    }
  } catch {
    // Doesn't exist, or isn't a symlink — fall through to the normal recursive delete below.
  }
  try {
    rmSync(solverDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}
