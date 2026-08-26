/** Shipd submission tool: build patches, fill a challenge draft, run quality checks, and return focused results. */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Browser, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { Type } from "typebox";
import { getShellExecutable } from "./config.js";
import { formatDuration } from "./report.js";

export const SUBMIT_SHIPD_TOOL_NAME = "submit_shipd";
export const SHIPD_JOB_LINK_COMMAND = "shipd:link";
export const SHIPD_JOB_LINK_ENTRY = "shipd_job_link";

const DEFAULT_STORAGE_STATE_PATH = join(homedir(), ".pi", "agent", "shipd-auth", "shipd.ai.json");
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 1_800_000;
const PATCH_SCRIPT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const UI_TIMEOUT_MS = 5_000;
const QUALITY_NAMES = ["Test Quality", "Solution Quality"] as const;

type QualityName = (typeof QUALITY_NAMES)[number];
type JsonRecord = Record<string, unknown>;

const submitShipdParams = Type.Object({});

interface SubmissionFiles {
  taskPrompt: string;
  testPatch: string;
  solutionPatch: string;
}

interface QualityReport {
  [key: string]: unknown;
}

interface ExtractedReport {
  quality: QualityName;
  parsed: QualityReport;
}

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled by user."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Cancelled by user."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Cancelled by user.");
}

function findChrome(): string | undefined {
  const candidates = [
    process.env.SHIPD_CHROME_PATH,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] &&
      join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}

function isShipdJobLink(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "shipd.ai" || hostname.endsWith(".shipd.ai"));
  } catch {
    return false;
  }
}

function readSavedJobLink(entries: readonly unknown[]): string | undefined {
  let saved: string | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SHIPD_JOB_LINK_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    if (typeof data.url === "string" && isShipdJobLink(data.url)) saved = data.url;
    else if (data.url === null) saved = undefined;
  }
  return saved;
}

function qualityLabel(page: Page, quality: QualityName): Locator {
  return page
    .locator("span")
    .filter({ hasText: new RegExp(`^${escapeRegex(quality)}$`) })
    .first();
}

function qualityRow(page: Page, quality: QualityName): Locator {
  return qualityLabel(page, quality).locator("..");
}

function qualityPopover(page: Page, quality: QualityName): Locator {
  // The popover is rendered in a portal, so scope it by its quality heading
  // instead of globally selecting whichever row was hovered most recently.
  return page.locator("div.fixed").filter({ hasText: quality }).last();
}

function isBusy(rowText: string): boolean {
  return /(?:starting|queued|pending|running|processing|reviewing|finalizing|building|evaluating|checking|\d+%)/i.test(
    rowText,
  );
}

function parseJson(raw: string, quality: QualityName): QualityReport {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw new Error(
      `${quality} raw output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${quality} raw output was not a JSON object.`);
  return parsed;
}

