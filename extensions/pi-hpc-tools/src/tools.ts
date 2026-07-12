/** Registers the ls_hpc / read_file_hpc / grep_hpc tools. */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GREP_TIMEOUT_MS, MAX_READ_LINES } from "./constants.js";
import { execOnHPC, formatHpcFailure, isHpcFailure, shQuote } from "./exec.js";
import { buildGrepOptions } from "./grep-options.js";
import { hpcRenderCall, hpcRenderResult } from "./render.js";
import { getToolsRegistered, setToolsRegistered } from "./state.js";

export function registerHPCTools(pi: ExtensionAPI): void {
	if (getToolsRegistered()) return;
	setToolsRegistered(true);

	const sharedRender = hpcRenderResult;

	pi.registerTool({
		name: "ls_hpc",
		label: "List HPC Directory",
		description:
			"List files and directories on the remote HPC system. Use recursive=true to list all files under a directory.",
		promptSnippet: "List or browse files on remote HPC",
		promptGuidelines: [
			"Use ls_hpc when the user wants to explore directories on the remote HPC filesystem.",
			"Use ls_hpc with recursive=true to enumerate files under a directory tree.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory on HPC. Defaults to home (~)." })),
			options: Type.Optional(
				Type.String({ description: "Extra ls flags (e.g. -lh). Default: -la. Ignored when recursive=true." }),
			),
			recursive: Type.Optional(Type.Boolean({ description: "List all files recursively under path. Default: false." })),
		}),
		renderCall(args, theme, context) {
			const path = (args.path as string) || "~";
			const rec = args.recursive ? " (recursive)" : "";
			const callText = theme.fg("toolTitle", theme.bold("ls_hpc ")) + theme.fg("accent", path) + theme.fg("muted", rec);
			return hpcRenderCall(callText, theme, context);
		},
		renderResult: sharedRender,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Listing on HPC..." }], details: undefined });
			const path = params.path || "~";
			const recursive = params.recursive ?? false;
			const options = params.options || "-la";

			const command = recursive
				? `find ${shQuote(path)} -type f 2>/dev/null | head -n 50000 | sort`
				: `ls ${options} ${shQuote(path)} 2>&1`;

			const result = await execOnHPC(pi, command, { signal });

			if (isHpcFailure(result)) {
				return {
					content: [{ type: "text", text: formatHpcFailure(result) }],
					details: { exitCode: result.exitCode, path, recursive, error: true },
					isError: true,
				};
			}

			const text = (result.stdout || "").trim() || "(empty)";
			return {
				content: [{ type: "text", text }],
				details: { exitCode: result.exitCode, path, recursive, lineCount: text.split("\n").length },
			};
		},
	});

	pi.registerTool({
		name: "read_file_hpc",
		label: "Read HPC File",
		description: `Read a file from remote HPC. Supports offset/limit line range (max ${MAX_READ_LINES} lines per call).`,
		promptSnippet: "Read file contents from remote HPC",
		promptGuidelines: [
			"Use read_file_hpc to view source or config files stored on HPC.",
			`Use offset and limit to paginate large files (max ${MAX_READ_LINES} lines per read).`,
		],
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or relative file path on HPC." }),
			offset: Type.Optional(Type.Integer({ description: "0-based starting line. Default: 0.", minimum: 0 })),
			limit: Type.Optional(
				Type.Integer({
					description: `Max lines to read (capped at ${MAX_READ_LINES}). Default: ${MAX_READ_LINES}.`,
					minimum: 1,
					maximum: MAX_READ_LINES,
				}),
			),
		}),
		renderCall(args, theme, context) {
			const path = args.path as string;
			const offset = (args.offset as number | undefined) ?? 0;
			const limit = (args.limit as number | undefined) ?? MAX_READ_LINES;
			const callText =
				theme.fg("toolTitle", theme.bold("read_file_hpc ")) +
				theme.fg("accent", path) +
				theme.fg("warning", `:${offset + 1}${limit ? `-${offset + limit}` : ""}`);
			return hpcRenderCall(callText, theme, context);
		},
		renderResult: sharedRender,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Reading from HPC..." }], details: undefined });
			const filePath = params.path;
			const offset = Math.max(0, params.offset ?? 0);
			let limit = params.limit ?? MAX_READ_LINES;
			if (limit > MAX_READ_LINES) limit = MAX_READ_LINES;

			const startLine = offset + 1;
			const endLine = offset + limit;
			const command = `sed -n '${startLine},${endLine}p' ${shQuote(filePath)} 2>&1`;

			const result = await execOnHPC(pi, command, { signal });
			const output = result.stdout ?? "";
			const err = result.stderr ?? "";

			if (result.exitCode !== 0) {
				return {
					content: [{ type: "text", text: `Error reading ${filePath}:\n${err || output || "(no output)"}` }],
					details: { exitCode: result.exitCode, path: filePath, error: true },
				};
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: `No content in lines ${startLine}-${endLine} of ${filePath}` }],
					details: { path: filePath, offset, limit, empty: true },
				};
			}

			const lineCount = output.split("\n").length;
			const header = `${filePath} (lines ${startLine}-${offset + lineCount}):\n`;
			return {
				content: [{ type: "text", text: header + output }],
				details: { path: filePath, offset, limit, lines: lineCount },
			};
		},
	});

	pi.registerTool({
		name: "grep_hpc",
		label: "Search HPC Files",
		description:
			"Search file contents on HPC with grep. Patterns with | (alternation) auto-use grep -E. Use options '-F' for literal/fixed-string search. Max runtime 2 minutes.",
		promptSnippet: "Grep/search text in remote HPC files",
		promptGuidelines: [
			"Use grep_hpc to find strings or regex patterns in HPC files.",
			"For alternation (foo|bar), use one pattern with | — grep -E is added automatically.",
			"Use options '-F' when the pattern must be matched literally (no regex).",
			"Use after/before/context for surrounding lines (like grep -A/-B/-C).",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "Search pattern. Use | for alternation (e.g. foo|bar)." }),
			path: Type.Optional(Type.String({ description: "File or directory on HPC. Default: ." })),
			options: Type.Optional(
				Type.String({
					description: "Extra grep flags (e.g. -i, -l, -E). Default base: -rn.",
				}),
			),
			file_pattern: Type.Optional(
				Type.String({
					description:
						"Glob for filenames to search, e.g. '*.csv' or '*.py' (uses grep --include, case-insensitive via find when non-recursive).",
				}),
			),
			after: Type.Optional(Type.Integer({ description: "Lines after match (grep -A).", minimum: 0 })),
			before: Type.Optional(Type.Integer({ description: "Lines before match (grep -B).", minimum: 0 })),
			context: Type.Optional(
				Type.Integer({ description: "Lines before and after (grep -C). Overrides after/before.", minimum: 0 }),
			),
			recursive: Type.Optional(Type.Boolean({ description: "Search recursively (-r). Default true for directories." })),
		}),
		renderCall(args, theme, context) {
			let callText = theme.fg("toolTitle", theme.bold("grep_hpc "));
			callText += theme.fg("accent", `"${args.pattern as string}"`);
			if (args.path) callText += theme.fg("toolOutput", ` in ${args.path as string}`);
			if (args.file_pattern) callText += theme.fg("toolOutput", ` (${args.file_pattern as string})`);
			return hpcRenderCall(callText, theme, context);
		},
		renderResult: sharedRender,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Searching on HPC..." }], details: undefined });

			const pattern = params.pattern;
			const searchPath = params.path || ".";
			const grepOpts = buildGrepOptions(params.options || "-n", pattern, searchPath, {
				recursive: params.recursive,
				context: params.context,
				after: params.after,
				before: params.before,
			});
			const quotedPattern = shQuote(pattern);
			const quotedPath = shQuote(searchPath);

			let command: string;
			if (params.file_pattern) {
				const glob = params.file_pattern.trim();
				const quotedGlob = shQuote(glob);
				let fileGrepOpts = grepOpts.replace(/--include(?:=\S+|\s+\S+)?/g, "").trim();

				if (params.recursive === false) {
					const namePred = glob.includes("*") || glob.includes("?") ? `-iname ${quotedGlob}` : `-name ${quotedGlob}`;
					command = `find ${quotedPath} -maxdepth 1 -type f ${namePred} -exec grep -Hn ${fileGrepOpts} -e ${quotedPattern} {} + 2>&1`;
				} else {
					if (!/\s-r\b/.test(fileGrepOpts)) fileGrepOpts += " -r";
					command = `grep ${fileGrepOpts} --include=${quotedGlob} -e ${quotedPattern} ${quotedPath} 2>&1`;
				}
			} else {
				command = `grep ${grepOpts} -e ${quotedPattern} ${quotedPath} 2>&1`;
			}
			command += " || true";

			const result = await execOnHPC(pi, command, { signal, timeout: GREP_TIMEOUT_MS });

			if (result.killed) {
				return {
					content: [
						{
							type: "text",
							text: `grep_hpc timed out after ${GREP_TIMEOUT_MS / 1000}s. Narrow the path, use file_pattern, or refine the pattern.`,
						},
					],
					details: { path: searchPath, pattern, timedOut: true, error: true },
				};
			}

			if (isHpcFailure(result)) {
				return {
					content: [{ type: "text", text: formatHpcFailure(result) }],
					details: {
						path: searchPath,
						pattern,
						file_pattern: params.file_pattern,
						exitCode: result.exitCode,
						error: true,
					},
					isError: true,
				};
			}

			const output = (result.stdout || "").trim();
			const stderr = (result.stderr || "").trim();
			if (!output) {
				const scope = params.file_pattern ? `${searchPath} (files: ${params.file_pattern})` : searchPath;
				if (stderr && /no such file|not found|cannot access/i.test(stderr)) {
					return {
						content: [{ type: "text", text: `grep_hpc failed:\n${stderr}` }],
						details: { path: searchPath, pattern, error: true },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `No matches for ${JSON.stringify(pattern)} in ${scope}${grepOpts.includes("-E") ? " (extended regex)" : ""}`,
						},
					],
					details: {
						path: searchPath,
						pattern,
						file_pattern: params.file_pattern,
						matches: 0,
						grepOptions: grepOpts,
					},
				};
			}

			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let agentText = truncation.content;
			const details: Record<string, unknown> = {
				path: searchPath,
				pattern,
				grepOptions: grepOpts,
				matches: output.split("\n").filter((l) => l.trim()).length,
				exitCode: result.exitCode,
			};

			if (truncation.truncated) {
				details.truncatedForAgent = true;
				const omittedLines = truncation.totalLines - truncation.outputLines;
				const omittedBytes = truncation.totalBytes - truncation.outputBytes;
				agentText += ` |  [Output truncated for agent: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Narrow search path or pattern.]`;
			}

			return {
				content: [{ type: "text", text: agentText }],
				details,
			};
		},
	});
}
