# SWE-bench Pro: OpenCode vs OpenCode + PACT

This adapter runs the same eight generated SWE-bench Pro tasks in Harbor with
the same Yunwu model. The direct arm uses Harbor's built-in OpenCode agent. The
PACT arm runs the standalone PACT driver in the task container with three
worker rounds at most. Its JSON worker processes use the same terminal-event
watchdog so every completed round can return control to the driver and reviewer.

The user-facing entry point is also linked at
`/Users/naiyu/Desktop/Code/CodingAgent/swebench_pact/harbor-pact`.

## Outputs

Direct trials use `OpenCodeObserved`, a thin Harbor wrapper that preserves
OpenCode behavior but safely closes a CLI that remains alive after emitting a
terminal `step_finish(reason=stop)` event. They retain Harbor's
`agent/opencode.txt`, `agent/trajectory.json`, result, verifier reward, and
final patch artifacts. PACT trials retain:

- `agent/pact-driver.txt`
- `agent/trajectory.json` (Harbor ATIF aggregated from all PACT worker rounds)
- `agent/pact/loops/**` (round prompts, reviews, events and raw JSON trajectories)
- `agent/opencode/xdg-data/**` (raw OpenCode session data)
- `agent/final.patch` and `agent/git-status.txt`
- Harbor verifier result and reward

## Contamination controls

Both Direct and PACT isolate the task repository before the model starts. The
adapter removes every original `.git` directory from the disposable task
container, initializes a new repository containing exactly one baseline
commit, and verifies that no remotes or nested Git metadata remain. The model
can still use normal `git diff` and `git status`, but it cannot inspect the
benchmark's future commits, branches, tags, reflogs, or remote-tracking refs.
Harbor also switches the agent execution phase from the task's public network
to an allowlist containing only `yunwu.ai`. Dependency installation happens
before the model runs; GitHub and other source hosts are unreachable while the
agent is solving the task. The audit rejects any Direct or PACT result that
does not record this explicit allowlist.

Patch capture records newly created files as well as tracked edits. Every trial
retains these additional audit artifacts:

- `agent/baseline-commit.txt`
- `agent/agent-exit-code.txt`
- `agent/patch-capture-exit-code.txt`
- `agent/git-status.txt` and `agent/final.patch`
- `agent/contamination.json`

The summary keeps the raw `verifier_reward` separate from `audited_reward`.
Direct or PACT trajectories are rejected unless the contamination audit is
clean. A target-commit reference or answer-patch access is marked
`contaminated` and receives an audited score of zero; future-history probes are
marked `suspicious` and are not assigned an audited score. The command exits
nonzero for contaminated, suspicious, or missing trajectories after writing
the forensic CSV. Use `--allow-audit-failures` only to summarize historical
runs for investigation, never to report benchmark scores.

Secrets are never stored in these configs. Rotate the key that was pasted into
chat, then export the replacement as `YUNWU_API_KEY` in the launching shell.
Harbor passes it through an environment template.

## Commands

Create a private environment file without putting the replacement key in shell
history:

```bash
mkdir -p ~/.config/swepro
chmod 700 ~/.config/swepro
read -s YUNWU_API_KEY
printf 'YUNWU_API_KEY=%s\n' "$YUNWU_API_KEY" > ~/.config/swepro/yunwu.env
chmod 600 ~/.config/swepro/yunwu.env
unset YUNWU_API_KEY
```

Then, from any directory:

```bash
/Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/check_env.sh
/Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/run_smoke.sh
```

To compare Direct and PACT on only one task, use `run_one.sh`. It defaults to
the Ansible smoke task and supports a dataset directory name or absolute task
path:

```bash
/Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/run_one.sh
/Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/run_one.sh \
  --task instance_navidrome__navidrome-55bff343cdaad1f04496f724eda4b55d422d7f17 \
  --arm both
```

Use `--arm direct` or `--arm pact` to run only one arm. Outputs go to
`swebench_pact/runs/<RUN_ID>/one`, and the script refuses to reuse an existing
one-task output directory.

Alternatively, export `YUNWU_API_KEY` directly. Set `YUNWU_ENV_FILE` to use a
different environment-file location.

Inspect the three smoke results before starting the full comparison. The full
script requires an explicit guard flag:

```bash
/Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/run_full.sh --execute
```

Both full jobs use `n_concurrent_trials: 1`, so the MacBook never builds or
runs multiple x86_64 SWE-Pro containers at once. Each script automatically
creates a run ID such as `20260716-153012` and writes under
`swebench_pact/runs/<RUN_ID>`. Set `RUN_ID` explicitly to group smoke and full
outputs under one experiment directory:

```bash
RUN_ID=20260716-exp01 \
  /Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/run_smoke.sh
RUN_ID=20260716-exp01 \
  /Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/run_full.sh --execute
```

The scripts refuse to reuse an existing `smoke`, `direct`, or `pact` output
directory. The final summary command fails unless it finds exactly eight task
pairs, a trajectory for both arms of every pair, and a clean contamination
audit for every Direct and PACT trial.

To rebuild the CSV summary without running trials:

```bash
cd /Users/naiyu/Desktop/Code/CodingAgent/harbor
RUN_ROOT=/Users/naiyu/Desktop/Code/CodingAgent/swebench_pact/runs/20260716-exp01
UV_CACHE_DIR=/tmp/harbor-uv-cache uv run python \
  /Users/naiyu/Desktop/Code/CodingAgent/opencode/.opencode/plugins/pact/harbor/scripts/summarize.py \
  "$RUN_ROOT/direct" \
  "$RUN_ROOT/pact" \
  --expect-pairs 8
```
