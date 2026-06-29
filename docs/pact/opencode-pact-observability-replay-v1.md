# OpenCode PACT Observability and Replay v1 Design

## Goal

Make each OpenCode PACT round self-explaining, replay-exportable, and governed by a Humanize-style review loop.

Today the plugin can start a PACT loop, keep a todo and goal tracker, run a worker, run a reviewer, and continue from reviewer feedback. v1 extends that into a Humanize-inspired loop with a stronger plan ledger, protected goal tracker, full alignment checks, review phase, finalize phase, and replay artifacts.

For CLI and LoLBench, the default round boundary is driver-owned `opencode run` exit: one worker process equals one round. When the worker process exits, the driver synchronously captures patch/snapshot/trajectory artifacts, invokes the reviewer, writes the result/replay bundle, and emits the next round prompt. The OpenCode `session.idle` path remains as an interactive fallback.

For retries after planner or outer timeout cost has already been paid, the driver supports explicit Round00 resume. `--resume-loop <loopDir>` / `PACT_RESUME_LOOP_DIR` with `round0` mode validates an existing Round00 package, creates a fresh loop in the target workspace, copies canonical plan/todo/goal-tracker artifacts, records the resume source, regenerates `round-01-prompt.md`, and starts directly at round1. This keeps the benchmark workspace clean while avoiding a second planner call.

In benchmark strict mode, worker prompts and tool reads are separated from reviewer-only evidence. The worker can read canonical plan/ledger files, its prompt, contract, summary, continuation package, and pre-snapshot. Raw feedback, verification logs, replay bundles, event logs, evidence, review outputs, and captured patches remain available for the driver, reviewer, reports, and humans, but are not fed back into worker rounds by default.

LoLBench defaults now use a public-loop/final-hidden split. Each worker round may run only worker-safe round verification: patch apply plus an optional public build/self-check command. It must not run LoLBench hidden `pact-gate`, must not apply `eval_tests.patch`, and must not expose F2P/P2P to the worker. Only after the reviewer writes candidate `PACT_COMPLETE` does the driver run the LoLBench hidden final gate for scoring/reporting artifacts. Hidden final failure stops the loop as unresolved; it is not reopened into worker feedback in v1.

v1 adds a small artifact chain under `.pact/loops/<loopID>/` so every round can answer:

1. What was the round input?
2. What constraints did the worker see?
3. What key actions happened?
4. What patch was produced, and is it usable?
5. What did the reviewer decide?
6. Can this checkpoint be exported for later replay?

## Non-Goals

- No dashboard.
- No workflow mutation promotion.
- No full Agent Team schema for router, mailbox, tiebreaker, or patch merge.
- No raw provider request or response dumps.
- No full transcript dump as the default artifact.
- No OpenCode core changes unless plugin-only implementation hits a hard blocker.
- No true Claude Code-style Stop hook in v1. CLI/LoLBench uses driver-owned `opencode run` exit as the reviewer gate; OpenCode `session.idle` remains a fallback for interactive server usage.
- No BitLesson, push-every-round, plan quiz, or Claude-specific Task system.

## Stage Model

