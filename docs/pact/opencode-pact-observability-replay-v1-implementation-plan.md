# OpenCode PACT Observability and Replay v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add plugin-only PACT artifacts and Humanize-style loop governance that make each round self-explaining, replay-exportable, and reviewer-gated.

**Architecture:** Keep the existing PACT loop in `.opencode/plugins/pact.ts` and move artifact logic into focused helpers under `.opencode/plugins/pact/`. `pact-core.ts` remains the state and decision owner, while new helpers handle artifact paths, JSON writing, event summaries, patch metadata, failure classification, and replay export.

**Tech Stack:** TypeScript, Bun tests, OpenCode plugin hooks, Node `fs`, Node `crypto`, local git commands for patch capture when SDK diff is insufficient.

**Implementation Status:** Core v1 is implemented in `.opencode/plugins/pact.ts`, `.opencode/plugins/pact/pact-core.ts`, `.opencode/plugins/pact/lolbench-smoke.ts`, `.opencode/plugins/pact/pact-run-driver.ts`, `.opencode/plugins/pact/pact-core.test.ts`, `.opencode/plugins/pact/pact-plugin.test.ts`, `.opencode/plugins/pact/pact-run-driver.test.ts`, and `.opencode/plugins/pact/lolbench-smoke.test.ts`. The LoLBench/run path uses synchronous Codex CLI defaults for planning and review: `planner_backend=codex-cli`, `planner_model=gpt-5.5`, `reviewer_backend=codex-cli`, and `reviewer_model=gpt-5.4-mini`. Both Codex calls run under the target workspace with `cwd=<project_root>` and `-C <project_root>`, isolated from user config with `--ignore-user-config` and medium reasoning. The default LoLBench worker attribution is `worker_backend=opencode-cli`, `worker_model=zai-coding-plan/glm-5-turbo`, and `worker_config_source=mini-swe-agent-env`. The Humanize-style extension adds a structured plan ledger, protected goal tracker, two-state reviewer protocol, full alignment reviews, review phase, finalize phase, and phase-aware artifacts. The CLI/LoLBench default round boundary is driver-owned `opencode run` exit: the driver starts one worker run per round, captures patch/snapshot/trajectory after process exit, invokes the reviewer synchronously, and writes the next round prompt. `session.idle` remains an interactive fallback. Latest fixes add public-only per-round verification, candidate-only LoLBench hidden final gate artifacts, explicit `next_round` / attempted / completed / reviewed counters, improved failure signatures, streamlined `results.csv`, worker round contracts as claims, worker-safe continuation sanitization, hard worker read guards for reviewer-only `.pact` artifacts, `round-XX-test.patch`, eval-patch exclusion for files declared by root `test.patch`, benchmark strict network blocking for OpenCode web/shell tool calls, and Round00 resume via `--resume-loop` / `PACT_RESUME_LOOP_DIR`.

## Global Constraints

- Do not change OpenCode core for v1.
- Do not write raw provider HTTP bodies, secrets, or full tool output by default.
- Do not add dashboard, workflow promotion, full Agent Team schema, or replay runner in v1.
- Preserve existing `pact-start`, `pact-status`, and `pact-cancel` command behavior.
- Reviewer parsing is two-state: final `PACT_COMPLETE` advances the phase; missing marker, `PACT_STOP`, and `PACT_CONTINUE` mean continue.
- PACT bookkeeping files under `.pact/**`, root `solution.patch`, root `test.patch`, and files declared inside root `test.patch` must not appear in eval/final captured patch files.
- Excluded root benchmark scaffolding files are recorded as metadata, never included in eval/workspace patch content.
- Worker-facing continuation packages and next-worker instructions must not include raw verification log tails, `eval_tests.patch`, F2P/P2P details, hidden/eval suite details, final hidden gate artifacts, Docker grade logs, benchmark harness paths, or benchmark command lines.
- LoLBench per-round verification is public/worker-safe only. Hidden `pact-gate` runs only after reviewer candidate `PACT_COMPLETE`, writes final hidden artifacts, and never feeds worker continuation.
- In benchmark strict mode, worker tool reads may only access worker-safe `.pact` files such as `plan.md`, `todo.md`, `goal-tracker.md`, source plan, round prompts, round contracts, round summaries, continuation packages, and pre-snapshots. Reviewer-only artifacts such as feedback, verification, replay, events, evidence, trajectory, review files, and captured patches stay available to the driver/reviewer/human reports but are blocked from worker reads.
- `plan.md`, `source-plan.md`, `todo.md`, `goal-tracker.md`, review artifacts, state artifacts, result artifacts, and replay artifacts are PACT-owned. Workers request ledger updates in summaries; reviewers approve or reject; PACT applies approved mutable updates.
- LoLBench/OpenCode run defaults must not depend on OpenCode provider discovery for planner or reviewer calls.
- LoLBench/OpenCode smoke must inject the ZAI Coding Plan custom provider from mini-swe-agent env placeholders instead of treating `zai-coding-plan/glm-5-turbo` as a built-in registry model.

