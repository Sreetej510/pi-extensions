/** Clean, non-mutating git HEAD snapshot into a scratch directory. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellExecutable } from "./config.js";

function toSlashPath(p: string): string {
	return p.replace(/\\/g, "/");
}

function bashQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function snapshotGitHead(
	pi: ExtensionAPI,
	repoDir: string,
	tempDir: string,
): Promise<{ status: "ok" } | { status: "error"; error: string }> {
	const headCheck = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeout: 15_000 });
	if (headCheck.code !== 0) {
		return { status: "error", error: "Not a git repository, or it has no commits yet." };
	}

	const cmd = `git archive HEAD | tar -x -C ${bashQuote(toSlashPath(tempDir))}`;
	const result = await pi.exec(getShellExecutable(), ["-c", cmd], { cwd: repoDir, timeout: 60_000 });
	if (result.code !== 0) {
		return { status: "error", error: result.stderr?.trim() || `git archive failed (exit ${result.code})` };
	}
	return { status: "ok" };
}
