/**
 * Spawns the throwaway gap-finder and solution-precheck agent sessions, races each
 * against a timeout + external cancel signal, and pulls structured results
 * back out of the tool-call capture objects. The `--solve` fairness reviewer runs
 * through the local Claude CLI instead (see `runClaude` in autoreview.ts).
 */

import { type AgentSession, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { runClaude } from "./autoreview.js";
import { buildSentenceGapFinderPrompt, buildSolutionAuditPrompt, buildSolverReviewPrompt } from "./prompts.js";
import {
  createGapFinderTool,
  createSolutionAuditTool,
  GAP_FINDER_REPORT_TOOL_NAME,
  SOLUTION_AUDIT_TOOL_NAME,
} from "./tools.js";
import type {
  GapStageResult,
  SolutionAuditFinding,
  SolutionAuditStageResult,
  SolverReviewConfig,
  SolverReviewResult,
  SolverRunResult,
  TestGapFinal,
  ThinkingLevel,
} from "./types.js";

export const REVIEWER_TIMEOUT_MS = 15 * 60 * 1000;
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;

// biome-ignore lint/suspicious/noExplicitAny: Model/ThinkingLevel generics are not on pi-coding-agent's public surface
function asSessionModel(model: unknown): any {
  return model;
}

// biome-ignore lint/suspicious/noExplicitAny: see asSessionModel
function sessionThinkingLevel(level: ThinkingLevel): any {
  return level === "off" ? undefined : level;
}

/** Outcome of racing an agent turn against a timeout and an external cancel signal. */
type AgentTurnOutcome = "done" | "timedOut" | "cancelled";

async function raceAgentTurn(
  work: () => Promise<void>,
  cancelSignal: AbortSignal,
  timeoutMs: number = REVIEWER_TIMEOUT_MS,
): Promise<AgentTurnOutcome> {
  if (cancelSignal.aborted) return "cancelled";

  return new Promise<AgentTurnOutcome>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      cancelSignal.removeEventListener("abort", onAbort);
    };
    const settle = (outcome: AgentTurnOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onAbort = () => settle("cancelled");

    timeoutHandle = setTimeout(() => settle("timedOut"), timeoutMs);
    cancelSignal.addEventListener("abort", onAbort, { once: true });

    // Always attach a rejection handler. If the timeout/cancellation wins,
    // the underlying prompt can still reject later; that rejection must not
    // become an unhandled background promise.
    void work().then(
      () => settle("done"),
      (error: unknown) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      },
    );
  });
}

async function disposeAgentSession(session: AgentSession | undefined): Promise<void> {
  if (!session) return;
  try {
    if (!session.isIdle) await session.abort();
  } catch {
    // The run is already ending; disposal must not mask its result.
  }
  session.dispose();
}

export async function runGapFinder(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  testRubric: string;
  gapRules: string;
  fairnessRules: string;
  codeFiles: string[];
  timeoutMinutes: number;
  cancelSignal: AbortSignal;
}): Promise<GapStageResult<TestGapFinal>> {
  const capture: { gaps?: TestGapFinal[] } = {};
  const model = asSessionModel(opts.model);
  let session: AgentSession | undefined;

  try {
    ({ session } = await createAgentSession({
      cwd: opts.tempDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...REVIEWER_TOOLS, GAP_FINDER_REPORT_TOOL_NAME],
      customTools: [createGapFinderTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(
      async () => {
        await session?.prompt(
          buildSentenceGapFinderPrompt(opts.testRubric, opts.gapRules, opts.fairnessRules, opts.codeFiles),
        );
      },
      opts.cancelSignal,
      opts.timeoutMinutes * 60 * 1000,
    );
    if (outcome !== "done") {
      await session.abort();
      return { status: outcome, gaps: [] };
    }
  } catch {
    return { status: "error", gaps: [] };
  } finally {
    await disposeAgentSession(session);
  }
  if (!capture.gaps) return { status: "noSubmission", gaps: [] };
  return { status: "ok", gaps: capture.gaps };
}

/** Runs one read-only solution-quality precheck over the changed implementation. */
export async function runSolutionAudit(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  solutionRules: string;
  codeFiles: string[];
  changedCodeDiff: string;
  timeoutMinutes: number;
  cancelSignal: AbortSignal;
}): Promise<SolutionAuditStageResult> {
  const capture: { findings?: SolutionAuditFinding[] } = {};
  const model = asSessionModel(opts.model);
  let session: AgentSession | undefined;

  try {
    ({ session } = await createAgentSession({
      cwd: opts.tempDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...REVIEWER_TOOLS, SOLUTION_AUDIT_TOOL_NAME],
      customTools: [createSolutionAuditTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(
      async () => {
        await session?.prompt(buildSolutionAuditPrompt(opts.solutionRules, opts.codeFiles, opts.changedCodeDiff));
      },
      opts.cancelSignal,
      opts.timeoutMinutes * 60 * 1000,
    );
    if (outcome !== "done") {
      await session.abort();
      return { status: outcome, findings: [] };
    }
  } catch {
    return { status: "error", findings: [] };
  } finally {
    await disposeAgentSession(session);
  }
  if (!capture.findings) return { status: "noSubmission", findings: [] };
  return { status: "ok", findings: capture.findings };
}

/** Runs the benchmark fairness reviewer as one read-only local Claude CLI session, like the Auto Review reviewers. */
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
