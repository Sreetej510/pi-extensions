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
4. Optionally runs a 2-stage behavioral test-gap analysis: an exhaustive researcher agent
   proposes candidate gaps (required-but-untested edge cases), then a strict, independent
   filter agent re-verifies each one against the fairness rules. This never turns a `PASS` into
   a `FAIL` — it's purely informational.
5. Posts a one-line chat summary and merges the results into `shipd_report.json` in your
   project root. Running flags separately, in any order, builds up one combined report instead
   of overwriting it — `overall` only becomes a confident `PASS`/`FAIL` once all 3 focus
   reviewers have run at least once.

## Commands

All flags except `--config` are additive/combinable, e.g. `/checks --tests --gap-finder` runs
just the tests reviewer plus the gap-finder/filter stages. `--config` must be used alone.

| Command | Effect |
|---|---|
| `/checks` | List available options (runs nothing) |
| `/checks --all` | Run all 3 focus reviewers + test-gap analysis |
| `/checks --review` | Run only the 3 focus reviewer agents |
| `/checks --description` | Run only the problem-description reviewer |
| `/checks --tests` | Run only the tests reviewer |
| `/checks --solution` | Run only the solution reviewer |
| `/checks --gap-finder` | Run only the test-gap finder + filter agents |
| `/checks --config` | Set the reviewer model and thinking level |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run.

## Configuration

`/checks --config` lets you pick a model from your `enabledModels` list in `settings.json`,
then (if the model supports more than one) a thinking level. The currently configured
model/level is highlighted `[current]` in the picker. Settings are saved globally to
`~/.pi/agent/checks-config.json` and shared by all reviewer/gap-finder/validator agents.

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
| `src/agents.ts` | Spawns and races the reviewer + gap-finder/validator agent sessions |
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
