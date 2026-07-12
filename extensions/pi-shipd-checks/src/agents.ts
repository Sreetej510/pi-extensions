/**
 * Spawns the throwaway reviewer / gap-finder / gap-validator agent sessions,
 * races each against a timeout + external cancel signal, and pulls the
 * structured result back out of the tool-call capture object.
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildGapFinderPrompt, buildGapValidatorPrompt, buildReviewerPrompt } from "./prompts.js";
import { createGapFinderTool, createGapValidatorTool, createReportTool } from "./tools.js";
import { GAP_FINDER_TOOL_NAME, GAP_VALIDATOR_TOOL_NAME, REPORT_TOOL_NAME } from "./tools.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GapStageResult, ReviewReport, ReviewerRole, TestGapCandidate, TestGapFinal, ThinkingLevel } from "./types.js";

export const REVIEWER_TIMEOUT_MS = 15 * 60 * 1000;
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Outcome of racing an agent turn against a timeout and an external cancel signal. */
type AgentTurnOutcome = "done" | "timedOut" | "cancelled";

async function raceAgentTurn(work: () => Promise<void>, cancelSignal: AbortSignal): Promise<AgentTurnOutcome> {
	let outcome: AgentTurnOutcome = cancelSignal.aborted ? "cancelled" : "done";
	await Promise.race([
		work().then(() => {
			if (!cancelSignal.aborted) outcome = "done";
		}),
		new Promise<void>((resolve) => {
			setTimeout(() => {
				outcome = "timedOut";
				resolve();
			}, REVIEWER_TIMEOUT_MS);
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
	// biome-ignore lint: model typed loosely to avoid depending on internal Model<Api> generics
	const model = opts.model as any;
	const { session } = await createAgentSession({
		cwd: opts.tempDir,
		model,
		thinkingLevel: opts.thinkingLevel === "off" ? undefined : (opts.thinkingLevel as any),
		tools: [...REVIEWER_TOOLS, REPORT_TOOL_NAME],
		customTools: [createReportTool(capture)],
		sessionManager: SessionManager.inMemory(),
	});

	try {
		const outcome = await raceAgentTurn(async () => {
			await session.prompt(buildReviewerPrompt(opts.role, opts.rubric, opts.fairnessRules));
			await session.waitForIdle();
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
	tempDir: string;
	model: unknown;
	thinkingLevel: ThinkingLevel;
	testRubric: string;
	fairnessRules: string;
	cancelSignal: AbortSignal;
}): Promise<GapStageResult<TestGapCandidate>> {
	const capture: { gaps?: TestGapCandidate[] } = {};
	// biome-ignore lint: model typed loosely to avoid depending on internal Model<Api> generics
	const model = opts.model as any;
	const { session } = await createAgentSession({
		cwd: opts.tempDir,
		model,
		thinkingLevel: opts.thinkingLevel === "off" ? undefined : (opts.thinkingLevel as any),
		tools: [...REVIEWER_TOOLS, GAP_FINDER_TOOL_NAME],
		customTools: [createGapFinderTool(capture)],
		sessionManager: SessionManager.inMemory(),
	});

	try {
		const outcome = await raceAgentTurn(async () => {
			await session.prompt(buildGapFinderPrompt(opts.testRubric, opts.fairnessRules));
			await session.waitForIdle();
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
	// biome-ignore lint: model typed loosely to avoid depending on internal Model<Api> generics
	const model = opts.model as any;
	const { session } = await createAgentSession({
		cwd: opts.tempDir,
		model,
		thinkingLevel: opts.thinkingLevel === "off" ? undefined : (opts.thinkingLevel as any),
		tools: [...REVIEWER_TOOLS, GAP_VALIDATOR_TOOL_NAME],
		customTools: [createGapValidatorTool(capture)],
		sessionManager: SessionManager.inMemory(),
	});

	try {
		const outcome = await raceAgentTurn(async () => {
			await session.prompt(buildGapValidatorPrompt(opts.candidates, opts.testRubric, opts.fairnessRules));
			await session.waitForIdle();
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
