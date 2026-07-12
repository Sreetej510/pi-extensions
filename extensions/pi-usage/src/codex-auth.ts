import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_OPENAI_BETA } from "./constants.js";
import { codexAuthCandidateModels } from "./models.js";
import { asString, hasHeader } from "./utils.js";

export async function resolvePiCodexAuth(
	ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
	const models = codexAuthCandidateModels(ctx);
	const errors: string[] = [];

	for (const model of models) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			errors.push(auth.error);
			continue;
		}

		const headers = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "Authorization") && auth.apiKey) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
		if (!hasHeader(headers, "User-Agent")) {
			headers["User-Agent"] = "pi-codex-usage";
		}
		if (hasHeader(headers, "Authorization")) {
			return { headers };
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
	return undefined;
}

export async function resolvePiCodexWhamAuth(
	ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) return undefined;
	const headers = { ...auth.headers };
	if (!hasHeader(headers, "Accept")) headers.Accept = "application/json";
	if (!hasHeader(headers, "Content-Type")) headers["Content-Type"] = "application/json";
	if (!hasHeader(headers, "OpenAI-Beta")) headers["OpenAI-Beta"] = CODEX_OPENAI_BETA;
	if (!hasHeader(headers, "originator")) headers.originator = "Codex Desktop";
	if (!hasHeader(headers, "ChatGPT-Account-ID")) {
		const accountId = readCodexAccountIdFromAuthFile();
		if (accountId) headers["ChatGPT-Account-ID"] = accountId;
	}
	return { headers };
}

export function readCodexAccountIdFromAuthFile(): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) as {
			tokens?: { account_id?: unknown; accountId?: unknown };
		};
		return asString(raw.tokens?.account_id) ?? asString(raw.tokens?.accountId);
	} catch {
		return undefined;
	}
}