---

## File Structure

- Modify `.opencode/plugins/pact/pact-core.ts`
  - Add artifact schema types, path helpers, loop manifest writing, round state/context writing, review decision writing, result writing, failure classification, and replay export helpers.
- Modify `.opencode/plugins/pact.ts`
  - Call the new helpers from loop start, idle handling, review handling, and tool hooks.
- Modify `.opencode/plugins/pact/pact-core.test.ts`
  - Add tests for artifact filenames, schema writers, failure categories, patch metadata, and replay export.
- Add `.opencode/plugins/pact/lolbench-smoke.ts`
  - Add helpers for env validation, ZAI provider config generation, worker model normalization, and config-content merge.
- Add `.opencode/plugins/pact/lolbench-smoke.test.ts`
  - Add tests that provider config uses env placeholders and does not embed secrets.
- Modify `.opencode/plugins/pact/pact-run-driver.ts`
  - Make CLI/LoLBench default to driver-owned `opencode run` once per round; after process exit the driver captures artifacts and runs review synchronously.
- Modify `.opencode/plugins/pact/pact-run-driver.test.ts`
  - Add coverage for run-exit round finalization, missing summary review, and same-session opt-in compatibility.
- Keep `.opencode/agent/pact-*.md` unchanged unless implementation reveals a prompt-only gap.
- Keep docs in `docs/pact/` as design and implementation handoff.

## Driver-Owned Round Lifecycle Update

**Default boundary:** `round_boundary=run_exit` for CLI and LoLBench. One `opencode run` process equals one worker round. When the process exits, the driver:

- captures the driver invocation in `round-XX-trajectory.json`;
- tolerates missing `round-XX-summary.md` and records `summary_status=missing`;
- reads `round-XX-contract.md` if present and treats it as a worker claim;
- captures workspace/eval/test patches and patch metadata;
- runs configured public/worker-safe verification without applying hidden eval tests or feeding raw final/eval details back to the worker;
- builds a reviewer prompt with separate `Authoritative Facts` and `Worker Claims`;
- writes review, decision, result, evidence, replay, and the next round prompt synchronously.

If the reviewer writes candidate `PACT_COMPLETE` during implementation/full-alignment, the driver then runs the LoLBench hidden final gate (`pact-gate`) for the configured suites and writes `final-hidden-gate-<suite>.json`, `final-hidden-gate-<suite>.log`, `final-hidden-gate-summary.json`, and `final-result.json`. Hidden final failure stops the loop with `stop_reason=final_hidden_gate_failed` and does not create a continuation prompt.

**Fallback boundary:** `session.idle` remains for interactive OpenCode server usage and continues to use the same core artifact helpers.

**Worker contract:** Every implementation/continuation prompt asks the worker to write `round-XX-contract.md` before coding, including a single mainline objective, target ACs, blocking issues, queued out-of-scope issues, and success criteria. The contract is not trusted as evidence; reviewer audits it under `Claim Audit` and `Contract Scope Audit`.

