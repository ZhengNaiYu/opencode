# OpenCode PACT Thread Handoff 2026-06-27

## Current Goal

OpenCode PACT is being shaped into a Humanize-style, driver-owned round loop for LoLBench and long-horizon coding tasks.

The current branch focuses on:

- one `opencode run` per worker round;
- Round00 canonical planning and ledger initialization;
- per-round artifact/replay bundles;
- synchronous Codex reviewer gates;
- worker-safe continuation packages;
- public per-round verification only;
- hidden LoLBench final gate only after candidate completion;
- Round00 resume so a timeout/retry can skip planner and restart from round1.

## Repositories and Worktrees

OpenCode worktree:

- path: `/Users/gujiazhen/Documents/cc_codes/opencode/.worktrees/pact-observability-replay-v1`
- branch: `pact-observability-replay-v1`
- remote branch: `origin/pact-observability-replay-v1`
- current uncommitted changes:
  - `.opencode/plugins/pact/pact-run-driver.ts`
  - `.opencode/plugins/pact/pact-run-driver.test.ts`

LoLBench local harness worktree:

- path: `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench-pact-local`
- branch: `opencode-pact-local-harness`
- current uncommitted changes:
  - `scripts/lolbench_eval.py`
  - `scripts/test_lolbench_eval.py`
- unrelated/untracked artifact still present:
  - `patches/opencode-pact-host-one-max3-smoke/`

## Recent Implemented Changes

### OpenCode PACT driver

File: `.opencode/plugins/pact/pact-run-driver.ts`

Added explicit Round00 resume support:

- CLI/env inputs:
  - `--resume-loop <loopDir>`
  - `--resume-mode round0`
  - `PACT_RESUME_LOOP_DIR`
  - `PACT_RESUME_MODE=round0`
- `runPactDriver(...)` now accepts `resumeLoopDir` and `resumeMode`.
- `initializeDriverLoop(...)` dispatches to `initializeDriverLoopFromRound0(...)` when resume input exists.
- Resume validates source Round00 package before starting worker:
  - `state.json`
  - `loop-manifest.json`
  - `source-plan.md`
  - `plan.md`
  - `todo.md`
  - `goal-tracker.md`
  - `round-00-result.json`
- Resume creates a new loop in the fresh target workspace:
  - source loop id `2026-06-26T09-04-37Z`
  - resumed loop id `2026-06-26T09-04-37Z-resume`
- Resume copies only Round00/canonical package files and writes:
  - `resume-source-loop-manifest.json`
  - new `loop-manifest.json` with `resume_mode=round0`
  - new `round-01-prompt.md`
  - new round1 context/state/pre-snapshot files
- Resume resets worker counters to zero and starts from `next_round=1`.
- Resume now writes `.pact/` to target workspace `.git/info/exclude`. This fixed a real smoke regression where final `solution.patch` captured `.pact/**`.

### LoLBench harness

File: `scripts/lolbench_eval.py`

Added host-side PACT resume support:

- New CLI flag:
  - `--pact-resume-loop <loopDir>`
- Host run path now passes:
  - `PACT_RESUME_LOOP_DIR=<resolved loop dir>`
  - `PACT_RESUME_MODE=round0`
- `prepare_pact_resume_loop_for_run(...)` protects resume source loops that live under the same run archive before `clear_pact_artifact_archive(...)` runs.

## Smoke Run

Latest successful smoke:

- output root: `/Users/gujiazhen/Documents/cc_codes/outputs/opencode_pact_lolbench_onecase_resume6400_fixed_20260626T101359Z`
- LoLBench worktree: `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench-pact-local`
- OpenCode worktree: `/Users/gujiazhen/Documents/cc_codes/opencode/.worktrees/pact-observability-replay-v1`
- case: `Ruff_Issue-8368_Allow-override-of-configuration-options-via-the-CLI_PR-9599`
- suite: `orig`
- worker model: `zai-coding-plan/glm-5-turbo`
- reviewer model: `gpt-5.4-mini`
- max worker rounds: `3`
- outer LoLBench timeout: `6400s`
- resume source loop:
  `/Users/gujiazhen/Documents/cc_codes/outputs/opencode_pact_lolbench_onecase_smoke_20260626T090432Z/opencode-pact-host-one-max3-smoke/Ruff_Issue-8368_Allow-override-of-configuration-options-via-the-CLI_PR-9599/pact-artifacts/loops/2026-06-26T09-04-37Z`

Result:

- `agent_status=agent_ok`
- `agent_exit=0`
- `agent_seconds=1663.6`
- `pact_status=stopped`
- `pact_phase=stopped`
- `pact_stop_reason=max_rounds`
- `pact_next_round=4`
- `pact_attempted_worker_rounds=3`
- `pact_completed_worker_rounds=3`
- `pact_reviewed_worker_rounds=3`
- `pact_first_public_build_success_round=1`
- `patch_lines=490`
- LoLBench final result: `UNRESOLVED F0/17 P3/3`

Important checks:

- Round00 planner was skipped.
- New resumed loop was created at:
  `/Users/gujiazhen/Documents/cc_codes/outputs/opencode_pact_lolbench_onecase_resume6400_fixed_20260626T101359Z/opencode-pact-host-one-max3-resume6400-fixed/Ruff_Issue-8368_Allow-override-of-configuration-options-via-the-CLI_PR-9599/pact-artifacts/loops/2026-06-26T09-04-37Z-resume`
- Each worker round produced a full artifact chain. Each of rounds 01, 02, and 03 has 25 `round-XX-*` files.
- `solution.patch` was checked with:
  - no `.pact`
  - no `round-0`
  - no `pact-artifacts`
  - no `final-hidden`
  - no `eval_tests`
  - no `F2P`
  - no `P2P`
- Reviewer ran synchronously with:
  `codex exec --ignore-user-config --skip-git-repo-check -m gpt-5.4-mini -c model_reasoning_effort="medium" -C <workspace> -`

Verification commands run after implementation:

```bash
bun test --config /dev/null .opencode/plugins/pact/pact-run-driver.test.ts
```

Result: `18 pass, 0 fail`.

```bash
python3 -m unittest test_lolbench_eval
```

Result: `82 tests, OK`.

## Known Issues and Follow-Ups

1. `state.json.stop_reason` is still `null` after max rounds.
   - `round-03-result.json` correctly records `failure_category=max_rounds`.
   - `results.csv` correctly records `pact_stop_reason=max_rounds`.
   - This is not blocking the current resume smoke, but should be cleaned for state consistency.

2. The fixed smoke still fails the LoLBench task.
   - This is worker solution quality, not loop plumbing.
   - The loop stopped because reviewers continued to find mainline gaps and max rounds was only 3.

3. The untracked LoLBench artifact directory should not be committed:
   - `/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench-pact-local/patches/opencode-pact-host-one-max3-smoke/`

4. If the next thread commits, treat OpenCode and LoLBench separately.
   - OpenCode branch has source changes that belong on `pact-observability-replay-v1`.
   - LoLBench local harness changes may need either a local branch commit or a deliberate backup branch, depending on whether we want to upstream harness support.

## Suggested Next Thread Prompt

Use this prompt in the new Codex thread:

```text
Read docs/pact/opencode-pact-thread-handoff-2026-06-27.md in /Users/gujiazhen/Documents/cc_codes/opencode/.worktrees/pact-observability-replay-v1.

Then:
1. inspect OpenCode and LoLBench worktree status;
2. review the Round00 resume implementation and tests;
3. decide whether to fix state.json.stop_reason=null for max_rounds;
4. prepare clean commits, keeping LoLBench artifact directories out of git.
```
