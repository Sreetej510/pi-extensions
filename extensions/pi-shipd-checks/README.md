# @sreetej510/pi-shipd-checks

A [pi](https://github.com/earendil-works/pi) coding agent extension for benchmark-test analysis, prompt humanization, and Shipd quality checks.

## What it does

For `/checks solve`:

1. Snapshots only the current git `HEAD` into a throwaway temp directory; the source checkout is never modified.
2. Sends the exact contents of `agent_prompt.md` as each solver's sole first user message. No prompt file, task Dockerfile, `test.patch`, `solution.patch`, or uncommitted test files are overlaid into a solver workspace. The Dockerfile is used only by the harness to provision the Fargate environment.
3. Runs several configurable (default 3) independent Claude Code CLI solver invocations in parallel, each with its own isolated clean-HEAD workspace and only the `Bash` tool enabled. Captures each solver's `stream-json` trace of assistant and tool events (not private chain-of-thought). There is no test-driven repair loop, and the test patch remains unavailable until that solver exits.
4. After a solver finishes, the harness applies `test.patch` to its workspace, then runs `bash test.sh --output_path <file> base` and `bash test.sh --output_path <file> new` as an unprivileged user with a fresh writable `HOME` and cache. It captures both full logs.
5. After all solvers exit and their tests run, the read-only local Pi reviewer receives an untouched clean-HEAD tree plus `agent_prompt.md`, all patch files, standalone copies of new test files, each solver's patch, and every solver's test logs. No patch is applied in the review workspace.
6. Runs the Claude CLI solvers inside one AWS ECS Fargate Spot task. A Spot interruption retries the task and resumes completed solver indexes. The local Claude Code login file is transferred through private, server-side-encrypted S3 objects, then run objects are deleted.
7. Posts a chat summary and logs results in `.pi/shipd-checks/<runId>/`, including `agent_steps.jsonl` per solver, and `shipd_report.json` in your project root.

The agent-callable `gap-finder` tool runs one exhaustive read-only agent over the prompt, repository, and tests. It
reviews requirements sentence by sentence, performs its own evidence and fairness check, and returns confirmed
behavioral test gaps in `details.testGaps`.

The agent-callable `solution-precheck` tool runs one exhaustive read-only solution-quality agent and returns findings in
`details.solutionAuditFindings`. It checks contract gaps, regressions, failure safety, architecture, dead code, and
unrelated changes.

The opt-in `humanize-agent-prompt` tool reads the complete current-project `agent_prompt.md`, requests 3 experimental
rewrite drafts from the CoreWeave Nemotron LoRA, scores every draft through a configured HTTPS detector endpoint, and
returns the top 2 as JSON (defaults are configurable). It never edits files: the local agent must review every source
requirement before applying a draft. Detector scores are exploratory triage, not confidence, authorship, semantic-fidelity,
or correctness evidence. The adapter is experimental and was trained on all 519 pairs, including records originally
assigned to EVAL and HOLDOUT; treat all outputs as unapproved drafts.

The agent-callable `quality-check` tool runs `create_patches.sh` in the current working directory and reads
`agent_prompt.md`, `test.patch`, and `solution.patch`. Before checking or running Prompt Quality, it uploads all three
contents to the authenticated Shipd draft fields and waits for the editor update to settle. It computes a SHA-256 of the
exact prompt content. The last passing prompt hash is stored as a custom entry in the current chat session. If the
hash matches, it skips the Shipd Prompt Quality check entirely and reports a cached `PASS`; if it differs or is absent, it
checks the refreshed status after filling the fields and runs only when the check is stale or has a `Run` button. Otherwise it
uses the current report. A new hash is saved only after Prompt Quality passes. On failure, only `promptQuality` is returned; there are no Test/Solution results or `stoppedReason`.
Only after Prompt Quality passes or has a matching cached pass does it run the Fargate patch precheck against a clean `HEAD`;
only if that passes does it run Test Quality and Solution Quality. Those checks run fresh jobs, rerun stale reports, skip
current reports, and wait for started jobs. It returns only the useful report data:
`details.testQuality.verdict`, `details.testQuality.coverageSuggestions`, `details.testQuality.unfairnessCount`, and
`details.testQuality.tests` filtered to blocks whose `concerns` array is non-empty or whose `fairness` is exactly `"Not fair"`,
`details.promptQuality` and its verdict, reason, and major non-AI comments (only `category`, `quote`, and `suggestion`; AI-category comments are omitted), plus
`details.solutionQuality.verdict` and its evaluation fields with `level` and `overall_feedback` removed. Fairness-only blocks
with an empty `concerns` array are marked `Not fully fair`. Test Quality is `PASS` only when there are no filtered unfair
tests, reported `unfairTestCount` is zero (when present), and coverage suggestions are empty. Prompt Quality is `PASS` only when the completed report and evaluation
verdicts are both `PASS`, `requirementCount` is not blocking, and the AI gate does not flag the prompt. The prompt is
flagged as AI when a Prompt Quality comment category identifies AI (for example, `ai_generated`). AI-category quote and suggestion details are omitted; guidance recommends humanizer for a broader rewrite or a small targeted manual edit for a recent change. A cached Prompt Quality pass is marked
`cached: true`. Test and Solution Quality return compact `PASS` results; failures include only actionable feedback. Prompt
Quality failures return a concise reason or major comments. Returned quality results omit `completed` and `skipped`. Its
compact UI is labeled `Quality Checks`, shows live elapsed time, and summarizes each stage; it does not print full pass
criteria in the tool description. It takes no parameters. Transient status and report-dialog operations retry up to three
times; after clicking Run, the tool verifies the stale state clears or the job shows running before it begins polling. It
uses one fresh headless browser tab at a time: for Prompt Quality
it checks after 2 minutes, then every 30 seconds; for Test and Solution Quality it checks after 5 minutes, then reopens
every 90 seconds until those jobs finish, with no client-side overall timeout. If all checks are current, it uses existing
reports without starting a job. Each browser context blocks images, fonts, and media to reduce memory use. It does not click the final orange
challenge-submit button. Authentication comes from `SHIPD_STORAGE_STATE` or the saved state created by
`/shipd:auth`. `/shipd:auth` launches the installed browser as a normal visible process and attaches over local CDP,
which supports Google/SSO sign-in better than an automated browser launch.

The gap-finder and solution-precheck tools are read-only and each uses one agent. Invoke them only when the user asks,
never in parallel, and run repeated requests sequentially after applying each result. The prompt humanizer also requires
an explicit user request and sends the prompt to CoreWeave and the configured detector endpoint. `quality-check` consumes
Shipd tokens; do not run overlapping invocations for the same challenge.

## Commands

`/checks solve` runs the benchmark using `agent_prompt.md`; it requires that prompt file, `Dockerfile`, and `test.patch` (which supplies `test.sh` and the test files). The solver sees only clean `HEAD` plus the prompt text; the harness applies `test.patch` after the solver exits. `solution.patch` is not required by the solver; when present, the local reviewer receives it as the task-author reference patch. `/checks --config` is separate and configures the local Pi reviewer/analysis models and Claude solver settings. The gap-finder, solution-precheck, and prompt-humanizer tools are enabled per project with `/analyze:on`.

| Command | Effect |
|---|---|
| `/checks` | Open a menu for settings or `solve` |
| `/checks solve` | Run isolated Claude CLI solvers and base/new tests, then use a local Pi reviewer to assess test fairness and failed agents |
| `/checks --config` | Configure local Pi reviewer/analysis models, Solver model (Claude), Claude solver effort, timeout, and parallel agent count |
| `/shipd:auth` | Open a browser for first-time Shipd sign-in and save the session |
| `/shipd:link <url>` | Save the Shipd job link for the current chat session |
| `/analyze:on` | Enable the gap-finder, solution-precheck, and prompt-humanizer tools for the current project |
| `/analyze:off` | Disable the gap-finder, solution-precheck, and prompt-humanizer tools for the current project |

**Shortcut:** `Ctrl+Shift+X` cancels an in-progress `/checks` run, stopping its active Fargate task or local Pi review. A cancelled run skips final report writing.

## Configuration

`/checks --config` opens the row-based settings menu with two sections:

- **Solver**: Solver model (Claude: `haiku`, `sonnet`, or `opus`), solver effort (`low`, `medium`, `high`, `xhigh`, or `max`), one-shot timeout, parallel agent count, and the local Pi reviewer model/thinking level. Solver effort defaults to `low` when unset and is passed explicitly to Claude. Diffs, agent output, `agent_steps.jsonl` traces, base/new logs, and the local reviewer assessment are saved under `.pi/shipd-checks/<runId>/` and summarized in `shipd_report.json`.
- **Analysis Tools**: timeout, model, and thinking level for the separate agent-callable gap-finder and solution-precheck tools. The timeout applies to each read-only agent. These are stored under `analyzeGap.timeoutMinutes`, `analyzeGap.provider`, `analyzeGap.modelId`, and `analyzeGap.thinkingLevel`. Fargate resources are selected automatically and are not configurable in this menu.

For each Claude solver, `shipd_report.json` records CLI-reported input/cache/output token totals, final and peak request-context token counts, context-window size/utilization, API-call count, and cost when available. When the CLI explicitly reports thinking tokens, `totalTokens` subtracts them from raw input-plus-output; otherwise it remains the raw total. The raw total is also recorded when a subtraction is made. The local Pi reviewer records session usage when the provider reports it. Per-agent, reviewer, and aggregate usage appears once under `solverTokenUsage`; `solverRunSummary` contains outcomes, aggregate test counts, and per-suite JUnit counts, while `solverReview` contains the assessment and reviewer model settings.

The humanizer candidate counts are configured separately in `~/.pi/agent/checks-config.json`. `candidateCount` controls
how many drafts are requested from CoreWeave (1–10); `topCount` controls the maximum returned (1–10, capped at
`candidateCount`). Only drafts below the detector's reported Human-like cutoff are returned; if none pass, `candidates` is empty:

```json
{
  "promptHumanizer": {
    "candidateCount": 3,
    "topCount": 2
  }
}
```

The detector runs as one on-demand `FARGATE_SPOT` task per humanizer invocation. The generated drafts are sent as one batch through short-lived, pre-signed S3 URLs; the task exits after scoring and the extension removes the run objects. There is no always-on detector task, API Gateway endpoint, or NLB in this execution path. The current task definition is 1 vCPU/2 GiB; the smoke test returned scores in about 83 seconds overall (the task ran about 27 seconds). The earlier 2-vCPU/4-GiB test took about 68 seconds; cold-start time varies. From the Pi agent directory, deploy the worker image/task definition with `bash shipd-humanizer-assets/shipd-detector/deploy_fargate_spot_worker.sh` before using the humanizer. The CoreWeave key can come from `COREWEAVE_API_KEY`, `COREWEAVE_API_KEY_FILE`, or the local path in `promptHumanizer.coreweaveApiKeyFile`; only the path, never the secret, is stored in `checks-config.json`. `COREWEAVE_BASE_URL` defaults to `https://api.inference.wandb.ai/v1`; `COREWEAVE_PROJECT` and `NEMOTRON_MODEL` default to the handoff's v1 LoRA. Output is intentionally compact: each candidate has rank, text, and a raw `triage_score`. It is exploratory triage, not a confidence percentage. Candidates that fail the detector's Human-like cutoff are discarded; passing candidates are ranked by ascending detector score, up to `topCount`. A CoreWeave `finish_reason: "length"` or reported completion count at the 900-token cap is rejected before scoring. If CoreWeave reports a normal stop despite an incomplete draft, there is no reliable automatic completeness check; compare each draft with the source. Detector scoring processes the full text in windows.

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
   written to `projectProfiles`; CPU telemetry is included in `shipd_report.json` for Claude
   benchmark runs, but no telemetry history is retained. Quality patch prechecks always use the `medium`
   profile and do not update adaptive sizing. Set `projectProfiles` to override solver-gap
   resources per repository: `{"C:/path/to/repo":"large"}`.

5. Sign in to Claude Code locally so `%USERPROFILE%\\.claude\\.credentials.json` exists. The Fargate runner copies that login file for this run; it does not upload Pi's `auth.json`. Configure the Solver model (Claude), thinking/effort level, count, and timeout in `/checks --config`, then run `/checks solve`. Projects need `Dockerfile`, `agent_prompt.md`, and `test.patch`, which should add `test.sh` with `--output_path <file> base` and `--output_path <file> new` modes. A task role is recommended for runs that may exceed the 55-minute pre-signed URL lifetime.

Use `/analyze:on` and `/analyze:off` to control the gap-finder, solution-precheck, and prompt-humanizer tools per project, like HPC. The
enabled project list is stored alongside the other settings in `~/.pi/agent/checks-config.json`.

The patch precheck always uses the `medium` Fargate profile. It applies `test.patch`, creates isolated workspaces with and without `solution.patch`, and runs the base suites concurrently in both workspaces followed by the new suites concurrently in both workspaces. It requires
`./test.sh base` to pass, requires every `./test.sh new` testcase to fail or error individually (with no suite-level error)
before `solution.patch`, then requires both base and new suites to pass after the solution patch. Pytest subtest totals are not treated as passing testcase records; emitted `<testcase>` statuses and explicit `SUBPASSED` records are used for the pre-solution invariant. A failed precheck aborts
before Shipd is opened and includes the Linux platform, a human-readable phase, and failed/errored test names in the tool error.

The `gap-finder` and `solution-precheck` tools are read-only and return repair recommendations; the caller changes the
tests, prompt, or solution. Invoke them only when the user asks, never in parallel, and run repeated requests
sequentially after applying each result. The humanizer does not modify `agent_prompt.md`; validate all requirements and
apply any selected draft locally.


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
| `src/agents.ts` | Spawns and races local Pi gap-finder, solution-precheck, and benchmark-review sessions |
| `src/solvergap.ts` | Benchmark artifact-directory constant |
| `src/fargate-docker.ts` | Supported Dockerfile parsing for remote solver setup |
| `src/fargate-runner.ts` | ECS Fargate Spot/S3 orchestration for Claude CLI benchmark runs, patch-prechecks, and detector tasks; retries and cleanup |
| `src/fargate-worker.ts` | ESM worker that runs isolated Claude CLI solvers or patch prechecks in the shared task |
| `src/resource-usage.ts` | Container CPU sampling for adaptive profile selection |
| `src/prompts.ts` | All prompt text sent to those agents |
| `src/tools.ts` | Custom tools the agents call to submit their structured results |
| `src/rubric.ts` | Embedded guidelines/fairness rubric text + per-role section loaders |
| `src/roles.ts` | The 3 reviewer roles (description/tests/solution) metadata |
| `src/report.ts` | `shipd_report.json` load/merge/summary logic |
| `src/config.ts` | `~/.pi/agent/checks-config.json` + `settings.json` helpers (models, humanizer counts, thinking levels, shell path) |
| `src/humanize.ts` | Opt-in CoreWeave draft generation, detector scoring, and ranked JSON output |
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