**Worker-safe feedback:** `writeContinuationPackage` and next-worker instructions sanitize benchmark/eval-only facts. Full verification artifacts remain available for human/report consumers, but the next worker prompt receives only safe, source-oriented guidance.

**Patch separation:** `round-XX-workspace.patch` is observability-oriented, `round-XX-eval.patch` is product/source evaluation-oriented, and `round-XX-test.patch` contains worker/public test changes inferred from root `test.patch` declarations. `.pact/**`, root `solution.patch`, root `test.patch`, and root `*.patch`/`*.diff` scaffolding stay out of eval patches.

**PACT container-worker v1:** the LoLBench host path can now keep the PACT driver on the host while running each worker round inside an eval-derived Docker image. LoLBench `--pact-container-worker` builds/exposes the private-stripped agent image with `build_agent_image(...)`, sets `PACT_WORKER_RUNNER=docker`, and passes `LOLBENCH_AGENT_IMAGE_TAG` to the driver. The driver can also be called directly with `--worker-runner docker` or `PACT_WORKER_RUNNER=docker`. Docker worker runs inherit `LOLBENCH_MEM` / `LOLBENCH_CPUS`, bind-mount the host workspace read-write, mount the PACT plugin bundle read-only, rewrite worker-side `OPENCODE_CONFIG_CONTENT`, and leave reviewer/reporting/final gate execution on the host.

**Host-flow prerequisite now fixed:** the CLI driver owns Round00 initialization directly. It creates the loop, runs planner/repair, writes canonical `plan.md` / `todo.md` / `goal-tracker.md`, and only then launches the first worker with `round-01-prompt.md`. The first worker run no longer has to call `pact-start-loop`. If the planner fails, PACT writes `planner-error.md` and `round-00-result.json` with `planner_failed` before any worker invocation, which prevents silent empty-patch runs.

**Round00 resume now fixed:** the CLI driver accepts `--resume-loop <loopDir>` or `PACT_RESUME_LOOP_DIR`, with `--resume-mode round0` / `PACT_RESUME_MODE=round0`. Resume validates an existing Round00 package, creates a new loop in the fresh target workspace, copies canonical Round00 artifacts, writes `resume-source-loop-manifest.json`, resets worker counters to zero, regenerates `round-01-prompt.md`, and starts again at round1 without calling planner. The LoLBench host harness exposes this via `--pact-resume-loop <loopDir>`. Resume also reuses the core git exclude helper to ignore `.pact/`, root `*.patch`, and root `*.diff` artifacts in ordinary repos and Git worktrees; this is required because fresh `createLoop(...)` used to do it, while resume bypasses `createLoop(...)`.

**Latest host smoke note:** a `glm-5-turbo` one-case host smoke on `Ruff_Issue-8368_Allow-override-of-configuration-options-via-the-CLI_PR-9599` resumed from existing Round00 with outer LoLBench `--agent-timeout 6400`, ran three driver-owned worker rounds, reviewed all three rounds synchronously with Codex `gpt-5.4-mini`, and stopped at `max_rounds`. Output root: `/Users/gujiazhen/Documents/cc_codes/outputs/opencode_pact_lolbench_onecase_resume6400_fixed_20260626T101359Z`. Results: `agent_status=agent_ok`, `agent_seconds=1663.6`, `pact_attempted_worker_rounds=3`, `pact_completed_worker_rounds=3`, `pact_reviewed_worker_rounds=3`, `pact_stop_reason=max_rounds`, final LoLBench `UNRESOLVED F0/17 P3/3`. The final `solution.patch` is 490 lines and was checked to contain no `.pact`, `round-0`, `pact-artifacts`, `final-hidden`, `eval_tests`, `F2P`, or `P2P` tokens. The driver now mirrors terminal `round-XX-result.failure_category` into `state.json.stop_reason` when the loop stops and no more specific stop reason was already set.

