# OpenCode PACT Multi-Agent v1

## Decision

PACT multi-agent v1 keeps the existing driver-owned round transaction. The driver still starts exactly one `pact-worker`; that worker may remain single-agent or autonomously use bounded read-only specialists. If it delegates, the same worker acts as the coordinator and remains the only writer of the canonical workspace and round summary.

Multi-agent execution is an optional worker capability, not a new PACT phase. The existing `implementation`, `full_alignment`, `review`, and `finalize` state machine is unchanged.

## Configuration

The PACT plugin accepts:

```json
{
  "multiAgentPolicy": "disabled",
  "multiAgentAllowedAgents": ["pact-specialist"],
  "multiAgentMaxSubagents": 3
}
```

- `multiAgentPolicy="disabled"` is the compatibility default. Active PACT workers cannot call `task`.
- `multiAgentPolicy="auto"` lets the worker decide whether delegation is useful.
- `multiAgentAllowedAgents` is a strict allowlist. The default contains only `pact-specialist`.
- `multiAgentMaxSubagents` limits delegation attempts per round. The default is three.

There is intentionally no `required` policy in v1. PACT does not reward formal delegation when direct execution is cheaper or safer.

## Execution Contract

In `auto` mode:

1. The driver starts the normal `pact-worker`.
2. The worker decides whether the current objective benefits from independent investigation.
3. A delegated task must be foreground and use an allowed specialist.
4. The worker waits for the specialist result, validates it, and integrates any useful findings.
5. The worker alone modifies the canonical workspace, performs implementation decisions, and writes `round-NN-summary.md`.
6. Worker process exit remains the CLI/LoLBench round boundary.
7. The driver captures the canonical patch, verifies it, invokes the reviewer, advances ledgers, and writes the checkpoint exactly as before.

The v1 restrictions are deliberate:

- specialists are read-only;
- shell and file-write tools are blocked for specialist sessions;
- background delegation is blocked;
- resuming an existing specialist `task_id` is blocked;
- nested delegation is blocked;
- reviewer-only PACT artifacts and benchmark network restrictions remain enforced;
- specialists do not update plan, todo, goal tracker, state, review, or checkpoint files.

The repository defines `.opencode/agent/pact-specialist.md`. The LoLBench smoke config also injects the same agent definition so benchmark workspaces do not depend on repository-local agent discovery.

## Observability

PACT writes `round-NN-execution.json` only after the worker makes an allowed delegation. Absence of this file means the round used the legacy single-worker path.

The v1 artifact records:

- policy and coordinator mode;
- the read-only workspace contract;
- foreground and no-nesting constraints;
- task call ID, specialist name, description, child session ID when observed, and status.

Normal tool events continue to be written to `round-NN-events.jsonl`. The execution artifact is provenance; the final workspace patch and reviewed checkpoint remain authoritative.

## Resume Compatibility

Round00 resume is unchanged. It restores canonical planning artifacts, creates a fresh loop, and begins round 1. No worker or specialist session is inherited.

Exact round resume is also unchanged:

1. validate the existing round checkpoint and hashed files;
2. require the same Git base commit;
3. apply and verify the cumulative canonical workspace patch;
4. restore post-review plan, todo, and goal-tracker ledgers;
5. clear historical active worker sessions;
6. begin a fresh worker at round `N+1`.

`round-NN-execution.json` is copied with inherited round artifacts when present, but it is not replayed and old specialist sessions are not resumed. A resumed worker independently decides whether the new round needs specialists.

This preserves compatibility with existing checkpoint schema `pact-round-checkpoint/v1`: old checkpoints have no multi-agent artifact and continue to mean single-worker execution. Multi-agent v1 does not promise mid-round crash recovery. A crash before a reviewed checkpoint resumes from the preceding completed checkpoint and reruns the round.

**Why multi-agent v1 is resume-compatible with the original PACT** comes down to four invariants that are deliberately left unchanged:

- **Single-writer invariant**: specialists are read-only throughout; the canonical workspace is always modified by exactly one `pact-worker`. Patches replayed during resume have the same structure as those produced by a single-agent run, so the driver's patch verification logic needs no changes.
- **Checkpoint schema invariant**: `round-NN-execution.json` is an optional additive file that does not touch any required field in `pact-round-checkpoint/v1`. Legacy resume logic encountering the file simply ignores it without failing validation.
- **Session statelessness**: specialist sessions are never persisted to a checkpoint. A resume does not need to know whether the previous round delegated; it only needs to start a clean worker session. The crash-recovery path is therefore identical to the single-agent path.
- **Round-boundary invariant**: worker process exit remains the sole round boundary. Multi-agent execution happens within a single worker lifetime and introduces no new boundary events, so the driver's round-advancement and ledger-write logic is unaffected.

## Safety Rationale

Allowing several agents to write the same workspace would make patch provenance, verification timing, and deterministic resume unreliable. v1 therefore gains parallelizable reasoning structure without changing the single-writer transaction boundary. Future versions may add background read-only joins or isolated implementation worktrees, but those require durable join state and a separate integration protocol.
