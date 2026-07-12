# @omega/pi-hpc-tools

A [pi](https://github.com/earendil-works/pi) coding agent extension for exploring a remote
HPC/SSH host through [`plink`](https://www.chiark.greenend.org.uk/~sgtatham/putty/) without
ever leaving your local project.

## What it does

- Adds three read-only tools — `ls_hpc`, `read_file_hpc`, `grep_hpc` — that shell out to a
  remote host via `plink -batch -pw "<password>" <user>@<host> "<command>"`.
- Tools are only active in projects where you've explicitly run `/hpc:on`, so the model never
  gets silent access to a remote machine.
- On/off state is stored per-project in `hpc-config.json` (`enabledProjects: ["/path/to/project", ...]`),
  and restored automatically on resume/session switch.

## Commands

| Command | Effect |
|---|---|
| `/hpc:on` | Enable the HPC tools for the current project |
| `/hpc:off` | Disable the HPC tools for the current project |
| `/hpc:config` | Configure host/user/password/plink path |

## Configuration

Credentials are resolved in this order:

1. Environment variables: `HPC_USERNAME` (or `HPC_USER`), `HPC_HOST`, `HPC_PASSWORD`.
2. `hpc-config.json` (in `~/.pi/agent/.pi/` or `~/.pi/`), written by `/hpc:config`:

   ```json
   {
     "username": "...",
     "host": "...",
     "password": "...",
     "plinkPath": "C:/path/to/plink.exe",
     "enabledProjects": ["/path/to/project"]
   }
   ```

3. `PLINK_PATH` env var, or `plinkPath` in the config file, or the default Windows/Git-Bash
   `plink.exe` path — falls back to `plink` on `PATH` otherwise.

The shell used to invoke `plink` is read from your pi `settings.json` (`shellPath`), defaulting
to Git Bash on Windows and `bash` elsewhere.

## Install

```bash
npm install -g @omega/pi-hpc-tools
```

Then add it to your pi `settings.json`:

```json
{
  "packages": ["npm:@omega/pi-hpc-tools"]
}
```

Or, for local development, point at the file directly:

```json
{
  "extensions": ["/absolute/path/to/pi-extensions/extensions/pi-hpc-tools/src/index.ts"]
}
```

## File layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry point: commands (`/hpc:on`, `/hpc:off`, `/hpc:config`) + lifecycle events |
| `src/constants.ts` | Tool names, timeouts, config file paths |
| `src/types.ts` | Shared TypeScript types |
| `src/state.ts` | Shared mutable module state (enabled flag, config cache, sync flags) |
| `src/config.ts` | `hpc-config.json` load/save, per-project enable state, shell/plink resolution |
| `src/exec.ts` | `plink` invocation + shell quoting helpers |
| `src/grep-options.ts` | `grep_hpc` option-string building heuristics |
| `src/render.ts` | Tool call/result rendering |
| `src/tool-sync.ts` | Keeps the HPC tools' active/inactive state in sync with `/hpc:on`/`/hpc:off` |
| `src/tools.ts` | Registers `ls_hpc` / `read_file_hpc` / `grep_hpc` |

## Development

```bash
npm install
npm run --workspace @omega/pi-hpc-tools check     # biome + typecheck
npm run --workspace @omega/pi-hpc-tools format
```

## Security notes

- Credentials are stored in plaintext JSON on disk (matching plink's own `-pw` usage) — treat
  `hpc-config.json` like any other secret file and keep it out of version control.
- Tools are strictly read-only (`ls`, `read`, `grep`); there is no remote write/execute tool.
