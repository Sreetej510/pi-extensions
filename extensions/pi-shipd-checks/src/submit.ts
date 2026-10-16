/** Shipd submission tool: build patches, fill a challenge draft, run quality checks, and return focused results. */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { Type } from "typebox";
import { getShellExecutable, loadFargateConfig } from "./config.js";
import { runFargatePatchPrecheck } from "./fargate-runner.js";
import { snapshotGitHead } from "./git.js";
import { formatDuration } from "./report.js";
import type { PatchPrecheckResult } from "./types.js";

export const QUALITY_CHECK_TOOL_NAME = "quality-check";
export const SHIPD_JOB_LINK_COMMAND = "shipd:link";
export const SHIPD_JOB_LINK_ENTRY = "shipd_job_link";
export const SHIPD_PROMPT_QUALITY_SHA_ENTRY = "shipd_prompt_quality_sha";

const DEFAULT_STORAGE_STATE_PATH = join(homedir(), ".pi", "agent", "shipd-auth", "shipd.ai.json");
const PATCH_PRECHECK_TIMEOUT_MINUTES = 15;
const SHIPD_AUTH_URL = "https://shipd.ai/";
const PATCH_SCRIPT_TIMEOUT_MS = 120_000;
const INITIAL_WAIT_MS = 300_000;
const RECHECK_INTERVAL_MS = 90_000;
const PROMPT_QUALITY_INITIAL_WAIT_MS = 120_000;
const PROMPT_QUALITY_RECHECK_INTERVAL_MS = 30_000;
const UI_TIMEOUT_MS = 5_000;
const QUALITY_UI_RETRY_ATTEMPTS = 3;
const QUALITY_UI_RETRY_DELAY_MS = 250;
const QUALITY_RUN_START_TIMEOUT_MS = 2_000;
const QUALITY_NAMES = ["Task Prompt Quality", "Test Quality", "Solution Quality"] as const;
const PROMPT_PRESERVATION_NOTE =
  "Keep agent_prompt.md unchanged if possible—small edits can make it fail. Prefer aligning tests and solution to the prompt; only if the prompt is demonstrably wrong, make the smallest correction while preserving its human style.";

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

function findFreePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local Chrome debugging port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForChromeDebuggingPort(
  port: number,
  chromeProcess: ReturnType<typeof spawn>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeProcess.exitCode !== null)
      throw new Error("Chrome exited before its debugging connection became available.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome may need a few moments to start listening.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for Chrome to start.");
}

async function findAuthenticatedShipdPage(context: BrowserContext, timeoutMs = 30_000): Promise<Page | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = context.pages();
    for (const page of pages) {
      if (!isShipdJobLink(page.url())) continue;
      const userMenu = page.locator('button[aria-label="Open user menu"]');
      if (await userMenu.isVisible({ timeout: 1_000 }).catch(() => false)) return page;
    }

    for (const page of pages) {
      if (!isShipdJobLink(page.url())) continue;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    }
    await sleep(1_000);
  }
  return undefined;
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

