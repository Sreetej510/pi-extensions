import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiCodexAuth } from "./codex-auth.js";
import { queryViaCodexAppServer } from "./codex-app-server.js";
import { CODEX_USAGE_URL } from "./constants.js";
import { isStaleExtensionContextError, throwUsageEndpointError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";
import { normalizeBackendPayload } from "./normalize-codex.js";
import type {
	CodexUsageReport,
	RateLimitStatusPayload,
	UsageQueryError,
	UsageReport,
} from "./types.js";
import { errorMessage, parseJsonObject } from "./utils.js";

export async function queryViaPiAuth(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<CodexUsageReport> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}

	const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers: auth.headers }, timeoutMs);
	const text = await response.text();
	if (!response.ok) {
		throwUsageEndpointError("Codex", response, text);
	}

	const payload = parseJsonObject(text, "Codex usage endpoint response");
	return normalizeBackendPayload(payload as RateLimitStatusPayload, Date.now(), "pi-auth");
}

export async function queryCodexUsageWithFallback(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<{ report?: UsageReport; errors: UsageQueryError[] }> {
	try {
		const report = await queryViaPiAuth(ctx, timeoutMs);
		return { report, errors: [] };
	} catch (cause) {
		if (isStaleExtensionContextError(cause)) throw cause;
		const errors: UsageQueryError[] = [
			{ source: "pi-auth", message: errorMessage(cause), cause },
		];
		try {
			const report = await queryViaCodexAppServer(timeoutMs);
			return { report, errors };
		} catch (fallbackCause) {
			if (isStaleExtensionContextError(fallbackCause)) throw fallbackCause;
			errors.push({
				source: "codex-app-server",
				message: errorMessage(fallbackCause),
				cause: fallbackCause,
			});
			return { errors };
		}
	}
}
