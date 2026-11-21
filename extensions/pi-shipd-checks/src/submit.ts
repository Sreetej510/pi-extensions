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
import { loadFargateConfig } from "./config.js";
import { runFargatePatchPrecheck } from "./fargate-runner.js";
import { runCreatePatches, snapshotGitHead } from "./git.js";
import { formatDuration } from "./report.js";
import type { PatchPrecheckResult } from "./types.js";

export const QUALITY_CHECK_TOOL_NAME = "quality-check";
export const SHIPD_JOB_LINK_COMMAND = "shipd:link";
export const SHIPD_JOB_LINK_ENTRY = "shipd_job_link";
export const SHIPD_PROMPT_QUALITY_SHA_ENTRY = "shipd_prompt_quality_sha";

const DEFAULT_STORAGE_STATE_PATH = join(homedir(), ".pi", "agent", "shipd-auth", "shipd.ai.json");
const PATCH_PRECHECK_TIMEOUT_MINUTES = 15;
const SHIPD_AUTH_URL = "https://shipd.ai/";
const RECHECK_INTERVAL_MS = 90_000;
const PROMPT_QUALITY_RECHECK_INTERVAL_MS = 30_000;
const UI_TIMEOUT_MS = 5_000;
const REPORT_PREVIEW_TIMEOUT_MS = 20_000;
const PAGE_READY_TIMEOUT_MS = 90_000;
const NETWORK_IDLE_TIMEOUT_MS = 15_000;
const DRAFT_SAVE_QUIET_MS = 3_000;
const DRAFT_SAVE_TIMEOUT_MS = 120_000;
const DRAFT_SYNC_ATTEMPTS = 3;
const CHALLENGE_FORM_TIMEOUT_MS = 30_000;
const CHALLENGE_FORM_POLL_INTERVAL_MS = 200;
const QUALITY_UI_RETRY_ATTEMPTS = 3;
const QUALITY_UI_RETRY_DELAY_MS = 250;
/** Verify checks build a Docker image first, so Shipd can take a while to show a started run. */
const QUALITY_RUN_START_TIMEOUT_MS = 30_000;
const QUALITY_ACTION_READY_TIMEOUT_MS = 30_000;
/** Shipd's Step 1 checks; each must have passed at least once before Step 2 (Solution Quality, Reward Hacking) unlocks. */
const STEP_ONE_CHECKS = ["Verify Tests", "Verify Solution", "Verify Flakiness", "Task Prompt Quality"] as const;
const QUALITY_NAMES = [...STEP_ONE_CHECKS, "Solution Quality", "Reward Hacking", "Test Quality"] as const;
/** After a stage runs, give Shipd time to start or unlock the next step before reading its status. */
const STAGE_SETTLE_MS = 15_000;
/** How long a check may stay locked behind its upstream step once that step has passed. */
const LOCKED_CHECK_TIMEOUT_MS = 120_000;
const LOCKED_CHECK_POLL_INTERVAL_MS = 5_000;
const PROMPT_PRESERVATION_NOTE =
  "Keep agent_prompt.md unchanged if possible—small edits can make it fail. Prefer aligning tests and solution to the prompt; only if the prompt is demonstrably wrong, make the smallest correction while preserving its human style.";

type QualityName = (typeof QUALITY_NAMES)[number];

/** How long to leave the browser closed before the first status check. */
const INITIAL_WAIT_MS: Record<QualityName, number> = {
  "Task Prompt Quality": 90_000,
  "Verify Tests": 10 * 60_000,
  "Verify Solution": 10 * 60_000,
  "Verify Flakiness": 10 * 60_000,
  "Reward Hacking": 10 * 60_000,
  "Solution Quality": 12 * 60_000,
  "Test Quality": 12 * 60_000,
};
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