async function readSubmissionFiles(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<SubmissionFiles> {
  const scriptPath = join(cwd, "create_patches.sh");
  const promptPath = join(cwd, "agent_prompt.md");
  const testPatchPath = join(cwd, "test.patch");
  const solutionPatchPath = join(cwd, "solution.patch");
  const missing = [
    ["create_patches.sh", scriptPath],
    ["agent_prompt.md", promptPath],
    ["test.patch", testPatchPath],
    ["solution.patch", solutionPatchPath],
  ]
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing required file(s) in the working directory: ${missing.join(", ")}`);

  checkCancelled(signal);
  const patchRun = await pi.exec(getShellExecutable(), ["create_patches.sh"], {
    cwd,
    timeout: PATCH_SCRIPT_TIMEOUT_MS,
    signal,
  });
  if (patchRun.killed || patchRun.code !== 0) {
    const output = (patchRun.stderr || patchRun.stdout || "").trim().slice(-2_000);
    throw new Error(
      `create_patches.sh failed${patchRun.killed ? " or timed out" : ` (exit ${patchRun.code})`}.${output ? `\n${output}` : ""}`,
    );
  }

  checkCancelled(signal);
  const [taskPrompt, testPatch, solutionPatch] = await Promise.all([
    readFile(promptPath, "utf8"),
    readFile(testPatchPath, "utf8"),
    readFile(solutionPatchPath, "utf8"),
  ]);
  return { taskPrompt, testPatch, solutionPatch };
}

async function navigateAuthenticated(page: Page, targetUrl: string, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  checkCancelled(signal);
  if (!isShipdJobLink(page.url())) {
    throw new Error("Shipd authentication or job-link navigation failed. Check the saved job link and auth state.");
  }
  if (response && response.status() >= 400) {
    throw new Error(`Shipd job-link navigation returned HTTP ${response.status()}.`);
  }
  await page.waitForTimeout(4_000);
  checkCancelled(signal);
}

async function fillChallengeFields(page: Page, files: SubmissionFiles, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const description = page.locator("#problem-description");
  const testEditor = page.locator('#problem-test-patch [contenteditable="true"][role="textbox"]');
  const solutionEditor = page.locator('#problem-solution-patch [contenteditable="true"][role="textbox"]');
  for (const selector of [description, testEditor, solutionEditor]) {
    if ((await selector.count()) !== 1) throw new Error("Shipd challenge form selectors were not found exactly once.");
  }

  await description.fill(files.taskPrompt);
  await testEditor.fill(files.testPatch);
  await solutionEditor.fill(files.solutionPatch);
  await qualityRow(page, "Test Quality").hover();
  await sleep(1_000, signal);
}

async function clickAndConfirm(page: Page, quality: QualityName, signal?: AbortSignal): Promise<JsonRecord> {
  checkCancelled(signal);
  const row = qualityRow(page, quality);
  const initialText = clean(await row.innerText());
  if (isBusy(initialText)) throw new Error(`${quality} is already running; refusing to start a duplicate job.`);

  const rerun = row.locator('button[title^="Re-run"]');
  const count = await rerun.count();
  if (count !== 1) throw new Error(`${quality}: expected one Re-run button, found ${count}`);
  if (!(await rerun.isEnabled())) throw new Error(`${quality}: Re-run button is disabled.`);
  const title = await rerun.getAttribute("title");

  await rerun.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const confirmation = clean(await dialog.innerText());
  const confirm = dialog.getByRole("button", { name: /confirm/i });
  if ((await confirm.count()) !== 1) throw new Error(`${quality}: rerun confirmation button was not found.`);
  await confirm.click();
  await sleep(500, signal);
  return { quality, status: "started", rerunTitle: title, confirmation };
}

async function waitForQualityComplete(
  page: Page,
  quality: QualityName,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ rowText: string }> {
  let sawBusy = false;
  let lastRowText = "";
  while (Date.now() < deadline) {
    checkCancelled(signal);
    const row = qualityRow(page, quality);
    lastRowText = clean(await row.innerText());
    const busy = isBusy(lastRowText);
    if (busy) sawBusy = true;
    if (sawBusy && !busy) return { rowText: lastRowText };
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error(`${quality} timed out waiting for completion; last row text: ${lastRowText}`);
}

async function getQualityExpander(page: Page, quality: QualityName): Promise<Locator> {
  await qualityRow(page, quality).hover();
  const popover = qualityPopover(page, quality);
  await popover.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const expanders = popover.locator('button[title="Expand to full view"]');
  const count = await expanders.count();
  if (count !== 1) throw new Error(`${quality}: expected one quality expander, found ${count}`);
  return expanders.first();
}

async function extractQualityReport(page: Page, quality: QualityName, signal?: AbortSignal): Promise<ExtractedReport> {
  checkCancelled(signal);
  const expander = await getQualityExpander(page, quality);
  await expander.click();

  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const heading = clean(
    await dialog
      .locator("h2")
      .first()
      .innerText()
      .catch(() => ""),
  );
  if (heading !== quality) throw new Error(`${quality}: expanded the wrong report dialog (${heading || "unknown"}).`);

  const code = dialog.locator("pre code").last();
  if (!(await code.isVisible().catch(() => false))) {
    const rawButton = dialog
      .locator("button")
      .filter({ hasText: /raw output/i })
      .first();
    try {
      await rawButton.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    } catch {
      const dialogText = clean(await dialog.innerText());
      throw new Error(`${quality}: raw output control did not appear; dialog text: ${dialogText.slice(0, 1_000)}`);
    }
    await rawButton.click();
  }

  await code.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const rawOutput = await code.innerText();
  const parsed = parseJson(rawOutput, quality);
  await page.keyboard.press("Escape").catch(() => undefined);
  return { quality, parsed };
}

function buildAgentResult(testReport: QualityReport, solutionReport: QualityReport): JsonRecord {
  const coverageSuggestions = Array.isArray(testReport.coverageSuggestions) ? testReport.coverageSuggestions : [];
  const unfairTests = Array.isArray(testReport.tests)
    ? testReport.tests.filter((item): item is JsonRecord => isRecord(item) && item.fairness === "Not fair")
    : [];
  return {
    testQuality: {
      verdict: testReport.verdict,
      completed: testReport.completed,
      coverageSuggestions,
      tests: unfairTests,
    },
    solutionQuality: {
      verdict: solutionReport.verdict,
      completed: solutionReport.completed,
      evaluation: solutionReport.evaluation ?? null,
    },
  };
}

function scoreText(evaluation: unknown, key: "code_quality" | "solution_comprehensiveness"): string {
  if (!isRecord(evaluation) || !isRecord(evaluation[key])) return "—";
  const score = evaluation[key].score;
  const maxScore = evaluation[key].max_score;
  return typeof score === "number" && typeof maxScore === "number" ? `${score}/${maxScore}` : "—";
}

function qualitySummaryText(details: unknown, theme: Theme): string[] {
  const value = isRecord(details) ? details : {};
  const testQuality = isRecord(value.testQuality) ? value.testQuality : {};
  const solutionQuality = isRecord(value.solutionQuality) ? value.solutionQuality : {};
  const unfairCount = Array.isArray(testQuality.tests) ? testQuality.tests.length : 0;
  const suggestionCount = Array.isArray(testQuality.coverageSuggestions) ? testQuality.coverageSuggestions.length : 0;
  const evaluation = solutionQuality.evaluation;
  return [
    `  ${theme.fg("accent", "Test Quality")}  ${theme.fg("muted", `${unfairCount} unfair · ${suggestionCount} suggestions`)}`,
    `  ${theme.fg("accent", "Solution Quality")}  ${theme.fg("muted", `quality ${scoreText(evaluation, "code_quality")} · comprehensiveness ${scoreText(evaluation, "solution_comprehensiveness")}`)}`,
  ];
}

export function registerSubmitShipdTool(pi: ExtensionAPI): void {
  let jobLink: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    jobLink = readSavedJobLink(ctx.sessionManager.getBranch());
  });

  pi.registerCommand(SHIPD_JOB_LINK_COMMAND, {
    description: "Save the Shipd job link for this chat session.",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value.toLowerCase() === "clear") {
        jobLink = undefined;
        pi.appendEntry(SHIPD_JOB_LINK_ENTRY, { url: null });
        ctx.ui.notify("Shipd job link cleared for this chat session.", "info");
        return;
      }
      if (!isShipdJobLink(value)) {
        ctx.ui.notify(`Usage: /${SHIPD_JOB_LINK_COMMAND} <https://shipd.ai/...>`, "warning");
        return;
      }
      jobLink = value;
      pi.appendEntry(SHIPD_JOB_LINK_ENTRY, { url: value });
      ctx.ui.notify("Shipd job link saved for this chat session.", "info");
    },
  });

  pi.registerTool({
    name: SUBMIT_SHIPD_TOOL_NAME,
    label: "Quality Checks",
    description:
      "Run create_patches.sh in the current working directory, read agent_prompt.md, test.patch, and solution.patch, " +
      "fill the saved Shipd job's draft fields, start Test Quality and then Solution Quality in one browser tab, wait " +
      "for both jobs, and return agent-focused JSON. details.testQuality contains coverageSuggestions and only tests whose " +
      'fairness is exactly "Not fair"; details.solutionQuality contains the complete evaluation block. The job link ' +
      `is set with /${SHIPD_JOB_LINK_COMMAND} and is scoped to this chat session. This consumes Shipd tokens and does not ` +
      "click the final challenge-submit button.",
    promptSnippet: "Submit the working-directory patches to Shipd",
    promptGuidelines: [
      "Use submit_shipd when the user explicitly asks to submit or evaluate the current Shipd task.",
      `Before calling submit_shipd, set the session job link with /${SHIPD_JOB_LINK_COMMAND} <job-link> if it is not already set.`,
      "submit_shipd has no parameters: it runs create_patches.sh, then reads agent_prompt.md, test.patch, and solution.patch from the working directory.",
      "A saved Shipd authentication state is required; never request or expose its contents.",
      "submit_shipd starts Test Quality and then Solution Quality in one browser tab, and waits for both before returning.",
      "Read details.testQuality.coverageSuggestions and details.testQuality.tests for test-quality feedback.",
      "Read details.solutionQuality.evaluation for the complete solution-quality feedback.",
    ],
    parameters: submitShipdParams,
    renderCall(_args, _theme, context) {
      const state = context.state as {
        startedAt?: number;
      };
      if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText("");
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };
      state.startedAt ??= Date.now();
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1_000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const endTime = state.endedAt ?? Date.now();
      const elapsed = formatDuration(endTime - state.startedAt);
      const elapsedLabel = options.isPartial ? `Elapsed ${elapsed}` : `Took ${elapsed}`;
      const header = theme.fg("toolTitle", theme.bold("Quality Checks")) + theme.fg("muted", `  ${elapsedLabel}`);
      if (options.isPartial) {
        return new Text(`${header}\n  ${theme.fg("muted", "Running quality checks...")}`, 0, 0);
      }
      if (context.isError) return new Text(`${header}\n  ${theme.fg("error", "Quality checks failed")}`, 0, 0);
      return new Text([header, ...qualitySummaryText(result.details, theme)].join("\n"), 0, 0);
    },
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      if (!jobLink) {
        throw new Error(
          `No Shipd job link is set for this chat session. Provide the job link with /${SHIPD_JOB_LINK_COMMAND} <job-link>.`,
        );
      }
      const targetUrl = jobLink;
      const storageStatePath = process.env.SHIPD_STORAGE_STATE ?? DEFAULT_STORAGE_STATE_PATH;
      if (!existsSync(storageStatePath)) {
        throw new Error(
          `Shipd authentication state not found at ${storageStatePath}. Run scripts/playwright-auth-smoke.mjs first.`,
        );
      }
      const executablePath = findChrome();
      if (!executablePath) throw new Error("Could not find Chrome/Chromium. Set SHIPD_CHROME_PATH and retry.");

      const configuredTimeout = Number.parseInt(process.env.SHIPD_SUBMIT_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(30_000, Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS),
      );
      const deadline = Date.now() + timeoutMs;
      let browser: Browser | undefined;
      const closeOnAbort = () => {
        void browser?.close().catch(() => undefined);
      };
      signal?.addEventListener("abort", closeOnAbort, { once: true });

      try {
        checkCancelled(signal);
        onUpdate?.({ content: [{ type: "text", text: "Running create_patches.sh..." }], details: undefined });
        const files = await readSubmissionFiles(pi, ctx.cwd, signal);
        checkCancelled(signal);

        onUpdate?.({
          content: [{ type: "text", text: "Opening Shipd and filling draft fields..." }],
          details: undefined,
        });
        browser = await chromium.launch({ executablePath, headless: true });
        const context = await browser.newContext({ storageState: storageStatePath });
        const page = await context.newPage();
        await navigateAuthenticated(page, targetUrl, signal);
        await fillChallengeFields(page, files, signal);

        onUpdate?.({
          content: [{ type: "text", text: "Starting Test Quality, then Solution Quality..." }],
          details: undefined,
        });
        const started: JsonRecord[] = [];
        for (const quality of QUALITY_NAMES) {
          started.push(await clickAndConfirm(page, quality, signal));
        }

        onUpdate?.({ content: [{ type: "text", text: "Waiting for both Shipd quality jobs..." }], details: undefined });
        const completed = await Promise.all(
          QUALITY_NAMES.map((quality) => waitForQualityComplete(page, quality, deadline, signal)),
        );

        onUpdate?.({ content: [{ type: "text", text: "Extracting quality reports..." }], details: undefined });
        const reports: ExtractedReport[] = [];
        for (const quality of QUALITY_NAMES) {
          reports.push(await extractQualityReport(page, quality, signal));
        }
        const testReport = reports.find((report) => report.quality === "Test Quality")?.parsed;
        const solutionReport = reports.find((report) => report.quality === "Solution Quality")?.parsed;
        if (!testReport || !solutionReport) throw new Error("Shipd did not return both quality reports.");

        const result = buildAgentResult(testReport, solutionReport);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { ...result, started, completed },
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("Cancelled by user.");
        throw error;
      } finally {
        signal?.removeEventListener("abort", closeOnAbort);
        await browser?.close().catch(() => undefined);
      }
    },
  });
}
