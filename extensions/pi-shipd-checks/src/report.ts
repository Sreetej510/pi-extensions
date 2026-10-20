/** Persistence and chat-summary helpers for benchmark and analysis runs. */

import { existsSync, readFileSync } from "node:fs";
import type {
  ChecksConfig,
  FargateResourceUsage,
  SolverGapConfig,
  SolverReviewResult,
  SolverRunResult,
  TestGapFinal,
} from "./types.js";

export const REQUIRED_FILES = ["agent_prompt.md"] as const;

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
  gapFinderStatus: string;
  gapFilterStatus: string;
  runClaudeBenchmark: boolean;
  solverConfig?: SolverGapConfig;
  solverResults: SolverRunResult[];
  fargateResourceUsage?: FargateResourceUsage;
  solverReview: SolverReviewResult | undefined;
}

export function mergeReport(input: MergeReportInput): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...input.existingReport,
    timestamp: formatLocalTimestamp(),
  };
  if (!input.runClaudeBenchmark) {
    merged.model = `${input.config.provider}/${input.config.modelId}`;
    merged.thinkingLevel = input.config.thinkingLevel;
  }
  // Discard fields created by pre-gap-finder-only versions of the extension.
  delete merged.overall;
  delete merged.reports;

  if (input.runGapFinder) {
    merged.testGaps = input.testGaps;
    if (input.gapAnalysisIncomplete) {
      merged.testGapAnalysisNote = `Gap analysis did not fully complete (sentence finder: ${input.gapFinderStatus}, review: ${input.gapFilterStatus}); testGaps may be incomplete.`;
    } else delete merged.testGapAnalysisNote;
  }
  if (input.runClaudeBenchmark) {
    delete merged.model;
    delete merged.thinkingLevel;
    if (input.solverConfig) {
      merged.solverModel = input.solverConfig.modelId;
      merged.solverThinkingLevel = input.solverConfig.thinkingLevel;
    } else {
      delete merged.solverModel;
      delete merged.solverThinkingLevel;
    }
    merged.solverRunSummary = input.solverResults.map((r) => ({
      index: r.index,
      status: r.status,
      passed: r.passed,
      durationMs: r.durationMs,
      totalTests: r.totalTests,
      failedTests: r.failedTests,
      basePassed: r.baseTests?.passed,
      newPassed: r.newTests?.passed,
      error: r.error ?? (r.status === "error" ? r.testOutputTail : undefined),
      artifactsDir: r.artifactsDir,
    }));
    const tokenUsages = [
      ...input.solverResults.map((result) => result.tokenUsage).filter((usage) => usage !== undefined),
      ...(input.solverReview?.tokenUsage ? [input.solverReview.tokenUsage] : []),
    ];
    const totalMetric = (
      key: "totalInputTokens" | "outputTokens" | "thinkingTokens" | "totalTokens" | "rawTotalTokens" | "costUsd",
    ) => {
      const values = tokenUsages
        .map((usage) => (key === "rawTotalTokens" ? (usage.rawTotalTokens ?? usage.totalTokens) : usage[key]))
        .filter((value): value is number => value !== undefined);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
    };
    merged.solverTokenUsage = {
      agents: input.solverResults
        .filter((result) => result.tokenUsage !== undefined)
        .map(({ index, tokenUsage }) => ({ index, tokenUsage })),
      ...(input.solverReview?.tokenUsage ? { reviewer: input.solverReview.tokenUsage } : {}),
      totalInputTokens: totalMetric("totalInputTokens"),
      outputTokens: totalMetric("outputTokens"),
      thinkingTokens: totalMetric("thinkingTokens"),
      totalTokens: totalMetric("totalTokens"),
      ...(tokenUsages.some((usage) => usage.rawTotalTokens !== undefined)
        ? { rawTotalTokens: totalMetric("rawTotalTokens") }
        : {}),
      totalCostUsd: totalMetric("costUsd"),
    };
    if (input.solverReview) {
      const solverReview = { ...input.solverReview };
      delete solverReview.tokenUsage;
      merged.solverReview = solverReview;
    } else delete merged.solverReview;
    if (input.fargateResourceUsage) merged.fargateResourceUsage = input.fargateResourceUsage;
    else delete merged.fargateResourceUsage;
    // Remove fields emitted by the former reference-patch comparison workflow.
    delete merged.solverGaps;
    delete merged.solverGapAnalysisNote;
  }
  return merged;
}

export function formatDuration(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

export interface SolverSummaryDetail {
  index: number;
  status: SolverRunResult["status"];
  passed: boolean;
  durationMs: number;
  totalTests: number | null;
  failedTests: number | null;
  basePassed?: boolean;
  newPassed?: boolean;
  error?: string;
}
export interface RunSummary {
  content: string;
  details: {
    gapsCount: number;
    showGaps: boolean;
    showClaudeBenchmark: boolean;
    solverDetails: SolverSummaryDetail[];
    solverReviewStatus?: SolverReviewResult["status"];
    solverReviewText?: string;
  };
}

export function buildRunSummary(opts: {
  merged: Record<string, unknown>;
  runGapFinder: boolean;
  runClaudeBenchmark: boolean;
}): RunSummary {
  const gapsCount = Array.isArray(opts.merged.testGaps) ? opts.merged.testGaps.length : 0;
  const solverDetails: SolverSummaryDetail[] =
    opts.runClaudeBenchmark && Array.isArray(opts.merged.solverRunSummary)
      ? (opts.merged.solverRunSummary as SolverSummaryDetail[]).map((s) => ({ ...s, durationMs: s.durationMs ?? 0 }))
      : [];
  const review = opts.merged.solverReview as SolverReviewResult | undefined;
  const parts: string[] = [];
  if (opts.runGapFinder) parts.push(gapsCount > 0 ? `${gapsCount} test gap(s) found` : "no test gaps found");
  if (opts.runClaudeBenchmark) {
    const basePassed = solverDetails.filter((solver) => solver.basePassed).length;
    const newPassed = solverDetails.filter((solver) => solver.newPassed).length;
    parts.push(
      `${solverDetails.length} Claude agent(s): base ${basePassed}/${solverDetails.length}, new ${newPassed}/${solverDetails.length}`,
    );
    parts.push(`review ${review?.status ?? "not completed"}`);
  }
  return {
    content: `Checks: ${parts.join("  |  ")}`,
    details: {
      gapsCount,
      showGaps: opts.runGapFinder,
      showClaudeBenchmark: opts.runClaudeBenchmark,
      solverDetails,
      solverReviewStatus: review?.status,
      solverReviewText: review?.text,
    },
  };
}
