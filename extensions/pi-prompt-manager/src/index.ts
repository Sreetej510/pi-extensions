/**
 * Prompt Manager Extension
 *
 * Quickly save, manage, and paste reusable prompts without retyping.
 *
 * Commands
 * ────────
 *   /prompt              Open the prompt manager (select · edit · delete · add)
 *   /prompt add [name]   Create a new saved prompt directly (opens multi-line editor)
 *
 * Storage: <pi-agent-dir>/prompt-manager.json
 *
 * File layout:
 *   index.ts      extension entry point (this file)
 *   command.ts    /prompt command handler
 *   component.ts  list-manager TUI component
 *   storage.ts    prompt-manager.json load/save helpers
 *   types.ts      shared TypeScript types
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptCommand } from "./command.js";

export default function promptManagerExtension(pi: ExtensionAPI) {
  registerPromptCommand(pi);
}
