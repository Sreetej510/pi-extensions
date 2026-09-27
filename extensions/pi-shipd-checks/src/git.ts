/** Clean, non-mutating git HEAD snapshot into a scratch directory. */

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function toWslPath(value: string): string | undefined {
  const slash = toSlashPath(value);
  const match = slash.match(/^([A-Za-z]):\/(.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : undefined;
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

type ExecResultSummary = { code: number; stderr?: string };
type GitSymlink = { path: string; target: string };

async function listGitSymlinks(
  pi: ExtensionAPI,
  repoDir: string,
  cancelSignal?: AbortSignal,
): Promise<{ symlinks: GitSymlink[] } | { error: string }> {
  const tree = await pi.exec("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: repoDir,
    timeout: 30_000,
    signal: cancelSignal,
  });
  if (tree.code !== 0) return { error: tree.stderr?.trim() || `git ls-tree failed (exit ${tree.code})` };

  const symlinkPaths = tree.stdout
    .split("\0")
    .map((entry) => {
      const separator = entry.indexOf("\t");
      if (separator < 0) return null;
      const metadata = entry.slice(0, separator).split(" ");
      return metadata[0] === "120000" ? entry.slice(separator + 1) : null;
    })
    .filter((path): path is string => path !== null);
  const symlinks: GitSymlink[] = [];
  for (const path of symlinkPaths) {
    const target = await pi.exec("git", ["show", `HEAD:${path}`], {
      cwd: repoDir,
      timeout: 15_000,
      signal: cancelSignal,
    });
    if (target.code !== 0) return { error: target.stderr?.trim() || `git show failed for symlink ${path}` };
    symlinks.push({ path, target: target.stdout.replace(/\r?\n$/, "") });
  }
  return { symlinks };
}

function pathExistsIncludingDanglingSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Git for Windows' tar cannot create a dangling symlink. Extract regular tree
 * entries first, excluding HEAD symlinks, then recreate links once their
 * targets exist. This keeps clean HEAD snapshots usable when WSL has no Git.
 */
async function snapshotWithGitBash(
  pi: ExtensionAPI,
  shell: string,
  repoDir: string,
  tempDir: string,
  cancelSignal?: AbortSignal,
): Promise<ExecResultSummary> {
  const listed = await listGitSymlinks(pi, repoDir, cancelSignal);
  if ("error" in listed) return { code: 1, stderr: listed.error };

  const archivePath = join(tempDir, ".shipd-head.tar");
  const quotedArchive = bashQuote(toSlashPath(archivePath));
  const quotedTemp = bashQuote(toSlashPath(tempDir));
  try {
    const archive = await pi.exec(shell, ["-c", `git -c core.autocrlf=false archive HEAD > ${quotedArchive}`], {
      cwd: repoDir,
      timeout: 60_000,
      signal: cancelSignal,
    });
    if (archive.code !== 0) return { code: archive.code, stderr: archive.stderr?.trim() };

    const excludes = listed.symlinks.map(({ path }) => `--exclude=${bashQuote(path)}`).join(" ");
    const extract = await pi.exec(shell, ["-c", `tar --force-local ${excludes} -xf ${quotedArchive} -C ${quotedTemp}`], {
      cwd: repoDir,
      timeout: 60_000,
      signal: cancelSignal,
    });
    if (extract.code !== 0) return { code: extract.code, stderr: extract.stderr?.trim() };

    const pending = [...listed.symlinks];
    while (pending.length > 0) {
      let created = 0;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const link = pending[index];
        const linkPath = join(tempDir, link.path);
        const targetPath = resolve(dirname(linkPath), link.target);
        if (!pathExistsIncludingDanglingSymlink(targetPath)) continue;
        const create = await pi.exec(shell, ["-c", `ln -s -- ${bashQuote(link.target)} ${bashQuote(link.path)}`], {
          cwd: tempDir,
          timeout: 15_000,
          signal: cancelSignal,
        });
        if (create.code !== 0) return { code: create.code, stderr: create.stderr?.trim() };
        pending.splice(index, 1);
        created += 1;
      }
      if (created === 0) {
        return {
          code: 1,
          stderr: `Could not recreate HEAD symlinks; unresolved targets: ${pending.map(({ path }) => path).join(", ")}`,
        };
      }
    }
    return { code: 0 };
  } finally {
    rmSync(archivePath, { force: true });
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
  // Git Bash also cannot extract dangling or forward-referenced symlinks on
  // Windows. When WSL is available, let its Linux tar preserve the HEAD tree
  // exactly; fall back to Git Bash for Windows hosts without WSL.
  const shell = getShellExecutable();
  const wslRepoDir = process.platform === "win32" ? toWslPath(repoDir) : undefined;
  const wslTempDir = process.platform === "win32" ? toWslPath(tempDir) : undefined;
  let result: ExecResultSummary;
  if (wslRepoDir && wslTempDir) {
    // A minimal Docker Desktop WSL distro may expose `wsl.exe` but not Git (or
    // Bash). Probe the actual archive tools before selecting the WSL path so
    // those hosts fall back to Git for Windows instead of returning a cryptic
    // `/bin/sh: git: not found` snapshot error.
    const wslProbe = await pi.exec("wsl.exe", ["-e", "git", "--version"], {
      cwd: repoDir,
      timeout: 15_000,
      signal: cancelSignal,
    });
    if (wslProbe.code === 0) {
      const wslCommand = `git -C ${bashQuote(wslRepoDir)} -c core.autocrlf=false archive HEAD | tar -x -C ${bashQuote(wslTempDir)}`;
      result = await pi.exec("wsl.exe", ["-e", "sh", "-lc", wslCommand], {
        cwd: repoDir,
        timeout: 60_000,
        signal: cancelSignal,
      });
    } else {
      result = await snapshotWithGitBash(pi, shell, repoDir, tempDir, cancelSignal);
    }
  } else {
    result = await snapshotWithGitBash(pi, shell, repoDir, tempDir, cancelSignal);
  }
  if (result.code !== 0) {
    return { status: "error", error: result.stderr?.trim() || `git archive failed (exit ${result.code})` };
  }
  return { status: "ok" };
}
