/** Clean, non-mutating git HEAD snapshot into a scratch directory. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellExecutable } from "./config.js";

export function toSlashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function bashQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const EXCLUDED_CODE_FILE = /(?:\.patch|\.md|\.sh)$/i;
const EXCLUDED_DOCKERFILE = /(?:^|\/)dockerfile(?:$|\.)/i;

function normalizeCodeFileName(name: string): string {
  return name.trim().replace(/\\/g, "/");
}

function isIncludedCodeFile(name: string): boolean {
  return name.length > 0 && !EXCLUDED_CODE_FILE.test(name) && !EXCLUDED_DOCKERFILE.test(name);
}

/**
 * Lists changed, existing code files to give read-only analysis agents a
 * concrete starting set. Patch, markdown, Dockerfile, and shell files are
 * intentionally excluded; untracked code files are included as well.
 */
export async function listChangedCodeFiles(
  pi: ExtensionAPI,
  repoDir: string,
  cancelSignal?: AbortSignal,
): Promise<string[]> {
  if (cancelSignal?.aborted) return [];

  const changed = await pi.exec("git", ["diff", "--name-only", "HEAD", "--"], {
    cwd: repoDir,
    timeout: 15_000,
    signal: cancelSignal,
  });
  const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repoDir,
    timeout: 15_000,
    signal: cancelSignal,
  });

  const names = [
    ...(changed.code === 0 ? changed.stdout.split(/\r?\n/) : []),
    ...(untracked.code === 0 ? untracked.stdout.split(/\r?\n/) : []),
  ]
    .map(normalizeCodeFileName)
    .filter(isIncludedCodeFile)
    .filter((name) => existsSync(join(repoDir, name)));

  return [...new Set(names)];
}

/**
 * Returns an in-memory unified diff for the changed code files. Tracked files
 * are diffed against HEAD; untracked files are represented as new-file diffs.
 * The diff is context for read-only auditors, not a patch they can apply.
 */
export async function getChangedCodeDiff(
  pi: ExtensionAPI,
  repoDir: string,
  codeFiles: string[],
  cancelSignal?: AbortSignal,
): Promise<string> {
  const includedCodeFiles = [...new Set(codeFiles.map(normalizeCodeFileName).filter(isIncludedCodeFile))].filter(
    (name) => existsSync(join(repoDir, name)),
  );
  if (cancelSignal?.aborted || includedCodeFiles.length === 0) return "";

  const diff = await pi.exec(
    "git",
    ["diff", "HEAD", "--no-ext-diff", "--no-color", "--unified=20", "--", ...includedCodeFiles],
    {
      cwd: repoDir,
      timeout: 30_000,
      signal: cancelSignal,
    },
  );
  if (cancelSignal?.aborted) return "";

  const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "--", ...includedCodeFiles], {
    cwd: repoDir,
    timeout: 15_000,
    signal: cancelSignal,
  });
  if (cancelSignal?.aborted) return "";

  const untrackedNames =
    untracked.code === 0
      ? new Set(untracked.stdout.split(/\r?\n/).map(normalizeCodeFileName).filter(isIncludedCodeFile))
      : new Set<string>();
  const untrackedDiffs = [...untrackedNames]
    .map((name) => formatUntrackedCodeDiff(repoDir, name))
    .filter((value): value is string => value !== null);

  return [diff.code === 0 ? diff.stdout.trimEnd() : "", ...untrackedDiffs]
    .filter((value) => value.length > 0)
    .join("\n\n");
}

function formatUntrackedCodeDiff(repoDir: string, name: string): string | null {
  try {
    const bytes = readFileSync(join(repoDir, name));
    const path = name.replace(/\\/g, "/");
    const header = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`];
    if (bytes.includes(0)) return [...header, `Binary files /dev/null and b/${path} differ`].join("\n");

    const content = bytes.toString("utf8").replace(/\r\n/g, "\n");
    if (content.length === 0) return [...header, "@@ -0,0 +0,0 @@"].join("\n");
    const hasFinalNewline = content.endsWith("\n");
    const body = hasFinalNewline ? content.slice(0, -1) : content;
    const lines = body.split("\n");
    const result = [...header, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
    if (!hasFinalNewline) result.push("\\ No newline at end of file");
    return result.join("\n");
  } catch {
    return null;
  }
}

export async function snapshotGitHead(
  pi: ExtensionAPI,
  repoDir: string,
  tempDir: string,
  cancelSignal?: AbortSignal,
): Promise<{ status: "ok" } | { status: "error"; error: string }> {
  if (cancelSignal?.aborted) return { status: "error", error: "cancelled" };

  const headCheck = await pi.exec("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    timeout: 15_000,
    signal: cancelSignal,
  });
  if (headCheck.code !== 0) {
    return { status: "error", error: "Not a git repository, or it has no commits yet." };
  }

  // Git for Windows can apply core.autocrlf while streaming an archive, which
  // makes patches generated from Git blobs fail to apply in the Linux worker.
  const cmd = `git -c core.autocrlf=false archive HEAD | tar -x -C ${bashQuote(toSlashPath(tempDir))}`;
  const result = await pi.exec(getShellExecutable(), ["-c", cmd], {
    cwd: repoDir,
    timeout: 60_000,
    signal: cancelSignal,
  });
  if (result.code !== 0) {
    return { status: "error", error: result.stderr?.trim() || `git archive failed (exit ${result.code})` };
  }
  return { status: "ok" };
}
