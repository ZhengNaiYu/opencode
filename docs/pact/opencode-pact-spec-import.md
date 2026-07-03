# OpenCode PACT Spec Import for LoLBench

## Purpose

PACT can start LoLBench runs from deterministic requirement decomposition and code localization output instead of asking the Round00 planner to rediscover the plan. The importer turns each external spec bundle into the same Round00 artifacts the driver expects: `state.json`, `loop-manifest.json`, `source-plan.md`, `plan.md`, `todo.md`, `goal-tracker.md`, `round-00-result.json`, and supporting spec files.

This is the preferred local path when the v14 LoLBench decomposition data is available. The driver still owns execution, review, patch capture, public verification, and final hidden scoring.

## Local Data

Current markdown section source bundle:

```text
/Users/gujiazhen/Documents/cc_codes/benchmark/lolbench_trial-outputs-reme-1dot2_v14_opencode/gpt-5.5
```

Case bundles live under:

```text
/Users/gujiazhen/Documents/cc_codes/benchmark/lolbench_trial-outputs-reme-1dot2_v14_opencode/gpt-5.5/<CASE>
```

Generated Round00 imports:

```text
/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best
```

Index file:

```text
/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best/round0-imports.tsv
```

Each row maps:

```text
case<TAB>bundle_dir<TAB>resume_loop_dir
```

Use `resume_loop_dir` as the value for LoLBench `--pact-resume-loop`.

## Generated Layout

For a case such as `CPython_PEP-709_Inlined-comprehensions_PR-101441`, the generated resume loop is:

```text
/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best/CPython_PEP-709_Inlined-comprehensions_PR-101441/spec-import-round0
```

The important files are:

- `state.json`: loop state with `planner_backend="spec-import"` and `planner_model=null`.
- `loop-manifest.json`: provenance, models, max rounds, and `round0_source="spec-import"`.
- `source-plan.md`: original and enhanced requirement plus imported execution guidance.
- `plan.md`: canonical PACT plan and acceptance criteria.
- `todo.md`: imported task table.
- `goal-tracker.md`: immutable ultimate goal, ACs, formal checklist, edge cases, anti-patterns, and mutable task ledger.
- `spec-input-manifest.json`: exact source section files, generated evidence paths, and excluded files.
- `spec-source/enhanced_requirement_sections/`: complete copied Markdown section directory for worker/reviewer lookup.
- `spec-code-localization.md`: code/function localization supplement when a localization-like section is present.
- `spec-implementation-anchors.md`, `spec-decomposed-steps.md`, `spec-decomposed-requirements.md`, `spec-formal-verification-checklist.md`, `spec-edge-cases.md`, `spec-anti-patterns.md`: compact worker/reviewer-safe spec slices.

## Artifact Generation Strategy

`markdown-sections-v2` is deterministic over the bundle content:

- Scan every `NN_*.md` file under `enhanced_requirement_sections`, sorted by numeric prefix.
- Build the compact PACT plan from stable roles when present: original requirement, decomposed requirements, decomposed implementation steps, implementation anchors, formal checklist, edge cases, and anti-patterns.
- Copy the full section directory into `spec-source/enhanced_requirement_sections` and list every copied section in `spec-input-manifest.json`, so the worker or reviewer can inspect sections that were not summarized into `plan.md`.
- Select code localization from an explicit semantic/code-localization section when present; otherwise use the highest-numbered section if it looks like code/function/file localization.
- Filter delivery-only patch packaging tasks and requirements from worker-facing `plan.md`/`todo.md`; those requirements remain available in the copied evidence directory. PACT/LoLBench owns final `solution.patch` and `test.patch` export.
- If decomposed requirements are absent or only describe delivery packaging, derive acceptance criteria from non-delivery implementation steps. Dependencies pointing to filtered tasks are dropped from worker-facing dependency tables.

Excluded files are recorded but not used as worker/reviewer input:

- `patch_final.diff`
- `opencode_output_build.jsonl`
- `trajectory_build.json`
- `solution.patch`
- `test.patch`

Do not feed hidden eval output, F2P/P2P details, final hidden gate artifacts, or code-host lookup results into worker or reviewer prompts.