## Task 1: Artifact Paths and JSON Writers

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `artifactPaths(loopDir: string, round: number): PactArtifactPaths`
- Produces `writeJsonFile(path: string, value: unknown): void`
- Produces `appendJsonLine(path: string, value: unknown): void`

- [x] Add `ArtifactPaths` type with these fields: `loopManifest`, `roundState`, `roundContext`, `roundEvents`, `workspacePatch`, `evalPatch`, `patchArtifact`, `reviewDecision`, `roundResult`, `replayCase`.
- [x] Implement `artifactPaths` using existing `roundName(round)`.
- [x] Implement stable JSON writing with two-space indentation and trailing newline.
- [x] Implement JSONL append with one compact JSON object per line.
- [x] Add tests that `artifactPaths("/tmp/loop", 1)` returns `round-01-*` names and `round 12` returns `round-12-*` names.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 2: Loop Manifest

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `writeLoopManifest(input: { loopDir: string; loopID: string; projectRoot: string; planFile: string; maxRounds: number; plannerBackend: PlannerBackend; plannerModel?: string; reviewerBackend: ReviewerBackend; reviewerModel?: string; activeSessionID?: string; createdAt: string }): void`

- [x] Extend `createLoop` to write `loop-manifest.json` after `state.json`.
- [x] Include schema `"pact-loop-manifest/v1"` and `artifact_version: 1`.
- [x] Keep existing `state.json`, `plan.md`, `todo.md`, and `goal-tracker.md` behavior unchanged.
- [x] Add a test that `createLoop` writes `loop-manifest.json` with loop id, plan file, planner backend/model, reviewer backend/model, and active session id.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 3: Round State and Context

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `writeRoundState(input: RoundStateInput): void`
- Produces `writeRoundContext(input: RoundContextInput): void`
- Produces `sha256Text(text: string): string`

- [x] Write round state when the initial worker prompt is created.
- [x] Write round state when idle handling starts a review path.
- [x] Write round context from state, todo, goal tracker, prompt path, feedback path, planner backend/model, and reviewer backend/model.
- [x] Use sha256 hashes for todo, goal tracker, and feedback text.
- [x] Add tests that missing feedback records an empty hash and existing feedback records a stable hash.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 4: Minimal Event Capture

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `appendRoundEvent(input: { loopDir: string; loopID: string; round: number; type: PactEventType; sessionID?: string; data?: Record<string, unknown> }): void`
- Produces `summarizeToolArgs(args: unknown): Record<string, unknown>`
- Produces `summarizeToolOutput(output: unknown): Record<string, unknown>`

- [x] Record `round_started` when a round prompt is emitted.
- [x] Record `tool_before` and `tool_after` only when the active PACT loop session id matches the event session id.
- [x] Store tool name, call id, summarized args keys, summarized output length, title, and metadata keys.
- [x] Do not store full raw tool output.
- [x] Record `summary_missing`, `review_started`, `review_finished`, and `round_finished` in idle handling.
- [x] Add tests for redacted output summary and JSONL event append.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 5: Patch Capture and Patch Artifact

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `capturePatchArtifact(input: { projectRoot: string; loopDir: string; loopID: string; round: number }): PatchArtifact`
- Produces `captureWorkspacePatch(projectRoot: string): string`
- Produces `buildPatchArtifact(input: PatchArtifactInput): PatchArtifact`

- [x] Capture patch after summary exists and before review starts.
- [x] Exclude `.pact/**` from captured patches.
- [x] Exclude root `solution.patch` and root `test.patch` from captured patches.
- [x] Record excluded root scaffolding files in `round-XX-patch-artifact.json` with path, sha256, bytes, and lines.
- [x] Write identical v1 content to `round-XX-workspace.patch` and `round-XX-eval.patch`.
- [x] Compute sha256, byte count, line count, changed files, and empty flag for each patch.
- [x] Add an apply check using `git apply --check` against the current worktree when patch is non-empty.
- [x] Add tests for empty patch metadata.
- [x] Add tests for a temp git repo with one tracked file change and one `.pact` file change, proving `.pact` is excluded.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 6: Structured Review Decision Artifact

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Extends `recordReviewDecision` to write `round-XX-review-decision.json`