function isBusy(rowText: string): boolean {
  // "Waiting for Verify Solution" marks a check Shipd has queued behind its upstream step.
  return /(?:starting|queued|pending|waiting|running|processing|reviewing|finalizing|building|evaluating|checking|\d+\s*%)/i.test(
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
  await runCreatePatches(pi, cwd, signal);

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
  await waitForChallengePage(page, signal);
}

async function qualityRowLoaded(page: Page, quality: QualityName): Promise<boolean> {
  const label = qualityLabel(page, quality);
  if ((await label.count()) !== 1 || !(await label.isVisible())) return false;
  const row = qualityRow(page, quality);
  // Locked rows (for example Test Quality before Solution Quality passes) show a disabled button
  // whose title explains the lock instead of Run/Re-run.
  if ((await row.locator("button").count()) > 0) return true;
  return isBusy(clean(await row.innerText()));
}

/**
 * Wait for the challenge form and every quality row's status to load. A row rendered before its
 * Convex status arrives has no Run/Re-run button, which would otherwise read as a current report.
 */
async function waitForChallengePage(page: Page, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  while (true) {
    checkCancelled(signal);
    const descriptionVisible = await page
      .locator("#problem-description")
      .isVisible()
      .catch(() => false);
    const pending: QualityName[] = [];
    for (const quality of QUALITY_NAMES) {
      if (!(await qualityRowLoaded(page, quality).catch(() => false))) pending.push(quality);
    }
    if (descriptionVisible && pending.length === 0) break;
    if (Date.now() >= deadline) {
      const missing = [...(descriptionVisible ? [] : ["Task Prompt field"]), ...pending.map(displayQualityName)];
      throw new Error(
        `Shipd challenge page did not finish loading within ${formatDuration(PAGE_READY_TIMEOUT_MS)} (waiting for ${missing.join(", ")}).`,
      );
    }
    await sleep(CHALLENGE_FORM_POLL_INTERVAL_MS, signal);
  }
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
  checkCancelled(signal);
}

interface ConvexMutationTracker {
  pending: Set<number>;
  lastActivityAt: number;
}

const convexMutationTrackers = new WeakMap<Page, ConvexMutationTracker>();

/** Track Shipd's Convex sync socket so draft saves can be awaited until the server acknowledges them. */
function trackConvexMutations(page: Page): void {
  const tracker: ConvexMutationTracker = { pending: new Set(), lastActivityAt: 0 };
  convexMutationTrackers.set(page, tracker);
  page.on("websocket", (socket) => {
    if (!socket.url().includes(".convex.cloud/")) return;
    const record =
      (direction: "sent" | "received") =>
      ({ payload }: { payload: string | Buffer }) => {
        let message: unknown;
        try {
          message = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (!isRecord(message) || typeof message.requestId !== "number") return;
        if (direction === "sent" && message.type === "Mutation") tracker.pending.add(message.requestId);
        else if (direction === "received" && message.type === "MutationResponse")
          tracker.pending.delete(message.requestId);
        else return;
        tracker.lastActivityAt = Date.now();
      };
    socket.on("framesent", record("sent"));
    socket.on("framereceived", record("received"));
  });
}

async function readSaveIndicators(page: Page): Promise<string[]> {
  const texts = await page
    .locator("span")
    .filter({ hasText: /^\s*(?:saved|saving|unsaved)\b/i })
    .allInnerTexts()
    .catch(() => []);
  return texts.map((text) => clean(text)).filter((text) => text.length <= 40);
}

/** Wait until Shipd has acknowledged every draft mutation and its header indicator reads "Saved". */
async function waitForDraftSaved(page: Page, signal?: AbortSignal): Promise<void> {
  const tracker = convexMutationTrackers.get(page);
  const startedAt = Date.now();
  await sleep(DRAFT_SAVE_QUIET_MS, signal);
  while (true) {
    checkCancelled(signal);
    const indicators = await readSaveIndicators(page);
    const pendingCount = tracker?.pending.size ?? 0;
    const quiet = pendingCount === 0 && Date.now() - (tracker?.lastActivityAt ?? 0) >= DRAFT_SAVE_QUIET_MS;
    if (quiet && indicators.every((text) => /^saved$/i.test(text))) return;
    if (Date.now() - startedAt >= DRAFT_SAVE_TIMEOUT_MS) {
      throw new Error(
        `Shipd draft did not finish saving within ${formatDuration(DRAFT_SAVE_TIMEOUT_MS)} (${pendingCount} unacknowledged save${pendingCount === 1 ? "" : "s"}; indicator: ${indicators.join(", ") || "none"}).`,
      );
    }
    await sleep(CHALLENGE_FORM_POLL_INTERVAL_MS, signal);
  }
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
    trackConvexMutations(page);
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

interface DraftField {
  key: keyof SubmissionFiles;
  name: string;
  root: string;
}

const DRAFT_FIELDS: readonly DraftField[] = [
  { key: "taskPrompt", name: "Task Prompt", root: "#problem-description" },
  { key: "testPatch", name: "Test Patch", root: "#problem-test-patch" },
  { key: "solutionPatch", name: "Solution Patch", root: "#problem-solution-patch" },
];

interface CodeMirrorViewLike {
  state?: { doc?: { toString(): string } };
}

function draftEditor(page: Page, field: DraftField): Locator {
  return field.key === "taskPrompt"
    ? page.locator(field.root)
    : page.locator(`${field.root} [contenteditable="true"], ${field.root} textarea`);
}

function normalizeDraftText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Read a field's full value. CodeMirror renders only visible lines, so read its document instead of the DOM text. */
async function readDraftField(page: Page, field: DraftField): Promise<string | undefined> {
  const value = await page
    .locator(field.root)
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
      const textarea = element.querySelector("textarea");
      if (textarea) return textarea.value;
      const content = element.querySelector(".cm-content") as
        | (Element & { cmView?: { rootView?: { view?: CodeMirrorViewLike } }; cmTile?: { view?: CodeMirrorViewLike } })
        | null;
      const text = (content?.cmView?.rootView?.view ?? content?.cmTile?.view)?.state?.doc?.toString();
      return typeof text === "string" ? text : null;
    })
    .catch(() => null);
  return value ?? undefined;
}

/** Fields whose draft value differs from the local files; unreadable fields count only when requested. */
async function changedDraftFields(
  page: Page,
  files: SubmissionFiles,
  includeUnreadable: boolean,
): Promise<DraftField[]> {
  const changed: DraftField[] = [];
  for (const field of DRAFT_FIELDS) {
    const current = await readDraftField(page, field);
    const differs =
      current === undefined ? includeUnreadable : normalizeDraftText(current) !== normalizeDraftText(files[field.key]);
    if (differs) changed.push(field);
  }
  return changed;
}

/**
 * Make the Shipd draft match the local files before any quality status is read. Only changed fields
 * are filled; each save is awaited, then the page is reloaded to confirm the server kept the content.
 */
async function syncChallengeDraft(
  page: Page,
  files: SubmissionFiles,
  targetUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  await waitForChallengeFields(page, signal);
  let changed = await changedDraftFields(page, files, true);
  for (let attempt = 1; changed.length > 0; attempt += 1) {
    if (attempt > DRAFT_SYNC_ATTEMPTS) {
      throw new Error(
        `Shipd did not keep the uploaded ${changed.map((field) => field.name).join(", ")} after ${DRAFT_SYNC_ATTEMPTS} save attempts.`,
      );
    }
    for (const field of changed) {
      const editor = draftEditor(page, field);
      if (field.key === "taskPrompt") await editor.fill(files[field.key]);
      else await fillCodeEditor(page, editor, files[field.key]);
      await editor.evaluate((element) => (element as HTMLElement).blur());
    }
    await waitForDraftSaved(page, signal);
    await navigateAuthenticated(page, targetUrl, signal);
    await waitForChallengeFields(page, signal);
    changed = await changedDraftFields(page, files, false);
  }
}

/** CodeMirror editors mount asynchronously after the challenge page hydrates. */
async function waitForChallengeFields(page: Page, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const fields = DRAFT_FIELDS.map((field) => draftEditor(page, field));
  const fieldNames = DRAFT_FIELDS.map((field) => field.name);
  const deadline = Date.now() + CHALLENGE_FORM_TIMEOUT_MS;
  let counts = await Promise.all(fields.map((field) => field.count()));
  while (
    counts.some((count) => count !== 1) ||
    !(await Promise.all(fields.map((field) => field.isVisible().catch(() => false)))).every(Boolean)
  ) {
    checkCancelled(signal);
    if (Date.now() >= deadline) {
      const diagnostics = counts.map((count, index) => `${fieldNames[index]}: ${count}`).join(", ");
      throw new Error(`Shipd challenge form fields did not become visible exactly once (${diagnostics}).`);
    }
    await sleep(CHALLENGE_FORM_POLL_INTERVAL_MS, signal);
    counts = await Promise.all(fields.map((field) => field.count()));
  }
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
    let confirmed = false;
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
      // Shipd keeps the Run/Re-run title while disabling the button during job
      // startup. Give its status update time to arrive instead of failing (or
      // clicking again) after three near-instant disabled-button retries.
      const actionReadyDeadline = Date.now() + QUALITY_ACTION_READY_TIMEOUT_MS;
      while (!(await action.isEnabled())) {
        checkCancelled(signal);
        const startedRowText = await qualityRunStartedRowText(page, quality, staleBefore, runButtonBefore);
        if (startedRowText !== undefined) {
          return {
            quality: displayQualityName(quality),
            status: "already-running",
            rowTextAfterConfirm: startedRowText,
          };
        }
        if (Date.now() >= actionReadyDeadline) {
          const title = await action.getAttribute("title");
          throw new Error(`${quality}: Run button remained disabled for 30 seconds${title ? ` (${title})` : ""}.`);
        }
        await sleep(200, signal);
      }
      // The button may become enabled in the same update that exposes the
      // running state. Check again before spending tokens on another run.
      const startedBeforeClick = await qualityRunStartedRowText(page, quality, staleBefore, runButtonBefore);
      if (startedBeforeClick !== undefined) {
        return {
          quality: displayQualityName(quality),
          status: "already-running",
          rowTextAfterConfirm: startedBeforeClick,
        };
      }
      rerunTitle = await action.getAttribute("title");

      await action.click({ timeout: UI_TIMEOUT_MS });
      const dialog = page.getByRole("dialog").last();
      await dialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      confirmation = clean(await dialog.innerText());
      const confirm = dialog.getByRole("button", { name: /confirm/i });
      if ((await confirm.count()) !== 1) throw new Error(`${quality}: rerun confirmation button was not found.`);
      await confirm.click({ timeout: UI_TIMEOUT_MS });
      confirmed = true;

      const startedRowText = await waitForQualityRunStart(page, quality, staleBefore, runButtonBefore, signal);
      return {
        quality: displayQualityName(quality),
        status: startedRowText === undefined ? "unconfirmed" : "started",
        rerunTitle,
        confirmation,
        rowTextAfterConfirm: startedRowText ?? clean(await qualityRow(page, quality).innerText()),
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      lastFailure = error instanceof Error ? error.message : String(error);
      // Once Shipd accepted the confirmation the run is queued (and paid for); clicking again could
      // start a second run. Leave it to the status polling, which re-runs only a check still idle.
      if (confirmed) return { quality: displayQualityName(quality), status: "unconfirmed", rerunTitle, confirmation };
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
  /** A completed report exists (the row offers Re-run rather than Run). */
  hasReport: boolean;
  /** Set while an upstream step blocks the check; its disabled button's title says why. */
  lockReason?: string;
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
    const hasReport = (await row.locator('button[title^="Re-run"]').count()) > 0;
    const lockButton = row.locator('button[disabled]:not([title^="Run"]):not([title^="Re-run"])').first();
    const lockReason =
      !hasRunButton && !hasReport && (await lockButton.count()) > 0
        ? clean((await lockButton.getAttribute("title")) ?? "") || "Locked until an earlier step passes."
        : undefined;
    statuses.push({
      quality,
      rowText,
      busy: isBusy(rowText),
      shouldRun: hasRunButton || isStale(rowText),
      hasReport,
      ...(lockReason ? { lockReason } : {}),
    });
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
  // The report preview is portal-rendered; locate its accessible control rather than
  // depending on the preview's Tailwind positioning class (for example, `div.fixed`).
  const expanders = page.locator(
    'button[title="Expand to full view"]:visible, button[aria-label="Expand to full view"]:visible',
  );
  // Move off the row and let any open preview close (about 200 ms) before hovering. Hovering the
  // point the pointer already rests on fires no new mouseenter, and a lingering preview belongs
  // to the previously hovered row.
  await page.mouse.move(0, 0);
  await expanders.first().waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
  await qualityRow(page, quality).hover();
  await expanders.first().waitFor({ state: "visible", timeout: REPORT_PREVIEW_TIMEOUT_MS });
  const count = await expanders.count();
  if (count !== 1) throw new Error(`${quality}: expected one visible quality expander, found ${count}`);
  const expander = expanders.first();
  const previewText = clean(await expander.locator("xpath=..").innerText());
  if (!previewText.includes(quality)) {
    throw new Error(`${quality}: the visible report preview did not match the hovered row.`);
  }
  return expander;
}

async function openQualityReport(page: Page, quality: QualityName, signal?: AbortSignal): Promise<Locator> {
  checkCancelled(signal);
  const expander = await getQualityExpander(page, quality);
  await expander.click();

  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible", timeout: REPORT_PREVIEW_TIMEOUT_MS });
  const heading = clean(
    await dialog
      .locator("h2")
      .first()
      .innerText()
      .catch(() => ""),
  );
  // The title may carry a status badge after the name, for example "Test Quality Stale".
  if (heading !== quality && !heading.startsWith(`${quality} `)) {
    throw new Error(`${quality}: expanded the wrong report dialog (${heading || "unknown"}).`);
  }
  return dialog;
}

/** Prompt Quality still shows its result as raw JSON. */
async function readJsonReport(page: Page, quality: QualityName, signal?: AbortSignal): Promise<QualityReport> {
  const dialog = await openQualityReport(page, quality, signal);
  const code = dialog.locator("pre code").last();
  if (!(await code.isVisible().catch(() => false))) {
    const rawButton = dialog
      .locator("button")
      .filter({ hasText: /raw output/i })
      .first();
    try {
      await rawButton.waitFor({ state: "visible", timeout: REPORT_PREVIEW_TIMEOUT_MS });
    } catch {
      const dialogText = clean(await dialog.innerText());
      throw new Error(`${quality}: raw output control did not appear; dialog text: ${dialogText.slice(0, 1_000)}`);
    }
    await rawButton.click();
  }

  await code.waitFor({ state: "visible", timeout: REPORT_PREVIEW_TIMEOUT_MS });
  const rawOutput = await code.innerText();
  const parsed = parseJson(rawOutput, quality);
  await page.keyboard.press("Escape").catch(() => undefined);
  return parsed;
}

interface FeedbackItem {
  category?: string;
  location?: string;
  finding?: string;
  details?: string;
  why?: string;
  suggestedChange?: string;
  [label: string]: string | undefined;
}

interface FeedbackReport {
  verdict?: string;
  /** The feedback SUMMARY line, or for checks without feedback (Verify Solution) the text under the verdict. */
  summary?: string;
  blocking: FeedbackItem[];
  nonBlocking: FeedbackItem[];
}

interface RawFeedbackItem {
  header: Array<{ text: string; mono: boolean }>;
  paragraphs: Array<{ label: string; text: string }>;
}

function camelCaseLabel(label: string): string {
  const words = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`)).join("");
}

function toFeedbackItem(raw: RawFeedbackItem): FeedbackItem {
  const item: FeedbackItem = {};
  const tags = raw.header.filter((tag) => !/^\d+\.$/.test(tag.text));
  const location = tags.find((tag) => tag.mono)?.text;
  const category = tags.find((tag) => !tag.mono)?.text;
  if (category) item.category = category;
  if (location) item.location = location;
  const unlabeled = raw.paragraphs.filter((paragraph) => !paragraph.label).map((paragraph) => paragraph.text);
  if (unlabeled[0]) item.finding = unlabeled[0];
  if (unlabeled.length > 1) item.details = unlabeled.slice(1).join("\n\n");
  for (const paragraph of raw.paragraphs) {
    if (paragraph.label) item[camelCaseLabel(paragraph.label)] = paragraph.text;
  }
  return item;
}

/**
 * Read a check's verdict and "Feedback for the author" from its report dialog. Feedback groups are
 * headed "BLOCKING: N issues" or "<GROUP> (not blocking)"; each item has a header (its number, or a
 * category and a file location) followed by paragraphs, some labelled in bold ("Why:", "Suggested change:").
 */
async function readFeedbackReport(page: Page, quality: QualityName, signal?: AbortSignal): Promise<FeedbackReport> {
  const dialog = await openQualityReport(page, quality, signal);
  const raw = await dialog.evaluate((root) => {
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    // Keep inline code visible to the agent as `code`.
    const richText = (node: Node, skip?: Node): string =>
      [...node.childNodes]
        .filter((child) => child !== skip)
        .map((child) =>
          child.nodeType === Node.TEXT_NODE
            ? (child.textContent ?? "")
            : child.nodeName === "CODE"
              ? ` \`${child.textContent ?? ""}\` `
              : richText(child),
        )
        .join("");
    const text = (node: Element | null | undefined) => squash(node?.textContent ?? "");
    const verdictLabel = [...root.querySelectorAll("p")].find((p) => text(p).toLowerCase() === "verdict");
    const verdictBlock = verdictLabel?.parentElement;
    const verdict = text(verdictLabel?.nextElementSibling);
    const feedback = [...root.querySelectorAll("section")].find((section) =>
      /feedback for the author/i.test(text(section.querySelector("h3"))),
    );
    const summaryParagraph = feedback
      ? [...feedback.querySelectorAll("p")].find((p) => /^summary:?$/i.test(text(p.querySelector(":scope > strong"))))
      : undefined;
    const next = verdictBlock?.nextElementSibling;
    const description =
      !feedback && next?.tagName === "DIV" && !next.querySelector("pre, code, section") ? text(next) : "";
    const summary = summaryParagraph ? squash(text(summaryParagraph).replace(/^summary:\s*/i, "")) : description;
    const groups = feedback
      ? [...feedback.querySelectorAll("h4")].map((heading) => ({
          heading: text(heading),
          items: [...(heading.parentElement?.querySelectorAll(":scope > ol > li, :scope > ul > li") ?? [])].map(
            (li) => {
              const body = li.firstElementChild ?? li;
              const header = body.querySelector(":scope > div");
              return {
                header: [...(header?.querySelectorAll("span") ?? [])].map((span) => ({
                  text: text(span),
                  mono: span.className.includes("font-mono"),
                })),
                paragraphs: [...body.querySelectorAll(":scope > p")].map((p) => {
                  const strong = p.querySelector(":scope > strong");
                  return {
                    label: strong ? text(strong).replace(/:$/, "") : "",
                    text: squash(richText(p, strong ?? undefined)),
                  };
                }),
              };
            },
          ),
        }))
      : [];
    return { verdict, summary, groups };
  });
  await page.keyboard.press("Escape").catch(() => undefined);

  const report: FeedbackReport = { blocking: [], nonBlocking: [] };
  if (raw.verdict) report.verdict = raw.verdict.toUpperCase();
  if (raw.summary) report.summary = raw.summary;
  for (const group of raw.groups) {
    const blocking = /\bblocking\b/i.test(group.heading) && !/not blocking|non-blocking/i.test(group.heading);
    (blocking ? report.blocking : report.nonBlocking).push(...group.items.map(toFeedbackItem));
  }
  return report;
}