## Run One Case

Pick the case from the index:

```bash
CASE="CPython_PEP-709_Inlined-comprehensions_PR-101441"
IMPORT_ROOT="/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best"
ROUND0_LOOP="$IMPORT_ROOT/$CASE/spec-import-round0"
```

Then pass it to LoLBench:

```bash
cd /Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench-pact-local/scripts

python3 lolbench_eval.py \
  --instances "$CASE" \
  --jobs 1 \
  --suites orig \
  --agent-name opencode-pact-specimport-example \
  --out-dir /Users/gujiazhen/Documents/cc_codes/outputs/opencode_pact_specimport_example \
  --patches-dir /Users/gujiazhen/Documents/cc_codes/outputs/opencode_pact_specimport_example/patches \
  --agent-timeout 21600 \
  --agent-retries 0 \
  --cheat-retries 0 \
  --jaccard-gate '' \
  --pact-container-worker \
  --pact-resume-loop "$ROUND0_LOOP" \
  --agent-cmd "bun /Users/gujiazhen/Documents/cc_codes/opencode/.worktrees/pact-observability-replay-v1/.opencode/plugins/pact/pact-run-driver.ts --max-rounds 5 --model zai-coding-plan/glm-5.2 --planner-model gpt-5.5 --reviewer-model gpt-5.5"
```

The `--pact-resume-loop` flag makes LoLBench set `PACT_RESUME_LOOP_DIR` and `PACT_RESUME_MODE=round0` for the PACT driver. The driver validates the imported Round00 package, creates a fresh loop inside the seeded benchmark workspace, regenerates `round-01-prompt.md`, and starts at round 1. The planner argument is retained for attribution but is skipped by resume.

Use the standard PACT smoke OpenCode config for the worker:

```json
{
  "provider": {
    "zai-coding-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "{env:ZAI_API_BASE}",
        "apiKey": "{env:ZAI_API_KEY}"
      },
      "models": {
        "glm-5.2": {}
      }
    }
  }
}
```

Source `ZAI_API_BASE` and `ZAI_API_KEY` from the local mini-swe-agent env before running.

## Regenerate One Import

Use the importer directly from the OpenCode PACT worktree:

```bash
CASE="CPython_PEP-709_Inlined-comprehensions_PR-101441"
SOURCE_ROOT="/Users/gujiazhen/Documents/cc_codes/benchmark/lolbench_trial-outputs-reme-1dot2_v14_opencode/gpt-5.5"
IMPORT_ROOT="/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best"
OPENCODE_ROOT="/Users/gujiazhen/Documents/cc_codes/opencode/.worktrees/pact-observability-replay-v1"
LOLBENCH_ROOT="/Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench-pact-local"

bun "$OPENCODE_ROOT/.opencode/plugins/pact/pact-spec-importer.ts" \
  --bundle-dir "$SOURCE_ROOT/$CASE" \
  --output-loop-dir "$IMPORT_ROOT/$CASE/spec-import-round0" \
  --project-root "$LOLBENCH_ROOT" \
  --plan-file "$SOURCE_ROOT/$CASE/original_requirement.txt" \
  --loop-id "spec-import-$CASE-round0" \
  --max-rounds 5 \
  --reviewer-model gpt-5.5 \
  --worker-model zai-coding-plan/glm-5.2 \
  --worker-config-source mini-swe-agent-env
```

The importer is deterministic over the bundle content and writes only the output loop directory.

## Regenerate All v14 Imports

To regenerate the current CPython imports, iterate over:

```text
/Users/gujiazhen/Documents/cc_codes/benchmark/lolbench_trial-outputs-reme-1dot2_v14_opencode/gpt-5.5/*
```

and run the single-case importer command for each case, writing to:

```text
/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best/<CASE>/spec-import-round0
```

After regeneration, rebuild:

```text
/Users/gujiazhen/Documents/cc_codes/outputs/lolbench_pact_round0_imports_v14_opencode_best/round0-imports.tsv
```

with columns `case`, `bundle_dir`, and `resume_loop_dir`.
