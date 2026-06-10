---
description: "Start a PACT checkpoint loop from a plan"
argument-hint: "path/to/plan.md [--max N] [--reviewer opencode-agent|codex-cli]"
---

Start a PACT loop by calling the `pact-start-loop` tool.

Parse `$ARGUMENTS`:

- First positional argument is `plan_file`.
- Optional `--max N` becomes `max_rounds`.
- Optional `--reviewer VALUE` becomes `reviewer_backend`.

If no plan file is provided, ask the user for one. Otherwise call `pact-start-loop` with the parsed arguments.