async function readReportWithRetry<T>(
  page: Page,
  quality: QualityName,
  read: (page: Page, quality: QualityName, signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastFailure = "The report dialog could not be opened.";
  for (let attempt = 1; attempt <= QUALITY_UI_RETRY_ATTEMPTS; attempt += 1) {
    checkCancelled(signal);
    try {
      return await read(page, quality, signal);
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
      "Prompt Quality flagged this prompt as AI. Rewrite the flagged parts of agent_prompt.md in plainer, more direct language, or make a small targeted manual change if the flag is due to a recent edit.",
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

/** Verify checks report a verdict and a one-line reason; their result is returned only when they fail. */
function buildVerifyCheckResult(quality: QualityName, report: FeedbackReport | undefined): JsonRecord {
  const name = displayQualityName(quality);
  if (!report?.verdict) return { verdict: "FAIL", reason: `No completed ${name} report was available.` };
  if (report.verdict === "PASS") return { verdict: "PASS" };
  return {
    verdict: "FAIL",
    reason: report.summary || `${name} failed; open its report on Shipd for the build and test logs.`,
  };
}

/** Checks that only have to have passed once (a stale pass is fine); a current failure stops the run for the user. */
const RUN_ONCE_CHECK_KEYS = {
  "Verify Tests": "verifyTests",
  "Verify Flakiness": "verifyFlakiness",
  "Reward Hacking": "rewardHacking",
} as const satisfies Partial<Record<QualityName, string>>;

type RunOnceCheck = keyof typeof RUN_ONCE_CHECK_KEYS;

function askUserAction(failed: string[]): string {
  return `Stop and ask the user how to proceed: ${failed.join(", ")} failed on the current draft. These checks must pass at least once; do not change the task or re-run them to fix this without the user's direction.`;
}

/**
 * Solution Quality, Reward Hacking and Test Quality fail only on blocking issues (as Shipd's verdict does).
 * Non-blocking issues are returned for the agent to consider but never fail the check.
 */
function buildFeedbackResult(quality: QualityName, report: FeedbackReport | undefined): JsonRecord {
  if (!report?.verdict) {
    return { verdict: "FAIL", reason: `No completed ${displayQualityName(quality)} report was available.` };
  }
  const passed = report.verdict === "PASS" && report.blocking.length === 0;
  return {
    verdict: passed ? "PASS" : "FAIL",
    ...(!passed && report.blocking.length === 0 && report.summary ? { reason: report.summary } : {}),
    ...(report.blocking.length > 0 ? { blocking: report.blocking } : {}),
    ...(report.nonBlocking.length > 0 ? { nonBlocking: report.nonBlocking } : {}),
  };
}

/** Each later check is present only if it ran: a failing gate stops the stages after it. */
function buildAgentResult(promptQuality: JsonRecord, checks: JsonRecord): JsonRecord {
  return {
    promptQuality,
    ...(promptQuality.verdict === "PASS" ? { note: PROMPT_PRESERVATION_NOTE } : {}),
    ...checks,
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

function feedbackSummary(check: JsonRecord): string {
  const blocking = Array.isArray(check.blocking) ? check.blocking.length : 0;
  const nonBlocking = Array.isArray(check.nonBlocking) ? check.nonBlocking.length : 0;
  const counts = [
    ...(blocking > 0 ? [`${blocking} blocking`] : []),
    ...(nonBlocking > 0 ? [`${nonBlocking} non-blocking`] : []),
  ];
  if (typeof check.reason === "string") counts.push(check.reason);
  return [String(check.verdict ?? "skipped"), ...counts].join(" · ");
}

function qualitySummaryText(details: unknown, theme: Theme): string[] {
  const value = isRecord(details) ? details : {};
  const promptQuality = isRecord(value.promptQuality) ? value.promptQuality : {};
  const promptComments = Array.isArray(promptQuality.comments) ? promptQuality.comments : [];
  const promptCommentCount = promptComments.length;
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
  const checks: Array<[string, string]> = [
    ["verifySolution", "Verify Solution"],
    ["verifyTests", "Verify Tests"],
    ["verifyFlakiness", "Verify Flakiness"],
    ["rewardHacking", "Reward Hacking"],
    ["solutionQuality", "Solution Quality"],
    ["testQuality", "Test Quality"],
  ];
  for (const [key, label] of checks) {
    const check = value[key];
    if (isRecord(check)) lines.push(`  ${theme.fg("accent", label)}  ${theme.fg("muted", feedbackSummary(check))}`);
  }
  if (typeof value.action === "string")
    lines.push(`  ${theme.fg("warning", "Stopped: ask the user before continuing")}`);
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
      "Run the staged checks in Shipd's order: prompt, patch precheck, Verify Solution, then Solution Quality, then Test Quality; cache only passing prompt hashes in this session.",
      "Verify Tests, Verify Flakiness and Reward Hacking only have to have passed once (a stale pass is fine); they are returned only when they fail. If the result has an `action`, stop and ask the user before changing anything.",
      "Only blocking issues fail a check. Non-blocking issues are returned as optional improvements; validate each before changing code.",
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
        /** Run and wait for the given checks where needed; resolves true if any check ran or was already running. */
        const runQualityStage = async (qualities: readonly QualityName[]): Promise<boolean> => {
          const stagePage = page;
          if (!browser || !stagePage) throw new Error("Shipd quality page was unavailable.");
          if (qualities.length === 0) return false;
          onUpdate?.({
            content: [{ type: "text", text: `Checking ${qualities.map(displayQualityName).join(" and ")} status...` }],
            details: undefined,
          });
          let initialStatuses = await readQualityStatusesWithRetry(stagePage, signal, qualities);
          // A check stays locked briefly after its upstream step passes; Shipd may also start it itself.
          const unlockDeadline = Date.now() + LOCKED_CHECK_TIMEOUT_MS;
          let locked = initialStatuses.filter((status) => status.lockReason && !status.busy);
          while (locked.length > 0) {
            if (Date.now() >= unlockDeadline) {
              throw new Error(
                locked
                  .map((status) => `${displayQualityName(status.quality)} is locked: ${status.lockReason}`)
                  .join(" "),
              );
            }
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Waiting for ${locked.map((s) => displayQualityName(s.quality)).join(", ")} to unlock...`,
                },
              ],
              details: undefined,
            });
            await sleep(LOCKED_CHECK_POLL_INTERVAL_MS, signal);
            initialStatuses = await readQualityStatusesWithRetry(stagePage, signal, qualities);
            locked = initialStatuses.filter((status) => status.lockReason && !status.busy);
          }
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
            return false;
          }

          // Every monitored check must finish before the stage ends, so wait for the slowest one.
          const initialWaitMs = Math.max(...qualitiesToMonitor.map((quality) => INITIAL_WAIT_MS[quality]));
          const recheckIntervalMs = qualitiesToMonitor.every((quality) => quality === "Task Prompt Quality")
            ? PROMPT_QUALITY_RECHECK_INTERVAL_MS
            : RECHECK_INTERVAL_MS;
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
              if (!status.busy && status.shouldRun && !status.lockReason)
                await clickAndConfirm(statusPage, status.quality, signal);
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
          return true;
        };

        // Every run opens the job link and syncs all draft fields first, so each later stage
        // (including a cached Prompt Quality pass) reads statuses for the local content.
        onUpdate?.({
          content: [{ type: "text", text: "Opening the Shipd job link and syncing the draft..." }],
          details: undefined,
        });
        const initial = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
        browser = initial.browser;
        page = initial.page;
        await syncChallengeDraft(page, files, targetUrl, signal);

        let promptQuality: JsonRecord;
        if (promptQualityCached) {
          promptQuality = { verdict: "PASS", cached: true };
          onUpdate?.({
            content: [
              { type: "text", text: "Prompt Quality already passed for this prompt in this session; skipping it." },
            ],
            details: undefined,
          });
          await browser.close().catch(() => undefined);
          browser = undefined;
          page = undefined;
        } else {
          await runQualityStage(["Task Prompt Quality"]);

          if (!page) throw new Error("Shipd page was closed before Prompt Quality report extraction.");
          onUpdate?.({ content: [{ type: "text", text: "Extracting Prompt Quality report..." }], details: undefined });
          const promptReport = (await hasQualityReport(page, "Task Prompt Quality"))
            ? await readReportWithRetry(page, "Task Prompt Quality", readJsonReport, signal)
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
          config: { fargate: loadFargateConfig() },
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

        const finish = (checks: JsonRecord) => {
          const result = buildAgentResult(promptQuality, checks);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        };
        const readFeedback = async (quality: QualityName): Promise<FeedbackReport | undefined> => {
          const reportPage = page;
          if (!reportPage)
            throw new Error(`Shipd page was closed before ${displayQualityName(quality)} report extraction.`);
          onUpdate?.({
            content: [{ type: "text", text: `Extracting ${displayQualityName(quality)} report...` }],
            details: undefined,
          });
          return (await hasQualityReport(reportPage, quality))
            ? await readReportWithRetry(reportPage, quality, readFeedbackReport, signal)
            : undefined;
        };
        const readRunOnceResult = async (quality: RunOnceCheck): Promise<JsonRecord> => {
          const report = await readFeedback(quality);
          return quality === "Reward Hacking"
            ? buildFeedbackResult(quality, report)
            : buildVerifyCheckResult(quality, report);
        };
        // A run-once check must have passed once; a stale pass is fine. It runs when it has never run,
        // or when its latest result failed and is stale. A running check is waited for, since its
        // report is unreadable until it finishes. A current failure is not re-run: same input, same result.
        const runOnceChecksToRun = async (qualities: readonly RunOnceCheck[]): Promise<RunOnceCheck[]> => {
          const statusPage = page;
          if (!statusPage) throw new Error("Shipd page was closed before reading the run-once checks.");
          const toRun: RunOnceCheck[] = [];
          for (const status of await readQualityStatusesWithRetry(statusPage, signal, qualities)) {
            const quality = status.quality as RunOnceCheck;
            if (status.busy || !status.hasReport) toRun.push(quality);
            else if (isStale(status.rowText) && (await readRunOnceResult(quality)).verdict !== "PASS")
              toRun.push(quality);
          }
          return toRun;
        };
        // Only failures are returned; a check still running is skipped.
        const readRunOnceFailures = async (qualities: readonly RunOnceCheck[]): Promise<JsonRecord> => {
          const statusPage = page;
          if (!statusPage) throw new Error("Shipd page was closed before reading the run-once checks.");
          const failures: JsonRecord = {};
          for (const status of await readQualityStatusesWithRetry(statusPage, signal, qualities)) {
            if (status.busy || !status.hasReport) continue;
            const quality = status.quality as RunOnceCheck;
            const result = await readRunOnceResult(quality);
            if (result.verdict !== "PASS") failures[RUN_ONCE_CHECK_KEYS[quality]] = result;
          }
          return failures;
        };
        const askUser = (failures: JsonRecord, checks: JsonRecord = {}) => {
          const failed = (Object.keys(RUN_ONCE_CHECK_KEYS) as RunOnceCheck[])
            .filter((quality) => RUN_ONCE_CHECK_KEYS[quality] in failures)
            .map(displayQualityName);
          return finish({ ...checks, ...failures, action: askUserAction(failed) });
        };
        // After a step runs, Shipd starts or unlocks the next one; reload once it has had time to.
        const settleAfterStage = async (ran: boolean): Promise<void> => {
          if (!ran || !page) return;
          onUpdate?.({
            content: [{ type: "text", text: "Waiting for Shipd to start the next step..." }],
            details: undefined,
          });
          await sleep(STAGE_SETTLE_MS, signal);
          await navigateAuthenticated(page, targetUrl, signal);
        };

        onUpdate?.({
          content: [
            { type: "text", text: "Fargate patch prechecks passed; opening Shipd to unlock Solution Quality..." },
          ],
          details: undefined,
        });
        const finalPage = await openShipdPage(executablePath, storageStatePath, targetUrl, signal);
        browser = finalPage.browser;
        page = finalPage.page;

        // Step 2 unlocks only when every Step 1 check has passed at least once (a stale pass is fine)
        // and Verify Solution is current and passing.
        const [promptStatus] = await readQualityStatusesWithRetry(finalPage.page, signal, ["Task Prompt Quality"]);
        const unlockChecks: QualityName[] = [
          "Verify Solution",
          ...(await runOnceChecksToRun(["Verify Tests", "Verify Flakiness"])),
          ...(promptStatus?.hasReport ? [] : ["Task Prompt Quality" as const]),
        ];
        const unlockRan = await runQualityStage(unlockChecks);
        const verifySolution = buildVerifyCheckResult("Verify Solution", await readFeedback("Verify Solution"));
        if (verifySolution.verdict !== "PASS") return finish({ verifySolution });
        const stepOneFailures = await readRunOnceFailures(["Verify Tests", "Verify Flakiness"]);
        if (Object.keys(stepOneFailures).length > 0) return askUser(stepOneFailures);

        await settleAfterStage(unlockRan);
        // Like the Step 1 checks, Reward Hacking only has to have passed once; a stale pass is fine.
        const stepTwoRan = await runQualityStage([
          "Solution Quality",
          ...(await runOnceChecksToRun(["Reward Hacking"])),
        ]);
        const solutionQuality = buildFeedbackResult("Solution Quality", await readFeedback("Solution Quality"));
        const rewardHackingFailure = await readRunOnceFailures(["Reward Hacking"]);
        if (Object.keys(rewardHackingFailure).length > 0) return askUser(rewardHackingFailure, { solutionQuality });
        if (solutionQuality.verdict !== "PASS") return finish({ solutionQuality });

        await settleAfterStage(stepTwoRan);
        await runQualityStage(["Test Quality"]);
        const testQuality = buildFeedbackResult("Test Quality", await readFeedback("Test Quality"));
        return finish({ solutionQuality, testQuality });
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
