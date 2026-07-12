import { COMMAND_COMPLETIONS, DEFAULT_TIMEOUT_MS } from "./constants.js";
import type { CommandArgumentCompletion, QueryUsageOptions } from "./types.js";

export function completeCodexStatusArguments(
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...COMMAND_COMPLETIONS];

	const trailingSpace = /\s$/.test(prefix);
	const tokens = prefix.trimEnd().split(/\s+/).filter(Boolean);
	const previous = tokens.at(-1);
	if (previous === "--timeout" && trailingSpace) return null;
	if (previous === "--consume-banked-reset" && trailingSpace) return null;
	if (!trailingSpace && tokens.at(-2) === "--timeout") return null;
	if (!trailingSpace && tokens.at(-2) === "--consume-banked-reset") return null;

	const current = trailingSpace ? "" : (previous ?? "");
	if (current && !current.startsWith("-")) return null;

	const currentRaw = trailingSpace ? "" : (prefix.match(/\S+$/)?.[0] ?? "");
	const completionPrefix = trailingSpace
		? prefix
		: prefix.slice(0, prefix.length - currentRaw.length);
	const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(current));
	return matches.length > 0
		? matches.map((item) => ({ ...item, value: `${completionPrefix}${item.value}` }))
		: null;
}

export function parseArgs(
	args: string,
): { ok: true; value: QueryUsageOptions } | { ok: false; error: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let clearStatusline = false;
	let consumeBankedReset = false;
	let consumeBankedResetId: string | undefined;
	let listBankedResets = false;
	let raw = false;
	let refresh = false;
	let statusline = true;
	let timeoutMs = DEFAULT_TIMEOUT_MS;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--clear-statusline") {
			clearStatusline = true;
			continue;
		}
		if (token === "--raw") {
			raw = true;
			continue;
		}
		if (token === "--list-banked-resets") {
			listBankedResets = true;
			continue;
		}
		if (token === "--consume-banked-reset") {
			consumeBankedReset = true;
			const rawValue = tokens[index + 1];
			if (rawValue && !rawValue.startsWith("-")) {
				consumeBankedResetId = rawValue;
				index += 1;
			}
			continue;
		}
		if (token === "--no-statusline") {
			statusline = false;
			continue;
		}
		if (token === "--refresh") {
			refresh = true;
			continue;
		}
		if (token === "--timeout") {
			const rawValue = tokens[index + 1];
			if (!rawValue)
				return {
					ok: false,
					error:
						"Usage: /usage [--refresh] [--raw] [--list-banked-resets] [--consume-banked-reset <id>] [--timeout seconds]",
				};
			const parsed = Number(rawValue);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 120) {
				return { ok: false, error: "--timeout must be a number of seconds between 1 and 120." };
			}
			timeoutMs = Math.round(parsed * 1000);
			index += 1;
			continue;
		}
		return {
			ok: false,
			error: `Unknown option: ${token}. Usage: /usage [--refresh] [--raw] [--list-banked-resets] [--consume-banked-reset <id>] [--no-statusline] [--clear-statusline] [--timeout seconds]`,
		};
	}

	const exclusiveActionCount = [clearStatusline, raw, listBankedResets, consumeBankedReset].filter(
		Boolean,
	).length;
	if (exclusiveActionCount > 1) {
		return {
			ok: false,
			error: "Choose only one of: --clear-statusline, --raw, --list-banked-resets, --consume-banked-reset.",
		};
	}

	return {
		ok: true,
		value: {
			clearStatusline,
			consumeBankedReset,
			consumeBankedResetId,
			listBankedResets,
			raw,
			refresh,
			statusline,
			timeoutMs,
		},
	};
}