- [x] Preserve current review markdown and feedback behavior.
- [x] Write review decision JSON with schema, loop id, round, marker, parse status, terminal line, review path, and feedback path.
- [x] Record `reviewer_backend` and `reviewer_model` in review decision/result artifacts for replay and A/B attribution.
- [x] Record `planner_backend` and `planner_model` in loop manifest, round context, and result artifacts.
- [x] Add tests for complete, stop, implicit continue, and deprecated continue marker.
- [x] Ensure deprecated continue marker still does not leak into feedback.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 7: Round Result and Failure Classification

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `classifyRoundFailure(input: FailureInput): FailureCategory`
- Produces `writeRoundResult(input: RoundResultInput): void`

- [x] Implement categories: `missing_summary`, `worker_failed`, `reviewer_failed`, `empty_patch`, `malformed_patch`, `patch_apply_failed`, `build_test_failed`, `agent_timeout`, `max_rounds`, `cancelled`, `unknown`.
- [x] Write `round-XX-result.json` after review decision or terminal failure.
- [x] On reviewer timeout/failure, write failed review markdown, failed decision JSON, stopped loop state, stopped result JSON, and replay export.
- [x] If reviewer failure happens before prompt/context exists, write minimal fallback replay inputs instead of leaving replay incomplete.
- [x] Include minimal metrics: patch empty flag, workspace patch lines, eval patch lines, changed file count, tool event count, review marker.
- [x] Include planner backend/model and reviewer backend/model in result artifacts.
- [x] Update `pact-cancel` to write a cancellation result for the active round when possible.
- [x] Add unit tests for missing summary, empty patch, patch apply failure, max rounds, cancelled, and Codex reviewer timeout.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 8: Replay Export

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Produces `exportReplayCase(input: { loopDir: string; round: number; projectRoot: string }): ReplayCase`
- Optional tool: `pact-export-replay-case` with args `{ round?: number }`

- [x] Build replay case from plan, round context, worker prompt, feedback, patch artifact, review decision, and baseline result.
- [x] Write `replay-case.json` in the loop directory.
- [x] If multiple rounds exist and no round is specified, export the current round from state; idle handling exports the reviewed round explicitly.
- [x] Add a plugin tool only if needed to invoke export from OpenCode. Decision: not needed for v1 because idle handling exports automatically.
- [x] Add tests that replay export fails with a clear error when required round artifacts are missing.
- [x] Add tests that replay export succeeds after a fake completed round.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 9: Integration-Style Fake Loop Test

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.test.ts`

**Interfaces:**

- Consumes all helpers above.

- [x] Create a temp git project with `plan.md` and one source file.
- [x] Call `createLoop`.
- [x] Write round context and fake summary.
- [x] Modify the source file.
- [x] Capture patch artifact.
- [x] Record a review decision.
- [x] Write round result.
- [x] Export replay case.
- [x] Assert all required files exist and contain matching loop id and round number.
- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.

## Task 10: Final Verification

**Files:**

- No new files unless tests reveal a needed fixture.

- [x] Run `bun test .opencode/plugins/pact/pact-core.test.ts`.
- [x] Run `bun test .opencode/plugins/pact/pact-plugin.test.ts`.
- [x] Add unit coverage proving Codex planner defaults to `gpt-5.5` and runs in the project root.
- [x] Run `bun typecheck` from `packages/opencode`.
- [x] Run `bun run lint -- .opencode/plugins/pact.ts .opencode/plugins/pact/pact-core.ts .opencode/plugins/pact/pact-core.test.ts .opencode/plugins/pact/pact-plugin.test.ts`; exits 0 with existing unsafe assertion/no-base-to-string warnings.
- [x] Run `git diff --check`.
- [x] Run LoLBench smoke through OpenCode with ZAI Coding Plan worker and `codex-cli` reviewer using `gpt-5.4-mini`; latest code adds unit coverage for reviewer timeout/model metadata after that smoke.
- [x] Run max-rounds=5 LoLBench smoke. Result: planner previously fell back because it still used an OpenCode subagent and hit `no providers found`; this plan now fixes planner to default to synchronous Codex CLI with `gpt-5.5`.
- [x] Add unit coverage for ZAI Coding Plan provider config generation, mini-swe model mapping, coding endpoint validation, and secret-free config merging.
- [x] Confirm `docs/pact/opencode-pact-observability-replay-v1.md` still matches the implemented artifact names.

## Task 11: Humanize-Style Plan Contract

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

- [x] Add deterministic fallback normalizer that produces a Humanize-style AC/task ledger when planner output is missing or sparse.
- [x] Update planner prompt to require `AC-*` acceptance criteria, positive/negative tests, task-to-AC mapping, task tags, and dependencies.
- [x] Normalize planner artifacts into table-backed `todo.md` and `goal-tracker.md`.
- [x] Add tests for AC/task extraction and Humanize-style ledger output.

## Task 12: Protected Goal Tracker Ownership

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`

