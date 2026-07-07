---
description: "Start a PACT checkpoint loop from a plan"
argument-hint: "path/to/plan.md [--max N] [--full-alignment-interval N] [--planner opencode-agent|codex-cli] [--planner-model MODEL] [--reviewer opencode-agent|codex-cli] [--reviewer-model MODEL] [--worker-model MODEL]"
---

Start a PACT loop by calling the `pact-start-loop` tool.

Parse `$ARGUMENTS`:

- First positional argument is `plan_file`.
- Optional `--max N` becomes `max_rounds`.
- Optional `--full-alignment-interval N` becomes `full_alignment_interval`.
- Optional `--planner VALUE` becomes `planner_backend`.
- Optional `--planner-model VALUE` becomes `planner_model`.
- Optional `--reviewer VALUE` becomes `reviewer_backend`.
- Optional `--reviewer-model VALUE` becomes `reviewer_model`.
- Optional `--worker-backend VALUE` becomes `worker_backend`.
- Optional `--worker-model VALUE` becomes `worker_model`.
- Optional `--worker-config-source VALUE` becomes `worker_config_source`.

Defaults:

- `planner_backend=codex-cli`
- `planner_model=gpt-5.5`
- `reviewer_backend=codex-cli`
- `reviewer_model=gpt-5.4-mini`
- `worker_backend=opencode-cli`
- `worker_model=zai-coding-plan/glm-5-turbo`
- `worker_config_source=mini-swe-agent-env`
- `full_alignment_interval=5`

Planner/reviewer backend notes:

- `codex-cli` remains the default for planner and reviewer.
- `opencode-agent` runs planner/reviewer through OpenCode agents, so model names should use OpenCode-native provider-qualified forms such as `openrouter/...`.
- OpenRouter is not a PACT backend; it is only a provider/API-key source used by OpenCode or Codex model configuration.
- Worker models still run through OpenCode. Use OpenCode-native worker model names such as `openrouter/...` or `zai-coding-plan/...` as appropriate.

If no plan file is provided, ask the user for one. Otherwise call `pact-start-loop` with the parsed arguments.
