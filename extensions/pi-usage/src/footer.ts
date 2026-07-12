import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { STATUS_KEY } from "./constants.js";
import type { FooterDataView, FooterTheme, FooterTui } from "./types.js";
import { asNumber, sanitizeStatusText } from "./utils.js";

let footerRegistered = false;

export function isFooterRegistered(): boolean {
	return footerRegistered;
}

export function setFooterRegistered(value: boolean): void {
	footerRegistered = value;
}

export function installUsageFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// biome-ignore lint/suspicious/noExplicitAny: footer factory params are provided by the host
	ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
		const footerTui = tui as FooterTui;
		const footerTheme = theme as FooterTheme;
		const footerView = footerData as FooterDataView;
		const unsubscribe = footerView.onBranchChange(() => footerTui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				return renderUsageFooter(pi, ctx, footerTheme, footerView, width);
			},
		};
	});
}

function renderUsageFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: FooterTheme,
	footerData: FooterDataView,
	width: number,
): string[] {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		const message = (entry as { type?: string; message?: unknown }).message as
			| { role?: string; usage?: Record<string, unknown> }
			| undefined;
		if ((entry as { type?: string }).type !== "message" || message?.role !== "assistant") continue;
		const usage = message.usage ?? {};
		const input = asNumber(usage.input) ?? 0;
		const output = asNumber(usage.output) ?? 0;
		const cacheRead = asNumber(usage.cacheRead) ?? 0;
		const cacheWrite = asNumber(usage.cacheWrite) ?? 0;
		const cost = usage.cost as { total?: unknown } | undefined;
		totalInput += input;
		totalOutput += output;
		totalCacheRead += cacheRead;
		totalCacheWrite += cacheWrite;
		totalCost += asNumber(cost?.total) ?? 0;
		const prompt = input + cacheRead + cacheWrite;
		latestCacheHitRate = prompt > 0 ? (cacheRead / prompt) * 100 : undefined;
	}

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent =
		contextUsage && contextUsage.percent !== null ? contextPercentValue.toFixed(1) : "?";

	let pwd = formatCwdForFooter(
		ctx.sessionManager.getCwd(),
		process.env.HOME || process.env.USERPROFILE,
	);
	const branch = footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;

	const statsParts: string[] = [];
	if (totalInput) statsParts.push(`\u2191${formatFooterTokens(totalInput)}`);
	if (totalOutput) statsParts.push(`\u2193${formatFooterTokens(totalOutput)}`);
	if (totalCacheRead) statsParts.push(`R${formatFooterTokens(totalCacheRead)}`);
	if (totalCacheWrite) statsParts.push(`W${formatFooterTokens(totalCacheWrite)}`);
	if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
		statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (totalCost || usingSubscription) {
		statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}
	const contextDisplay =
		contextPercent === "?"
			? `?/${formatFooterTokens(contextWindow)}`
			: `${contextPercent}%/${formatFooterTokens(contextWindow)}`;
	let contextStr = contextDisplay;
	if (contextPercentValue > 90) contextStr = theme.fg("error", contextDisplay);
	else if (contextPercentValue > 70) contextStr = theme.fg("warning", contextDisplay);
	statsParts.push(contextStr);

	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const modelName = ctx.model?.id || "no-model";
	let rightSide = modelName;
	if (ctx.model?.reasoning) {
		const level = pi.getThinkingLevel?.() ?? "off";
		rightSide = level === "off" ? `${modelName} \u2022 thinking off` : `${modelName} \u2022 ${level}`;
	}
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const withProvider = `(${ctx.model.provider}) ${rightSide}`;
		if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
	}

	const rightSideWidth = visibleWidth(rightSide);
	let statsLine: string;
	if (statsLeftWidth + 2 + rightSideWidth <= width) {
		statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - 2;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const pad = Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight));
			statsLine = statsLeft + " ".repeat(pad) + truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	const dimStatsLeft = theme.fg("dim", statsLeft);
	const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
	const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
	const lines = [pwdLine, dimStatsLeft + dimRemainder];

	const statusLine = renderUsageStatusLine(theme, footerData, width);
	if (statusLine !== undefined) lines.push(statusLine);
	return lines;
}

function renderUsageStatusLine(
	theme: FooterTheme,
	footerData: FooterDataView,
	width: number,
): string | undefined {
	const statuses = footerData.getExtensionStatuses();
	if (statuses.size === 0) return undefined;

	const ours = statuses.get(STATUS_KEY);
	const others = Array.from(statuses.entries())
		.filter(([key]) => key !== STATUS_KEY)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text));
	const left = others.join(" ");

	if (!ours) {
		return left ? truncateToWidth(left, width, theme.fg("dim", "...")) : undefined;
	}

	const right = sanitizeStatusText(ours);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 1 + rightWidth > width) {
		// Not enough room to right-align cleanly; keep usage visible on its own line.
		return truncateToWidth(left ? `${left} ${right}` : right, width, theme.fg("dim", "..."));
	}
	const padding = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
	return left + padding + right;
}

function formatFooterTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