- [x] Store `goal_tracker_immutable_sha256` in state and manifest.
- [x] Make `goal-tracker.md` use `IMMUTABLE SECTION` and `MUTABLE SECTION` with Humanize-style tables.
- [x] Reject worker writes that alter the immutable section hash.
- [x] Add reviewer-approved Goal Tracker Update Request application for mutable ledger updates.
- [x] Add tests for immutable hash protection and approved update application.

## Task 13: Two-State Reviewer and Humanize Output Format

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-core.test.ts`
- Test: `.opencode/plugins/pact/pact-plugin.test.ts`

- [x] Parse only final `PACT_COMPLETE` as complete.
- [x] Treat `PACT_STOP`, `PACT_CONTINUE`, and missing markers as continuation.
- [x] Strip deprecated terminal markers from feedback.
- [x] Require reviewer sections: Decision Summary, Goal Alignment Summary, Acceptance Criteria Audit, Findings, Goal Tracker Updates, Next Worker Instructions.
- [x] Write `round-XX-review-prompt.md` for replay/debugging.
- [x] Add tests proving `PACT_STOP` continues and prompts the next worker round.

## Task 14: Humanize-Style Phases

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Test: `.opencode/plugins/pact/pact-plugin.test.ts`

- [x] Add loop phase values: `implementation`, `full_alignment`, `review`, `finalize`, `complete`, `stopped`.
- [x] Record phase in state, round context, round state, round result, and review decision.
- [x] Run full alignment review every configured interval.
- [x] Make implementation/full-alignment `PACT_COMPLETE` enter review phase, not complete.
- [x] Make review phase `PACT_COMPLETE` enter finalize phase.
- [x] Make `finalize-summary.md` complete the loop and write `complete-state.md`.
- [x] Add integration tests for implementation -> review -> finalize -> complete.

## Task 15: Docs and Command Surface

**Files:**

- Modify: `.opencode/command/pact-start.md`
- Modify: `docs/pact/opencode-pact-observability-replay-v1.md`
- Modify: `docs/pact/opencode-pact-observability-replay-v1-implementation-plan.md`

- [x] Document `--full-alignment-interval`.
- [x] Document that OpenCode PACT does not implement a true Stop hook in v1.
- [x] Document the two-state reviewer protocol and deprecated `PACT_STOP` behavior.
- [x] Document review/finalize phase semantics.
- [x] Document ZAI Coding Plan worker defaults, Codex reviewer isolation args, failed reviewer artifact behavior, and patch pollution exclusions.

## Task 16: LoLBench Smoke Reliability Repair

**Files:**

- Add: `.opencode/plugins/pact/lolbench-smoke.ts`
- Add: `.opencode/plugins/pact/lolbench-smoke.test.ts`
- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact.ts`
- Modify: `docs/pact/opencode-pact-observability-replay-v1.md`
- Modify: `docs/pact/opencode-pact-observability-replay-v1-implementation-plan.md`

