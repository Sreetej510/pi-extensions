# @sreetej510/pi-shipd-checks

A [pi](https://github.com/earendil-works/pi) coding agent extension that finds behavioral
coverage gaps in a benchmark task's hidden tests.

## What it does

For the flags you pass, `/checks`:

1. Snapshots the current git `HEAD` into a throwaway temp directory (via
   `git archive HEAD | tar -x`) — it never touches your working directory, staged, or
   uncommitted changes.
2. Copies `agent_prompt.md`, `solution.patch`, and `test.patch` from your project root into
   that temp dir.
3. Optionally runs a 3-agent behavioral test-gap analysis: two specialized finders
   run in parallel (positive required-behavior gaps + negative forbidden-behavior gaps),
   then a strict validator filters the combined list.
4. Optionally runs the solver gap finder: several (configurable, default 3) TDD-style solver
   agents, each in its own throwaway git repo with `test.patch` and `agent_prompt.md` applied
   (never `solution.patch`), given write/edit/bash access to iterate until `./test.sh new`
   passes or they give up. The extension independently re-verifies each
   solver's result and captures its diff (excluding any files `test.patch` touched, and
   including any new, previously-uncommitted files the solver created), writes each
   solver's diff + test output to `solver_gap_solutions/solver_<n>/` inside the shared
   snapshot dir (plus a `manifest.json` summary) — rather than embedding them directly in
   a prompt — so a read-only comparison reviewer can read only what it needs via its
   normal read/grep/find/ls tools, keeping its context usage independent of solver count
   and diff size. That reviewer compares the solvers' diffs against the real
   `agent_prompt.md`/`solution.patch` to surface behavioral gaps — cases where a passing
   solver's approach diverges from the intended behavior, indicating a test that's
   under-specified. This is empirical (grounded in real agent attempts) rather than
   analytical, so it's reported separately from the `--gap-finder` results. Each solver's full
   `trajectory.json` (its raw session entries), `solution.patch`, and `./test.sh new` output
   are also persisted to `.pi/shipd-checks/<run-id>/solver_<n>/` in your project root, for
   later inspection independent of `shipd_report.json`.
5. Posts a chat summary and merges the gap-finder results into `shipd_report.json` in your
   project root. Running either finder separately builds up one combined report without any
   PASS/FAIL verdict.

## Commands

The two finder flags are additive/combinable; `--config` must be used alone.

| Command | Effect |
|---|---|
| `/checks` | List available options (runs nothing) |
| `/checks --gap-finder` | Run positive + negative gap finders (parallel), then validator |
| `/checks --solver-gap-finder` | Run several solver agents TDD-style against `agent_prompt.md` + `test.patch`, then compare their solutions to the real solution to find gaps |
| `/checks --config` | Configure behavioral and solver gap-finder models |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run.

## Configuration

`/checks --config` lets you choose which setting to change:

- **Reviewer model**: model and thinking level used by the behavioral gap finders, validator,
  and solver-solution comparison agent.
- **Solver model**: model and thinking level used by the TDD solver agents. Configure the
  reviewer model first.

Settings are saved to `~/.pi/agent/checks-config.json`; solver settings are nested under
`solverGap`.

## Install

```bash
npm install -g @sreetej510/pi-shipd-checks
```

Then add it to your pi `settings.json`:

```json
{
  "packages": ["npm:@sreetej510/pi-shipd-checks"]
}
```

Or, for local development, point at the entry point directly:

```json
{
  "extensions": ["/absolute/path/to/pi-extensions/extensions/pi-shipd-checks/src/index.ts"]
}
```

## File layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry point: message renderer, cancel shortcut, command registration |
| `src/command.ts` | The `/checks` command: argument parsing, `--config` flow, run orchestration |
| `src/agents.ts` | Spawns and races the reviewer + gap-finder/validator/solver agent sessions |
| `src/solvergap.ts` | Solver-gap-finder workspace lifecycle: setup, verification, artifact persistence, cleanup |
| `src/prompts.ts` | All prompt text sent to those agents |
| `src/tools.ts` | Custom tools the agents call to submit their structured results |
| `src/rubric.ts` | Embedded guidelines/fairness rubric text + per-role section loaders |
| `src/roles.ts` | The 3 reviewer roles (description/tests/solution) metadata |
| `src/report.ts` | `shipd_report.json` load/merge/summary logic |
| `src/config.ts` | `~/.pi/agent/checks-config.json` + `settings.json` helpers (models, thinking levels, shell path) |
| `src/git.ts` | Clean, non-mutating git `HEAD` snapshot into a scratch directory |
| `src/progress.ts` | Progress-bar widget rendering |
| `src/state.ts` | Shared "run in progress" / cancel state between the command and the shortcut |
| `src/types.ts` | Shared TypeScript types |

To change reviewer strictness or wording, edit `prompts.ts`. To change the rubric/fairness text
itself, edit `rubric.ts`. To add a new tool, add it in `tools.ts` and wire it up in `agents.ts`.

## Development

```bash
npm install
npm run --workspace @sreetej510/pi-shipd-checks check     # biome + typecheck
npm run --workspace @sreetej510/pi-shipd-checks format
```
