/** grep_hpc option-string building heuristics. */

function grepUsesFixedStrings(options: string): boolean {
	return /(?:^|\s)-F(?:\s|$)/.test(options) || /--fixed-strings/.test(options);
}

function grepUsesExtendedRegex(options: string): boolean {
	return /(?:^|\s)-E(?:\s|$)/.test(options) || /--extended-regexp/.test(options);
}

/** Heuristic: | alternation and common ERE syntax need grep -E. */
function patternNeedsExtendedRegex(pattern: string): boolean {
	if (pattern.includes("|")) return true;
	if (/[()[\]+]/.test(pattern)) return true;
	if (/(?:^|[^\\])\?/.test(pattern)) return true;
	return false;
}

function isLikelyFilePath(path: string): boolean {
	const base = path.split("/").pop() ?? path;
	return base.includes(".") && !path.endsWith("/");
}

export function buildGrepOptions(
	baseOptions: string,
	pattern: string,
	searchPath: string,
	params: {
		recursive?: boolean;
		context?: number;
		after?: number;
		before?: number;
	},
): string {
	let opts = baseOptions.trim();
	opts = opts.replace(/-(?:A|B|C)\s*\d+/g, "").trim();

	if (!grepUsesFixedStrings(opts) && !grepUsesExtendedRegex(opts) && patternNeedsExtendedRegex(pattern)) {
		opts += " -E";
	}

	if (params.context !== undefined && params.context > 0) {
		opts += ` -C ${params.context}`;
	} else {
		if (params.after && params.after > 0) opts += ` -A ${params.after}`;
		if (params.before && params.before > 0) opts += ` -B ${params.before}`;
	}

	const useRecursive = params.recursive !== false && !isLikelyFilePath(searchPath);
	if (!useRecursive) {
		opts = opts.replace(/\s*-r\b/g, "").trim();
	} else if (!/\s-r\b/.test(opts)) {
		opts += " -r";
	}

	return opts.replace(/\s+/g, " ").trim();
}
