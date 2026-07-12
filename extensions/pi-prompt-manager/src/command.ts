import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PromptManagerComponent } from "./component.js";
import { loadPrompts, newId, savePrompts } from "./storage.js";
import type { ListResult } from "./types.js";

type PromptUi = ExtensionCommandContext["ui"];

async function addPrompt(ui: PromptUi, nameHint?: string): Promise<void> {
  let name = nameHint?.trim();

  if (!name) {
    const entered = await ui.input("Prompt name:", "e.g. Code Review Template");
    if (!entered?.trim()) {
      ui.notify("Cancelled — no name given.", "info");
      return;
    }
    name = entered.trim();
  }

  const content = await ui.editor(`New prompt: ${name}`, "");
  if (!content?.trim()) {
    ui.notify("Cancelled — empty content not saved.", "info");
    return;
  }

  const all = await loadPrompts();
  const existIdx = all.findIndex((p) => p.name.toLowerCase() === name!.toLowerCase());

  if (existIdx >= 0) {
    const ok = await ui.confirm(
      "Name already exists",
      `A prompt named "${name}" already exists. Overwrite it?`,
    );
    if (!ok) return;
    all[existIdx] = {
      ...all[existIdx]!,
      content: content.trim(),
      updatedAt: Date.now(),
    };
  } else {
    const now = Date.now();
    all.push({
      id: newId(),
      name,
      content: content.trim(),
      createdAt: now,
      updatedAt: now,
    });
  }

  await savePrompts(all);
  ui.notify(`Prompt "${name}" saved.`, "info");
}

export function registerPromptCommand(pi: ExtensionAPI): void {
  pi.registerCommand("prompt", {
    description: "Manage saved prompts — /prompt | /prompt add [name]",

    getArgumentCompletions: (prefix) => {
      const opts = [{ value: "add", label: "add — create a new prompt" }];
      const filtered = opts.filter((o) => o.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/prompt requires interactive mode", "error");
        return;
      }

      const ui = ctx.ui;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";

      if (sub === "add") {
        const nameArg = parts.slice(1).join(" ") || undefined;
        await addPrompt(ui, nameArg);
        return;
      }

      if (sub !== "") {
        ui.notify("Usage: /prompt  |  /prompt add [name]", "warning");
        return;
      }

      let all = await loadPrompts();
      let sel = 0;

      for (;;) {
        const r = await ui.custom<ListResult>(
          (_tui, theme, _kb, done) =>
            new PromptManagerComponent(all, sel, theme, done),
        );

        if (!r || r.action === "close") break;

        if (r.action === "paste") {
          const p = all[r.index];
          if (p) ui.pasteToEditor(p.content);
          break;
        }

        if (r.action === "add") {
          await addPrompt(ui);
          all = await loadPrompts();
          continue;
        }

        if (r.action === "edit") {
          sel = r.index;
          const p = all[r.index];
          if (!p) continue;
          const txt = await ui.editor(`Edit: ${p.name}`, p.content);
          if (txt?.trim()) {
            all[r.index] = {
              ...p,
              content: txt.trim(),
              updatedAt: Date.now(),
            };
            await savePrompts(all);
            ui.notify(`"${p.name}" updated.`, "info");
          }
          continue;
        }

        if (r.action === "delete") {
          sel = r.index;
          const p = all[r.index];
          if (!p) continue;
          const ok = await ui.confirm(
            "Delete prompt",
            `Delete "${p.name}"? This cannot be undone.`,
          );
          if (ok) {
            all = all.filter((_, i) => i !== r.index);
            sel = Math.max(0, sel - 1);
            await savePrompts(all);
            ui.notify(`"${p.name}" deleted.`, "info");
          }
          continue;
        }
      }
    },
  });
}
