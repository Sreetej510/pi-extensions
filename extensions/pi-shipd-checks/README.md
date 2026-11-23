# @sreetej510/pi-shipd-checks

A [pi](https://github.com/earendil-works/pi) coding agent extension for benchmark-test analysis and Shipd quality checks.

## What it does

For `/checks --solve`:

1. Snapshots only the current git `HEAD` into a throwaway temp directory; the source checkout is never modified.
2. Sends the exact contents of `agent_prompt.md` as each solver's sole first user message. No prompt file, task Dockerfile, `test.patch`, `solution.patch`, or uncommitted test files are overlaid into a solver workspace. The Dockerfile is used only by the harness to provision the Fargate environment.
3. Runs several configurable (default 3) independent Codex CLI (`codex exec`) solver invocations in parallel, each with its own isolated clean-HEAD workspace. Captures each solver's `--json` event trace of agent messages, commands and file changes (reasoning items are dropped). There is no test-driven repair loop, and the test patch remains unavailable until that solver exits.
4. After a solver finishes, the harness applies `test.patch` to its workspace, then runs `bash test.sh --output_path <file> base` and `bash test.sh --output_path <file> new` as an unprivileged user with a fresh writable `HOME` and cache. It captures both full logs.
5. After all solvers exit and their tests run, a read-only local Codex CLI reviewer (`codex exec --sandbox read-only`; your local `codex` login, same runner as the `auditor` tool) receives an untouched clean-HEAD tree plus `agent_prompt.md`, all patch files, standalone copies of new test files, each solver's patch, and every solver's test logs. No patch is applied in the review workspace.
6. Runs the Codex CLI solvers inside one AWS ECS Fargate Spot task. A Spot interruption retries the task and resumes completed solver indexes. The solvers use your local ChatGPT Codex login (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`). Before each run the extension reads the access token's expiry and, when the login might expire (or be old enough for Codex to refresh it) before the task and its Spot retries can finish, forces a refresh through `codex app-server` first; a refresh on Fargate would rotate the refresh token and sign out your local login. The checked login is transferred through a private, server-side-encrypted S3 object and copied into each solver's private `CODEX_HOME` (`cli_auth_credentials_store=file`). Each Codex process runs under its own unprivileged UID with a private `CODEX_HOME`, a scrubbed environment (no AWS or transport variables), and `--dangerously-bypass-approvals-and-sandbox`, because Fargate lacks the user-namespace/Landlock support Codex's own Linux sandbox needs. `shell_environment_policy.exclude` keeps credential, AWS and harness variables out of every command Codex runs; the solver's commands share its UID and can read that solver's copy of `auth.json`. The temporary login copy and run objects are deleted after the task stops.
7. Posts a chat summary and logs results in `.pi/shipd-checks/<runId>/`, including `agent_steps.jsonl` per solver, and `shipd_report.json` in your project root.

The agent-callable `auditor` tool replaces the old `gap-finder` and `solution-precheck` tools. It is a local replica of the hosted Auto Review, ported from the shipd-workflow rulebook, for the tests and the solution only (no description grading; `test.sh` is ignored). It takes no parameters:

1. Requires `create_patches.sh` and `agent_prompt.md`, then runs `create_patches.sh` to create `test.patch` and `solution.patch` (they are not checked beforehand).
2. Snapshots git `HEAD` into a temp workspace as the pinned base (`repo/`), next to `review_assets/` holding `agent_prompt.md` (as problem.md), `test.patch` with its `test.sh` section removed, `solution.patch`, and standalone copies of new test files. Neither patch is applied.
3. Runs typed read-only Codex CLI agents on this machine (`codex exec --sandbox read-only`; your local `codex` login) in parallel. **Test agents** own `test.patch`: unfair tests (including shared-helper coupling and tests that contradict other tests in the suite), missing coverage (including interrupted processes, existing lifecycle operations and mirror cases), and non-blocking test code quality (Clutter, Conventions, Design, Practice). **Solution agents** own `solution.patch`: concrete wrong outputs (input, expected output, received, including kill-and-restart sequences, portability and regressions of existing operations) and non-blocking solution code quality (Practice, Clutter, Design, Conventions, Scope, Stale callers). The count of each type follows the patch sizes (one test agent per ~70 KB of `test.patch`, one solution agent per ~50 KB of `solution.patch`, 1–4 each); test agents split the test files and the prompt's requirement sentences, solution agents split the changed hunks. The agents are instructed to be as hard to pass as the hosted checks: assume findings exist, sweep twice, and report borderline candidates for synthesis to judge. The embedded `rules.md` families go to the type they belong to (fairness and test-gap rules to test agents, solution-gap rules to solution agents), and the prompts carry hosted calibration distilled into general patterns (`src/auditor-data.ts`), not quotes from past tasks.
4. Runs one combined synthesis (one session per 60 findings) that reads problem.md and both patches, merges duplicates across agents, and applies the hosted proof legs (failing case, wrong implementation, promise citation, load-bearing check, provenance, materiality, reference pass, exercised environment). A finding gates only when synthesis keeps it HIGH; it drops only findings the files show are wrong. Code-quality findings never gate.
5. Returns `PASS` or `FAIL` for the overall audit, tests and solution. A `HIGH` finding or incomplete review fails the audit. `MEDIUM` findings are advisory. The Markdown report under `.pi/shipd-checks/` gives every retained finding one short line, ordered by severity. A test-gap recommendation requires an exact prompt citation and a public check that passes both the reference and an alternative compliant design. Structured tool details include reviewer statuses and unexecuted counter-tests.

The agent-callable `quality-check` tool runs `create_patches.sh` in the current working directory and reads
`agent_prompt.md`, `test.patch`, and `solution.patch`. First, on every run (including a cached prompt pass), it opens the saved job link and syncs the Shipd draft: it
fills only the fields whose saved content differs from the local files, waits until Shipd's Convex backend acknowledges
every save and the header shows `Saved`, then reloads and confirms the draft matches (up to three attempts). Each page
load waits until every quality row's status has loaded, since a row without its status would read as a current report. Only then does it compute a SHA-256 of the
exact prompt content. The last passing prompt hash is stored as a custom entry in the current chat session. If the
hash matches, it skips the Shipd Prompt Quality check entirely and reports a cached `PASS`; if it differs or is absent, it
checks the refreshed status of the synced draft and runs only when the check is stale or has a `Run` button. Otherwise it
uses the current report. A new hash is saved only after Prompt Quality passes. On failure, only `promptQuality` is returned; there are no Test/Solution results or `stoppedReason`.
Only after Prompt Quality passes or has a matching cached pass does it run the Fargate patch precheck against a clean `HEAD`.
Then it follows Shipd's three steps. Step 1 holds Verify Tests, Verify Solution, Verify Flakiness and Prompt Quality;
Step 2 (Solution Quality and Reward Hacking) unlocks only when every Step 1 check has passed at least once and Verify
Solution is current and passing. Verify Solution is re-run whenever it is stale. Verify Tests, Verify Flakiness and
Reward Hacking only have to have passed once, so a stale pass is fine and is never re-run; the tool runs one of them
only when it has never run or its latest result is a stale failure, and waits for one that is already running. A
failing Verify Solution returns `promptQuality` and `verifySolution` (verdict and Shipd's reason). If Verify Tests,
Verify Flakiness or Reward Hacking still fails on the current draft, the tool returns it as `verifyTests`,
`verifyFlakiness` or `rewardHacking` plus an `action` telling the agent to stop and ask the user, and runs nothing
further. These checks, like Verify Solution, are returned only when they fail. Next it runs Solution Quality (and Reward Hacking when it needs a run); if Solution Quality fails it
returns it without running Test Quality, which Shipd keeps locked until Solution Quality passes. Otherwise it runs Test
Quality. Verify Solution, Solution Quality and Test Quality start fresh jobs, rerun stale reports, skip current
reports, and wait for started or queued jobs (a row reading `Waiting for …` counts as queued). After a step runs it
waits 15 seconds and reloads before the next step, because Shipd may start or unlock that step itself; a check still
locked two minutes later is reported as an error.

Solution Quality, Reward Hacking and Test Quality reports are read from each report's "Feedback for the author"
section, not raw JSON. Each returns `verdict`, plus `blocking` and `nonBlocking` arrays of items with `finding`,
`details`, `why` and `suggestedChange` (and `category`/`location` when Shipd gives them), and `reason` when a failure
has no blocking items. Only blocking issues fail a check, as in Shipd's verdict; non-blocking issues are returned for
the agent to validate and consider, but never fail it. `details.promptQuality` returns the verdict, reason, and major
non-AI comments (only `category`, `quote`, and `suggestion`; AI-category comments are omitted); Prompt Quality is still
read from its raw JSON and is `PASS` only when the completed report and evaluation
verdicts are both `PASS`, `requirementCount` is not blocking, and the AI gate does not flag the prompt. The prompt is
flagged as AI when a Prompt Quality comment category identifies AI (for example, `ai_generated`). AI-category quote and suggestion details are omitted; guidance recommends rewriting the flagged parts in plainer language or a small targeted manual edit for a recent change. A cached Prompt Quality pass is marked
`cached: true`. Prompt
Quality failures return a concise reason or major comments. Returned quality results omit `completed` and `skipped`. Its
compact UI is labeled `Quality Checks`, shows live elapsed time, and summarizes each stage; it does not print full pass
criteria in the tool description. It takes no parameters. Transient status and report-dialog operations retry up to three
times; after clicking Run, the tool waits up to 30 seconds for the stale state to clear or the job to show running. Once Shipd accepts
the confirmation it never clicks Run again in that attempt, because the run is already queued; a run that has not shown up
yet is left to the polling, which re-runs a check only if it is still stale and idle at its first status check. It
uses one fresh headless browser tab at a time: for Prompt Quality
it checks after 90 seconds, then every 30 seconds; for the other checks it first checks after 10 minutes (Verify
Tests, Verify Solution, Verify Flakiness and Reward Hacking) or 12 minutes (Solution Quality and Test Quality); when
several run together it waits for the longest, then reopens
every 90 seconds until those jobs finish, with no client-side overall timeout. If all checks are current, it uses existing
reports without starting a job. Each browser context blocks images, fonts, and media to reduce memory use. It does not click the final orange
challenge-submit button. Authentication comes from `SHIPD_STORAGE_STATE` or the saved state created by
`/shipd:auth`. `/shipd:auth` launches the installed browser as a normal visible process and attaches over local CDP,
which supports Google/SSO sign-in better than an automated browser launch.

The `auditor` tool is read-only apart from its report and `create_patches.sh`, takes a long time, and consumes Codex
usage. Invoke it only when the user asks, never in parallel, and run repeated requests sequentially after applying each
result. `quality-check` consumes
Shipd tokens; do not run overlapping invocations for the same challenge.

## Commands

`/checks --solve` runs the benchmark using `agent_prompt.md`; it requires `create_patches.sh`, that prompt file, and `Dockerfile`. Like the `quality-check` tool, it first runs `create_patches.sh` in the working directory to create `test.patch` (which supplies `test.sh` and the test files) and `solution.patch`, and stops if the script fails or does not create `test.patch`. The solver sees only clean `HEAD` plus the prompt text; the harness applies `test.patch` after the solver exits. `solution.patch` is not required by the solver; when present, the local reviewer receives it as our reference solution: it stays context only for the fairness review, and the reviewer also compares its non-test code logic with every solver's patch and lists, under "Suggested improvements to our solution", edge cases or logical errors a solver handles correctly that ours does not (no tests, docs, or style). `/checks --config` is separate and configures the Codex solver, reviewer and auditor settings. The `auditor` tool is enabled per project with `/analyze:on`.

| Command | Effect |
|---|---|
| `/checks` | Open a menu for config or solve |
| `/checks --solve` | Run isolated Codex CLI solvers and base/new tests, then use a local Codex CLI reviewer to assess test fairness and failed agents |
| `/checks --config` | Configure Solver model, Codex solver effort, solver and test timeouts, parallel agent count, the Codex reviewer, and the auditor tool |
| `/shipd:auth` | Open a browser for first-time Shipd sign-in and save the session |
| `/shipd:link <url>` | Save the Shipd job link for the current chat session |
| `/analyze:on` | Enable the `auditor` tool for the current project |
| `/analyze:off` | Disable the `auditor` tool for the current project |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run, stopping its active Fargate task or local Codex review. A cancelled run skips final report writing.

## Configuration

`/checks --config` opens the row-based settings menu with two sections:

- **Solver**: Solver model (`gpt-6-luna`, `gpt-6.2-sol`, or `gpt-6.2-astra`; default `gpt-6.2-sol`), solver effort (`low`, `medium`, `high`, `xhigh`, or `max`), one-shot timeout (10–90 minutes), test timeout per suite (5–60 minutes; default 15; the base and new test runs after each solver each get this limit), parallel agent count, and the Codex reviewer model (default `gpt-6.2-astra`), effort (default `high`), and timeout (10–60 minutes; default 20), stored under `solverReview` in `checks-config.json`. Solver effort defaults to `low` when unset and is passed to Codex as `-c model_reasoning_effort=<level>`. Any other Codex model ID saved in `checks-config.json` is passed through unchanged; Claude aliases saved by earlier versions map to `gpt-6-luna` (`haiku`), `gpt-6.2-sol` (`sonnet`) and `gpt-6.2-astra` (`opus`). Diffs, agent output, `agent_steps.jsonl` traces, base/new logs, and the local reviewer assessment are saved under `.pi/shipd-checks/<runId>/` and summarized in `shipd_report.json`.
- **Analysis Tools**: whether the analysis tools are enabled for this project, and the `auditor` tool's Codex settings: model (`gpt-6-luna`, `gpt-6.2-sol`, or `gpt-6.2-astra`; default `gpt-6.2-astra`), effort (default `high`), timeout per reviewer (10–90 minutes; default 40), and parallel reviewers (1–8; default 4), stored under `auditor` in `checks-config.json` (an `autoReview` block from earlier versions is still read). Fargate resources are selected automatically and are not configurable in this menu.

For each Codex solver, `shipd_report.json` records the CLI-reported input/cached-input/output/reasoning token totals, the final and peak request-context token counts, the model context-window size and utilization, and the model-request count. Context sizes come from the `token_count` events in the solver's Codex session rollout (each request's input tokens, cached tokens included), which is written to the solver's private `CODEX_HOME` and deleted with it. `totalTokens` subtracts reasoning tokens from raw input-plus-output, and the raw total is recorded alongside it. The local Codex reviewer records the CLI-reported usage. Per-agent, reviewer, and aggregate usage appears once under `solverTokenUsage`; `solverRunSummary` contains outcomes, aggregate test counts, and per-suite JUnit counts, while `solverReview` contains the assessment and reviewer model settings.

AWS credentials stay local. Configure the AWS CLI profile, then set `AWS_PROFILE`/`AWS_REGION` (or add
`fargate.awsProfile`/`fargate.region` to `checks-config.json`). The runner discovers the default
VPC, public subnets, security group, ECS cluster, and an account-scoped private S3 bucket unless
explicit IDs are configured. It uses the `FARGATE_SPOT` capacity provider only; there is no
On-Demand fallback. Spot interruptions are retried according to `fargate.maxRetries`.

### Fargate setup

1. Create a dedicated, least-privilege IAM user in the AWS Console (do not use root), create an
   access key under **Security credentials**, and save it locally in
   `%USERPROFILE%\\.aws\\credentials`—no AWS CLI is required:

   ```ini
   [shipd-static]
   aws_access_key_id = YOUR_ACCESS_KEY_ID
   aws_secret_access_key = YOUR_SECRET_ACCESS_KEY
   ```

   Use `"awsProfile": "shipd-static"` in the checks config. The AWS SDK reads this file directly.
   Keep it outside the repository, rotate the key periodically, and never paste it into chat or
   commit it. The IAM user needs the runtime ECS, S3, EC2-discovery, STS, and `iam:PassRole`
   permissions for the configured task/execution roles.

   Alternatively, AWS CLI browser login/SSO profiles work and are automatically refreshed by the
   SDK; CLI setup is optional.

2. Create an ECS task role with this trust policy (`ecs-tasks.amazonaws.com`) and an inline S3
   policy. Use an explicit bucket name so the policy stays narrow:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:GetObject", "s3:PutObject"],
       "Resource": "arn:aws:s3:::BUCKET_NAME/runs/*"
     }]
   }
   ```

   The task role is recommended for long-running jobs because temporary presigned URLs can expire
   while dependencies or agents are running; it is needed if a run may exceed the URL lifetime.

3. Create an ECS execution role trusted by `ecs-tasks.amazonaws.com`, attach the AWS-managed
   `service-role/AmazonECSTaskExecutionRolePolicy`, and create the CloudWatch log group. The
   execution role is used for `awslogs` and image startup; the task role is used for S3 data.

4. Add the role ARNs and bucket to `~/.pi/agent/checks-config.json`:

   ```json
   {
     "fargate": {
       "awsProfile": "shipd-static",
       "region": "us-east-1",
       "bucket": "BUCKET_NAME",
       "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/pi-shipd-checks-task",
       "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/pi-shipd-checks-execution",
       "logGroup": "/aws/ecs/pi-shipd-checks",
       "resourceProfile": "medium",
       "adaptiveResourceProfile": true,
       "maxRetries": 1
     }
   }
   ```
   `cluster`, `subnetIds`, and `securityGroupId` are optional when a default VPC is available.
   With `adaptiveResourceProfile: true`, solver-gap runs use `resourceProfile` initially and adapt
   on later runs (unless `projectProfiles` already overrides the repository). They upgrade when
   normalized CPU is at least 95% for more than seven minutes, downgrade when CPU is at least 95%
   for under two minutes, and otherwise retain the profile. Only the selected next profile is
   written to `projectProfiles`; CPU telemetry is included in `shipd_report.json` for Codex
   benchmark runs, but no telemetry history is retained. Quality patch prechecks always use the `medium`
   profile and do not update adaptive sizing. Set `projectProfiles` to override solver-gap
   resources per repository: `{"C:/path/to/repo":"large"}`.

5. Install the Codex CLI (`npm install --global @openai/codex`) and sign in once with `codex login` using your ChatGPT account, keeping the default file credential storage so `~/.codex/auth.json` exists. Before each run the extension checks that login and refreshes it with `codex app-server` when it might expire or be refreshed during the run (the run window is at least an hour and covers the task timeout and every Spot retry). The runner transfers the login through a private, server-side-encrypted S3 object, does not place it in the ECS task definition or bootstrap JSON, and deletes the local temporary copy and run object after the task stops. If the refresh fails, run `codex login` again. The worker installs `@openai/codex` with `npm`, so the project image needs Node.js. Configure the Solver model, thinking/effort level, count, and solver and test timeouts in `/checks --config` (the Fargate task may run for the solver timeout plus two test timeouts plus 30 minutes of setup slack), then run `/checks --solve`. Projects need `Dockerfile`, `agent_prompt.md`, and `create_patches.sh`, whose `test.patch` should add `test.sh` with `--output_path <file> base` and `--output_path <file> new` modes. A task role is required for runs that may exceed the 55-minute pre-signed URL lifetime; configure it before using longer solver timeouts.

Use `/analyze:on` and `/analyze:off` to control the `auditor` tool per project, like HPC. The
enabled project list is stored alongside the other settings in `~/.pi/agent/checks-config.json`.

The patch precheck always uses the `medium` Fargate profile. It applies `test.patch`, creates isolated workspaces with and without `solution.patch`, and runs the base suites concurrently in both workspaces followed by the new suites concurrently in both workspaces. It requires
`./test.sh base` to pass, requires every `./test.sh new` testcase to fail or error individually (with no suite-level error)
before `solution.patch`, then requires both base and new suites to pass after the solution patch. Pytest subtest totals are not treated as passing testcase records; emitted `<testcase>` statuses and explicit `SUBPASSED` records are used for the pre-solution invariant. A failed precheck aborts
before Shipd is opened and includes the Linux platform, a human-readable phase, and failed/errored test names in the tool error.

The `auditor` tool returns review findings, not edits; the caller changes the tests or solution. Invoke them only when the user asks, never in parallel, and run repeated requests
sequentially after applying each result.


```json
{
  "enabledProjects": ["/path/to/project"]
}
```

Use ↑/↓ to select a row and Enter/Space to change it. Settings are saved to `~/.pi/agent/checks-config.json`; solver
settings are nested under `solverGap`, the solve reviewer under `solverReview`, and the auditor under `auditor`.

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
| `src/submit.ts` | `quality-check`: Playwright draft syncing, Shipd's staged checks, scheduled polling, and report extraction |
| `src/command.ts` | The `/checks` command: argument parsing, `--config` flow, run orchestration |
| `src/agents.ts` | Runs the `--solve` benchmark review through the local Codex CLI |
| `src/analyze.ts` | The agent-callable `auditor` tool (rendering, result text) |
| `src/auditor.ts` | The auditor engine: workspace, reviewer plan, findings, synthesis grading, report |
| `src/auditor-prompts.ts` | Auditor reviewer and synthesis prompts |
| `src/auditor-data.ts` | Hosted Auto Review calibration distilled into general patterns |
| `src/codex-cli.ts` | Read-only local Codex CLI runner shared by the auditor and the `--solve` reviewer |
| `src/codex-auth.ts` | Checks the local Codex ChatGPT login before Fargate runs and forces a refresh through `codex app-server` when needed |
| `src/solvergap.ts` | Benchmark artifact-directory constant |
| `src/fargate-docker.ts` | Supported Dockerfile parsing for remote solver setup |
| `src/fargate-runner.ts` | ECS Fargate Spot/S3 orchestration for Codex CLI benchmark runs and patch-prechecks; retries and cleanup |
| `src/fargate-worker.ts` | ESM worker that runs isolated Codex CLI solvers or patch prechecks in the shared task |
| `src/resource-usage.ts` | Container CPU sampling for adaptive profile selection |
| `src/prompts.ts` | Focus-reviewer and `--solve` reviewer prompt text |
| `src/tools.ts` | Report-submission tool for the focus reviewers |
| `src/rubric.ts` | Embedded guidelines/fairness rubric text + per-role section loaders |
| `src/roles.ts` | The 3 reviewer roles (description/tests/solution) metadata |
| `src/report.ts` | `shipd_report.json` load/merge/summary logic |
| `src/config.ts` | `~/.pi/agent/checks-config.json` + `settings.json` helpers (models, reasoning efforts, shell path) |
| `src/git.ts` | Clean, non-mutating git `HEAD` snapshot into a scratch directory |
| `src/progress.ts` | Progress-bar widget rendering |
| `src/state.ts` | Shared "run in progress" / cancel state between the command and the shortcut |
| `src/types.ts` | Shared TypeScript types |

To change reviewer strictness or wording, edit `prompts.ts`. To change the rubric/fairness text
itself, edit `rubric.ts`. Agent result-submission tools are defined in `tools.ts` and wired up in `agents.ts`; direct
extension tools are registered from their feature modules and synchronized in `tool-sync.ts`.

## Development

```bash
npm install
npm run --workspace @sreetej510/pi-shipd-checks check     # biome + typecheck
npm run --workspace @sreetej510/pi-shipd-checks format
```
