/** Tool call/result rendering — matches built-in ls/grep/read formatting. */
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { UI_PREVIEW_LINES } from "./constants.js";
import type { HpcToolRenderResult } from "./types.js";

function getToolText(result: HpcToolRenderResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.type === "text" ? (block.text ?? "") : "";
}

/** Match built-in ls/grep/read renderResult formatting (in-place expand via Ctrl+O). */
export function formatHpcResult(
  result: HpcToolRenderResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: import("@earendil-works/pi-coding-agent").Theme,
): string {
  if (options.isPartial) {
    return theme.fg("warning", "Connecting to HPC...");
  }

  const details = result.details ?? {};
  const output = getToolText(result).trim();
  const exitCode = details.exitCode as number | undefined;

  if (details.error || (exitCode !== undefined && exitCode !== 0)) {
    return theme.fg("error", output || `HPC command failed (exit ${exitCode ?? "?"})`);
  }

  if (!output) {
    return theme.fg("dim", "(no output)");
  }

  const lines = output.split("\n");
  const maxLines = options.expanded ? lines.length : UI_PREVIEW_LINES;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  if (details.truncatedForAgent) {
    text += `\n${theme.fg("warning", "[Truncated for agent — narrow path or pattern]")}`;
  }
  return text;
}

export function hpcRenderCall(
  callText: string,
  _theme: import("@earendil-works/pi-coding-agent").Theme,
  context: { lastComponent?: unknown },
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(callText);
  return text;
}

export function hpcRenderResult(
  result: HpcToolRenderResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: import("@earendil-works/pi-coding-agent").Theme,
  context: { lastComponent?: unknown },
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(formatHpcResult(result, options, theme));
  return text;
}
