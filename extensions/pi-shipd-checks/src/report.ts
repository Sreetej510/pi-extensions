/** Persistence and chat-summary helpers for the gap-finder runs. */

import { existsSync, readFileSync } from "node:fs";
import type { ChecksConfig, SolverGap, SolverRunResult, TestGapFinal } from "./types.js";

export const REQUIRED_FILES = ["agent_prompt.md", "solution.patch", "test.patch"] as const;

export function formatLocalTimestamp(date = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offset = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

export function loadExistingReport(reportPath: string): Record<string, unknown> {
  try {
    if (!existsSync(reportPath)) return {};
    const parsed = JSON.parse(readFileSync(reportPath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export interface MergeReportInput {
  existingReport: Record<string, unknown>;
  config: ChecksConfig;
  runGapFinder: boolean;
  testGaps: TestGapFinal[];
  gapAnalysisIncomplete: boolean;
  positiveGapFinderStatus: string;
  negativeGapFinderStatus: string;
  gapFilterStatus: string;
  runSolverGapFinder: boolean;
  solverResults: SolverRunResult[];
  solverGaps: SolverGap[];
  solverGapAnalysisIncomplete: boolean;
  solverComparisonStatus: string;
}

export function mergeReport(input: MergeReportInput): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...input.existingReport,
    timestamp: formatLocalTimestamp(),
    model: `${input.config.provider}/${input.config.modelId}`,
    thinkingLevel: input.config.thinkingLevel,
  };
  // Discard fields created by pre-gap-finder-only versions of the extension.
  delete merged.overall;
  delete merged.reports;

  if (input.runGapFinder) {
    merged.testGaps = input.testGaps;
    if (input.gapAnalysisIncomplete) {
      merged.testGapAnalysisNote = `Gap analysis did not fully complete (positive finder: ${input.positiveGapFinderStatus}, negative finder: ${input.negativeGapFinderStatus}, filter: ${input.gapFilterStatus}); testGaps may be incomplete.`;
    } else delete merged.testGapAnalysisNote;
  }
  if (input.runSolverGapFinder) {
    merged.solverRunSummary = input.solverResults.map((r) => ({
      index: r.index,
      status: r.status,
      passed: r.passed,
      durationMs: r.durationMs,
      artifactsDir: r.artifactsDir,
    }));
    merged.solverGaps = input.solverGaps;
    if (input.solverGapAnalysisIncomplete) {
      merged.solverGapAnalysisNote = `Solver-gap analysis did not fully complete (comparison reviewer: ${input.solverComparisonStatus}); solverGaps may be incomplete.`;
    } else delete merged.solverGapAnalysisNote;
  }
  return merged;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export interface SolverSummaryDetail {
  index: number;
  status: SolverRunResult["status"];
  passed: boolean;
  durationMs: number;
}
export interface RunSummary {
  content: string;
  details: {
    gapsCount: number;
    showGaps: boolean;
    showSolverGaps: boolean;
    solverDetails: SolverSummaryDetail[];
    solverGapsCount: number;
  };
}

export function buildRunSummary(opts: {
  merged: Record<string, unknown>;
  runGapFinder: boolean;
  runSolverGapFinder: boolean;
}): RunSummary {
  const gapsCount = Array.isArray(opts.merged.testGaps) ? opts.merged.testGaps.length : 0;
  const solverDetails: SolverSummaryDetail[] =
    opts.runSolverGapFinder && Array.isArray(opts.merged.solverRunSummary)
      ? (opts.merged.solverRunSummary as SolverSummaryDetail[]).map((s) => ({ ...s, durationMs: s.durationMs ?? 0 }))
      : [];
  const solverGapsCount = Array.isArray(opts.merged.solverGaps) ? opts.merged.solverGaps.length : 0;
  const parts: string[] = [];
  if (opts.runGapFinder) parts.push(gapsCount > 0 ? `${gapsCount} test gap(s) found` : "no test gaps found");
  if (opts.runSolverGapFinder)
    parts.push(
      `${solverDetails.filter((s) => s.passed).length}/${solverDetails.length} solvers passed, ${solverGapsCount} gap(s) found`,
    );
  return {
    content: `Gap finders: ${parts.join("  |  ")}`,
    details: {
      gapsCount,
      showGaps: opts.runGapFinder,
      showSolverGaps: opts.runSolverGapFinder,
      solverDetails,
      solverGapsCount,
    },
  };
}
