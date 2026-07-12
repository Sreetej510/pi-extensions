import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiCodexWhamAuth } from "./codex-auth.js";
import {
	CODEX_CONSUME_RESET_CREDITS_URL,
	CODEX_RESET_CREDITS_URL,
} from "./constants.js";
import { throwUsageEndpointError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";
import type {
	CodexResetCredit,
	CodexResetCreditList,
	CodexResetCreditPayload,
	CodexResetCreditRowPayload,
} from "./types.js";
import {
	asNumber,
	asString,
	assertObject,
	parseJsonObject,
	redactErrorBody,
} from "./utils.js";

export async function fetchCodexResetCredits(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<CodexResetCreditList> {
	const auth = await resolvePiCodexWhamAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}
	const response = await fetchWithTimeout(
		CODEX_RESET_CREDITS_URL,
		{ headers: auth.headers },
		timeoutMs,
		"Codex banked resets",
	);
	const text = await response.text();
	if (!response.ok) {
		throwUsageEndpointError("Codex banked resets", response, text);
	}
	const payload = parseJsonObject(text, "Codex banked reset credits response");
	return normalizeCodexResetCreditList(payload as CodexResetCreditPayload);
}

export async function consumeCodexResetCredit(
	ctx: ExtensionContext,
	timeoutMs: number,
	creditId: string,
): Promise<void> {
	const auth = await resolvePiCodexWhamAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}
	const redeemRequestId = randomUUID();
	const bodies = [
		{ id: creditId, redeem_request_id: redeemRequestId },
		{ credit_id: creditId, redeem_request_id: redeemRequestId },
		{ rate_limit_reset_credit_id: creditId, redeem_request_id: redeemRequestId },
		{ id: creditId, redeemRequestId },
		{ credit_id: creditId, redeemRequestId },
		{ rate_limit_reset_credit_id: creditId, redeemRequestId },
	];
	let lastError: Error | undefined;
	for (const body of bodies) {
		const response = await fetchWithTimeout(
			CODEX_CONSUME_RESET_CREDITS_URL,
			{ method: "POST", headers: auth.headers, body: JSON.stringify(body) },
			timeoutMs,
			"Codex consume banked reset",
		);
		const text = await response.text();
		if (response.ok) return;
		lastError = new Error(
			`Codex consume banked reset returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
		);
		if (response.status !== 400 && response.status !== 422) break;
	}
	throw lastError ?? new Error("Failed to consume Codex banked reset.");
}

function normalizeCodexResetCreditList(payload: CodexResetCreditPayload): CodexResetCreditList {
	const rawCredits = Array.isArray(payload.credits) ? payload.credits : [];
	const credits = rawCredits
		.map((value) => normalizeCodexResetCreditRow(value))
		.filter((value): value is CodexResetCredit => value !== undefined);
	const availableCount =
		asNumber(payload.available_count) ??
		asNumber(payload.availableCount) ??
		credits.filter((credit) => (credit.status ?? "available") === "available").length;
	return { availableCount: Math.max(0, Math.trunc(availableCount)), credits };
}

function normalizeCodexResetCreditRow(value: unknown): CodexResetCredit | undefined {
	if (!value) return undefined;
	const credit = assertObject(value, "Codex reset credit") as CodexResetCreditRowPayload;
	const id = asString(credit.id);
	if (!id) return undefined;
	return {
		id,
		resetType: asString(credit.reset_type) ?? asString(credit.resetType),
		status: asString(credit.status),
		grantedAt: asString(credit.granted_at) ?? asString(credit.grantedAt),
		expiresAt: asString(credit.expires_at) ?? asString(credit.expiresAt),
	};
}

export function formatCodexResetCreditList(list: CodexResetCreditList): string {
	const lines = ["  >_ Codex Banked Resets", ""];
	lines.push(`  Banked resets available: ${list.availableCount}`);
	if (list.credits.length === 0) {
		lines.push("  No banked reset credits found.");
		return lines.join("\n");
	}
	for (const credit of list.credits) {
		const status = credit.status ? ` [${credit.status}]` : "";
		const granted = credit.grantedAt ? `granted ${formatIsoReset(credit.grantedAt)}` : undefined;
		const expires = credit.expiresAt ? `expires ${formatIsoReset(credit.expiresAt)}` : undefined;
		const timing = [granted, expires].filter(Boolean).join(" • ");
		lines.push(`  ${credit.id}${status}${timing ? ` — ${timing}` : ""}`);
	}
	return lines.join("\n");
}

export function formatCodexResetCreditChoice(credit: CodexResetCredit): string {
	const expires = credit.expiresAt ? `expires ${formatIsoReset(credit.expiresAt)}` : "no expiry shown";
	return `${credit.id} — ${expires}`;
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