| Stage                 | Input                                                                                                                       | Files Written                                                                                              | Later Use                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Loop Start            | Plan file, project root, worker session, max rounds, full alignment interval, planner backend/model, reviewer backend/model, worker backend/model/config source | `state.json`, `loop-manifest.json`, `plan.md`, `todo.md`, `goal-tracker.md`, workspace `.git/info/exclude` | Establish run identity, goal, plan anchor, active session, worker attribution, and loop phase. |
| Round00 Resume        | Existing loop directory with complete Round00 package, fresh project root, max rounds, current worker/reviewer config       | `state.json`, `loop-manifest.json`, `resume-source-loop-manifest.json`, copied Round00 files, regenerated `round-01-prompt.md`, workspace `.git/info/exclude` | Restart from canonical planning without re-running planner or reusing partial worker output.  |
| Round Start           | Current state, todo, goal tracker, previous feedback                                                                        | `round-XX-state.json`, `round-XX-context.json`                                                             | Explain the checkpoint input and provide replay context.                                     |
| Worker Execution      | Worker prompt, repository state, summarized tool events                                                                     | `round-XX-events.jsonl`, `round-XX-contract.md`, `round-XX-summary.md`                                      | Show key actions, worker-declared scope, and detect missing summary or worker failure.        |
| Patch Capture         | Repository diff at round end                                                                                                | `round-XX-workspace.patch`, `round-XX-eval.patch`, `round-XX-test.patch`, `round-XX-patch-artifact.json`    | Determine empty patch, changed files, patch hash, and replay or eval candidate.              |
| Public Round Verification | Round eval patch, patch metadata, optional public build/self-check command                                               | `round-XX-verification.json`, `round-XX-verification.log`                                                  | Check patch apply/public build facts without hidden benchmark feedback.                      |
| Implementation Review | Plan, goal tracker, round summary, patch artifact, public verification                                                       | `round-XX-review-prompt.md`, `round-XX-review.md`, `round-XX-review-decision.json`, `round-XX-feedback.md` | Gate implementation progress and produce continuation or review-phase input.                 |
| Full Alignment Review | Plan, goal tracker, recent round history, patch artifact                                                                    | `round-XX-review-prompt.md`, `round-XX-review.md`, `round-XX-feedback.md`                                  | Detect forgotten ACs, unjustified deferrals, and stalled progress without stopping the loop. |
| Review Phase          | Completed implementation signal, current patch, round summary                                                               | `round-XX-review-prompt.md`, `round-XX-review.md`, `round-XX-feedback.md`                                  | Perform a code-review-oriented pass before finalization.                                     |
| Final Hidden Gate     | Reviewer candidate completion, eval patch, LoLBench suite selection                                                         | `final-hidden-gate-<suite>.json`, `final-hidden-gate-<suite>.log`, `final-hidden-gate-summary.json`, `final-result.json` | Score/report hidden benchmark outcome without feeding it to workers.                         |
| Finalize Phase        | Review phase completion, final verification summary                                                                         | `finalize-summary.md`, `complete-state.md`                                                                 | Final verification and terminal completion.                                                  |
| Round Result          | Round state, events, patch artifact, review decision                                                                        | `round-XX-result.json`                                                                                     | Classify failure and expose minimal metrics for batch analysis.                              |
| Replay Export         | Round context, worker prompt, feedback, patch/result metadata                                                               | `replay-case.json`                                                                                         | Freeze a checkpoint for repeated execution or future A/B comparison.                         |

## File Contract

### `loop-manifest.json`

Run-level metadata.

Minimum fields:

- `schema`: `"pact-loop-manifest/v1"`
- `loop_id`
- `project_root`
- `plan_file`
- `created_at`
- `max_rounds`
- `next_round`: next worker round cursor
- `current_round`: deprecated compatibility alias for `next_round`
- `attempted_worker_rounds`: implementation worker runs that were launched
- `completed_worker_rounds`: implementation worker runs that exited and reached patch capture
- `reviewed_worker_rounds`: implementation worker runs with a reviewer decision, including reviewer failure/timeout decisions
- `full_alignment_interval`
- `phase_config`
- `planner_backend`
- `planner_model`
- `reviewer_backend`
- `reviewer_model`
- `worker_backend`
- `worker_model`
- `worker_config_source`
- `goal_tracker_immutable_sha256`
- `base_commit`
- `active_session_id`
- `artifact_version`: `1`

Purpose: make a loop indexable without reading every markdown file.

### `resume-source-loop-manifest.json`

Present only for Round00 resume loops.

Minimum fields: exact copy of the source loop's `loop-manifest.json`.

The new loop's own `loop-manifest.json` records:

- `resume_mode`: `"round0"`
- `resume_source_loop`
- `resume_source_loop_id`
- `round0_reused`: `true`

Purpose: preserve provenance when a fresh workspace reuses an existing canonical Round00 package and restarts from round1.

### `round-XX-state.json`

Mutable round lifecycle state.

Minimum fields:

- `schema`: `"pact-round-state/v1"`
- `loop_id`
- `round`
- `phase`: one of `round_started`, `worker_waiting`, `summary_missing`, `patch_captured`, `review_started`, `review_finished`, `round_finished`
- `loop_phase`: one of `implementation`, `full_alignment`, `review`, `finalize`, `complete`, `stopped`
- `started_at`
- `updated_at`
- `summary_path`
- `review_path`
- `feedback_path`
- `result_path`

Purpose: identify where a round currently is or where it failed.

### `round-XX-context.json`

Stable round input context.

Minimum fields:

- `schema`: `"pact-round-context/v1"`
- `loop_id`
- `round`
- `session_id`
- `worker_agent`
- `worker_backend`
- `worker_model`
- `worker_config_source`
- `loop_phase`
- `planner_backend`
- `planner_model`
- `reviewer_backend`
- `reviewer_model`
- `prompt_path`
- `todo_path`
- `goal_tracker_path`
- `feedback_path`
- `todo_sha256`
- `goal_tracker_sha256`
- `feedback_sha256`

Purpose: explain what the worker was asked to work from.

### `round-XX-events.jsonl`

Append-only event summary for the round.

Event types:

- `round_started`
- `tool_before`
- `tool_after`
- `summary_missing`
- `patch_captured`
- `review_started`
- `review_finished`
- `round_finished`

Each event line includes:

- `schema`: `"pact-event/v1"`
- `time`
- `loop_id`
- `round`
- `type`
- `session_id`
- event-specific `data`

Tool event data is redacted and summarized. Do not write full raw output by default.

Purpose: show what happened without turning the artifact directory into a transcript landfill.

### `round-XX-workspace.patch`

The full patch representing the worker-visible repository change for this round, excluding PACT bookkeeping files such as `.pact/**` and benchmark scaffolding files at the repository root: `solution.patch` and `test.patch`. If the worker also leaves files described by root `test.patch` in the worktree, those files remain visible here for observability.

Purpose: answer what the worker actually changed.

### `round-XX-eval.patch`

The patch intended for benchmark or external evaluation.

v1 default: excludes `.pact/**`, root `solution.patch`, root `test.patch`, and paths declared inside root `test.patch`. This keeps benchmark-only test files out of the patch submitted for evaluation while preserving them in `round-XX-workspace.patch`.

Purpose: answer what should be evaluated.

### `round-XX-test.patch`

The optional patch containing worker/public test changes inferred from paths declared inside root `test.patch`.

Purpose: preserve worker test effort for observability without polluting the benchmark/product eval patch.

### `round-XX-patch-artifact.json`

Patch metadata for both patch files.

Minimum fields:

- `schema`: `"pact-patch-artifact/v1"`
- `loop_id`
- `round`
- `primary_patch`: `"eval"`
- `workspace_patch`: file, sha256, bytes, lines, changed files, empty flag
- `eval_patch`: file, sha256, bytes, lines, changed files, empty flag
- `test_patch`: file, sha256, bytes, lines, changed files, empty flag
- `excluded_scaffolding_files`: metadata for excluded root benchmark files, including path, sha256, bytes, and lines
- `excluded_test_patch_files`: metadata for worktree files excluded because root `test.patch` declared them
- `checks`: apply check status and message

Purpose: support batch statistics and avoid trusting worker self-report.

### `round-XX-contract.md`

Worker-authored round contract.

Required fields:

- single mainline objective
- target ACs
- blocking issues
- queued out-of-scope issues
- success criteria

Purpose: preserve the worker's declared scope for review. The contract is a claim, not an authoritative completion condition. The reviewer audits it under `Claim Audit` and `Contract Scope Audit`.

### `goal-tracker.md`

Humanize-style semantic ledger.

Required sections:

- `IMMUTABLE SECTION`: Ultimate Goal and AC table.
- `MUTABLE SECTION`: Plan Version, Plan Evolution Log, Active Tasks, Completed and Verified, Explicitly Deferred, Open Issues.

Worker summaries may include `Goal Tracker Update Request`. The reviewer approves or rejects those requests in `Goal Tracker Updates`; the plugin applies approved mutable updates. The immutable section is guarded by a stored hash.

### `round-XX-review-decision.json`

Structured reviewer decision.

Minimum fields:

- `schema`: `"pact-review-decision/v1"`
- `loop_id`
- `round`
- `marker`: `complete` or `continue`
- `parse_status`
- `terminal_line`
- `review_path`
- `feedback_path`
- `reviewer_backend`
- `reviewer_model`

Purpose: make reviewer output machine-readable while preserving the original markdown. `PACT_STOP` and `PACT_CONTINUE` are deprecated compatibility tokens and parse as `continue`.

### `round-XX-verification.json` and `round-XX-verification.log`

Worker-safe round verification.

Minimum fields:

- `schema`: `"pact-round-verification/v1"`
- `round`
- `command`
- `source`: public/lightweight verification
- `status`: `not_run`, `passed`, `failed`, `timeout`, or `infra_failed`
- `applied`
- `build_status`
- `error_categories`
- `failure_signature`
- `patch_sha256`
- `duration_ms`

