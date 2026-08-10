/** Clean, non-mutating git HEAD snapshot into a scratch directory. */

import { existsSync } from "node:fs";
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
    .map((name) => name.trim().replace(/\\/g, "/"))
    .filter((name) => name.length > 0)
    .filter((name) => !EXCLUDED_CODE_FILE.test(name) && !EXCLUDED_DOCKERFILE.test(name))
    .filter((name) => existsSync(join(repoDir, name)));

  return [...new Set(names)];
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

  const cmd = `git archive HEAD | tar -x -C ${bashQuote(toSlashPath(tempDir))}`;
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
