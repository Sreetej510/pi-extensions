/**
 * Spawns the throwaway reviewer / gap-finder / gap-validator agent sessions,
 * races each against a timeout + external cancel signal, and pulls the
 * structured result back out of the tool-call capture object.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildGapValidatorPrompt,
  buildNegativeGapFinderPrompt,
  buildPositiveGapFinderPrompt,
  buildReviewerPrompt,
  buildSolverComparisonPrompt,
  buildSolverPrompt,
} from "./prompts.js";
import {
  createGapFinderTool,
  createGapValidatorTool,
  createReportTool,
  createSolverGapTool,
  GAP_FINDER_TOOL_NAME,
  GAP_VALIDATOR_TOOL_NAME,
  REPORT_TOOL_NAME,
  SOLVER_GAP_TOOL_NAME,
} from "./tools.js";
import type {
  GapFinderKind,
  GapStageResult,
  ReviewerRole,
  ReviewReport,
  SolverGap,
  SolverRunResult,
  TestGapCandidate,
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
  let outcome: AgentTurnOutcome = cancelSignal.aborted ? "cancelled" : "done";
  await Promise.race([
    work().then(() => {
      if (!cancelSignal.aborted) outcome = "done";
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        outcome = "timedOut";
        resolve();
      }, timeoutMs);
    }),
    new Promise<void>((resolve) => {
      if (cancelSignal.aborted) return resolve();
      cancelSignal.addEventListener(
        "abort",
        () => {
          outcome = "cancelled";
          resolve();
        },
        { once: true },
      );
    }),
  ]);
  return outcome;
}

export async function runReviewer(opts: {
  pi: ExtensionAPI;
  role: ReviewerRole;
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  rubric: string;
  fairnessRules: string;
  cancelSignal: AbortSignal;
}): Promise<ReviewReport> {
  const capture: { report?: ReviewReport } = {};
  const model = asSessionModel(opts.model);
  const { session } = await createAgentSession({
    cwd: opts.tempDir,
    model,
    thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
    tools: [...REVIEWER_TOOLS, REPORT_TOOL_NAME],
    customTools: [createReportTool(capture)],
    sessionManager: SessionManager.inMemory(),
  });

  try {
    const outcome = await raceAgentTurn(async () => {
      await session.prompt(buildReviewerPrompt(opts.role, opts.rubric, opts.fairnessRules));
    }, opts.cancelSignal);

    if (outcome === "cancelled") {
      await session.abort();
      return {
        verdict: "FAIL",
        summary: `${opts.role.label} reviewer cancelled`,
        reasons: ["Cancelled by user."],
        notes: [],
      };
    }

    if (outcome === "timedOut") {
      await session.abort();
      return {
        verdict: "FAIL",
        summary: `${opts.role.label} reviewer timed out`,
        reasons: [`Reviewer did not finish within ${REVIEWER_TIMEOUT_MS / 1000}s.`],
        notes: [],
      };
    }
  } catch (err) {
    return {
      verdict: "FAIL",
      summary: `${opts.role.label} reviewer errored`,
      reasons: [`Reviewer agent failed: ${err instanceof Error ? err.message : String(err)}`],
      notes: [],
    };
  }

  if (!capture.report) {
    return {
      verdict: "FAIL",
      summary: `${opts.role.label} reviewer did not submit a report`,
      reasons: [`The reviewer agent finished without calling ${REPORT_TOOL_NAME}.`],
      notes: [],
    };
  }
  return capture.report;
}

export async function runGapFinder(opts: {
  kind: GapFinderKind;
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  testRubric: string;
  fairnessRules: string;
  cancelSignal: AbortSignal;
}): Promise<GapStageResult<TestGapCandidate>> {
  const capture: { gaps?: TestGapCandidate[] } = {};
  const buildPrompt = opts.kind === "positive" ? buildPositiveGapFinderPrompt : buildNegativeGapFinderPrompt;
  const model = asSessionModel(opts.model);
  const { session } = await createAgentSession({
    cwd: opts.tempDir,
    model,
    thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
    tools: [...REVIEWER_TOOLS, GAP_FINDER_TOOL_NAME],
    customTools: [createGapFinderTool(capture)],
    sessionManager: SessionManager.inMemory(),
  });

  try {
    const outcome = await raceAgentTurn(async () => {
      await session.prompt(buildPrompt(opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
    if (outcome !== "done") {
      await session.abort();
      return { status: outcome, gaps: [] };
    }
  } catch {
    return { status: "error", gaps: [] };
  }
  if (!capture.gaps) return { status: "noSubmission", gaps: [] };
  return { status: "ok", gaps: capture.gaps };
}

export const SOLVER_AGENT_TOOLS = ["read", "grep", "find", "ls", "write", "edit", "bash"] as const;

/** Runs one TDD-style solver agent; the extension verifies its work independently afterward via finalizeSolverRun. */
export async function runSolverAgent(opts: {
  pi: ExtensionAPI;
  solverDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  timeoutMinutes: number;
  cancelSignal: AbortSignal;
}): Promise<{ outcome: AgentTurnOutcome | "error"; trajectory: unknown[] }> {
  const model = asSessionModel(opts.model);
  try {
    const sessionManager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      cwd: opts.solverDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...SOLVER_AGENT_TOOLS],
      sessionManager,
    });

    const outcome = await raceAgentTurn(
      async () => {
        await session.prompt(buildSolverPrompt());
      },
      opts.cancelSignal,
      opts.timeoutMinutes * 60 * 1000,
    );
    if (outcome !== "done") await session.abort();
    return { outcome, trajectory: sessionManager.getEntries() };
  } catch {
    return { outcome: "error", trajectory: [] };
  }
}