function isShipdSignInPage(value: string): boolean {
  try {
    return /\/sign-in(?:\/|$)/i.test(new URL(value).pathname);
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

function readSavedPromptQualitySha(entries: readonly unknown[]): string | undefined {
  let saved: string | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SHIPD_PROMPT_QUALITY_SHA_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    if (typeof data.sha256 === "string" && /^[a-f0-9]{64}$/i.test(data.sha256)) saved = data.sha256;
    else if (data.sha256 === null) saved = undefined;
  }
  return saved;
}

function displayQualityName(quality: QualityName): string {
  return quality === "Task Prompt Quality" ? "Prompt Quality" : quality;
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

function isStale(rowText: string): boolean {
  return /\bstale\b/i.test(rowText);
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
  if (isShipdSignInPage(page.url())) {
    throw new Error("Shipd authentication failed: the saved session is expired or signed out. Run /shipd:auth again.");
  }
  if (response && response.status() >= 400) {
    throw new Error(`Shipd job-link navigation returned HTTP ${response.status()}.`);
  }
  await page.waitForTimeout(4_000);
  checkCancelled(signal);
}

async function openShipdPage(
  executablePath: string,
  storageStatePath: string,
  targetUrl: string,
  signal?: AbortSignal,
): Promise<{ browser: Browser; page: Page }> {
  checkCancelled(signal);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ storageState: storageStatePath });
    await context.route("**/*", async (route) => {
      const resourceType = route.request().resourceType();
      if (resourceType === "image" || resourceType === "font" || resourceType === "media") {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    const page = await context.newPage();
    await navigateAuthenticated(page, targetUrl, signal);
    return { browser, page };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function fillCodeEditor(page: Page, editor: Locator, value: string): Promise<void> {
  await editor.click({ timeout: UI_TIMEOUT_MS });
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
  await page.keyboard.insertText(value);
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
  await fillCodeEditor(page, testEditor, files.testPatch);
  await fillCodeEditor(page, solutionEditor, files.solutionPatch);
  await qualityRow(page, "Task Prompt Quality").hover();
  await sleep(1_000, signal);
}

async function qualityRunStartedRowText(
  page: Page,
  quality: QualityName,
  staleBefore: boolean,
  runButtonBefore: boolean,
): Promise<string | undefined> {
  const row = qualityRow(page, quality);
  const rowText = clean(await row.innerText());
  const runButtonAfter = await row.locator('button[title^="Run"]').count();
  if (
    isBusy(rowText) ||
    (Boolean(rowText) && staleBefore && !isStale(rowText)) ||
    (Boolean(rowText) && runButtonBefore && runButtonAfter === 0)
  ) {
    return rowText;
  }
  return undefined;
}

async function waitForQualityRunStart(
  page: Page,
  quality: QualityName,
  staleBefore: boolean,
  runButtonBefore: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + QUALITY_RUN_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    checkCancelled(signal);
    const rowText = await qualityRunStartedRowText(page, quality, staleBefore, runButtonBefore);
    if (rowText !== undefined) return rowText;
    await sleep(200, signal);
  }
  return undefined;
}

async function clickAndConfirm(page: Page, quality: QualityName, signal?: AbortSignal): Promise<JsonRecord> {
  let lastFailure = "The Run action did not start the quality check.";
  for (let attempt = 1; attempt <= QUALITY_UI_RETRY_ATTEMPTS; attempt += 1) {
    checkCancelled(signal);
    let staleBefore = false;
    let runButtonBefore = false;
    let rerunTitle: string | null = null;
    let confirmation = "";
    try {
      const row = qualityRow(page, quality);
      const beforeText = clean(await row.innerText());
      if (isBusy(beforeText)) {
        return { quality: displayQualityName(quality), status: "already-running", rowTextAfterConfirm: beforeText };
      }
      staleBefore = isStale(beforeText);
      const runButton = row.locator('button[title^="Run"]');
      const rerunButton = row.locator('button[title^="Re-run"]');
      runButtonBefore = (await runButton.count()) > 0;
      if (!staleBefore && !runButtonBefore) {
        return { quality: displayQualityName(quality), status: "no-longer-stale", rowTextAfterConfirm: beforeText };
      }

      const rerunCount = await rerunButton.count();
      const runCount = await runButton.count();
      const action = rerunCount === 1 ? rerunButton : runButton;
      const actionCount = rerunCount === 1 ? rerunCount : runCount;
      if (actionCount !== 1) throw new Error(`${quality}: expected one Run button, found ${actionCount}`);
      if (!(await action.isEnabled())) throw new Error(`${quality}: Run button is disabled.`);
      rerunTitle = await action.getAttribute("title");

      await action.click({ timeout: UI_TIMEOUT_MS });
      const dialog = page.getByRole("dialog").last();
      await dialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      confirmation = clean(await dialog.innerText());
      const confirm = dialog.getByRole("button", { name: /confirm/i });
      if ((await confirm.count()) !== 1) throw new Error(`${quality}: rerun confirmation button was not found.`);
      await confirm.click({ timeout: UI_TIMEOUT_MS });

      const startedRowText = await waitForQualityRunStart(page, quality, staleBefore, runButtonBefore, signal);
      if (startedRowText !== undefined) {
        return {
          quality: displayQualityName(quality),
          status: "started",
          rerunTitle,
          confirmation,
          rowTextAfterConfirm: startedRowText,
        };
      }
      lastFailure = `${quality}: the confirmation was accepted, but the stale status did not clear and no running state appeared.`;
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const startedRowText = await qualityRunStartedRowText(page, quality, staleBefore, runButtonBefore).catch(
      () => undefined,
    );
    if (startedRowText !== undefined) {
      return {
        quality: displayQualityName(quality),
        status: "started",
        rerunTitle,
        confirmation,
        rowTextAfterConfirm: startedRowText,
      };
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    if (attempt < QUALITY_UI_RETRY_ATTEMPTS) await sleep(QUALITY_UI_RETRY_DELAY_MS * attempt, signal);
  }
  throw new Error(`${quality}: could not start after ${QUALITY_UI_RETRY_ATTEMPTS} attempts. ${lastFailure}`);
}

interface QualityStatus {
  quality: QualityName;
  rowText: string;
  busy: boolean;
  shouldRun: boolean;
}

async function readQualityStatuses(
  page: Page,
  signal?: AbortSignal,
  qualities: readonly QualityName[] = QUALITY_NAMES,
): Promise<QualityStatus[]> {
  const statuses: QualityStatus[] = [];
  for (const quality of qualities) {
    checkCancelled(signal);
    const label = qualityLabel(page, quality);
    if ((await label.count()) !== 1) throw new Error(`${quality}: quality status row was not found.`);
    await label.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    const row = label.locator("..");
    const rowText = clean(await row.innerText());
    const hasRunButton = (await row.locator('button[title^="Run"]').count()) > 0;
    statuses.push({ quality, rowText, busy: isBusy(rowText), shouldRun: hasRunButton || isStale(rowText) });
  }
  return statuses;
}

async function readQualityStatusesWithRetry(
  page: Page,
  signal?: AbortSignal,
  qualities: readonly QualityName[] = QUALITY_NAMES,
): Promise<QualityStatus[]> {
  let lastFailure = "Quality status rows were unavailable.";
  for (let attempt = 1; attempt <= QUALITY_UI_RETRY_ATTEMPTS; attempt += 1) {
    checkCancelled(signal);
    try {
      return await readQualityStatuses(page, signal, qualities);
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempt < QUALITY_UI_RETRY_ATTEMPTS) await sleep(QUALITY_UI_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw new Error(`Could not read quality status after ${QUALITY_UI_RETRY_ATTEMPTS} attempts. ${lastFailure}`);
}

async function hasQualityReport(page: Page, quality: QualityName): Promise<boolean> {
  const row = qualityRow(page, quality);
  // A fresh challenge uses a Run button and has no report popover yet. A completed
  // check uses Re-run and exposes the report through the hover popover.
  return (await row.locator('button[title^="Re-run"]').count()) > 0;
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

async function extractQualityReportWithRetry(
  page: Page,
  quality: QualityName,
  signal?: AbortSignal,
): Promise<ExtractedReport> {
  let lastFailure = "The report dialog could not be opened.";
  for (let attempt = 1; attempt <= QUALITY_UI_RETRY_ATTEMPTS; attempt += 1) {
    checkCancelled(signal);
    try {
      return await extractQualityReport(page, quality, signal);
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      lastFailure = error instanceof Error ? error.message : String(error);
      await page.keyboard.press("Escape").catch(() => undefined);
      if (attempt < QUALITY_UI_RETRY_ATTEMPTS) await sleep(QUALITY_UI_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw new Error(`${quality}: report dialog failed after ${QUALITY_UI_RETRY_ATTEMPTS} attempts. ${lastFailure}`);
}

function getMajorPromptComments(evaluation: JsonRecord): JsonRecord[] {
  return Array.isArray(evaluation.comments)
    ? evaluation.comments
        .filter((comment): comment is JsonRecord => isRecord(comment) && comment.severity === "major")
        .map((comment) => ({
          category: comment.category,
          quote: comment.quote,
          suggestion: compactFeedback(comment.suggestion, 500) ?? comment.suggestion,
        }))
    : [];
}

function isAIPromptCategory(category: unknown): boolean {
  if (typeof category !== "string") return false;
  const normalized = category.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "ai" ||
    normalized.startsWith("ai") ||
    normalized.includes("aigenerated") ||
    /(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(category)
  );
}

function hasAIPromptComment(evaluation: JsonRecord): boolean {
  return (
    Array.isArray(evaluation.comments) &&
    evaluation.comments.some((comment) => isRecord(comment) && isAIPromptCategory(comment.category))
  );
}

function aiPromptFailure(evaluation: JsonRecord): JsonRecord {
  const result: JsonRecord = {
    verdict: "FAIL",
    reason:
      "Prompt Quality flagged this prompt as AI. Use humanize-agent-prompt for a broader rewrite, or make a small targeted manual change if the flag is due to a recent edit.",
  };
  const comments = getMajorPromptComments(evaluation).filter((comment) => !isAIPromptCategory(comment.category));
  if (comments.length > 0) result.comments = comments;
  return result;
}

function buildPromptQualityResult(report: QualityReport | undefined): JsonRecord {
  if (report?.completed !== true || !isRecord(report.evaluation)) {
    return { verdict: "FAIL", reason: "No completed Prompt Quality report was available." };
  }

  const evaluation = report.evaluation;
  const requirementCount = isRecord(evaluation.requirementCount) ? evaluation.requirementCount : {};
  if (requirementCount.blocking === true && requirementCount.mode === "blocking") {
    return {
      verdict: "FAIL",
      reason:
        "There are too many requirements in the prompt. Decrease the very easy requirements that any agent can easily implement.",
    };
  }

  if (hasAIPromptComment(evaluation)) return aiPromptFailure(evaluation);

  const passed = report.verdict === "PASS" && evaluation.verdict === "PASS";
  if (passed) return { verdict: "PASS" };

  const comments = getMajorPromptComments(evaluation);
  const result: JsonRecord = { verdict: "FAIL" };
  if (comments.length > 0) result.comments = comments;
  else if (typeof evaluation.summary === "string") result.reason = evaluation.summary;
  return result;
}

function buildAgentResult(
  testReport: QualityReport | undefined,
  promptQuality: JsonRecord,
  solutionReport: QualityReport | undefined,
): JsonRecord {
  const coverageSuggestions = Array.isArray(testReport?.coverageSuggestions) ? testReport.coverageSuggestions : [];
  const unfairnessTests = Array.isArray(testReport?.tests)
    ? testReport.tests
        .filter(
          (item): item is JsonRecord =>
            isRecord(item) &&
            (item.fairness === "Not fair" || (Array.isArray(item.concerns) && item.concerns.length > 0)),
        )
        .map((item) =>
          item.fairness === "Not fair" && Array.isArray(item.concerns) && item.concerns.length === 0
            ? { ...item, concerns: ["Not fully fair"] }
            : item,
        )
    : [];
  const reportedUnfairnessCount =
    typeof testReport?.unfairTestCount === "number" && Number.isFinite(testReport.unfairTestCount)
      ? Math.max(0, Math.floor(testReport.unfairTestCount))
      : 0;
  const unfairnessCount = Math.max(unfairnessTests.length, reportedUnfairnessCount);
  const testPasses = Boolean(testReport) && unfairnessCount === 0 && coverageSuggestions.length === 0;
  const testQuality: JsonRecord = !testReport
    ? { verdict: "FAIL", reason: "No completed Test Quality report was available." }
    : testPasses
      ? { verdict: "PASS" }
      : {
          verdict: "FAIL",
          ...(coverageSuggestions.length > 0 ? { coverageSuggestions } : {}),
          unfairnessCount,
          ...(unfairnessTests.length > 0 ? { tests: unfairnessTests } : {}),
        };
  const solutionPasses = Boolean(solutionReport) && hasPerfectSolutionEvaluation(solutionReport?.evaluation);
  const solutionQuality: JsonRecord = !solutionReport
    ? { verdict: "FAIL", reason: "No completed Solution Quality report was available." }
    : solutionPasses
      ? { verdict: "PASS" }
      : { verdict: "FAIL", failures: solutionQualityFailures(solutionReport.evaluation) };

  return {
    promptQuality,
    ...(promptQuality.verdict === "PASS" ? { note: PROMPT_PRESERVATION_NOTE } : {}),
    testQuality,
    solutionQuality,
  };
}

function compactFeedback(value: unknown, maxLength = 400): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > 0 ? boundary : maxLength).trim()}…`;
}

function solutionQualityFailures(evaluation: unknown): JsonRecord[] {
  if (!isRecord(evaluation)) return [{ feedback: "No scored Solution Quality evaluation was available." }];

  const issues = Array.isArray(evaluation.issues) ? evaluation.issues.filter(isRecord) : [];
  const failures = Object.entries(evaluation).filter(
    ([, value]) =>
      isRecord(value) &&
      typeof value.score === "number" &&
      typeof value.max_score === "number" &&
      value.score !== value.max_score,
  );
  if (failures.length === 0) {
    return [
      { feedback: compactFeedback(evaluation.summary) ?? "One or more required scores did not meet its maximum." },
    ];
  }

  return failures.map(([criterion, value]) => {
    if (!isRecord(value)) return { criterion };
    const normalizedCriterion = criterion.toLowerCase().replace(/[^a-z0-9]/g, "");
    const issue = issues.find((candidate) => {
      const issueCriterion =
        typeof candidate.criterion === "string" ? candidate.criterion.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
      return (
        issueCriterion && (normalizedCriterion.endsWith(issueCriterion) || issueCriterion.endsWith(normalizedCriterion))
      );
    });
    const feedback = compactFeedback(issue?.detail ?? value.reasoning ?? evaluation.summary);
    return {
      criterion,
      score: value.score,
      max_score: value.max_score,
      ...(typeof issue?.title === "string" ? { title: issue.title } : {}),
      ...(feedback ? { feedback } : {}),
    };
  });
}

function hasPerfectSolutionEvaluation(evaluation: unknown): boolean {
  if (!isRecord(evaluation)) return false;
  const requiredCriteria = ["code_quality", "solution_comprehensiveness"];
  if (
    !requiredCriteria.every((key) => {
      const criterion = evaluation[key];
      return isRecord(criterion) && typeof criterion.score === "number" && typeof criterion.max_score === "number";
    })
  ) {
    return false;
  }
  const scoredCriteria = Object.values(evaluation).filter(
    (value): value is JsonRecord => isRecord(value) && ("score" in value || "max_score" in value),
  );
  return scoredCriteria.every(
    (criterion) =>
      typeof criterion.score === "number" &&
      typeof criterion.max_score === "number" &&
      criterion.score === criterion.max_score,
  );
}

function qualitySummaryText(details: unknown, theme: Theme): string[] {
  const value = isRecord(details) ? details : {};
  const testQualityDetails = isRecord(value.testQuality) ? value.testQuality : undefined;
  const testQuality = testQualityDetails ?? {};
  const promptQuality = isRecord(value.promptQuality) ? value.promptQuality : {};
  const solutionQualityDetails = isRecord(value.solutionQuality) ? value.solutionQuality : undefined;
  const solutionQuality = solutionQualityDetails ?? {};
  const unfairnessCount =
    typeof testQuality.unfairnessCount === "number"
      ? testQuality.unfairnessCount
      : Array.isArray(testQuality.tests)
        ? testQuality.tests.length
        : 0;
  const suggestionCount = Array.isArray(testQuality.coverageSuggestions) ? testQuality.coverageSuggestions.length : 0;
  const promptComments = Array.isArray(promptQuality.comments) ? promptQuality.comments : [];
  const promptCommentCount = promptComments.length;
  const testSummary =
    testQuality.verdict === null || testQuality.verdict === undefined
      ? "skipped"
      : testQuality.verdict === "PASS"
        ? "PASS"
        : typeof testQuality.reason === "string"
          ? `FAIL · ${testQuality.reason}`
          : `${unfairnessCount} unfairness · ${suggestionCount} suggestions`;
  const promptSummary =
    promptQuality.verdict === null || promptQuality.verdict === undefined
      ? "skipped"
      : promptQuality.cached === true
        ? `${promptQuality.verdict} · cached`
        : promptQuality.verdict === "PASS"
          ? "PASS"
          : typeof promptQuality.reason === "string"
            ? `${promptQuality.verdict} · ${promptQuality.reason}`
            : `${promptQuality.verdict} · ${promptCommentCount} major comment${promptCommentCount === 1 ? "" : "s"}`;
  const solutionFailures = Array.isArray(solutionQuality.failures) ? solutionQuality.failures : [];
  const solutionSummary =
    solutionQuality.verdict === null || solutionQuality.verdict === undefined
      ? "skipped"
      : solutionQuality.verdict === "PASS"
        ? "PASS"
        : typeof solutionQuality.reason === "string"
          ? `FAIL · ${solutionQuality.reason}`
          : `${solutionFailures.length} solution-quality issue${solutionFailures.length === 1 ? "" : "s"}`;
  const promptCommentDetails = promptComments.flatMap((item) =>
    isRecord(item)
      ? [
          `    Category: ${String(item.category ?? "")}`,
          `    Quote: ${String(item.quote ?? "")}`,
          `    Suggestion: ${String(item.suggestion ?? "")}`,
        ]
      : [],
  );
  const lines = [
    `  ${theme.fg("accent", "Prompt Quality")}  ${theme.fg("muted", promptSummary)}`,
    ...promptCommentDetails,
  ];
  if (testQualityDetails) lines.push(`  ${theme.fg("accent", "Test Quality")}  ${theme.fg("muted", testSummary)}`);
  if (solutionQualityDetails)
    lines.push(`  ${theme.fg("accent", "Solution Quality")}  ${theme.fg("muted", solutionSummary)}`);
  return lines;
}

function parseErrorCount(lines: string[], label: string): number | undefined {
  const line = lines.find((value) => new RegExp(`^${label}:`, "i").test(value));
  const count = line?.match(/:\s*(\d+)/)?.[1];
  return count === undefined ? undefined : Number.parseInt(count, 10);
}

function patchPrecheckUiProblem(
  phase: string,
  passed: number | undefined,
  skipped: number | undefined,
  failedLine: string,
  erroredLine: string,
  collectionLine: string,
): string {
  if (phase === "new tests before solution") {
    if (passed !== undefined && passed > 0) {
      return "Some individual test cases or subtests pass before the solution; the precheck remains failed. Ensure every new case fails or errors before the solution.";
    }
    if (collectionLine && !/:\s*none$/i.test(collectionLine)) {
      return "New tests fail during collection; move solution-dependent imports or setup into each test so every testcase fails or errors individually.";
    }
    if (passed === 0 && /:\s*none$/i.test(failedLine) && /:\s*none$/i.test(erroredLine)) {
      return "The test file did not produce individual failures or errors; use lazy imports so every test executes separately.";
    }
    return "Every new test must fail or error individually before the solution.";
  }
  if (phase === "new tests after solution") {
    if (skipped !== undefined && skipped > 0) {
      return "New tests were skipped after the solution; every new test must execute and pass.";
    }
    return "The solution does not make every new test pass.";
  }
  if (phase === "base tests after solution") {
    return "Base-test regression: existing base tests fail after the solution.";
  }
  if (phase === "base tests before solution") {
    return "Base tests fail before the solution; review the test patch and test setup.";
  }
  return "The patch precheck did not meet the required test outcomes.";
}

function compactToolError(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = (result.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(" ");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const phaseLine = lines.find((line) => /^phase:/i.test(line));
  if (/patch precheck/i.test(text)) {
    if (phaseLine) {
      const phase = phaseLine.replace(/^phase:\s*/i, "");
      const passed = parseErrorCount(lines, "passed tests");
      const skipped = parseErrorCount(lines, "skipped tests");
      const failedLine = lines.find((line) => /^failed tests:/i.test(line)) ?? "";
      const erroredLine = lines.find((line) => /^errored tests:/i.test(line)) ?? "";
      const collectionLine = lines.find((line) => /^collection errors:/i.test(line)) ?? "";
      return [
        "Patch precheck failed.",
        `Phase: ${phase}`,
        `Problem: ${patchPrecheckUiProblem(phase, passed, skipped, failedLine, erroredLine, collectionLine)}`,
      ].join("\n");
    }
    return "Patch precheck failed.\nProblem: The precheck task could not be completed.";
  }
  return (
    lines
      .map((line) => line.replace(/\bFargate\b\s*/gi, "").trim())
      .slice(0, 4)
      .join("\n") || "Quality checks failed"
  );
}

function patchPrecheckError(result: PatchPrecheckResult): string {
  const prefix = `Fargate patch precheck failed:\nplatform: ${result.platform}`;
  if (result.error) return `${prefix}\n${result.error}`;
  const failed = result.phases.find((phase) => !phase.passed);
  return `${prefix}${failed ? `\nphase: ${failed.phase}` : ""}.`;
}

export function registerSubmitShipdTool(pi: ExtensionAPI): void {
  let jobLink: string | undefined;
  let promptQualitySha: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    jobLink = readSavedJobLink(entries);
    promptQualitySha = readSavedPromptQualitySha(entries);
  });

  pi.registerCommand("shipd:auth", {
    description: "Open Shipd in a browser so you can sign in and save authentication.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/shipd:auth requires interactive mode.", "error");
        return;
      }
      const executablePath = findChrome();
      if (!executablePath) {
        ctx.ui.notify("Could not find Chrome/Chromium. Set SHIPD_CHROME_PATH and retry.", "error");
        return;
      }

      const storageStatePath = process.env.SHIPD_STORAGE_STATE ?? DEFAULT_STORAGE_STATE_PATH;
      let browser: Browser | undefined;
      let chromeProcess: ReturnType<typeof spawn> | undefined;
      let userDataDir: string | undefined;
      try {
        mkdirSync(dirname(storageStatePath), { recursive: true });
        userDataDir = await mkdtemp(join(tmpdir(), "shipd-auth-"));
        const port = await findFreePort();
        chromeProcess = spawn(
          executablePath,
          [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            "--no-first-run",
            "--no-default-browser-check",
            SHIPD_AUTH_URL,
          ],
          { stdio: "ignore", windowsHide: false },
        );
        await waitForChromeDebuggingPort(port, chromeProcess);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = context.pages()[0] ?? (await context.newPage());
        await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined);
        if (!isShipdJobLink(page.url())) {
          await page.goto(SHIPD_AUTH_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        }
        ctx.ui.notify("A Shipd browser window is open. Sign in there, then return here.", "info");
        const confirmed = await ctx.ui.confirm(
          "Shipd sign-in",
          "After you finish signing in in the browser, press OK to save the session.",
        );
        if (!confirmed) {
          ctx.ui.notify("Shipd sign-in cancelled; nothing was saved.", "info");
          return;
        }

        // Save immediately after the user's confirmation so the state is not lost if the
        // post-login page uses a different tab or UI shape than expected.
        await context.storageState({ path: storageStatePath });
        const authenticatedPage = await findAuthenticatedShipdPage(context);
        if (!authenticatedPage) {
          ctx.ui.notify(
            `Shipd state was saved to ${storageStatePath}, but the signed-in page could not be verified. Try quality-check; if it reports an authentication error, run /shipd:auth again and wait for Shipd to return before confirming.`,
            "warning",
          );
        } else {
          await context.storageState({ path: storageStatePath });
          ctx.ui.notify(`Shipd authentication saved to ${storageStatePath}. quality-check is ready to use.`, "info");
        }
      } catch (error) {
        ctx.ui.notify(
          `Shipd authentication failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        await browser?.close().catch(() => undefined);
        if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill();
        if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
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
    name: QUALITY_CHECK_TOOL_NAME,
    label: "Quality Checks",
    description:
      "Run the staged Shipd quality checks for the current project. Return compact pass results and concise, actionable failure feedback. Does not submit the challenge.",
    promptSnippet: "Submit the working-directory patches to Shipd",
    promptGuidelines: [
      "Use only when the user asks to evaluate the current Shipd task.",
      "Run the staged prompt, patch-precheck, test, and solution checks; cache only passing prompt hashes in this session.",
      "Return compact pass verdicts and concise, scenario-specific failure feedback. Never submit the challenge.",
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
      if (context.isError) {
        return new Text(`${header}\n  ${theme.fg("error", compactToolError(result))}`, 0, 0);
      }
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
        throw new Error(`Shipd authentication state not found at ${storageStatePath}. Run /shipd:auth first.`);
      }
      const executablePath = findChrome();
      if (!executablePath) throw new Error("Could not find Chrome/Chromium. Set SHIPD_CHROME_PATH and retry.");

      let browser: Browser | undefined;
      let page: Page | undefined;
      let precheckDir: string | undefined;
      const closeOnAbort = () => {
        void browser?.close().catch(() => undefined);
      };
      signal?.addEventListener("abort", closeOnAbort, { once: true });

      try {
        checkCancelled(signal);
        onUpdate?.({ content: [{ type: "text", text: "Running create_patches.sh..." }], details: undefined });
        const files = await readSubmissionFiles(pi, ctx.cwd, signal);
        checkCancelled(signal);
        const promptSha = createHash("sha256").update(files.taskPrompt, "utf8").digest("hex");
        const promptQualityCached = promptQualitySha === promptSha;

        let precheck: PatchPrecheckResult | null = null;
        const runQualityStage = async (qualities: readonly QualityName[]): Promise<void> => {
          const stagePage = page;
          if (!browser || !stagePage) throw new Error("Shipd quality page was unavailable.");
          onUpdate?.({
            content: [{ type: "text", text: `Checking ${qualities.map(displayQualityName).join(" and ")} status...` }],
            details: undefined,
          });
          const initialStatuses = await readQualityStatusesWithRetry(stagePage, signal, qualities);
          const isPromptQualityStage = qualities.includes("Task Prompt Quality");
          const initialWaitMs = isPromptQualityStage ? PROMPT_QUALITY_INITIAL_WAIT_MS : INITIAL_WAIT_MS;
          const recheckIntervalMs = isPromptQualityStage ? PROMPT_QUALITY_RECHECK_INTERVAL_MS : RECHECK_INTERVAL_MS;
          const qualitiesToMonitor = initialStatuses.filter((status) => status.busy).map((status) => status.quality);
          for (const quality of qualities) {
            const status = initialStatuses.find((item) => item.quality === quality);
            if (!status) throw new Error(`${quality}: quality status was not available after updating the draft.`);
            if (!status.busy && status.shouldRun) {
              const runResult = await clickAndConfirm(stagePage, quality, signal);
              if (runResult.status !== "no-longer-stale") qualitiesToMonitor.push(quality);
            }
          }

          if (qualitiesToMonitor.length === 0) {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `No ${qualities.map(displayQualityName).join(" or ")} checks need to run; using current reports.`,
                },
              ],
              details: undefined,
            });
            return;
          }

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Quality checks queued (${qualitiesToMonitor.map(displayQualityName).join(", ")}); closing the browser until the first check in ${formatDuration(initialWaitMs)}...`,
              },
            ],
            details: undefined,
          });
          const activeBrowser = browser;
          if (!activeBrowser) throw new Error("Shipd browser was unavailable while waiting for quality checks.");
          await activeBrowser.close();
          browser = undefined;
          page = undefined;

          let nextCheckAt = Date.now() + initialWaitMs;
          while (true) {
            const waitMs = nextCheckAt - Date.now();
            if (waitMs > 0) {
              onUpdate?.({
                content: [{ type: "text", text: `Browser closed; next quality check in ${formatDuration(waitMs)}...` }],
                details: undefined,
              });
              await sleep(waitMs, signal);
            }
            checkCancelled(signal);

            onUpdate?.({
              content: [{ type: "text", text: "Reopening Shipd to check quality job status..." }],
              details: undefined,
            });
            const reopened = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
            browser = reopened.browser;
            page = reopened.page;
            const statusPage = page;
            if (!statusPage) throw new Error("Shipd quality status page was unavailable after reopening.");
            let statuses = await readQualityStatusesWithRetry(statusPage, signal, qualitiesToMonitor);
            for (const status of statuses) {
              if (!status.busy && status.shouldRun) await clickAndConfirm(statusPage, status.quality, signal);
            }
            statuses = await readQualityStatusesWithRetry(statusPage, signal, qualitiesToMonitor);
            if (statuses.every((status) => !status.busy && !status.shouldRun)) break;

            const statusText = statuses
              .map((status) => `${displayQualityName(status.quality)}: ${status.rowText}`)
              .join("; ");
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Quality jobs still running (${statusText}); closing browser until the next check...`,
                },
              ],
              details: undefined,
            });
            const pollingBrowser = browser;
            if (!pollingBrowser) throw new Error("Shipd browser was unavailable while polling quality checks.");
            await pollingBrowser.close();
            browser = undefined;
            page = undefined;
            nextCheckAt = Date.now() + recheckIntervalMs;
          }
        };

        let promptQuality: JsonRecord;
        if (promptQualityCached) {
          promptQuality = { verdict: "PASS", cached: true };
          onUpdate?.({
            content: [
              { type: "text", text: "Prompt Quality already passed for this prompt in this session; skipping it." },
            ],
            details: undefined,
          });
        } else {
          onUpdate?.({
            content: [{ type: "text", text: "Opening Shipd to prepare Prompt Quality..." }],
            details: undefined,
          });
          const initial = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
          browser = initial.browser;
          page = initial.page;
          await fillChallengeFields(page, files, signal);
          await runQualityStage(["Task Prompt Quality"]);

          if (!page) throw new Error("Shipd page was closed before Prompt Quality report extraction.");
          onUpdate?.({ content: [{ type: "text", text: "Extracting Prompt Quality report..." }], details: undefined });
          const promptReport = (await hasQualityReport(page, "Task Prompt Quality"))
            ? (await extractQualityReportWithRetry(page, "Task Prompt Quality", signal)).parsed
            : undefined;
          promptQuality = buildPromptQualityResult(promptReport);
          if (promptQuality.verdict !== "PASS") {
            const result = { promptQuality };
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              details: result,
            };
          }

          promptQualitySha = promptSha;
          pi.appendEntry(SHIPD_PROMPT_QUALITY_SHA_ENTRY, { sha256: promptSha });
          await browser?.close().catch(() => undefined);
          browser = undefined;
          page = undefined;
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: promptQualityCached
                ? "Prompt Quality passed from this session's SHA cache; running Fargate patch prechecks..."
                : "Prompt Quality passed; running Fargate patch prechecks...",
            },
          ],
          details: undefined,
        });
        precheckDir = await mkdtemp(join(tmpdir(), "shipd-patch-precheck-"));
        const snapshot = await snapshotGitHead(pi, ctx.cwd, precheckDir, signal);
        if (snapshot.status === "error")
          throw new Error(`Fargate patch precheck snapshot failed on linux: ${snapshot.error}`);
        await Promise.all([
          writeFile(join(precheckDir, "test.patch"), files.testPatch, "utf8"),
          writeFile(join(precheckDir, "solution.patch"), files.solutionPatch, "utf8"),
        ]);
        precheck = await runFargatePatchPrecheck({
          pi,
          repoDir: ctx.cwd,
          snapshotDir: precheckDir,
          config: {
            provider: "patch-precheck",
            modelId: "patch-precheck",
            thinkingLevel: "off",
            fargate: loadFargateConfig(),
          },
          cancelSignal: signal ?? new AbortController().signal,
          runId: `quality-precheck-${randomUUID()}`,
          precheckTimeoutMinutes: PATCH_PRECHECK_TIMEOUT_MINUTES,
          onPhase: (phase) =>
            onUpdate?.({
              content: [{ type: "text", text: `Patch precheck: ${phase}...` }],
              details: undefined,
            }),
        });
        if (!precheck.passed) throw new Error(patchPrecheckError(precheck));
        await rm(precheckDir, { recursive: true, force: true });
        precheckDir = undefined;

        onUpdate?.({
          content: [
            { type: "text", text: "Fargate patch prechecks passed; opening Shipd for Test and Solution Quality..." },
          ],
          details: undefined,
        });
        const finalPage = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
        browser = finalPage.browser;
        page = finalPage.page;
        if (promptQualityCached) await fillChallengeFields(page, files, signal);
        await runQualityStage(["Test Quality", "Solution Quality"]);

        if (!page) throw new Error("Shipd quality status page was closed before report extraction.");
        onUpdate?.({
          content: [{ type: "text", text: "Extracting Test and Solution Quality reports..." }],
          details: undefined,
        });
        const testReport = (await hasQualityReport(page, "Test Quality"))
          ? (await extractQualityReportWithRetry(page, "Test Quality", signal)).parsed
          : undefined;
        const solutionReport = (await hasQualityReport(page, "Solution Quality"))
          ? (await extractQualityReportWithRetry(page, "Solution Quality", signal)).parsed
          : undefined;
        const result = buildAgentResult(testReport, promptQuality, solutionReport);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("Cancelled by user.");
        throw error;
      } finally {
        signal?.removeEventListener("abort", closeOnAbort);
        await browser?.close().catch(() => undefined);
        if (precheckDir) await rm(precheckDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}
