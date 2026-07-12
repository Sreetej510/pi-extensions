/**
 * shipd_report.json read/merge/summarize logic. Running --review, --description,
 * --tests, --solution, and --gap-finder separately (in any order) should build
 * up one combined report rather than each overwriting the others' results.
 */

import { existsSync, readFileSync } from "node:fs";
import { ROLES } from "./roles.js";
import type { ChecksConfig, ReviewerRole, ReviewReport, TestGapFinal, Verdict } from "./types.js";

export const REQUIRED_FILES = ["agent_prompt.md", "solution.patch", "test.patch"] as const;

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
  } = input;

  const merged: Record<string, unknown> = {
    ...existingReport,
    timestamp: new Date().toISOString(),
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
    // `overall` only reflects a confident PASS/FAIL once all 3 focus
    // reviewers have actually run (possibly across separate invocations
    // of --description/--tests/--solution) — otherwise it's incomplete.
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

  return merged;
}

export interface RunSummary {
  content: string;
  details: {
    overall?: Verdict;
    hasTestGaps: boolean;
    gapsCount: number;
    roleVerdicts?: Record<string, Verdict>;
    showGaps: boolean;
  };
}

/** Builds the one-line chat summary + renderer details for this run's results. */
export function buildRunSummary(opts: {
  merged: Record<string, unknown>;
  runReviewers: boolean;
  activeRoles: ReviewerRole[];
  byRole: Record<string, ReviewReport>;
  runGapStages: boolean;
}): RunSummary {
  const { merged, runReviewers, activeRoles, byRole, runGapStages } = opts;

  const overall = typeof merged.overall === "string" ? (merged.overall as Verdict) : undefined;
  const gapsCount = Array.isArray(merged.testGaps) ? merged.testGaps.length : 0;

  // Always surface whichever reviewer(s) actually just ran, even when
  // `overall` is still incomplete (e.g. --tests alone, before --description
  // and --solution have run) — a partial run must never look like it
  // produced no PASS/FAIL information at all.
  const roleVerdicts: Record<string, Verdict> | undefined = runReviewers
    ? Object.fromEntries(
        activeRoles.filter((role) => byRole[role.key]).map((role) => [role.key, byRole[role.key].verdict]),
      )
    : undefined;

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

  return {
    content: `Checks: ${summaryParts.join("  |  ")}`,
    details: {
      overall,
      hasTestGaps: gapsCount > 0,
      gapsCount,
      roleVerdicts,
      showGaps: runGapStages,
    },
  };
}
