/** The `--solve` fairness reviewer: one read-only local Claude CLI session over all solver runs. */

import { runClaude } from "./claude-cli.js";
import { buildSolverReviewPrompt } from "./prompts.js";
import type { SolverReviewConfig, SolverReviewResult, SolverRunResult } from "./types.js";

/** Runs the benchmark fairness reviewer as one read-only local Claude CLI session, like the auditor reviewers. */
export async function runSolverReview(opts: {
  tempDir: string;
  config: SolverReviewConfig;
  taskPrompt: string;
  solverResults: SolverRunResult[];
  testGuidelines: string;
  fairnessRules: string;
  /** Whether our solution.patch is in the workspace, so the reviewer also suggests improvements from the solvers. */
  hasReferenceSolution: boolean;
  cancelSignal: AbortSignal;
}): Promise<SolverReviewResult> {
  const run = await runClaude({
    cwd: opts.tempDir,
    prompt: buildSolverReviewPrompt(
      opts.taskPrompt,
      opts.solverResults,
      opts.testGuidelines,
      opts.fairnessRules,
      opts.hasReferenceSolution,
    ),
    config: opts.config,
    signal: opts.cancelSignal,
  });
  const text = run.text.trim();
  const tokenUsage = run.tokenUsage ? { tokenUsage: run.tokenUsage } : {};
  if (run.status !== "ok") {
    return { status: run.status, text, ...tokenUsage, ...(run.error ? { error: run.error } : {}) };
  }
  if (!text) return { status: "error", text: "Local Claude reviewer returned no text.", error: "No reviewer output." };
  return { status: "ok", text, ...tokenUsage };
}
