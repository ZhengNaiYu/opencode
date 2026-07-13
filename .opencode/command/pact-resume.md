---
description: "Fork a PACT loop from a completed round checkpoint"
argument-hint: "source-loop-dir ROUND plan.md --max N [--worker-model MODEL]"
---

Resume a PACT loop from a completed round checkpoint by calling the `pact-resume-round` tool.

Parse `$ARGUMENTS`:

- First positional argument is `source_loop`.
- Second positional argument is `resume_round`.
- Third positional argument is `plan_file`.
- Required `--max N` becomes `max_rounds`; it is the total worker-round budget and must be greater than `resume_round`.
- Optional `--reviewer VALUE` becomes `reviewer_backend`.
- Optional `--reviewer-model VALUE` becomes `reviewer_model`.
- Optional `--worker-model VALUE` becomes `worker_model`.
- Optional `--worker-config-source VALUE` becomes `worker_config_source`.
- Optional `--session-strategy VALUE` becomes `session_strategy`.
- Optional `--full-alignment-interval N` becomes `full_alignment_interval`.
- Optional `--verification-command VALUE` becomes `verification_command`.
- Optional `--verification-timeout-ms N` becomes `verification_timeout_ms`.

If a required positional argument or `--max` is absent, ask the user for it. Otherwise call `pact-resume-round`.

The current workspace must be a clean checkout of the same Git base as the source checkpoint. A successful restore starts the next round in this current OpenCode session; it does not modify the source loop.