/** Read-only comparison reviewer: cwd is the shared snapshot dir (already has agent_prompt.md/solution.patch/test.patch). */
export async function runSolverComparisonReviewer(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  solverResults: SolverRunResult[];
  testRubric: string;
  fairnessRules: string;
  cancelSignal: AbortSignal;
}): Promise<GapStageResult<SolverGap>> {
  const capture: { gaps?: SolverGap[] } = {};
  const model = asSessionModel(opts.model);
  const { session } = await createAgentSession({
    cwd: opts.tempDir,
    model,
    thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
    tools: [...REVIEWER_TOOLS, SOLVER_GAP_TOOL_NAME],
    customTools: [createSolverGapTool(capture)],
    sessionManager: SessionManager.inMemory(),
  });

  try {
    const outcome = await raceAgentTurn(async () => {
      await session.prompt(buildSolverComparisonPrompt(opts.solverResults, opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
    if (outcome !== "done") {
      await session.abort();
      return { status: outcome, gaps: [] };
    }
  } catch {
    return { status: "error", gaps: [] };
  }
  if (!capture.gaps) return { status: "noSubmission", gaps: [] };
  return { status: "ok", gaps: capture.gaps };
}

export async function runGapValidator(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  testRubric: string;
  fairnessRules: string;
  candidates: TestGapCandidate[];
  cancelSignal: AbortSignal;
}): Promise<GapStageResult<TestGapFinal>> {
  const capture: { gaps?: TestGapFinal[] } = {};
  const model = asSessionModel(opts.model);
  const { session } = await createAgentSession({
    cwd: opts.tempDir,
    model,
    thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
    tools: [...REVIEWER_TOOLS, GAP_VALIDATOR_TOOL_NAME],
    customTools: [createGapValidatorTool(capture)],
    sessionManager: SessionManager.inMemory(),
  });

  try {
    const outcome = await raceAgentTurn(async () => {
      await session.prompt(buildGapValidatorPrompt(opts.candidates, opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
    if (outcome !== "done") {
      await session.abort();
      return { status: outcome, gaps: [] };
    }
  } catch {
    return { status: "error", gaps: [] };
  }
  if (!capture.gaps) return { status: "noSubmission", gaps: [] };
  return { status: "ok", gaps: capture.gaps };
}
