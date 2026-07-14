/**
 * shipd_report.json read/merge/summarize logic. Running --review, --description,
 * --tests, --solution, and --gap-finder separately (in any order) should build
 * up one combined report rather than each overwriting the others' results.
 */

import { existsSync, readFileSync } from "node:fs";
import { ROLES } from "./roles.js";
import type {
  ChecksConfig,
  ReviewerRole,
  ReviewReport,
  SolverGap,
  SolverRunResult,
  TestGapFinal,
  Verdict,
} from "./types.js";

export const REQUIRED_FILES = ["agent_prompt.md", "solution.patch", "test.patch"] as const;

/** ISO-8601-style local timestamp with numeric offset (not UTC `Z`). */
export function formatLocalTimestamp(date = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  );
}

/** Load a prior shipd_report.json (if any) so a later run can merge into it instead of clobbering it. */
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
  runReviewers: boolean;
  byRole: Record<string, ReviewReport>;
  runGapStages: boolean;
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

/** Merges this run's results into the prior report, keeping any roles/gaps not touched this time. */
export function mergeReport(input: MergeReportInput): Record<string, unknown> {
  const {
    existingReport,
    config,
    runReviewers,
    byRole,
    runGapStages,
    testGaps,
    gapAnalysisIncomplete,
    positiveGapFinderStatus,
    negativeGapFinderStatus,
    gapFilterStatus,
    runSolverGapFinder,
    solverResults,
    solverGaps,
    solverGapAnalysisIncomplete,
    solverComparisonStatus,
  } = input;

  const merged: Record<string, unknown> = {
    ...existingReport,
    timestamp: formatLocalTimestamp(),
    model: `${config.provider}/${config.modelId}`,
    thinkingLevel: config.thinkingLevel,
  };

  if (runReviewers) {
    const existingReports =
      existingReport.reports && typeof existingReport.reports === "object"
        ? (existingReport.reports as Record<string, ReviewReport>)
        : {};
    const mergedReports = { ...existingReports, ...byRole };
    merged.reports = mergedReports;
    if (ROLES.every((role) => mergedReports[role.key])) {
      merged.overall = ROLES.every((role) => mergedReports[role.key].verdict === "PASS") ? "PASS" : "FAIL";
    } else {
      delete merged.overall;
    }
  }

  if (runGapStages) {
    merged.testGaps = testGaps;
    if (gapAnalysisIncomplete) {
      merged.testGapAnalysisNote = `Gap analysis did not fully complete (positive finder: ${positiveGapFinderStatus}, negative finder: ${negativeGapFinderStatus}, filter: ${gapFilterStatus}); testGaps may be incomplete.`;
    } else {
      delete merged.testGapAnalysisNote;
    }
  }

  if (runSolverGapFinder) {
    merged.solverRunSummary = solverResults.map((r) => ({
      index: r.index,
      status: r.status,
      passed: r.passed,
      durationMs: r.durationMs,
      artifactsDir: r.artifactsDir,
    }));
    merged.solverGaps = solverGaps;
    if (solverGapAnalysisIncomplete) {
      merged.solverGapAnalysisNote = `Solver-gap analysis did not fully complete (comparison reviewer: ${solverComparisonStatus}); solverGaps may be incomplete.`;
    } else {
      delete merged.solverGapAnalysisNote;
    }
  }

  return merged;
}

/** `m` `s` breakdown of a duration, e.g. `2m 34s` or `48s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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
    overall?: Verdict;
    hasTestGaps: boolean;
    gapsCount: number;
    roleVerdicts?: Record<string, Verdict>;
    showGaps: boolean;
    showSolverGaps: boolean;
    solverDetails: SolverSummaryDetail[];
    solverGapsCount: number;
  };
}

/** Builds the chat summary + renderer details for this run's results — only sections actually run this invocation are populated. */
export function buildRunSummary(opts: {
  merged: Record<string, unknown>;
  runReviewers: boolean;
  activeRoles: ReviewerRole[];
  byRole: Record<string, ReviewReport>;
  runGapStages: boolean;
  runSolverGapFinder: boolean;
}): RunSummary {
  const { merged, runReviewers, activeRoles, byRole, runGapStages, runSolverGapFinder } = opts;

  const gapsCount = Array.isArray(merged.testGaps) ? merged.testGaps.length : 0;

  const roleVerdicts: Record<string, Verdict> | undefined = runReviewers
    ? Object.fromEntries(
        activeRoles.filter((role) => byRole[role.key]).map((role) => [role.key, byRole[role.key].verdict]),
      )
    : undefined;
  // Only surface `overall` when this run actually included the reviewers — a solver-gap-finder-only
  // invocation shouldn't resurface a PASS/FAIL verdict from a previous, unrelated run merged into the same report.
  const overall = runReviewers && typeof merged.overall === "string" ? (merged.overall as Verdict) : undefined;

  const summaryParts: string[] = [];
  if (roleVerdicts) {
    summaryParts.push(activeRoles.map((role) => `${role.label}: ${roleVerdicts[role.key] ?? "?"}`).join(", "));
  }
  if (overall) {
    const suffix = overall === "PASS" && gapsCount > 0 ? " (with test gaps)" : "";
    summaryParts.push(`Overall: ${overall}${suffix}`);
  }
  if (runGapStages) {
    summaryParts.push(gapsCount > 0 ? `${gapsCount} test gap(s) found` : "no test gaps found");
  }

  const solverDetails: SolverSummaryDetail[] = runSolverGapFinder
    ? (Array.isArray(merged.solverRunSummary) ? (merged.solverRunSummary as SolverSummaryDetail[]) : []).map((s) => ({
        index: s.index,
        status: s.status,
        passed: s.passed,
        durationMs: s.durationMs ?? 0,
      }))
    : [];
  const solverPassCount = solverDetails.filter((s) => s.passed).length;
  const solverGapsCount = Array.isArray(merged.solverGaps) ? merged.solverGaps.length : 0;
  if (runSolverGapFinder) {
    summaryParts.push(`${solverPassCount}/${solverDetails.length} solvers passed, ${solverGapsCount} gap(s) found`);
  }

  return {
    content: `Checks: ${summaryParts.join("  |  ")}`,
    details: {
      overall,
      hasTestGaps: gapsCount > 0,
      gapsCount,
      roleVerdicts,
      showGaps: runGapStages,
      showSolverGaps: runSolverGapFinder,
      solverDetails,
      solverGapsCount,
    },
  };
}
