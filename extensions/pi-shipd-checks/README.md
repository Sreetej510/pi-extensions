# @sreetej510/pi-shipd-checks

A [pi](https://github.com/earendil-works/pi) coding agent extension that analyzes benchmark
tests for behavioral coverage gaps, fairness, and test strength.

## What it does

For `/checks`:

1. Snapshots the current git `HEAD` into a throwaway temp directory (via
   `git archive HEAD | tar -x`) — it never touches your working directory, staged, or
   uncommitted changes.
2. Copies `agent_prompt.md`, `solution.patch`, and `test.patch` from your project root into
   that temp dir.
3. Optionally runs the solver gap finder: several (configurable, default 3) TDD-style solver
   agents, each in its own throwaway git repo with `test.patch` and `agent_prompt.md` applied
   (never `solution.patch`), given write/edit/bash access to iterate until `./test.sh new`
   passes or they give up. The extension independently re-verifies each solver's result and
   compares passing solver diffs with the reference to surface behavioral gaps.
4. Runs solver workers in one AWS ECS Fargate Spot task when enabled, with the source snapshot
   and partial results in S3. A Spot interruption retries the task and resumes completed
   solver indexes.
5. Posts a chat summary and merges solver results into `shipd_report.json` in your project root.

The agent-callable `gap-finder` tool runs one exhaustive read-only agent over the prompt, repository, and tests. It
reviews requirements sentence by sentence, performs its own evidence and fairness check, and returns confirmed
behavioral test gaps in `details.testGaps`.

The agent-callable `solution-precheck` tool runs one exhaustive read-only solution-quality agent and returns findings in
`details.solutionAuditFindings`. It checks contract gaps, regressions, failure safety, architecture, dead code, and
unrelated changes.

The agent-callable `quality-check` tool runs `create_patches.sh` in the current working directory, reads
`agent_prompt.md`, `test.patch`, and `solution.patch`, first runs a Fargate patch precheck against a clean `HEAD`, then
fills the authenticated Shipd draft fields, runs fresh checks with a `Run` button, reruns checks marked `Stale`, skips
current checks, starts Test Quality before Solution Quality in one browser tab, waits for any started jobs, and returns only the useful report data:
`details.testQuality.coverageSuggestions`, `details.testQuality.tests` filtered to items whose `fairness` is exactly
`"Not fair"`, and the complete `details.solutionQuality.evaluation` block. Its compact UI is labeled `Quality Checks`,
shows live elapsed time, and only displays unfair-test count, suggestion count, code-quality score, and
comprehensiveness score. It takes no parameters. It uses one fresh headless browser tab at a time: it closes the
browser after starting the needed jobs, checks after 5 minutes, then reopens every 90 seconds until those jobs finish. If
all checks are current, it uses existing reports without starting a job. Each
browser context blocks images, fonts, and media to reduce memory use. It does not click the final orange
challenge-submit button. Authentication comes from `SHIPD_STORAGE_STATE` or the saved state created by
`/shipd:auth`. `/shipd:auth` launches the installed browser as a normal visible process and attaches over local CDP,
which supports Google/SSO sign-in better than an automated browser launch.

The analysis tools are read-only and each uses one agent. Invoke them only when the user asks, never in parallel, and
run repeated requests sequentially after applying each result. `quality-check` consumes Shipd tokens; do not run
overlapping invocations for the same challenge.

## Commands

`--config` must be used alone; solver-gap-finder is the only `/checks` run mode. The gap-finder and solution-precheck tools are enabled per project with `/analyze:on`.

| Command | Effect |
|---|---|
| `/checks` | Open a menu with config and solver-gap-finder options |
| `/checks --config` | Configure reviewer, solver, and analysis models |
| `/checks --solver-gap-finder` | Run several solver agents TDD-style against `agent_prompt.md` + `test.patch`, then compare their solutions to the real solution to find gaps |
| `/shipd:auth` | Open a browser for first-time Shipd sign-in and save the session |
| `/shipd:link <url>` | Save the Shipd job link for the current chat session |
| `/analyze:on` | Enable the gap-finder and solution-precheck tools for the current project |
| `/analyze:off` | Disable the gap-finder and solution-precheck tools for the current project |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run. Cancellation is propagated to active solver sessions and their spawned shell/test process trees; post-cancel verification, comparison, and artifact writing are skipped.

## Configuration

`/checks --config` opens the row-based settings menu with two sections:

- **Solver**: reviewer model and thinking level for the final solver-result reviewer, plus the
  solver model, thinking level, timeout, parallel solver count, and artifact-saving setting.
- **Analysis Tools**: timeout, model, and thinking level shared by the agent-callable gap-finder and
  solution-precheck tools. The timeout applies to each read-only agent. These are stored under
  `analyzeGap.timeoutMinutes`, `analyzeGap.provider`, `analyzeGap.modelId`, and
  `analyzeGap.thinkingLevel`. Fargate resources are selected automatically and are not configurable in this menu.

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

   The task role is required for long-running jobs because temporary presigned URLs can expire
   while dependencies or agents are running.

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
   With `adaptiveResourceProfile: true`, the first solver-gap or quality patch-precheck run for
   a repository uses `resourceProfile` (unless `projectProfiles` already overrides it); later runs
   upgrade when normalized CPU is at least 95% for more than seven
   minutes, downgrade when CPU is at least 95% for under two minutes, and otherwise retain the
   profile. Only the selected next profile is written to `projectProfiles`; CPU telemetry is
   included in `shipd_report.json` for solver-gap runs, but no telemetry history is retained. Set
   `projectProfiles` to override resources per repository:
   `{"C:/path/to/repo":"large"}`.

5. Restart pi, use `/checks --config` to select the solver and reviewer models, then run
   `/checks --solver-gap-finder`. Projects need `Dockerfile`, `agent_prompt.md`,
   `solution.patch`, `test.patch`, and `test.sh`.

For a Command Code subscription model, install the provider in the local pi if needed
(`pi install npm:pi-commandcode-provider`), then authenticate it with `/login` (**Use a
subscription** → **Command Code**) and make sure the plan includes Provider API access. Select a
`commandcode/...` solver model. The standalone Fargate worker bundles the pinned
`pi-commandcode-provider` package and registers it before starting solver sessions; installing a
separate Command Code CLI or npm package in the task image is not required. The task needs
outbound HTTPS access to the Command Code API. The runner uploads only the selected provider
credential from the local pi auth state for the task; never put the credential in project files.

Use `/analyze:on` and `/analyze:off` to control the gap-finder and solution-precheck tools per project, like HPC. The
enabled project list is stored alongside the other settings in `~/.pi/agent/checks-config.json`.

The patch precheck applies `test.patch`, creates isolated workspaces with and without `solution.patch`, and runs the
base suites concurrently in both workspaces followed by the new suites concurrently in both workspaces. It requires
`./test.sh base` to pass, requires every `./test.sh new` testcase to fail or error individually (with no suite-level error)
before `solution.patch`, then requires both base and new suites to pass after the solution patch. A failed precheck aborts
before Shipd is opened and includes the Linux platform, a human-readable phase, and failed/errored test names in the tool error.

The `gap-finder` and `solution-precheck` tools are read-only and return repair recommendations; the caller changes the
tests, prompt, or solution. Invoke them only when the user asks, never in parallel, and run repeated requests
sequentially after applying each result.


```json
{
  "enabledProjects": ["/path/to/project"]
}
```

Use ↑/↓ to select a row and Enter/Space to change it. The currently selected model is shown first
in its picker. Model settings are saved to `~/.pi/agent/checks-config.json`; solver settings are nested
under `solverGap` and analyze-tool model settings under `analyzeGap`.

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
| `src/submit.ts` | `quality-check`: Playwright draft filling, sequential quality checks, scheduled polling, and report extraction |
| `src/command.ts` | The `/checks` command: argument parsing, `--config` flow, run orchestration |
| `src/agents.ts` | Spawns and races the gap-finder, solution-precheck, reviewer, and solver agent sessions |
| `src/solvergap.ts` | Local solver result persistence and comparison artifacts |
| `src/fargate-docker.ts` | Supported Dockerfile parsing for remote solver setup |
| `src/fargate-runner.ts` | ECS Fargate Spot/S3 orchestration for solver and patch-precheck tasks, retries, cleanup, and telemetry |
| `src/fargate-worker.ts` | ESM worker that runs solver workspaces or patch prechecks in the shared task |
| `src/resource-usage.ts` | Container CPU sampling for adaptive profile selection |
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
