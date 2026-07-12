# @omega/pi-prompt-manager

A [pi](https://github.com/earendil-works/pi) coding agent extension to quickly save, manage,
and paste reusable prompts without retyping them.

## Commands

| Command | Effect |
|---|---|
| `/prompt` | Open the prompt manager (select · edit · delete · add) |
| `/prompt add [name]` | Create a new saved prompt directly (opens a multi-line editor) |

## Keyboard shortcuts (inside `/prompt`)

| Key | Action |
|---|---|
| `↑` / `↓` / `j` / `k` | Navigate the list |
| `Enter` | Paste the selected prompt into the editor |
| `e` | Edit the selected prompt |
| `d` | Delete the selected prompt (with confirmation) |
| `a` | Add a new prompt |
| `Esc` | Close without action |

## Storage

Saved prompts are stored as JSON at `<pi-agent-dir>/prompt-manager.json`:

```json
{
  "prompts": [
    { "id": "...", "name": "...", "content": "...", "createdAt": 0, "updatedAt": 0 }
  ]
}
```

## Install

```bash
npm install -g @omega/pi-prompt-manager
```

Then add it to your pi `settings.json`:

```json
{
  "packages": ["npm:@omega/pi-prompt-manager"]
}
```

Or, for local development, point at the file directly:

```json
{
  "extensions": ["/absolute/path/to/pi-extensions/extensions/pi-prompt-manager/src/index.ts"]
}
```

## File layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry point |
| `src/command.ts` | `/prompt` command handler + add/edit/delete flow |
| `src/component.ts` | List-manager TUI component |
| `src/storage.ts` | `prompt-manager.json` load/save helpers |
| `src/types.ts` | Shared TypeScript types |

## Development

```bash
npm install
npm run --workspace @omega/pi-prompt-manager check     # biome + typecheck
npm run --workspace @omega/pi-prompt-manager format
```
