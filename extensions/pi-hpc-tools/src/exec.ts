/** Remote command execution over plink + shell quoting helpers. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHPCConfig, getPlinkCommand, getShellExecutable } from "./config.js";
import type { HpcExecResult } from "./types.js";

/** Single-quote escape for remote shell command strings. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function bashQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function execOnHPC(
	pi: ExtensionAPI,
	remoteCommand: string,
	opts?: { timeout?: number; signal?: AbortSignal },
): Promise<HpcExecResult> {
	const config = getHPCConfig();
	if (!config) {
		throw new Error("HPC not configured. Use /hpc:config username@host password");
	}

	const plink = bashQuote(getPlinkCommand());
	const localCmd = `${plink} -batch -pw ${bashQuote(config.password)} ${config.username}@${config.host} ${bashQuote(remoteCommand)}`;
	const connectTimeoutMs = opts?.timeout ?? 60_000;
	const result = await pi.exec(getShellExecutable(), ["-c", localCmd], {
		signal: opts?.signal,
		timeout: connectTimeoutMs,
	});

	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.code ?? 0,
		killed: result.killed,
	};
}

export function isHpcFailure(result: HpcExecResult): boolean {
	const text = `${result.stdout}\n${result.stderr}`;
	return result.exitCode !== 0 || /FATAL ERROR/i.test(text);
}

export function formatHpcFailure(result: HpcExecResult): string {
	if (result.killed) return "HPC command timed out.";
	return (result.stderr || result.stdout).trim() || `HPC command failed (exit ${result.exitCode})`;
}
