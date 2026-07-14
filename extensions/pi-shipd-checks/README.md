# @sreetej510/pi-shipd-checks

A [pi](https://github.com/earendil-works/pi) coding agent extension that runs a strict,
multi-agent review of a benchmark task's `agent_prompt.md`, `test.patch`, and `solution.patch`
against a fairness rubric, and finds behavioral test-coverage gaps that could let an incorrect
agent solution slip past the hidden tests.

## What it does

For the flags you pass, `/checks`:

1. Snapshots the current git `HEAD` into a throwaway temp directory (via
   `git archive HEAD | tar -x`) — it never touches your working directory, staged, or
   uncommitted changes.
2. Copies `agent_prompt.md`, `solution.patch`, and `test.patch` from your project root into
   that temp dir.
3. Spawns one read-only reviewer agent per focus area you selected — **description**, **tests**,
   **solution** — each restricted to `read`/`grep`/`find`/`ls` tools plus a single
   `submit_review_report` tool it must call with a structured `PASS`/`FAIL` verdict, reasons,
   and notes.
4. Optionally runs a 3-agent behavioral test-gap analysis: two specialized finders
   run in parallel (positive required-behavior gaps + negative forbidden-behavior gaps),
   then a strict validator filters the combined list. This never turns a `PASS` into a
   `FAIL` — it's purely informational.
5. Optionally runs the solver gap finder: several (configurable, default 3) TDD-style solver
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
   analytical, so it's reported separately from the `--gap-finder` results and is never
   included in `--all` since it's by far the most expensive stage. Each solver's full
   `trajectory.json` (its raw session entries), `solution.patch`, and `./test.sh new` output
   are also persisted to `.pi/shipd-checks/<run-id>/solver_<n>/` in your project root, for
   later inspection independent of `shipd_report.json`.
6. Posts a chat summary (only for the stage(s) actually run this invocation — a `--tests`-only
   run won't show a stale `Overall` verdict from a previous, unrelated run) and merges the
   results into `shipd_report.json` in your project root. Running flags separately, in any
   order, builds up one combined report instead of overwriting it — `overall` only becomes a
   confident `PASS`/`FAIL` once all 3 focus reviewers have run at least once, in the same
   invocation.

## Commands

All flags except `--config` are additive/combinable, e.g. `/checks --tests --gap-finder` runs
just the tests reviewer plus the gap-finder/filter stages. `--config` must be used alone.
`--solver-gap-finder` is additive like the other stage flags, but deliberately **not** included
in `--all` since it's the most expensive stage (several full coding-agent runs with shell access).

| Command | Effect |
|---|---|
| `/checks` | List available options (runs nothing) |
| `/checks --all` | Run all 3 focus reviewers + test-gap analysis |
| `/checks --review` | Run only the 3 focus reviewer agents |
| `/checks --description` | Run only the problem-description reviewer |
| `/checks --tests` | Run only the tests reviewer |
| `/checks --solution` | Run only the solution reviewer |
| `/checks --gap-finder` | Run positive + negative gap finders (parallel), then validator |
| `/checks --solver-gap-finder` | Run several solver agents TDD-style against `agent_prompt.md` + `test.patch`, then compare their solutions to the real solution to find gaps |
| `/checks --config` | Open the settings menu (reviewer + solver-gap-finder settings) |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run.

## Configuration

`/checks --config` opens a single row-based settings menu with two section headers:

- **Reviewer**: model and thinking level used by the focus reviewers, gap-finders, gap-validator,
  and the solver-gap-finder's comparison reviewer.
- **Solver Gap Finder**: model, thinking level, per-agent timeout in minutes (default 30, clamped to
  1–120), and number of parallel solver agents (default 3, clamped to 1–10) — used only by the
  TDD-style solver agents spawned by `--solver-gap-finder`. These write code and run shell commands
  (a heavier job than the read-only reviewers), so you may want a stronger coding model here.

Use ↑/↓ to move between rows, Enter/Space to open a model picker or cycle a value in place, and
`Ctrl+S` to save and exit (Esc cancels without discarding already-saved changes). Everything is
saved immediately to `~/.pi/agent/checks-config.json`, with the solver-gap-finder settings nested
under a `solverGap` key.

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