- [x] Add ZAI Coding Plan provider config helper using `@ai-sdk/openai-compatible`.
- [x] Reference `ZAI_API_BASE` and `ZAI_API_KEY` using OpenCode env placeholders, never literal secret values.
- [x] Validate that `ZAI_API_BASE` is the coding endpoint `https://api.z.ai/api/coding/paas/v4`.
- [x] Normalize `zai/glm-*` mini-swe model names to `zai-coding-plan/glm-*` only when no worker model was explicitly supplied.
- [x] Record worker backend/model/config source in state, manifest, round context, result, and replay context.
- [x] Idempotently add `.pact/` to `.git/info/exclude` at loop start.
- [x] Exclude `.pact/**`, root `solution.patch`, and root `test.patch` from patch capture.
- [x] Record excluded scaffolding metadata in patch artifact JSON.
- [x] Update default Codex planner/reviewer args to `exec --ignore-user-config --skip-git-repo-check -m <model> -c model_reasoning_effort="medium" -C <project_root> -`.
- [x] Preserve `codexArgs` / `plannerCodexArgs` as full override escape hatches.
- [x] On reviewer timeout or failure, write failed review artifacts, stopped state/result, and replay export instead of throwing out of the hook.
- [x] Tighten reviewer prompt scope to plan, todo, goal tracker, summary, eval patch, patch metadata, and changed files.
- [x] Add tests for provider merge, model mapping, Codex args, failed reviewer artifacts, patch pollution exclusions, and replay export on failure.

## Follow-Up Findings From Smoke

- Resolved in Task 16: internal patch capture now excludes `.pact/**`, root `solution.patch`, and root `test.patch`, and loop start writes `.pact/` to `.git/info/exclude`.
- Resolved in Task 17: internal eval patch and LoLBench final `solution.patch` now also exclude files declared inside root `test.patch`, while workspace patch keeps them for observability.
- Resolved in Task 16: planner and reviewer defaults are synchronous Codex CLI invocations with explicit default models.
- Open follow-up for Task 18: `.round-history/artifacts` currently mirrors only a subset of top-level loop artifacts and can become stale after replay export, finalize, or complete-state writes. Treat the top-level loop directory as the only authoritative archive and make round history optional/debug-only.

## Task 17: Smoke Follow-Up Fixes

**Files:**

- Add: `.opencode/plugins/pact/pact-run-driver.ts`
- Add: `.opencode/plugins/pact/pact-run-driver.test.ts`
- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact/pact-core.test.ts`
- Modify: `.opencode/plugins/pact.ts`
- Modify: `.opencode/plugins/pact/pact-plugin.test.ts`
- Modify: `.opencode/plugins/pact/lolbench-smoke.ts`
- Modify: `.opencode/plugins/pact/lolbench-smoke.test.ts`
- Modify: `docs/pact/opencode-pact-observability-replay-v1.md`
- Modify: `docs/pact/opencode-pact-observability-replay-v1-implementation-plan.md`
- External harness: `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench/scripts/lolbench_eval.py`
- External harness tests: `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench/scripts/test_lolbench_eval.py`

- [x] Add a PACT run driver that starts the loop once, then starts a fresh OpenCode run per round with `round-XX-prompt.md` while state remains `running`.
- [x] Add unit coverage proving the driver uses fresh sessions by default and keeps same-session continuation as an explicit opt-in.
- [x] Parse root `test.patch` and exclude declared paths from `round-XX-eval.patch`, while retaining them in `round-XX-workspace.patch`.
- [x] Record excluded test-patch file metadata in `round-XX-patch-artifact.json`.
- [x] Update LoLBench final host capture to exclude paths declared by workspace `test.patch`.
- [x] Add `benchmarkStrictNetwork` plugin mode and enable it by default in ZAI LoLBench smoke config.
- [x] Block OpenCode `webfetch`, `websearch`, and obvious shell download attempts to GitHub, python.org, PyPI, and related feature-source hosts in benchmark mode.
- [x] Add LoLBench `--host-anticheat` wrapper support using existing `scripts/anticheat_host.sh` for host-mode smoke runs.
- [x] Restrict protected ledger enforcement to file-writing tools, so workers can read reviewer feedback and goal-tracker files during continuation rounds.
- [x] On LoLBench host-mode `agent_timeout`, mark active PACT loops as `status=stopped, phase=stopped`, write an `agent_timeout` round result, and archive `.pact` under the run directory.

## Task 18: Simplify Round Artifact History

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact/pact-core.test.ts`
- Modify: `docs/pact/opencode-pact-observability-replay-v1.md`
- Modify: `docs/pact/opencode-pact-observability-replay-v1-implementation-plan.md`

