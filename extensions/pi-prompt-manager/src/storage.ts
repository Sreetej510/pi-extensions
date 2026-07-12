import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SavedPrompt } from "./types.js";

function dataFilePath(): string {
  return join(getAgentDir(), "prompt-manager.json");
}

export async function loadPrompts(): Promise<SavedPrompt[]> {
  try {
    const raw = await readFile(dataFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { prompts?: unknown };
    return Array.isArray(parsed.prompts) ? (parsed.prompts as SavedPrompt[]) : [];
  } catch {
    return [];
  }
}

export async function savePrompts(prompts: SavedPrompt[]): Promise<void> {
  const path = dataFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ prompts }, null, 2), "utf8");
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
