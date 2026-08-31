/** Shipd submission tool: build patches, fill a challenge draft, run quality checks, and return focused results. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { getShellExecutable, loadFargateConfig, persistFargateResourceUsage } from "./config.js";
import { runFargatePatchPrecheck } from "./fargate-runner.js";
import { snapshotGitHead } from "./git.js";
import { formatDuration } from "./report.js";
import type { FargateResourceUsage, PatchPrecheckResult } from "./types.js";

export const QUALITY_CHECK_TOOL_NAME = "quality-check";
export const SHIPD_JOB_LINK_COMMAND = "shipd:link";
export const SHIPD_JOB_LINK_ENTRY = "shipd_job_link";

const DEFAULT_STORAGE_STATE_PATH = join(homedir(), ".pi", "agent", "shipd-auth", "shipd.ai.json");
const PATCH_PRECHECK_TIMEOUT_MINUTES = 10;
const SHIPD_AUTH_URL = "https://shipd.ai/";
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 1_800_000;
const PATCH_SCRIPT_TIMEOUT_MS = 120_000;
const INITIAL_WAIT_MS = 300_000;
const RECHECK_INTERVAL_MS = 90_000;
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
  await qualityRow(page, "Test Quality").hover();
  await sleep(1_000, signal);
}

async function clickAndConfirm(page: Page, quality: QualityName, signal?: AbortSignal): Promise<JsonRecord> {
  checkCancelled(signal);
  const row = qualityRow(page, quality);
  const initialText = clean(await row.innerText());
  if (isBusy(initialText)) return { quality, status: "already-running", rowTextAfterConfirm: initialText };

  const rerun = row.locator('button[title^="Re-run"]').or(row.locator('button[title^="Run"]'));
  const count = await rerun.count();
  if (count !== 1) throw new Error(`${quality}: expected one Run button, found ${count}`);
  if (!(await rerun.isEnabled())) throw new Error(`${quality}: Run button is disabled.`);
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

function buildAgentResult(
  testReport: QualityReport | undefined,
  solutionReport: QualityReport | undefined,
): JsonRecord {
  const coverageSuggestions = Array.isArray(testReport?.coverageSuggestions) ? testReport.coverageSuggestions : [];
  const unfairTests = Array.isArray(testReport?.tests)
    ? testReport.tests.filter((item): item is JsonRecord => isRecord(item) && item.fairness === "Not fair")
    : [];
  return {
    testQuality: {
      verdict: testReport?.verdict ?? null,
      completed: testReport?.completed ?? false,
      skipped: !testReport,
      coverageSuggestions,
      tests: unfairTests,
    },
    solutionQuality: {
      verdict: solutionReport?.verdict ?? null,
      completed: solutionReport?.completed ?? false,
      skipped: !solutionReport,
      evaluation: solutionReport?.evaluation ?? null,
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
  const testSummary =
    testQuality.skipped === true ? "skipped" : `${unfairCount} unfair · ${suggestionCount} suggestions`;
  const solutionSummary =
    solutionQuality.skipped === true
      ? "skipped"
      : `quality ${scoreText(evaluation, "code_quality")} · comprehensiveness ${scoreText(evaluation, "solution_comprehensiveness")}`;
  return [
    `  ${theme.fg("accent", "Test Quality")}  ${theme.fg("muted", testSummary)}`,
    `  ${theme.fg("accent", "Solution Quality")}  ${theme.fg("muted", solutionSummary)}`,
  ];
}

function compactToolError(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = (result.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(" ");
  return clean(text).slice(0, 300) || "Quality checks failed";
}

function patchPrecheckError(result: PatchPrecheckResult): string {
  const prefix = `Fargate patch precheck failed:\nplatform: ${result.platform}`;
  if (result.error) return `${prefix}\n${result.error}`;
  const failed = result.phases.find((phase) => !phase.passed);
  return `${prefix}${failed ? `\nphase: ${failed.phase}` : ""}.`;
}

export function registerSubmitShipdTool(pi: ExtensionAPI): void {
  let jobLink: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    jobLink = readSavedJobLink(ctx.sessionManager.getBranch());
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
      "Run create_patches.sh in the current working directory, read agent_prompt.md, test.patch, and solution.patch, " +
      "run the Fargate patch precheck, then fill the Shipd challenge draft fields, run fresh checks with a Run button, " +
      "rerun checks marked Stale, and skip current checks. Start Test Quality then Solution Quality in one browser tab. " +
      "Wait for any started jobs and return agent-focused JSON. details.testQuality contains coverageSuggestions and only tests whose " +
      'fairness is exactly "Not fair"; details.solutionQuality contains the complete evaluation block. This consumes Shipd ' +
      "tokens and does not click the final challenge-submit button.",
    promptSnippet: "Submit the working-directory patches to Shipd",
    promptGuidelines: [
      "Use quality-check when the user explicitly asks to submit or evaluate the current Shipd task.",
      "quality-check has no parameters.",
      "quality-check first runs the Fargate patch precheck; only after all four test phases meet their expectations does it upload the draft to Shipd. It runs fresh checks with a Run button, reruns checks marked Stale after the draft update, skips current checks, then waits using scheduled browser reopen checks.",
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

      const configuredTimeout = Number.parseInt(process.env.SHIPD_SUBMIT_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(30_000, Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS),
      );
      const deadline = Date.now() + timeoutMs;
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

        onUpdate?.({
          content: [{ type: "text", text: "Running Fargate patch prechecks before opening Shipd..." }],
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
        let precheckResourceUsage: FargateResourceUsage | undefined;
        const precheck = await runFargatePatchPrecheck({
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
          onResourceUsage: (usage) => {
            precheckResourceUsage = usage;
          },
          onPhase: (phase) =>
            onUpdate?.({
              content: [{ type: "text", text: `Fargate patch precheck: ${phase}...` }],
              details: undefined,
            }),
        });
        if (precheckResourceUsage) persistFargateResourceUsage(ctx.cwd, precheckResourceUsage);
        if (!precheck.passed) throw new Error(patchPrecheckError(precheck));
        await rm(precheckDir, { recursive: true, force: true });
        precheckDir = undefined;
        onUpdate?.({
          content: [
            { type: "text", text: "Fargate patch prechecks passed; opening Shipd and filling draft fields..." },
          ],
          details: undefined,
        });
        checkCancelled(signal);
        const initial = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
        browser = initial.browser;
        page = initial.page;
        await fillChallengeFields(page, files, signal);

        onUpdate?.({
          content: [{ type: "text", text: "Checking which quality checks are stale..." }],
          details: undefined,
        });
        const initialStatuses = await readQualityStatuses(page, signal);
        const qualitiesToMonitor = initialStatuses
          .filter((status) => status.busy || status.shouldRun)
          .map((status) => status.quality);
        const started: JsonRecord[] = [];
        for (const quality of QUALITY_NAMES) {
          const status = initialStatuses.find((item) => item.quality === quality);
          if (!status) throw new Error(`${quality}: quality status was not available after updating the draft.`);
          if (status.shouldRun) {
            started.push(await clickAndConfirm(page, quality, signal));
          } else if (status.busy) {
            started.push({ quality, status: "already-running", rowTextAfterConfirm: status.rowText });
          }
        }

        let completed = initialStatuses.map(({ quality, rowText }) => ({ quality, rowText }));
        if (qualitiesToMonitor.length > 0) {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Quality checks queued (${qualitiesToMonitor.join(", ")}); closing the browser until the first check in 5 minutes...`,
              },
            ],
            details: undefined,
          });
          await browser.close();
          browser = undefined;
          page = undefined;

          let nextCheckAt = Date.now() + INITIAL_WAIT_MS;
          while (true) {
            const waitMs = Math.min(nextCheckAt, deadline) - Date.now();
            if (waitMs > 0) {
              onUpdate?.({
                content: [{ type: "text", text: `Browser closed; next quality check in ${formatDuration(waitMs)}...` }],
                details: undefined,
              });
              await sleep(waitMs, signal);
            }
            checkCancelled(signal);
            if (Date.now() >= deadline) {
              throw new Error(`Shipd quality checks timed out after ${formatDuration(timeoutMs)}.`);
            }

            onUpdate?.({
              content: [{ type: "text", text: "Reopening Shipd to check quality job status..." }],
              details: undefined,
            });
            const reopened = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
            browser = reopened.browser;
            page = reopened.page;
            const statuses = await readQualityStatuses(page, signal, qualitiesToMonitor);
            if (statuses.every((status) => !status.busy)) {
              completed = [
                ...initialStatuses
                  .filter((status) => !qualitiesToMonitor.includes(status.quality))
                  .map(({ quality, rowText }) => ({ quality, rowText })),
                ...statuses.map(({ quality, rowText }) => ({ quality, rowText })),
              ];
              break;
            }

            const statusText = statuses.map((status) => `${status.quality}: ${status.rowText}`).join("; ");
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Quality jobs still running (${statusText}); closing browser until the next check...`,
                },
              ],
              details: undefined,
            });
            await browser.close();
            browser = undefined;
            page = undefined;
            nextCheckAt += RECHECK_INTERVAL_MS;
          }
        } else {
          onUpdate?.({
            content: [{ type: "text", text: "No quality checks need to run; using the current reports." }],
            details: undefined,
          });
        }

        if (!page) throw new Error("Shipd quality status page was closed before report extraction.");
        onUpdate?.({ content: [{ type: "text", text: "Extracting quality reports..." }], details: undefined });
        const reports: ExtractedReport[] = [];
        const skipped: QualityName[] = [];
        for (const quality of QUALITY_NAMES) {
          if (!(await hasQualityReport(page, quality))) {
            skipped.push(quality);
            continue;
          }
          reports.push(await extractQualityReport(page, quality, signal));
        }
        const testReport = reports.find((report) => report.quality === "Test Quality")?.parsed;
        const solutionReport = reports.find((report) => report.quality === "Solution Quality")?.parsed;
        const result = buildAgentResult(testReport, solutionReport);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { ...result, started, completed, skipped, precheck },
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