- [ ] Make `pact-artifacts/loops/<loop-id>/` the single authoritative artifact archive for LoLBench and normal PACT runs.
- [ ] Disable `.round-history` creation by default, or guard it behind an explicit debug option such as `round_history_enabled=true`.
- [ ] Stop copying artifacts into `.round-history/artifacts` on replay export in the default path.
- [ ] Preserve history semantics by writing round-scoped top-level files instead: `round-XX-state.json`, `round-XX-replay-case.json`, `round-XX-pre-snapshot.json`, `round-XX-post-snapshot.json`, and related prompt/review/result artifacts.
- [ ] Add explicit per-round ledger snapshots if mutable ledgers can change: `round-XX-goal-tracker-pre.md`, `round-XX-goal-tracker-post.md`, and equivalent `todo` snapshots only if `todo.md` becomes mutable.
- [ ] Keep `state.json` and `replay-case.json` as latest pointers/copies, but document that replay should prefer `round-XX-replay-case.json`.
- [ ] Add tests proving default loops do not create `.round-history`, while debug-enabled loops create it only when requested.
- [ ] Update artifact documentation to remove the "two authoritative copies" ambiguity and explain top-level-only replay inspection.

## Task 19: Public Round Verification and Final Hidden Gate

**Files:**

- Modify: `.opencode/plugins/pact/pact-core.ts`
- Modify: `.opencode/plugins/pact/pact-run-driver.ts`
- Modify: `.opencode/plugins/pact/pact-run-driver.test.ts`
- Modify: `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench/scripts/lolbench_eval.py`
- Modify: `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench/scripts/test_lolbench_eval.py`
- Modify: `docs/pact/opencode-pact-observability-replay-v1.md`
- Modify: `docs/pact/opencode-pact-observability-replay-v1-implementation-plan.md`

- [x] Change LoLBench default per-round verification from hidden `pact-gate` to worker-safe `pact-public-check`.
- [x] Add LoLBench `pact-public-check` mode that reads PACT patch apply metadata and optionally runs an explicit public build/check command.
- [x] Run LoLBench hidden `pact-gate` only after reviewer candidate `PACT_COMPLETE`.
- [x] Write `final-hidden-gate-<suite>.json`, `final-hidden-gate-<suite>.log`, `final-hidden-gate-summary.json`, and `final-result.json`.
- [x] Stop unresolved hidden-final failures with `stop_reason=final_hidden_gate_failed` and no continuation prompt.
- [x] Add `next_round`, `attempted_worker_rounds`, `completed_worker_rounds`, and `reviewed_worker_rounds` while keeping `current_round` and `worker_round_count` as compatibility aliases.
- [x] Make max-round and reporting logic use completed/reviewed worker counters rather than the round cursor.
- [x] Improve LoLBench failure signatures so JSON tail braces are skipped and structured report facts are preferred.
- [x] Streamline default `results.csv`; write deprecated aliases and debug refs to `results.verbose.csv`.
- [x] Add tests for public default verification, final hidden gate failure, reviewer failure counters, signature extraction, PACT summary counters, and CSV headers.

## Commit Plan

- Commit 1: `docs: add pact observability replay design`
- Commit 2: `feat(pact): add loop and round artifacts`
- Commit 3: `feat(pact): add patch metadata and replay export`
- Commit 4: `test(pact): cover observability artifacts`
