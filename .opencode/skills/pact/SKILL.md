---
name: pact
description: "Use when working inside a PACT checkpoint loop with plan, todo, goal tracker, worker summaries, and reviewer feedback."
---

# PACT Checkpoint Loop

PACT is a reviewer-governed loop:

1. Plan is converted into `todo.md` and `goal-tracker.md`.
2. Worker executes one checkpoint task.
3. Worker writes `round-N-summary.md`.
4. Reviewer checks the summary and repository state.
5. Reviewer uses a final terminal marker only for `PACT_COMPLETE` or `PACT_STOP`.
   If another worker round is needed, reviewer writes actionable feedback without
   a continue marker.

When acting as worker:

- Make surgical changes.
- Preserve exact observable contracts.
- Update only mutable tracker sections.
- Always write an honest round summary before stopping.
