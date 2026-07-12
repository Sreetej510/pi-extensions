import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ListResult, SavedPrompt } from "./types.js";

export class PromptManagerComponent {
  private selectedIndex: number;
  private cache?: { w: number; lines: string[] };

  constructor(
    private prompts: SavedPrompt[],
    initialIndex: number,
    private theme: Theme,
    private done: (result: ListResult) => void,
  ) {
    this.selectedIndex =
      prompts.length > 0 ? Math.max(0, Math.min(initialIndex, prompts.length - 1)) : 0;
  }

  handleInput(data: string): void {
    const n = this.prompts.length;

    if (matchesKey(data, "up") || data === "k") {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      if (this.selectedIndex < n - 1) {
        this.selectedIndex++;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "enter") && n > 0) {
      this.done({ action: "paste", index: this.selectedIndex });
      return;
    }
    if ((data === "e" || data === "E") && n > 0) {
      this.done({ action: "edit", index: this.selectedIndex });
      return;
    }
    if ((data === "d" || data === "D") && n > 0) {
      this.done({ action: "delete", index: this.selectedIndex });
      return;
    }
    if (data === "a" || data === "A") {
      this.done({ action: "add" });
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done({ action: "close" });
      return;
    }
  }

  render(width: number): string[] {
    if (this.cache?.w === width) return this.cache.lines;

    const th = this.theme;
    const lines: string[] = [];

    const TITLE = " Prompt Manager ";
    const rightDashes = Math.max(0, width - TITLE.length - 3);
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          th.fg("accent", TITLE) +
          th.fg("borderMuted", "─".repeat(rightDashes)),
        width,
      ),
    );
    lines.push("");

    if (this.prompts.length === 0) {
      lines.push(
        truncateToWidth(
          "  " + th.fg("dim", "No prompts saved yet. Press [a] to add one."),
          width,
        ),
      );
    } else {
      const MAX_VISIBLE = 10;
      const half = Math.floor(MAX_VISIBLE / 2);
      const start = Math.max(
        0,
        Math.min(this.selectedIndex - half, this.prompts.length - MAX_VISIBLE),
      );
      const end = Math.min(this.prompts.length, start + MAX_VISIBLE);

      if (start > 0) {
        lines.push(
          truncateToWidth("  " + th.fg("dim", `↑ ${start} more above`), width),
        );
      }

      for (let i = start; i < end; i++) {
        const p = this.prompts[i]!;
        const isSel = i === this.selectedIndex;

        const arrow = isSel ? th.fg("accent", "❯ ") : "  ";
        const nameStyled = isSel
          ? th.fg("text", th.bold(p.name))
          : th.fg("muted", p.name);

        let row = arrow + nameStyled;

        if (isSel && p.content) {
          const firstLine = p.content.split("\n")[0]?.trim() ?? "";
          if (firstLine) {
            const avail = width - 2 - p.name.length - 4;
            if (avail > 8) {
              const preview =
                firstLine.length > avail
                  ? firstLine.slice(0, avail - 1) + "…"
                  : firstLine;
              row += "  " + th.fg("dim", preview);
            }
          }
        }

        lines.push(truncateToWidth(row, width));
      }

      if (end < this.prompts.length) {
        lines.push(
          truncateToWidth(
            "  " + th.fg("dim", `↓ ${this.prompts.length - end} more below`),
            width,
          ),
        );
      }
    }

    lines.push("");

    const hints =
      this.prompts.length > 0
        ? "[↑↓/jk] navigate  [Enter] paste  [e] edit  [d] delete  [a] add  [Esc] close"
        : "[a] add a new prompt  [Esc] close";
    lines.push(truncateToWidth("  " + th.fg("dim", hints), width));
    lines.push("");

    this.cache = { w: width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