Purpose: record patch apply and public build/self-check facts for reviewer use. In LoLBench default mode these files must not contain hidden `pact-gate` output, `eval_tests.patch`, F2P/P2P counts, or Docker grade logs.

### `final-hidden-gate-<suite>.json`, `final-hidden-gate-<suite>.log`, `final-hidden-gate-summary.json`, and `final-result.json`

Reviewer-candidate final hidden scoring artifacts.

Minimum fields:

- `suite`
- `status`
- `applied`
- `resolved`
- `build_status`
- `f2p`
- `p2p`
- `error_categories`
- `failure_signature`
- `diagnostic_signature`
- `patch_sha256`
- `duration_ms`

Purpose: preserve LoLBench hidden final gate evidence for reports and human diagnosis. These artifacts are reviewer/report-only and are not copied into worker continuation packages. Hidden final failure stops the loop with `stop_reason=final_hidden_gate_failed`.

### `round-XX-continuation-package.md/json`

Worker-facing continuation input derived from review results, patch metadata, and public verification status.

This file must be sanitized. It must not include raw verification log tails, `eval_tests.patch`, F2P/P2P details, hidden/eval suite details, final hidden gate details, Docker grade logs, benchmark harness paths, or benchmark command lines. Full verification and final hidden artifacts can still be saved for human/report consumers, but they are not default worker input.

Purpose: make each fresh worker round self-contained without leaking benchmark-only or hidden-eval details.

### `round-XX-result.json`

Round-level result summary.

Minimum fields:

- `schema`: `"pact-round-result/v1"`
- `loop_id`
- `round`
- `status`
- `failure_category`
- `review_marker`
- `loop_phase`
- `planner_backend`
- `planner_model`
- `reviewer_backend`
- `reviewer_model`
- `worker_backend`
- `worker_model`
- `worker_config_source`
- `metrics`
- `artifacts`

v1 failure categories:

- `missing_summary`
- `worker_failed`
- `reviewer_failed`
- `empty_patch`
- `malformed_patch`
- `patch_apply_failed`
- `build_test_failed`
- `build_gate_failed`
- `max_rounds_without_build_success`
- `verification_timeout`
- `agent_timeout`
- `max_rounds`
- `cancelled`
- `unknown`

When a terminal round stops the loop, the driver mirrors the final `failure_category` into `state.json.stop_reason` unless a more specific stop reason, such as `final_hidden_gate_failed`, was already set.

Minimum metrics:

- `patch_empty`
- `workspace_patch_lines`
- `eval_patch_lines`
- `changed_file_count`
- `tool_event_count`
- `review_marker`
- `next_round`
- `attempted_worker_rounds`
- `completed_worker_rounds`
- `reviewed_worker_rounds`

Purpose: give LoLBench-style runs a consistent failure and metric row.

### `replay-case.json`

Replay input package for one checkpoint.

Minimum fields:

- `schema`: `"pact-replay-case/v1"`
- `source_loop_id`
- `source_round`
- `project_root`
- `plan`
- `round_context`
- `worker_prompt`
- `feedback`
- `patch_artifact`
- `review_decision`
- `baseline_result`

Purpose: freeze a checkpoint so later work can repeat it N times or compare mechanism variants.

## Default Behavior

