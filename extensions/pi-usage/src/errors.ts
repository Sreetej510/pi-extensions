import {
	RATE_LIMIT_BACKOFF_MAX_MS,
	RATE_LIMIT_BACKOFF_MIN_MS,
	RATE_LIMIT_BACKOFF_MS,
} from "./constants.js";
import type { UsageQueryError } from "./types.js";
import { redactErrorBody } from "./utils.js";

export function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

/** Error thrown for HTTP failures from usage endpoints; carries Retry-After for 429s. */
export class UsageEndpointError extends Error {
	retryAfterMs?: number;
	constructor(message: string, retryAfterMs?: number) {
		super(message);
		this.name = "UsageEndpointError";
		this.retryAfterMs = retryAfterMs;
	}
}

export function isRateLimitErrorMessage(message: string): boolean {
	return /\b429\b|rate_limit_error|rate.?limited/i.test(message);
}

export function throwUsageEndpointError(provider: string, response: Response, body: string): never {
	const message = `${provider} usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(body)}`;
	throw new UsageEndpointError(
		message,
		response.status === 429 ? parseRetryAfterMs(response) : undefined,
	);
}

/** Parse a Retry-After header — either delta-seconds or an HTTP date. */
export function parseRetryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(header);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}

/** Server-provided Retry-After from a failed query, clamped to sane bounds. */
export function rateLimitBackoffMs(errors: UsageQueryError[]): number {
	for (const error of errors) {
		if (error.cause instanceof UsageEndpointError && error.cause.retryAfterMs !== undefined) {
			return Math.min(
				Math.max(error.cause.retryAfterMs, RATE_LIMIT_BACKOFF_MIN_MS),
				RATE_LIMIT_BACKOFF_MAX_MS,
			);
		}
	}
	return RATE_LIMIT_BACKOFF_MS;
}
