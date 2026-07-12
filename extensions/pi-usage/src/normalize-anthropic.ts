import { ANTHROPIC_NON_WINDOW_KEYS } from "./constants.js";
import { progressBarUsed } from "./format.js";
import type {
	AnthropicExtraUsage,
	AnthropicOAuthUsagePayload,
	AnthropicOAuthWindow,
	AnthropicUsageReport,
} from "./types.js";
import {
	asBoolean,
	asNumber,
	asString,
	assertObject,
	clampPercent,
	compactLimitLabel,
	formatCurrencyAmount,
} from "./utils.js";

export function normalizeAnthropicUsagePayload(
	payload: AnthropicOAuthUsagePayload,
	capturedAt: number,
): AnthropicUsageReport {
	const lines = ["  >_ Anthropic Usage", ""];
	const statusParts: string[] = ["claude"];

	const enterpriseWindows: {
		key: string;
		usedPercent: number;
		usedDollars: number;
		limitDollars: number;
		resetsAt?: string;
	}[] = [];
	for (const [key, rawValue] of Object.entries(payload)) {
		if (ANTHROPIC_NON_WINDOW_KEYS.has(key)) continue;
		if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
		const value = rawValue as AnthropicOAuthWindow;
		const limitDollars = asNumber(value.limit_dollars);
		const usedDollars = asNumber(value.used_dollars);
		if (limitDollars === undefined || usedDollars === undefined) continue;
		enterpriseWindows.push({
			key,
			usedPercent: clampPercent(asNumber(value.utilization) ?? 0),
			usedDollars,
			limitDollars,
			resetsAt: asString(value.resets_at),
		});
	}

	let hasAnySection = false;

	// Section 1: enterprise budget windows
	if (enterpriseWindows.length > 0) {
		hasAnySection = true;
		enterpriseWindows.sort((left, right) => left.limitDollars - right.limitDollars);
		lines.push("  Enterprise budget windows:");
		for (const window of enterpriseWindows) {
			const label = compactLimitLabel(window.key).replace(/\b\w/g, (char) => char.toUpperCase());
			const reset = window.resetsAt ? ` (resets ${formatIsoReset(window.resetsAt)})` : "";
			lines.push(
				`  ${label}: ${progressBarUsed(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used (${formatCurrencyAmount(window.usedDollars, "USD")}/${formatCurrencyAmount(window.limitDollars, "USD")})${reset}`,
			);
		}
		// Statusline shows the window that's actually moving: the one with the
		// highest utilization (not just the smallest limit).
		const primary = [...enterpriseWindows].sort(
			(left, right) => right.usedPercent - left.usedPercent,
		)[0];
		statusParts.push(`${primary.usedPercent.toFixed(0)}%`);
		statusParts.push(
			`${formatCurrencyAmount(primary.usedDollars, "USD", 0)}/${formatCurrencyAmount(primary.limitDollars, "USD", 0)}`,
		);
	}

	// Section 2: monthly extra usage (pay-per-use overflow). Shown alongside
	// enterprise windows — both are real spend and both belong in the statusline.
	const extraUsageRaw = payload.extra_usage;
	if (extraUsageRaw) {
		const extraUsage = assertObject(extraUsageRaw, "Anthropic extra usage") as AnthropicExtraUsage;
		const enabled = asBoolean(extraUsage.is_enabled);
		const usedCredits = asNumber(extraUsage.used_credits);
		if (enabled && usedCredits !== undefined) {
			if (hasAnySection) lines.push("");
			const hadStatusSegment = statusParts.length > 1;
			hasAnySection = true;
			const currency = asString(extraUsage.currency) ?? "USD";
			// used_credits / monthly_limit are minor units (cents): 30000 => 300.00
			const usedMajor = usedCredits / 100;
			const monthlyLimitMajor =
				asNumber(extraUsage.monthly_limit) !== undefined
					? (asNumber(extraUsage.monthly_limit) as number) / 100
					: undefined;
			const usedPercent = clampPercent(asNumber(extraUsage.utilization) ?? 0);
			const amount = `${formatCurrencyAmount(usedMajor, currency)}${monthlyLimitMajor !== undefined ? `/${formatCurrencyAmount(monthlyLimitMajor, currency)}` : ""}`;
			const amountCompact = `${formatCurrencyAmount(usedMajor, currency, 0)}${monthlyLimitMajor !== undefined ? `/${formatCurrencyAmount(monthlyLimitMajor, currency, 0)}` : ""}`;
			const resetsAt = asString(extraUsage.reset_at) ?? asString(extraUsage.resets_at);
			const reset = resetsAt ? ` (resets ${formatIsoReset(resetsAt)})` : "";
			lines.push("  Monthly extra usage:");
			lines.push(`  ${progressBarUsed(usedPercent)} ${usedPercent.toFixed(0)}% used ${amount}${reset}`);
			// Append alongside any enterprise-window segment already added — don't
			// overwrite it. Label with "extra" only when it's not the sole segment,
			// so accounts with just extra usage keep the simpler unlabeled form.
			statusParts.push(`${usedPercent.toFixed(0)}%`);
			statusParts.push(amountCompact);
			if (hadStatusSegment) statusParts.push("extra");
		}
	}

	// Section 3: subscription rolling windows
	const fiveHour = normalizeAnthropicRollingWindow(payload.five_hour);
	const sevenDay = normalizeAnthropicRollingWindow(payload.seven_day);
	if (fiveHour || sevenDay) {
		if (hasAnySection) lines.push("");
		hasAnySection = true;
		lines.push("  Subscription usage:");
		if (fiveHour) lines.push(`  ${formatAnthropicRollingWindow("5h", fiveHour, false)}`);
		if (sevenDay) lines.push(`  ${formatAnthropicRollingWindow("7d", sevenDay, true)}`);
		if (statusParts.length === 1) {
			if (fiveHour) statusParts.push(`${fiveHour.usedPercent.toFixed(0)}% 5h`);
			if (sevenDay) statusParts.push(`${sevenDay.usedPercent.toFixed(0)}% 7d`);
		}
	}

	if (!hasAnySection) {
		throw new Error("Anthropic usage endpoint returned no displayable usage data.");
	}

	return {
		provider: "anthropic",
		source: "anthropic-oauth",
		capturedAt,
		summaryLines: lines,
		statusline: statusParts.join(" "),
	};
}

function normalizeAnthropicRollingWindow(
	value: unknown,
): { usedPercent: number; resetsAt?: string } | undefined {
	if (!value) return undefined;
	const window = assertObject(value, "Anthropic rolling usage window") as AnthropicOAuthWindow;
	const usedPercent = asNumber(window.utilization);
	if (usedPercent === undefined) return undefined;
	return { usedPercent: clampPercent(usedPercent), resetsAt: asString(window.resets_at) };
}

function formatAnthropicRollingWindow(
	label: string,
	window: { usedPercent: number; resetsAt?: string },
	showDay: boolean,
): string {
	const reset = window.resetsAt ? ` (resets ${formatIsoReset(window.resetsAt, showDay)})` : "";
	return `${label}: ${progressBarUsed(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used${reset}`;
}

function formatIsoReset(value: string, showDay = true): string {
	const reset = new Date(value);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";
	const now = new Date();
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	if (!showDay && reset.toDateString() === now.toDateString()) return time;
	const day = reset.getDate().toString();
	const month = reset.toLocaleDateString(undefined, { month: "short" });
	return `${time} on ${day} ${month}`;
}