- Existing PACT commands keep working.
- `pact-start-loop` continues to create the loop and initial worker prompt.
- Planner default: `planner_backend=codex-cli`, `planner_model=gpt-5.5`.
- Reviewer default: `reviewer_backend=codex-cli`, `reviewer_model=gpt-5.4-mini`.
- Worker attribution default for LoLBench smoke: `worker_backend=opencode-cli`, `worker_model=zai-coding-plan/glm-5-turbo`, `worker_config_source=mini-swe-agent-env`.
- LoLBench smoke loads `~/Library/Application Support/mini-swe-agent/.env` and injects a custom OpenAI-compatible provider named `zai-coding-plan` with `baseURL={env:ZAI_API_BASE}` and `apiKey={env:ZAI_API_KEY}`. Secrets are referenced by env placeholder and are not written into artifacts.
- Local PACT execution should use the same config-file path: set `OPENCODE_CONFIG` to a config that declares `provider.zai-coding-plan.npm="@ai-sdk/openai-compatible"`, `provider.zai-coding-plan.options.baseURL="{env:ZAI_API_BASE}"`, `provider.zai-coding-plan.options.apiKey="{env:ZAI_API_KEY}"`, and `provider.zai-coding-plan.models.glm-5.2`. With that config, `opencode run -m zai-coding-plan/glm-5.2` is the verified local default worker invocation.
- LoLBench smoke should use `.opencode/plugins/pact/pact-run-driver.ts` rather than a single `opencode run` invocation. The driver starts a fresh OpenCode run per round by default, feeding `round-XX-prompt.md` while the PACT state remains `running`; same-session continuation is an explicit opt-in.
- Optional LoLBench container-worker mode keeps the PACT driver on the host but runs each worker round through `docker run` inside an eval-derived agent image. Enable from LoLBench with `--pact-container-worker`, or call the driver with `--worker-runner docker` / `PACT_WORKER_RUNNER=docker`. The worker image is selected by `LOLBENCH_AGENT_IMAGE_TAG` unless `--worker-container-image` is explicit.
- LoLBench smoke config enables `benchmarkStrictNetwork` by default; this blocks OpenCode `webfetch`, `websearch`, and obvious shell download attempts against feature-source hosts such as GitHub, python.org, and PyPI. True network isolation still requires LoLBench in-container execution or the host anti-cheat wrapper.
- LoLBench host-mode `agent_timeout` marks active PACT loops stopped and archives `.pact` under the run directory for post-hoc inspection.
- LoLBench `results.csv` reports stable public fields: image build status, agent status/timing, suite score, PACT loop path/status/phase/stop reason, `next_round`, attempted/completed/reviewed worker counters, first public build-success round, final hidden gate status/suites, and latest failure signature. Deprecated aliases and raw artifact debug refs are written to `results.verbose.csv`.
- The smoke harness only maps mini-swe model names such as `zai/glm-4.7` to `zai-coding-plan/glm-4.7` when no explicit worker model is supplied. The provider config declares `glm-5.2` for local PACT runs even when a specific benchmark run overrides the worker model.
- Full alignment default: every 5 implementation rounds.
- Codex planner and reviewer invocations run synchronously under the target project root using `cwd=<project_root>` and `-C <project_root>`.
- Default Codex args are `exec --ignore-user-config --skip-git-repo-check -m <model> -c model_reasoning_effort="medium" -C <project_root> -`. `codexArgs` and `plannerCodexArgs` remain full override escape hatches.
- `opencode-agent` remains an explicit opt-in backend for interactive or long-lived OpenCode server scenarios.
- Reviewer protocol is two-state: only final `PACT_COMPLETE` advances the loop phase; missing marker, `PACT_STOP`, and `PACT_CONTINUE` all continue.
- Reviewer prompt scope is intentionally narrow: plan, todo, goal tracker, summary, eval patch, patch metadata, and changed files listed in metadata.
- Reviewer timeout or failure writes `round-XX-review.md`, `round-XX-review-decision.json`, `round-XX-result.json`, sets loop `status=stopped` and `phase=stopped`, and still attempts to export `replay-case.json`.
- `PACT_COMPLETE` in implementation/full-alignment enters review phase, `PACT_COMPLETE` in review phase enters finalize phase, and `finalize-summary.md` completes the loop.
- `pact-status` may show artifact completeness, but v1 does not need a new status command.
- Loop start idempotently adds `.pact/` to workspace `.git/info/exclude`.
- Patch capture excludes `.pact/**`, root `solution.patch`, root `test.patch`, and root `test.patch` declared paths from eval patches; excluded scaffolding and test-path metadata is retained in `round-XX-patch-artifact.json`.
- Raw provider bodies, secrets, and full tool outputs are not written.
- Replay v1 requires export. A replay runner can be built later from `replay-case.json`.

## Success Criteria

- A normal one-round PACT run writes the core artifact chain from loop start through round result.
- Deprecated `PACT_STOP` no longer terminates a LoLBench/OpenCode run.
- Complete implementation reviews enter review phase instead of immediately completing the loop.
- Review phase completion enters finalize phase, and finalization writes `complete-state.md`.
- Missing summary, empty patch, reviewer failure, max rounds, and cancellation produce structured results.
- Planner, reviewer, and worker backend/model defaults are recorded in loop manifest, round context, and round result artifacts.
- LoLBench final `solution.patch` should not contain `.pact/**`, `round-XX-*`, nested `solution.patch`, `test.patch` diffs, or files declared inside root `test.patch`.
- A replay case can be exported from any completed round.
- The files are useful enough for post-hoc analysis without reading the whole session transcript.
