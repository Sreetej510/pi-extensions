/**
 * Host-side Codex login handling for Fargate solver runs. The solvers use a copy of the local ChatGPT login
 * (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`). If a solver had to refresh that login remotely, the rotated
 * refresh token would sign out the local copy, so the login is refreshed here first whenever it might not outlast the run.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex refreshes a ChatGPT login on its own once it is about 8 days old; refresh locally before that can happen remotely. */
const MAX_LOGIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 60_000;

export interface CodexLoginStatus {
  path: string;
  json: string;
  /** Access-token expiry; undefined for API-key logins, which do not expire. */
  expiresAt?: Date;
  lastRefresh?: Date;
}

export interface PreparedCodexLogin extends CodexLoginStatus {
  refreshed: boolean;
}

export function codexAuthPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

function jwtExpiry(token: unknown): Date | undefined {
  if (typeof token !== "string") return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads and validates the local Codex login without exposing any token value. */
export function readCodexLogin(path = codexAuthPath()): CodexLoginStatus {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      `No Codex login found at ${path}. Run \`codex login\` with your ChatGPT account (file credential storage) first.`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error(`The Codex login file is not valid JSON: ${path}. Run \`codex login\` again.`);
  }
  const tokens = parsed.tokens as Record<string, unknown> | null | undefined;
  const hasTokens = Boolean(tokens && typeof tokens === "object" && typeof tokens.refresh_token === "string");
  if (!hasTokens && typeof parsed.OPENAI_API_KEY !== "string")
    throw new Error(`The Codex login file has no ChatGPT login or API key: ${path}. Run \`codex login\` first.`);
  const lastRefresh = typeof parsed.last_refresh === "string" ? new Date(parsed.last_refresh) : undefined;
  return {
    path,
    json: JSON.stringify(parsed),
    ...(hasTokens ? { expiresAt: jwtExpiry(tokens?.access_token) } : {}),
    ...(lastRefresh && !Number.isNaN(lastRefresh.getTime()) ? { lastRefresh } : {}),
  };
}

/** Why the login needs a refresh before a run that may use it for `minValidityMs`, or undefined when it is safe. */
export function codexLoginRefreshReason(status: CodexLoginStatus, minValidityMs: number, now = Date.now()) {
  const parsed = JSON.parse(status.json) as { tokens?: unknown };
  if (!parsed.tokens) return undefined; // API-key login: nothing expires
  if (!status.expiresAt) return "the access token expiry is unreadable";
  if (status.expiresAt.getTime() - now < minValidityMs)
    return `the access token expires at ${status.expiresAt.toISOString()}`;
  if (!status.lastRefresh || now - status.lastRefresh.getTime() > MAX_LOGIN_AGE_MS - minValidityMs)
    return "the login is old enough that Codex would refresh it during the run";
  return undefined;
}

/** Forces Codex to refresh its own login (`codex app-server` → `account/read { refreshToken: true }`). */
export function forceCodexLoginRefresh(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // The npm shim is a .cmd on Windows, which Node only launches through a shell.
    const windows = process.platform === "win32";
    const child = spawn(windows ? "codex app-server" : "codex", windows ? [] : ["app-server"], {
      shell: windows,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdin?.end();
      if (child.exitCode === null && child.pid !== undefined) {
        if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else child.kill("SIGTERM");
      }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("Cancelled by user."));
    const timer = setTimeout(() => finish(new Error("Timed out refreshing the Codex login.")), REFRESH_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    const send = (message: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: { id?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error && (message.id === 0 || message.id === 1)) {
          finish(new Error(`Codex could not refresh the login: ${String(message.error.message ?? "unknown error")}`));
        } else if (message.id === 0) {
          send({ method: "initialized" });
          send({ id: 1, method: "account/read", params: { refreshToken: true } });
        } else if (message.id === 1) {
          finish();
        }
      }
    });
    child.on("error", (error) => finish(new Error(`Could not start codex app-server: ${error.message}`)));
    child.on("close", (code) => {
      if (!settled)
        finish(new Error(`codex app-server exited with code ${code}. ${stderr.trim().slice(0, 500)}`.trim()));
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "pi-shipd-checks", version: "1.0.0" } } });
  });
}

/**
 * Returns the local Codex login, refreshed first when it might expire (or be refreshed by Codex) within `minValidityMs`.
 * Throws when the login is missing or still unsafe after a refresh, so no solver starts with a login it would rotate.
 */
export async function prepareCodexLoginForRun(opts: {
  minValidityMs: number;
  signal?: AbortSignal;
  onRefresh?: (reason: string) => void;
}): Promise<PreparedCodexLogin> {
  const before = readCodexLogin();
  const reason = codexLoginRefreshReason(before, opts.minValidityMs);
  if (!reason) return { ...before, refreshed: false };
  opts.onRefresh?.(reason);
  await forceCodexLoginRefresh(opts.signal);
  const after = readCodexLogin(before.path);
  const stillUnsafe = codexLoginRefreshReason(after, opts.minValidityMs);
  if (stillUnsafe)
    throw new Error(
      `The Codex login is still not safe for this run after a refresh (${stillUnsafe}). Run \`codex login\` again.`,
    );
  return { ...after, refreshed: true };
}
