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
3. Optionally runs a two-agent behavioral test-gap analysis: one finder works through every
   meaningful prompt sentence, submitting positive and negative candidates for each; a strict
   reviewer then filters the combined list for fair, public behavioral assertions.
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
5. Runs the solver workers in one AWS ECS Fargate Spot task (when the solver finder is enabled),
   with the source snapshot and partial results in S3. A Spot interruption retries the task and
   resumes solver indexes whose results were already uploaded; the final comparison still runs
   locally.
6. Posts a chat summary and merges the gap-finder results into `shipd_report.json` in your
   project root. Running either finder separately builds up one combined report without any
   PASS/FAIL verdict.

## Commands

The two finder flags are additive/combinable; `--config` must be used alone.

| Command | Effect |
|---|---|
| `/checks` | Open a menu with config, solver-gap-finder, and gap-finder options |
| `/checks --config` | Configure behavioral and solver gap-finder models |
| `/checks --solver-gap-finder` | Run several solver agents TDD-style against `agent_prompt.md` + `test.patch`, then compare their solutions to the real solution to find gaps |
| `/checks --gap-finder` | Find gaps sentence-by-sentence, then review them for fairness |
| `/analyze:on` | Enable the agent-callable Gap Finder tool for the current project |
| `/analyze:off` | Disable the agent-callable Gap Finder tool for the current project |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run. Cancellation is propagated to active solver sessions and their spawned shell/test process trees; post-cancel verification, comparison, and artifact writing are skipped.

## Configuration

`/checks --config` opens the row-based settings menu with four sections:

- **Reviewer**: model and thinking level used by the behavioral gap finders, validator, and
  solver-solution comparison agent.
- **Solver**: model and thinking level for TDD solver agents, plus their timeout, parallel solver
  count, and artifact-saving setting.
- **Analyze Tool**: pick the model + thinking level for the agent-callable Gap Finder tool.
- **Fargate**: choose the shared-task resource profile for the current project: `small` (1 vCPU,
  2 GB), `medium` (2 vCPU, 4 GB), or `large` (4 vCPU, 8 GB). Adaptive sizing can select the
  next profile from task telemetry after each run.

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
   With `adaptiveResourceProfile: true`, the first run uses `resourceProfile`; later runs upgrade
   when normalized CPU is at least 90% for 40% or more of the runtime, downgrade when that is
   below 10%, and otherwise retain the profile. Set
   `projectProfiles` to override resources per repository:
   `{"C:/path/to/repo":"large"}`.

5. Restart pi, use `/checks --config` to select the solver model and project resource profile,
   then run `/checks --solver-gap-finder`. Projects need `Dockerfile`, `agent_prompt.md`,
   `solution.patch`, `test.patch`, and `test.sh`.

Use `/analyze:on` and `/analyze:off` to control the tool per project, like HPC. The enabled project
list is stored alongside the other settings in `~/.pi/agent/checks-config.json`:

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
| `src/command.ts` | The `/checks` command: argument parsing, `--config` flow, run orchestration |
| `src/agents.ts` | Spawns and races the gap-finder/reviewer/solver agent sessions |
| `src/solvergap.ts` | Local solver result persistence and comparison artifacts |
| `src/fargate-docker.ts` | Supported Dockerfile parsing for remote solver setup |
| `src/fargate-runner.ts` | ECS Fargate Spot/S3 orchestration, retries, cleanup, and task telemetry |
| `src/fargate-worker.ts` | ESM worker that runs concurrent solver workspaces in the shared task |
| `src/resource-usage.ts` | Container CPU/memory sampling for adaptive profile selection |
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
