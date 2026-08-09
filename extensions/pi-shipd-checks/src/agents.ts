/**
 * Spawns the throwaway gap-finder / gap-validator agent sessions,
 * races each against a timeout + external cancel signal, and pulls the
 * structured result back out of the tool-call capture object.
 */

import {
  type AgentSession,
  createAgentSession,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  buildGapValidatorPrompt,
  buildSentenceGapFinderPrompt,
  buildSolverComparisonPrompt,
  buildSolverPrompt,
  buildTestAuditPrompt,
  buildTestAuditValidatorPrompt,
} from "./prompts.js";
import {
  createGapFinderTool,
  createGapValidatorTool,
  createSolverGapTool,
  createTestAuditTool,
  createTestAuditValidatorTool,
  GAP_FINDER_TOOL_NAME,
  GAP_VALIDATOR_TOOL_NAME,
  SOLVER_GAP_TOOL_NAME,
  TEST_AUDIT_TOOL_NAME,
  TEST_AUDIT_VALIDATOR_TOOL_NAME,
} from "./tools.js";
import type {
  GapStageResult,
  SolverGap,
  SolverRunResult,
  StatementGapReport,
  TestAuditFinding,
  TestAuditStageResult,
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
  fairnessRules: string;
  cancelSignal: AbortSignal;
}): Promise<GapStageResult<StatementGapReport>> {
  const capture: { statements?: StatementGapReport[] } = {};
  const model = asSessionModel(opts.model);
  let session: AgentSession | undefined;

  try {
    ({ session } = await createAgentSession({
      cwd: opts.tempDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...REVIEWER_TOOLS, GAP_FINDER_TOOL_NAME],
      customTools: [createGapFinderTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(async () => {
      await session?.prompt(buildSentenceGapFinderPrompt(opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
    if (outcome !== "done") {
      await session.abort();
      return { status: outcome, gaps: [] };
    }
  } catch {
    return { status: "error", gaps: [] };
  } finally {
    await disposeAgentSession(session);
  }
  if (!capture.statements) return { status: "noSubmission", gaps: [] };
  return { status: "ok", gaps: capture.statements };
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
  const sessionManager = SessionManager.inMemory();
  let session: AgentSession | undefined;
  try {
    ({ session } = await createAgentSession({
      cwd: opts.solverDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...SOLVER_AGENT_TOOLS],
      sessionManager,
    }));

    const outcome = await raceAgentTurn(
      async () => {
        await session?.prompt(buildSolverPrompt());
      },
      opts.cancelSignal,
      opts.timeoutMinutes * 60 * 1000,
    );
    if (outcome !== "done") await session.abort();
    return { outcome, trajectory: sessionManager.getEntries() };
  } catch {
    return { outcome: "error", trajectory: [] };
  } finally {
    await disposeAgentSession(session);
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
  let session: AgentSession | undefined;

  try {
    ({ session } = await createAgentSession({
      cwd: opts.tempDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...REVIEWER_TOOLS, SOLVER_GAP_TOOL_NAME],
      customTools: [createSolverGapTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(async () => {
      await session?.prompt(buildSolverComparisonPrompt(opts.solverResults, opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
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

export async function runGapValidator(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  testRubric: string;
  fairnessRules: string;
  statementReports: StatementGapReport[];
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
      tools: [...REVIEWER_TOOLS, GAP_VALIDATOR_TOOL_NAME],
      customTools: [createGapValidatorTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(async () => {
      await session?.prompt(buildGapValidatorPrompt(opts.statementReports, opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
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

/** Runs one read-only audit over the tests currently present in the repository. */
export async function runTestAudit(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  testRubric: string;
  fairnessRules: string;
  cancelSignal: AbortSignal;
}): Promise<TestAuditStageResult> {
  const capture: { findings?: TestAuditFinding[] } = {};
  const model = asSessionModel(opts.model);
  let session: AgentSession | undefined;

  try {
    ({ session } = await createAgentSession({
      cwd: opts.tempDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...REVIEWER_TOOLS, TEST_AUDIT_TOOL_NAME],
      customTools: [createTestAuditTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(async () => {
      await session?.prompt(buildTestAuditPrompt(opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
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

/** Independently validates the first audit agent's candidates before they reach the caller. */
export async function runTestAuditValidator(opts: {
  tempDir: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  testRubric: string;
  fairnessRules: string;
  findings: TestAuditFinding[];
  cancelSignal: AbortSignal;
}): Promise<TestAuditStageResult> {
  const capture: { findings?: TestAuditFinding[] } = {};
  const model = asSessionModel(opts.model);
  let session: AgentSession | undefined;

  try {
    ({ session } = await createAgentSession({
      cwd: opts.tempDir,
      model,
      thinkingLevel: sessionThinkingLevel(opts.thinkingLevel),
      tools: [...REVIEWER_TOOLS, TEST_AUDIT_VALIDATOR_TOOL_NAME],
      customTools: [createTestAuditValidatorTool(capture)],
      sessionManager: SessionManager.inMemory(),
    }));

    const outcome = await raceAgentTurn(async () => {
      await session?.prompt(buildTestAuditValidatorPrompt(opts.findings, opts.testRubric, opts.fairnessRules));
    }, opts.cancelSignal);
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
