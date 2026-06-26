import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import {
  appendJsonLine,
  appendRoundEvent,
  applyApprovedGoalTrackerUpdates,
  applyPlannerArtifacts,
  artifactPaths,
  buildContinuationPrompt,
  buildFinalizePrompt,
  buildInitialWorkerPrompt,
  buildPlannerPrompt,
  buildPlannerRepairPrompt,
  buildReviewPrompt,
  capturePatchArtifact,
  classifyRoundFailure,
  createLoop,
  exportReplayCase,
  isImmutableGoalTrackerEdit,
  isProtectedWrite,
  normalizePlanLedger,
  parsePlannerArtifacts,
  parseReviewDecision,
  readState,
  recordReviewDecision,
  writeContinuationPackage,
  writeVerificationArtifact,
  extractPatchChangedPaths,
  sha256Text,
  summarizeToolArgs,
  summarizeToolOutput,
  writeJsonFile,
  validatePlannerArtifacts,
  writeRoundEvidence,
  writeRoundSnapshot,
  writeRoundTrajectory,
  writeRoundContext,
  writeRoundResult,
  writeRoundState,
} from "./pact-core"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pact-core-test-"))
  tempDirs.push(dir)
  writeFileSync(join(dir, "plan.md"), "# Plan\nFix the bug.\n", "utf-8")
  return dir
}

function tempGitProject(): string {
  const dir = tempProject()
  execFileSync("git", ["init"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir })
  writeFileSync(join(dir, "src.txt"), "before\n", "utf-8")
  execFileSync("git", ["add", "plan.md", "src.txt"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir })
  return dir
}

describe("artifact helpers", () => {
  test("builds stable artifact paths for padded rounds", () => {
    expect(artifactPaths("/tmp/loop", 1)).toMatchObject({
      loopManifest: "/tmp/loop/loop-manifest.json",
      roundState: "/tmp/loop/round-01-state.json",
      roundContext: "/tmp/loop/round-01-context.json",
      roundEvents: "/tmp/loop/round-01-events.jsonl",
      preSnapshot: "/tmp/loop/round-01-pre-snapshot.json",
      postSnapshot: "/tmp/loop/round-01-post-snapshot.json",
      trajectory: "/tmp/loop/round-01-trajectory.json",
      evidenceJson: "/tmp/loop/round-01-evidence.json",
      evidenceMarkdown: "/tmp/loop/round-01-evidence.md",
      workspacePatch: "/tmp/loop/round-01-workspace.patch",
      evalPatch: "/tmp/loop/round-01-eval.patch",
      patchArtifact: "/tmp/loop/round-01-patch-artifact.json",
      verification: "/tmp/loop/round-01-verification.json",
      verificationLog: "/tmp/loop/round-01-verification.log",
      continuationPackage: "/tmp/loop/round-01-continuation-package.md",
      continuationPackageJson: "/tmp/loop/round-01-continuation-package.json",
      reviewDecision: "/tmp/loop/round-01-review-decision.json",
      roundResult: "/tmp/loop/round-01-result.json",
      roundReplayCase: "/tmp/loop/round-01-replay-case.json",
      replayCase: "/tmp/loop/replay-case.json",
    })
    expect(artifactPaths("/tmp/loop", 0)).toMatchObject({
      roundState: "/tmp/loop/round-00-state.json",
      roundResult: "/tmp/loop/round-00-result.json",
      roundReplayCase: "/tmp/loop/round-00-replay-case.json",
    })
    expect(artifactPaths("/tmp/loop", 12).roundState).toBe("/tmp/loop/round-12-state.json")
  })

  test("writes stable JSON and JSONL files", () => {
    const project = tempProject()
    const jsonPath = join(project, "artifact.json")
    const jsonlPath = join(project, "events.jsonl")

    writeJsonFile(jsonPath, { z: 1, a: true })
    appendJsonLine(jsonlPath, { event: "first" })
    appendJsonLine(jsonlPath, { event: "second" })

    expect(readFileSync(jsonPath, "utf-8")).toBe('{\n  "z": 1,\n  "a": true\n}\n')
    expect(readFileSync(jsonlPath, "utf-8")).toBe('{"event":"first"}\n{"event":"second"}\n')
  })

  test("writes verification and continuation package artifacts", () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      maxRounds: 3,
    })
    const paths = artifactPaths(loop.loopDir, 1)
    writeFileSync(paths.evalPatch, "diff --git a/src.txt b/src.txt\n", "utf-8")
    const verification = writeVerificationArtifact({
      loopDir: loop.loopDir,
      round: 1,
      command: "fake grade",
      status: "failed",
      exitCode: 1,
      durationMs: 1200,
      patchSha256: "abc123",
      applied: false,
      resolved: false,
      buildStatus: "failed",
      f2p: { passed: 0, total: 3 },
      p2p: { passed: 0, total: 3 },
      errorCategories: ["build_failure"],
      logText:
        "compiler said secret-token=abc should be hidden\n[run_tests eval/orig] eval_tests.patch did not apply\nF2P 0/3 P2P 0/3\nDocker grade log: hidden eval TestRecord.java:152: error\n",
      source: "lightweight",
    })
    const pkg = writeContinuationPackage({
      loopDir: loop.loopDir,
      round: 1,
      nextRound: 2,
      maxRounds: 3,
      workerRoundCount: 1,
      loopPhase: "implementation",
      reviewText:
        "### Findings\n- Docker grade says eval_tests.patch failed and F2P 0/3.\n\n### Next Worker Instructions\nRerun lolbench_eval.py pact-gate and repair hidden eval TestRecord constructor failure.",
      verification,
      changedFiles: ["src.txt"],
      patchSha256: "abc123",
      feedbackPath: join(loop.loopDir, "round-01-feedback.md"),
    })

    expect(readFileSync(paths.verificationLog, "utf-8")).toContain("TestRecord.java:152")
    expect(readFileSync(paths.verificationLog, "utf-8")).not.toContain("secret-token=abc")
    expect(JSON.parse(readFileSync(paths.verification, "utf-8"))).toMatchObject({
      schema: "pact-round-verification/v1",
      round: 1,
      status: "failed",
      applied: false,
      resolved: false,
      build_status: "failed",
      f2p: { passed: 0, total: 3 },
      error_categories: ["build_failure"],
    })
    expect(pkg.markdown).toContain("Remaining worker rounds: 2")
    expect(pkg.markdown).not.toContain("Latest Verification Log Tail")
    expect(pkg.markdown).not.toContain("TestRecord.java:152")
    expect(pkg.markdown).not.toContain("eval_tests.patch")
    expect(pkg.markdown).not.toContain("F2P")
    expect(pkg.markdown).not.toContain("P2P")
    expect(pkg.markdown).not.toContain("hidden eval")
    expect(pkg.markdown).not.toContain("lolbench_eval.py")
    expect(pkg.markdown).toContain("Use the worker-safe continuation package and changed files to make workspace-only source changes")
    expect(JSON.parse(readFileSync(paths.continuationPackageJson, "utf-8"))).toMatchObject({
      schema: "pact-continuation-package/v1",
      round: 1,
      next_round: 2,
      verification: { status: "failed", build_status: "failed" },
    })
  })
})

describe("loop and round artifacts", () => {
  test("normalizes a Humanize-style plan ledger with AC and task tables", () => {
    const artifacts = normalizePlanLedger({
      planPath: "plan.md",
      planContent: `# Plan

Ship the checkpoint loop.

- AC-1: Reviewer complete should enter review phase.
- AC-2: Deprecated stop signals should continue.

- [ ] Implement review phase
- [ ] Implement stop compatibility
`,
    })

    expect(artifacts.todo).toContain("| task-1 | Implement review phase | AC-1 | coding | - | pending |")
    expect(artifacts.todo).toContain("| task-2 | Implement stop compatibility | AC-2 | coding | task-1 | pending |")
    expect(artifacts.goalTracker).toContain("## IMMUTABLE SECTION")
    expect(artifacts.goalTracker).toContain("| AC-1 | Reviewer complete should enter review phase.")
    expect(artifacts.goalTracker).toContain("## MUTABLE SECTION")
    expect(artifacts.goalTracker).toContain("#### Active Tasks")
  })

  test("normalizes LoLBench patch files as harness-owned artifacts, not worker tasks", () => {
    const artifacts = normalizePlanLedger({
      planPath: "PROMPT.md",
      planContent: `# Task
Implement PEP 680 tomllib support, delivering implementation changes only in solution.patch and tests in test.patch.

- AC-1: Add tomllib.
- AC-2: Implementation changes are isolated to solution.patch; tests, if added, are isolated to test.patch.

- [ ] Add tomllib implementation
- [ ] Generate and inspect solution.patch and optional test.patch for boundary compliance
`,
    })

    expect(artifacts.todo).toContain("Add tomllib implementation")
    expect(artifacts.todo).toContain("Keep implementation and optional test changes separable")
    expect(artifacts.todo).not.toContain("Generate and inspect solution.patch")
    expect(artifacts.goalTracker).toContain("PACT/harness")
    expect(artifacts.goalTracker).not.toContain("solution.patch")
    expect(artifacts.goalTracker).not.toContain("test.patch")
  })

  test("planner prompt explains that benchmark patch files are not worker outputs", () => {
    const prompt = buildPlannerPrompt({
      planPath: "PROMPT.md",
      planContent: "Deliver implementation in solution.patch and tests in test.patch.",
    })

    expect(prompt).toContain("PACT/harness owns final patch export")
    expect(prompt).toContain("Do not create acceptance criteria or tasks that ask the worker to generate, edit, stage, or inspect")
  })

  test("createLoop writes a loop manifest", () => {
    const project = tempProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      maxRounds: 2,
      plannerBackend: "codex-cli",
      plannerModel: "gpt-5.5",
      reviewerBackend: "codex-cli",
      reviewerModel: "gpt-5.4-mini",
      workerSessionID: "ses_worker",
      now: new Date("2026-06-22T01:02:03Z"),
    })

    expect(JSON.parse(readFileSync(join(loop.loopDir, "loop-manifest.json"), "utf-8"))).toMatchObject({
      schema: "pact-loop-manifest/v1",
      artifact_version: 2,
      loop_id: "2026-06-22T01-02-03Z",
      project_root: project,
      plan_file: "plan.md",
      source_plan_path: join(loop.loopDir, "source-plan.md"),
      round0_enabled: true,
      max_rounds: 2,
      full_alignment_interval: 5,
      session_strategy: "new-per-round",
      trajectory_mode: "full-redact",
      phase_config: {
        gate: "session_idle",
        stop_hook: false,
      },
      planner_backend: "codex-cli",
      planner_model: "gpt-5.5",
      reviewer_backend: "codex-cli",
      reviewer_model: "gpt-5.4-mini",
      active_session_id: "ses_worker",
      active_round_session_id: "ses_worker",
      goal_tracker_immutable_sha256: readState(loop.loopDir).goal_tracker_immutable_sha256,
    })
    expect(readFileSync(join(loop.loopDir, "source-plan.md"), "utf-8")).toBe("# Plan\nFix the bug.\n")
    expect(existsSync(join(loop.loopDir, "round-00-state.json"))).toBe(true)
    expect(existsSync(join(loop.loopDir, "round-00-git-snapshot.json"))).toBe(true)
    expect(existsSync(join(loop.loopDir, "round-00-result.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-00-state.json"), "utf-8"))).toMatchObject({
      phase: "round_finished",
      status: "complete",
      loop_phase: "implementation",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-00-result.json"), "utf-8"))).toMatchObject({
      status: "complete",
      loop_phase: "implementation",
      failure_category: null,
    })
    expect(readState(loop.loopDir)).toMatchObject({
      version: 2,
      status: "running",
      phase: "implementation",
      current_round: 1,
      worker_round_count: 0,
      session_strategy: "new-per-round",
      trajectory_mode: "full-redact",
      active_round_session_id: "ses_worker",
    })
  })

  test("validates canonical planner artifacts and builds a repair prompt for invalid output", () => {
    const valid = parsePlannerArtifacts(`<<<PACT_PLAN>>>
# Goal Description
Fix the bug.

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected |

## Path Boundaries
- Modify only relevant files.

## Dependencies
- None.

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - |

## Pending Decisions
- None.
<<<END_PACT_PLAN>>>
<<<PACT_TODO>>>
# Todo
| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - | pending |
<<<END_PACT_TODO>>>
<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE SECTION
### Ultimate Goal
Fix the bug.
### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected | pending |
## MUTABLE SECTION
#### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
| --- | --- | --- | --- |
#### Active Tasks
| Task | Target AC | Status | Tag | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| task-1 | AC-1 | pending | coding | worker | Fix parser |
### Completed and Verified
| AC | Task | Completed Round | Verified Round | Evidence |
| --- | --- | --- | --- | --- |
### Explicitly Deferred
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
| --- | --- | --- | --- | --- |
### Open Issues
| Issue | Discovered Round | Blocking AC | Resolution Path |
| --- | --- | --- | --- |
<<<END_PACT_GOAL_TRACKER>>>
`)
    const invalid = parsePlannerArtifacts(`<<<PACT_TODO>>>\n# Todo\n- [ ] Fix it\n<<<END_PACT_TODO>>>`)
    const missingTodo = parsePlannerArtifacts(`<<<PACT_PLAN>>>
# Goal Description
Fix the bug.

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected |

## Path Boundaries
- Modify only relevant files.

## Dependencies
- None.

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - |

## Pending Decisions
- None.
<<<END_PACT_PLAN>>>
<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE SECTION
### Ultimate Goal
Fix the bug.
### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected | pending |
## MUTABLE SECTION
#### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
| --- | --- | --- | --- |
#### Active Tasks
| Task | Target AC | Status | Tag | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| task-1 | AC-1 | pending | coding | worker | Fix parser |
### Completed and Verified
| AC | Task | Completed Round | Verified Round | Evidence |
| --- | --- | --- | --- | --- |
### Explicitly Deferred
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
| --- | --- | --- | --- | --- |
### Open Issues
| Issue | Discovered Round | Blocking AC | Resolution Path |
| --- | --- | --- | --- |
<<<END_PACT_GOAL_TRACKER>>>
`)
    const missingGoalTracker = parsePlannerArtifacts(`<<<PACT_PLAN>>>
# Goal Description
Fix the bug.

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected |

## Path Boundaries
- Modify only relevant files.

## Dependencies
- None.

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - |

## Pending Decisions
- None.
<<<END_PACT_PLAN>>>
<<<PACT_TODO>>>
# Todo
| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - | pending |
<<<END_PACT_TODO>>>
`)

    expect(validatePlannerArtifacts(valid).ok).toBe(true)
    expect(validatePlannerArtifacts(invalid)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(["canonical_plan"]),
    })
    expect(validatePlannerArtifacts(missingTodo)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(["todo_marker"]),
    })
    expect(validatePlannerArtifacts(missingGoalTracker)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(["goal_tracker_marker"]),
    })
    expect(buildPlannerRepairPrompt({ previousOutput: "bad", validation: validatePlannerArtifacts(invalid) })).toContain(
      "Repair the PACT planner output",
    )
  })

  test("createLoop defaults to codex planner and reviewer backends", () => {
    const project = tempProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      now: new Date("2026-06-22T01:02:03Z"),
    })

    expect(readState(loop.loopDir).planner_backend).toBe("codex-cli")
    expect(readState(loop.loopDir).reviewer_backend).toBe("codex-cli")
    expect(JSON.parse(readFileSync(join(loop.loopDir, "loop-manifest.json"), "utf-8"))).toMatchObject({
      planner_backend: "codex-cli",
      reviewer_backend: "codex-cli",
    })
  })

  test("createLoop records worker metadata and excludes pact artifacts from git", () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerBackend: "opencode-cli",
      workerModel: "zai-coding-plan/glm-5-turbo",
      workerConfigSource: "mini-swe-agent-env",
      now: new Date("2026-06-22T01:02:03Z"),
    })
    const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: project,
      encoding: "utf-8",
    }).trim()
    const absoluteExcludePath = isAbsolute(excludePath) ? excludePath : join(project, excludePath)

    expect(readState(loop.loopDir)).toMatchObject({
      worker_backend: "opencode-cli",
      worker_model: "zai-coding-plan/glm-5-turbo",
      worker_config_source: "mini-swe-agent-env",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "loop-manifest.json"), "utf-8"))).toMatchObject({
      worker_backend: "opencode-cli",
      worker_model: "zai-coding-plan/glm-5-turbo",
      worker_config_source: "mini-swe-agent-env",
    })
    const excludeText = readFileSync(absoluteExcludePath, "utf-8")
    expect(excludeText).toContain(".pact/")
    expect(excludeText).toContain("/*.patch")
    expect(excludeText).toContain("/*.diff")
  })

  test("writes round state and context with stable content hashes", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md", now: new Date("2026-06-22T01:02:03Z") })
    writeFileSync(join(loop.loopDir, "round-01-prompt.md"), "prompt\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-01-feedback.md"), "feedback\n", "utf-8")

    writeRoundState({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      phase: "round_started",
      startedAt: "2026-06-22T01:02:03.000Z",
      updatedAt: "2026-06-22T01:02:04.000Z",
    })
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      workerAgent: "pact-worker",
      workerBackend: "opencode-cli",
      workerModel: "zai-coding-plan/glm-5-turbo",
      workerConfigSource: "mini-swe-agent-env",
      loopPhase: "implementation",
      plannerBackend: "codex-cli",
      plannerModel: "gpt-5.5",
      reviewerBackend: "opencode-agent",
      reviewerModel: null,
      promptPath: join(loop.loopDir, "round-01-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
      feedbackPath: join(loop.loopDir, "round-01-feedback.md"),
    })

    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-state.json"), "utf-8"))).toMatchObject({
      schema: "pact-round-state/v1",
      loop_id: loop.loopID,
      round: 1,
      phase: "round_started",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-context.json"), "utf-8"))).toMatchObject({
      schema: "pact-round-context/v1",
      loop_id: loop.loopID,
      round: 1,
      session_id: "ses_worker",
      worker_backend: "opencode-cli",
      worker_model: "zai-coding-plan/glm-5-turbo",
      worker_config_source: "mini-swe-agent-env",
      loop_phase: "implementation",
      planner_backend: "codex-cli",
      planner_model: "gpt-5.5",
      reviewer_backend: "opencode-agent",
      feedback_sha256: sha256Text("feedback\n"),
    })
  })

  test("missing feedback context uses the empty string hash", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    writeFileSync(join(loop.loopDir, "round-01-prompt.md"), "prompt\n", "utf-8")

    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      workerAgent: "pact-worker",
      reviewerBackend: "opencode-agent",
      promptPath: join(loop.loopDir, "round-01-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })

    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-context.json"), "utf-8")).feedback_sha256).toBe(
      sha256Text(""),
    )
  })

  test("rejects immutable goal tracker edits after initialization", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const trackerPath = join(loop.loopDir, "goal-tracker.md")
    const original = readFileSync(trackerPath, "utf-8")
    const changedImmutable = original.replace("Fix the bug.", "Silently change the plan.")
    const changedMutable = original.replace("Initial plan ledger", "Initial plan ledger updated")

    expect(isImmutableGoalTrackerEdit(trackerPath, changedImmutable)).toBe(true)
    expect(isImmutableGoalTrackerEdit(trackerPath, changedMutable)).toBe(false)
  })

  test("applies reviewer-approved goal tracker updates to the mutable ledger", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    const applied = applyApprovedGoalTrackerUpdates({
      loopDir: loop.loopDir,
      round: 2,
      summaryText: "## Goal Tracker Update Request\nMark task-1 complete with evidence: tests pass.\n",
      reviewText: "### Goal Tracker Updates\nAPPROVED\nThe requested update is justified.\n",
    })

    expect(applied).toBe(true)
    expect(readFileSync(join(loop.loopDir, "goal-tracker.md"), "utf-8")).toContain(
      "Reviewer-approved goal tracker update",
    )
    expect(readFileSync(join(loop.loopDir, "goal-tracker.md"), "utf-8")).toContain(
      "| AC-1 | task-1 | 2 | 2 | tests pass. |",
    )
    expect(readFileSync(join(loop.loopDir, "goal-tracker.md"), "utf-8")).toContain(
      "| task-1 | AC-1 | complete | coding | worker | Implement the smallest coherent checkpoint. |",
    )
  })

  test("does not apply rejected goal tracker updates containing the word approved", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const trackerPath = join(loop.loopDir, "goal-tracker.md")
    const original = readFileSync(trackerPath, "utf-8")

    const applied = applyApprovedGoalTrackerUpdates({
      loopDir: loop.loopDir,
      round: 2,
      summaryText: "## Goal Tracker Update Request\nMark task-1 complete with evidence: tests pass.\n",
      reviewText: "### Goal Tracker Updates\nNOT APPROVED\nNo updates approved.\n",
    })

    expect(applied).toBe(false)
    expect(readFileSync(trackerPath, "utf-8")).toBe(original)
  })

  test("normalizes planner goal tracker headings before applying approved updates", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const plannerArtifacts = parsePlannerArtifacts(`<<<PACT_PLAN>>>
# Goal Description
Fix the bug.

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected |

## Path Boundaries
- Modify only relevant files.

## Dependencies
- None.

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - |

## Pending Decisions
- None.
<<<END_PACT_PLAN>>>
<<<PACT_TODO>>>
# Todo
| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
| task-1 | Fix parser | AC-1 | coding | - | pending |
<<<END_PACT_TODO>>>
<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE SECTION
### Ultimate Goal
Fix the bug.
### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
| AC-1 | Bug is fixed | Regression test passes | Old failure is rejected | pending |
## MUTABLE SECTION
### Plan Version: 1 (Updated: Round 1)
### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
| --- | --- | --- | --- |
| 1 | Initial plan ledger | Planner initialization | - |
### Active Tasks
| Task | Target AC | Status | Tag | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| task-1 | AC-1 | pending | coding | worker | Fix parser |
### Completed and Verified
| AC | Task | Completed Round | Verified Round | Evidence |
| --- | --- | --- | --- | --- |
### Explicitly Deferred
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
| --- | --- | --- | --- | --- |
### Open Issues
| Issue | Discovered Round | Blocking AC | Resolution Path |
| --- | --- | --- | --- |
<<<END_PACT_GOAL_TRACKER>>>
`)

    applyPlannerArtifacts(loop.loopDir, plannerArtifacts)
    applyApprovedGoalTrackerUpdates({
      loopDir: loop.loopDir,
      round: 2,
      summaryText: "## Goal Tracker Update Request\nMark task-1 complete with evidence: tests pass.\n",
      reviewText: "### Goal Tracker Updates\nAPPROVED\n",
    })

    const tracker = readFileSync(join(loop.loopDir, "goal-tracker.md"), "utf-8")
    expect(tracker.match(/Plan Evolution Log/g)?.length).toBe(1)
    expect(tracker.match(/Active Tasks/g)?.length).toBe(1)
    expect(tracker).toContain("#### Plan Evolution Log")
    expect(tracker).toContain("#### Active Tasks")
    expect(tracker).toContain("| 2 | Reviewer-approved goal tracker update |")
    expect(tracker).toContain("| AC-1 | task-1 | 2 | 2 | tests pass. |")
  })
})

describe("worker prompt shape", () => {
  test("worker prompts forbid task and subagent delegation for observable replay", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    const initial = buildInitialWorkerPrompt({
      loopDir: loop.loopDir,
      round: 1,
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    const continuation = buildContinuationPrompt({
      loopDir: loop.loopDir,
      round: 2,
      feedbackPath: join(loop.loopDir, "round-01-feedback.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    const finalize = buildFinalizePrompt({
      loopDir: loop.loopDir,
      round: 3,
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })

    for (const prompt of [initial, continuation, finalize]) {
      expect(prompt).toContain("Do not use Task/subagent delegation")
    }
  })

  test("worker prompts reserve patch export, git index, and external validation gates for PACT", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    const initial = buildInitialWorkerPrompt({
      loopDir: loop.loopDir,
      round: 1,
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    const continuation = buildContinuationPrompt({
      loopDir: loop.loopDir,
      round: 2,
      feedbackPath: join(loop.loopDir, "round-01-feedback.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })

    for (const prompt of [initial, continuation]) {
      expect(prompt).toContain("Do not create or edit external validation-owned patch files")
      expect(prompt).toContain("Do not run external validation gates")
      expect(prompt).not.toContain("lolbench_eval.py")
      expect(prompt).toContain("Do not stage, reset, commit, stash, or otherwise manage git index state")
    }
  })

  test("worker prompts require a round contract but treat ledgers as reviewer-owned", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    const initial = buildInitialWorkerPrompt({
      loopDir: loop.loopDir,
      round: 1,
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    const continuation = buildContinuationPrompt({
      loopDir: loop.loopDir,
      round: 2,
      feedbackPath: join(loop.loopDir, "round-01-feedback.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })

    for (const prompt of [initial, continuation]) {
      expect(prompt).toContain("round-")
      expect(prompt).toContain("-contract.md")
      expect(prompt).toContain("single mainline objective")
      expect(prompt).toContain("blocking")
      expect(prompt).toContain("queued")
      expect(prompt).toContain("Do not directly edit todo.md")
      expect(prompt).toContain("Ledger Update Request")
      expect(prompt).not.toContain("goes idle")
    }
    expect(initial).toContain("when this bounded run ends")
  })

  test("continuation prompts are self-contained round packages", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const prompt = buildContinuationPrompt({
      loopDir: loop.loopDir,
      round: 2,
      feedbackPath: join(loop.loopDir, "round-01-feedback.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      planPath: join(loop.loopDir, "plan.md"),
      preSnapshotPath: join(loop.loopDir, "round-02-pre-snapshot.json"),
      cumulativePatchPath: join(loop.loopDir, "round-01-eval.patch"),
    })

    expect(prompt).toContain("Plan:")
    expect(prompt).toContain("Todo:")
    expect(prompt).toContain("Goal tracker:")
    expect(prompt).not.toContain("Reviewer feedback:")
    expect(prompt).toContain("Pre-round snapshot:")
    expect(prompt).not.toContain("Cumulative eval patch:")
    expect(prompt).not.toContain("round-01-feedback.md")
    expect(prompt).not.toContain("round-01-eval.patch")
    expect(prompt).not.toContain("LoLBench")
    expect(prompt).toContain("write an honest summary")
  })

  test("continuation package translates benchmark-owned patch and gate feedback into workspace-only work", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const verification = writeVerificationArtifact({
      loopDir: loop.loopDir,
      round: 1,
      command: "python3 /bench/lolbench_eval.py pact-gate",
      status: "failed",
      buildStatus: "skipped",
      logText:
        "[run_tests eval/orig] eval_tests.patch did not apply cleanly on top of source patch:\nerror: Lib/test/test_tomllib/__main__.py: already exists in working directory\n",
    })

    const { artifact, markdown } = writeContinuationPackage({
      loopDir: loop.loopDir,
      round: 1,
      nextRound: 2,
      maxRounds: 12,
      workerRoundCount: 1,
      loopPhase: "implementation",
      verification,
      changedFiles: ["Lib/test/test_tomllib/__main__.py", "Lib/tomllib/_parser.py"],
      reviewText: `### Findings
- round-01-patch-artifact.json shows workspace_patch and eval_patch are identical.

### Next Worker Instructions
Regenerate the patch artifacts so the eval patch contains only the incremental delta after the source patch, then rerun the pact gate until patch application succeeds and build_status is success.
`,
    })

    expect(artifact.next_worker_instruction).not.toContain("Regenerate the patch artifacts")
    expect(artifact.next_worker_instruction).not.toContain("rerun the pact gate")
    expect(markdown).not.toContain("Regenerate the patch artifacts")
    expect(markdown).not.toContain("rerun the pact gate")
    expect(markdown).not.toContain("eval_tests.patch")
    expect(markdown).not.toContain("benchmark eval patches")
    expect(markdown).not.toContain("eval failure")
    expect(markdown).not.toContain("Latest Verification Log Tail")
    expect(JSON.stringify(artifact)).not.toContain("verification.json")
    expect(JSON.stringify(artifact)).not.toContain("round-01-feedback.md")
    expect(markdown).toContain("Do not modify PACT artifacts or run gates")
    expect(markdown).toContain("make workspace-only source changes")
    expect(markdown).toContain("Lib/test/test_tomllib/__main__.py")
  })

  test("continuation package does not expose verification artifact paths to worker", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const verification = writeVerificationArtifact({
      loopDir: loop.loopDir,
      round: 4,
      command: "python3 /bench/lolbench_eval.py pact-gate",
      status: "failed",
      buildStatus: "skipped",
      logText:
        "[run_tests eval/orig] eval_tests.patch did not apply cleanly on top of source patch:\nerror: Lib/test/test_unparse.py: patch does not apply\n",
    })

    const { markdown } = writeContinuationPackage({
      loopDir: loop.loopDir,
      round: 4,
      nextRound: 5,
      maxRounds: 10,
      workerRoundCount: 4,
      loopPhase: "implementation",
      verification,
      changedFiles: ["Lib/test/test_unparse.py", "Python/compile.c"],
      reviewText: `### Findings
- Blocking: round-04-eval.patch does not apply cleanly. See [verification](${join(
        loop.loopDir,
        "round-04-verification.json",
      )}#L23) and [log](${join(loop.loopDir, "round-04-verification.log")}#L1).

### Next Worker Instructions
Fix the patch export so round-04-eval.patch applies cleanly on top of the source patch, then rerun the gate.
`,
    })
    const prompt = buildContinuationPrompt({
      loopDir: loop.loopDir,
      round: 5,
      feedbackPath: join(loop.loopDir, "round-04-feedback.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
      continuationPackageText: markdown,
      continuationPackagePath: join(loop.loopDir, "round-04-continuation-package.md"),
    })

    for (const workerText of [markdown, prompt]) {
      expect(workerText).not.toContain("round-04-verification.json")
      expect(workerText).not.toContain("round-04-verification.log")
      expect(workerText).not.toContain("Fix the patch export")
      expect(workerText).not.toContain("rerun the gate")
      expect(workerText).toContain("[redacted worker-unsafe benchmark/eval detail]")
    }
  })

  test("continuation package redacts reviewer-restated eval case details", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const verification = writeVerificationArtifact({
      loopDir: loop.loopDir,
      round: 2,
      command: "python3 /bench/lolbench_eval.py pact-gate",
      status: "failed",
      buildStatus: "ok",
      f2p: { passed: 2, total: 6 },
      p2p: { passed: 18, total: 18 },
      logText:
        "test_ast.AST_Tests.test_snippets failed\nForwardRef('*c')\na[*a,] unparses as a[(*a,)]\n",
    })

    const { markdown } = writeContinuationPackage({
      loopDir: loop.loopDir,
      round: 2,
      nextRound: 3,
      maxRounds: 10,
      workerRoundCount: 2,
      loopPhase: "implementation",
      verification,
      changedFiles: ["Grammar/python.gram", "Parser/parser.c", "Python/compile.c"],
      patchSha256: "abc123",
      reviewText: `### Findings
- [Python/compile.c](/private/tmp/workspace/Python/compile.c#L2375) sends starred vararg annotations through future-annotations handling, which leads to a \`ForwardRef('*c')\` failure in verification. This blocks AC-6.
- [Parser/parser.c](/private/tmp/workspace/Parser/parser.c#L5482) constructs the \`Starred\` annotation node with locations that do not match expected AST spans; verification shows a column-offset mismatch in \`test_ast.AST_Tests.test_snippets\`.
- [Parser/parser.c](/private/tmp/workspace/Parser/parser.c#L13897) leaves starred subscript round-tripping inconsistent; verification reports \`a[*a,]\` unparses as \`a[(*a,)]\`, which blocks AC-7.

### Next Worker Instructions
Fix future-annotations handling for starred vararg annotations, AST span correctness, and starred-subscript unparse round-tripping.
`,
    })
    const prompt = buildContinuationPrompt({
      loopDir: loop.loopDir,
      round: 3,
      feedbackPath: join(loop.loopDir, "round-02-feedback.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
      continuationPackageText: markdown,
      continuationPackagePath: join(loop.loopDir, "round-02-continuation-package.md"),
    })

    for (const workerText of [markdown, prompt]) {
      expect(workerText).not.toContain("test_ast.AST_Tests.test_snippets")
      expect(workerText).not.toContain("ForwardRef")
      expect(workerText).not.toContain("a[*a,]")
      expect(workerText).not.toContain("a[(*a,)]")
      expect(workerText).not.toContain("f2p")
      expect(workerText).not.toContain("p2p")
      expect(workerText).not.toContain("F2P")
      expect(workerText).not.toContain("P2P")
      expect(workerText).toContain("[redacted worker-unsafe benchmark/eval detail]")
      expect(workerText).toContain("Fix future-annotations handling")
    }
  })

  test("continuation package preserves safe action when reviewer instruction includes eval tokens", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const verification = writeVerificationArtifact({
      loopDir: loop.loopDir,
      round: 1,
      command: "python3 /bench/lolbench_eval.py pact-gate",
      status: "failed",
      buildStatus: "ok",
      logText: "}\n",
    })

    const { artifact, markdown } = writeContinuationPackage({
      loopDir: loop.loopDir,
      round: 1,
      nextRound: 2,
      maxRounds: 3,
      workerRoundCount: 1,
      loopPhase: "implementation",
      verification,
      changedFiles: ["Grammar/python.gram", "Parser/parser.c", "Python/compile.c"],
      reviewText: `### Findings
- The current patch still has source-level regressions around starred annotations.

### Next Worker Instructions
Fix the starred-subscript unparse regression, the *args source-location regression, and the future-annotations ForwardRef('*c') failure, then rerun the same focused evaluation until F2P passes.
`,
    })

    expect(artifact.latest_failure_signature).toBeUndefined()
    expect(markdown).not.toContain("Latest failure category: }")
    expect(artifact.next_worker_instruction).toContain("Fix the starred-subscript unparse regression")
    expect(artifact.next_worker_instruction).toContain("source-location regression")
    expect(artifact.next_worker_instruction).toContain("future-annotations")
    expect(artifact.next_worker_instruction).not.toContain("ForwardRef")
    expect(artifact.next_worker_instruction).not.toContain("F2P")
    expect(markdown).toContain("Fix the starred-subscript unparse regression")
    expect(markdown).not.toContain("ForwardRef")
    expect(markdown).not.toContain("F2P")
  })

  test("worker prompts make contract-first and stop-after-summary explicit", () => {
    const loopDir = "/tmp/project/.pact/loops/2026-06-26T00-00-00Z"
    const initial = buildInitialWorkerPrompt({
      loopDir,
      round: 1,
      todoPath: join(loopDir, "todo.md"),
      goalTrackerPath: join(loopDir, "goal-tracker.md"),
    })
    const continuation = buildContinuationPrompt({
      loopDir,
      round: 2,
      feedbackPath: join(loopDir, "round-01-feedback.md"),
      goalTrackerPath: join(loopDir, "goal-tracker.md"),
      continuationPackageText: "Safe package",
    })

    for (const prompt of [initial, continuation]) {
      expect(prompt).toContain("First action")
      expect(prompt).toContain("Missing contract is a reviewer-blocking defect")
      expect(prompt).toContain("After writing the summary, stop work and return control")
    }
  })
})

describe("review prompt shape", () => {
  test("reviewer prompt separates authoritative facts from worker claims", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const prompt = buildReviewPrompt({
      loopDir: loop.loopDir,
      round: 1,
      summaryPath: join(loop.loopDir, "round-01-summary.md"),
      summary: "",
      summaryStatus: "missing",
      contractPath: join(loop.loopDir, "round-01-contract.md"),
      contractStatus: "missing",
    })

    expect(prompt).toContain("Authoritative Facts")
    expect(prompt).toContain("Worker Claims")
    expect(prompt).toContain("Summary status: missing")
    expect(prompt).toContain("Contract status: missing")
    expect(prompt).toContain("### Claim Audit")
    expect(prompt).toContain("### Contract Scope Audit")
    expect(prompt).toContain("Mainline Gaps")
    expect(prompt).toContain("Blocking Side Issues")
    expect(prompt).toContain("Queued Side Issues")
  })

  test("full alignment reviews include historical round references and two-state instructions", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const prompt = buildReviewPrompt({
      loopDir: loop.loopDir,
      round: 5,
      summaryPath: join(loop.loopDir, "round-05-summary.md"),
      summary: "Summary",
      reviewKind: "full_alignment",
    })

    expect(prompt).toContain("## Full Alignment Check")
    expect(prompt).toContain("Previous round summaries")
    expect(prompt).toContain("### Acceptance Criteria Audit")
    expect(prompt).toContain("PACT_STOP and PACT_CONTINUE are deprecated")
  })

  test("protects PACT-owned ledgers and state artifacts from worker writes", () => {
    const loopDir = "/tmp/project/.pact/loops/2026-06-25T00-00-00Z"

    for (const filePath of [
      `${loopDir}/state.json`,
      `${loopDir}/plan.md`,
      `${loopDir}/source-plan.md`,
      `${loopDir}/todo.md`,
      `${loopDir}/goal-tracker.md`,
      `${loopDir}/round-01-context.json`,
      `${loopDir}/round-01-state.json`,
      `${loopDir}/round-01-review.md`,
      `${loopDir}/round-01-review-decision.json`,
      `${loopDir}/round-01-feedback.md`,
      `${loopDir}/complete-state.md`,
      `${loopDir}/stop-state.md`,
    ]) {
      expect(isProtectedWrite(filePath)).toBe(true)
    }
  })
})

describe("round events", () => {
  test("appends summarized round events without raw tool output", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    appendRoundEvent({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      type: "tool_after",
      sessionID: "ses_worker",
      data: summarizeToolOutput({
        title: "Read",
        output: "secret output that should not be copied",
        metadata: { truncated: false, outputPath: "/tmp/out" },
      }),
      time: "2026-06-22T01:02:03.000Z",
    })

    expect(readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")).toContain('"output_length":39')
    expect(readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")).not.toContain("secret output")
    expect(summarizeToolArgs({ filePath: "src/a.ts", content: "secret" })).toEqual({
      keys: ["content", "filePath"],
    })
  })

  test("redacts secret-like values before persisting event data", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    appendRoundEvent({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      type: "review_finished",
      sessionID: "ses_worker",
      data: {
        status: "failed",
        error: "Codex reviewer failed: api_key=secret-value token=another-secret ZAI_API_KEY=prefixed-secret",
      },
      time: "2026-06-22T01:02:03.000Z",
    })

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).not.toContain("secret-value")
    expect(events).not.toContain("another-secret")
    expect(events).not.toContain("prefixed-secret")
    expect(events).toContain("[REDACTED]")
  })

  test("redacts JSON-formatted secret-like values before persisting event data", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    appendRoundEvent({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      type: "review_finished",
      sessionID: "ses_worker",
      data: {
        error: 'Codex reviewer failed: {"api_key":"json-secret","token":"token-secret","password":"pw-secret"}',
      },
      time: "2026-06-22T01:02:03.000Z",
    })

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).not.toContain("json-secret")
    expect(events).not.toContain("token-secret")
    expect(events).not.toContain("pw-secret")
    expect(events).toContain("[REDACTED]")
  })
})

describe("patch artifacts", () => {
  test("extracts safe changed paths from patch text", () => {
    expect(
      extractPatchChangedPaths(`diff --git a/Lib/test/test_tomllib.py b/Lib/test/test_tomllib.py
--- a/Lib/test/test_tomllib.py
+++ b/Lib/test/test_tomllib.py
diff --git a/old name.py b/new name.py
rename from old name.py
rename to new name.py
diff --git a/../../escape b/../../escape
+++ b//dev/null
`),
    ).toEqual(["Lib/test/test_tomllib.py", "new name.py", "old name.py"])
  })

  test("captures empty patch metadata", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    const artifact = capturePatchArtifact({
      projectRoot: project,
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
    })

    expect(artifact.eval_patch.empty).toBe(true)
    expect(artifact.eval_patch.lines).toBe(0)
    expect(artifact.eval_patch.changed_files).toEqual([])
    expect(readFileSync(join(loop.loopDir, "round-01-eval.patch"), "utf-8")).toBe("")
  })

  test("captures tracked and untracked changes while excluding pact files", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    writeFileSync(join(project, "new.txt"), "new\n", "utf-8")
    mkdirSync(join(project, ".pact"), { recursive: true })
    writeFileSync(join(project, ".pact", "ignored.txt"), "ignored\n", "utf-8")

    const artifact = capturePatchArtifact({
      projectRoot: project,
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
    })

    expect(artifact.eval_patch.empty).toBe(false)
    expect(artifact.eval_patch.changed_files).toEqual(["new.txt", "src.txt"])
    expect(readFileSync(join(loop.loopDir, "round-01-eval.patch"), "utf-8")).toContain("new.txt")
    expect(readFileSync(join(loop.loopDir, "round-01-eval.patch"), "utf-8")).not.toContain(".pact")
    expect(artifact.checks.apply_check.status).toBe("passed")
  })

  test("excludes benchmark scaffolding patches while recording their metadata", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    writeFileSync(join(project, "new.txt"), "new\n", "utf-8")
    writeFileSync(join(project, "solution.patch"), "diff --git a/secret b/secret\n", "utf-8")
    writeFileSync(join(project, "test.patch"), "diff --git a/test b/test\n", "utf-8")
    writeFileSync(join(project, "all_changes.patch"), "diff --git a/all b/all\n", "utf-8")
    writeFileSync(join(project, "solution_new.patch"), "diff --git a/new b/new\n", "utf-8")
    writeFileSync(join(project, "notes.diff"), "diff --git a/notes b/notes\n", "utf-8")

    const artifact = capturePatchArtifact({
      projectRoot: project,
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
    })
    const patch = readFileSync(join(loop.loopDir, "round-01-eval.patch"), "utf-8")

    expect(artifact.eval_patch.changed_files).toEqual(["new.txt", "src.txt"])
    expect(patch).not.toContain("solution.patch")
    expect(patch).not.toContain("test.patch")
    expect(patch).not.toContain("all_changes.patch")
    expect(patch).not.toContain("solution_new.patch")
    expect(patch).not.toContain("notes.diff")
    expect(artifact.excluded_scaffolding_files).toEqual([
      {
        path: "all_changes.patch",
        sha256: sha256Text("diff --git a/all b/all\n"),
        bytes: 23,
        lines: 1,
      },
      {
        path: "notes.diff",
        sha256: sha256Text("diff --git a/notes b/notes\n"),
        bytes: 27,
        lines: 1,
      },
      {
        path: "solution.patch",
        sha256: sha256Text("diff --git a/secret b/secret\n"),
        bytes: 29,
        lines: 1,
      },
      {
        path: "solution_new.patch",
        sha256: sha256Text("diff --git a/new b/new\n"),
        bytes: 23,
        lines: 1,
      },
      {
        path: "test.patch",
        sha256: sha256Text("diff --git a/test b/test\n"),
        bytes: 25,
        lines: 1,
      },
    ])
  })

  test("excludes files listed inside root test.patch from eval patch while retaining workspace observability", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    mkdirSync(join(project, "Lib", "test"), { recursive: true })
    writeFileSync(join(project, "Lib", "test", "test_tomllib.py"), "new test\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    writeFileSync(
      join(project, "test.patch"),
      [
        "diff --git a/Lib/test/test_tomllib.py b/Lib/test/test_tomllib.py",
        "--- /dev/null",
        "+++ b/Lib/test/test_tomllib.py",
        "@@ -0,0 +1 @@",
        "+new test",
        "",
      ].join("\n"),
      "utf-8",
    )

    const artifact = capturePatchArtifact({
      projectRoot: project,
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
    })
    const workspacePatch = readFileSync(join(loop.loopDir, "round-01-workspace.patch"), "utf-8")
    const evalPatch = readFileSync(join(loop.loopDir, "round-01-eval.patch"), "utf-8")

    expect(artifact.workspace_patch.changed_files).toEqual(["Lib/test/test_tomllib.py", "src.txt"])
    expect(artifact.eval_patch.changed_files).toEqual(["src.txt"])
    expect(workspacePatch).toContain("Lib/test/test_tomllib.py")
    expect(evalPatch).not.toContain("Lib/test/test_tomllib.py")
    expect(artifact.excluded_test_patch_files).toEqual([
      {
        path: "Lib/test/test_tomllib.py",
        sha256: sha256Text("new test\n"),
        bytes: 9,
        lines: 1,
      },
    ])
  })

  test("splits conventional project test files into test patch even without root test.patch", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    mkdirSync(join(project, "Lib", "test"), { recursive: true })
    writeFileSync(join(project, "Lib", "test", "test_unparse.py"), "public test edit\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")

    const artifact = capturePatchArtifact({
      projectRoot: project,
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
    })
    const evalPatch = readFileSync(join(loop.loopDir, "round-01-eval.patch"), "utf-8")
    const testPatch = readFileSync(join(loop.loopDir, "round-01-test.patch"), "utf-8")

    expect(artifact.workspace_patch.changed_files).toEqual(["Lib/test/test_unparse.py", "src.txt"])
    expect(artifact.eval_patch.changed_files).toEqual(["src.txt"])
    expect(artifact.test_patch.changed_files).toEqual(["Lib/test/test_unparse.py"])
    expect(evalPatch).not.toContain("Lib/test/test_unparse.py")
    expect(testPatch).toContain("Lib/test/test_unparse.py")
    expect(artifact.excluded_test_patch_files).toEqual([
      {
        path: "Lib/test/test_unparse.py",
        sha256: sha256Text("public test edit\n"),
        bytes: 17,
        lines: 1,
      },
    ])
  })
})

describe("parseReviewDecision", () => {
  test("accepts PACT_COMPLETE only as the final non-empty line", () => {
    expect(parseReviewDecision("Looks good.\n\nPACT_COMPLETE\n")).toMatchObject({
      marker: "complete",
      parseStatus: "complete_signal",
    })
    expect(parseReviewDecision("PACT_COMPLETE would be wrong here.\nPlease repair.")).toMatchObject({
      marker: "continue",
      parseStatus: "implicit_continue",
    })
  })

  test("treats deprecated PACT_STOP as continuation feedback", () => {
    expect(parseReviewDecision("Blocked.\nPACT_STOP\n")).toMatchObject({
      marker: "continue",
      parseStatus: "deprecated_stop_signal",
    })
  })

  test("treats missing and deprecated continue markers as continue", () => {
    expect(parseReviewDecision("Please repair the failing case.")).toMatchObject({
      marker: "continue",
      parseStatus: "implicit_continue",
    })
    expect(parseReviewDecision("Please repair the failing case.\nPACT_CONTINUE\n")).toMatchObject({
      marker: "continue",
      parseStatus: "deprecated_continue_signal",
    })
  })
})

describe("recordReviewDecision", () => {
  test("continues and writes feedback when no terminal signal is present", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md", maxRounds: 2 })

    const decision = recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Please repair the failing case.",
    })
    const state = readState(loop.loopDir)

    expect(decision.marker).toBe("continue")
    expect(state.status).toBe("running")
    expect(state.current_round).toBe(2)
  })

  test("deprecated continue marker does not leak into feedback", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md", maxRounds: 2 })

    recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Please repair the failing case.\nPACT_CONTINUE\n",
    })

    expect(readFileSync(join(loop.loopDir, "round-01-feedback.md"), "utf-8")).toBe("Please repair the failing case.\n")
  })

  test("stops at max round when feedback continues", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md", maxRounds: 1 })

    recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Still failing.",
    })

    expect(readState(loop.loopDir).status).toBe("stopped")
  })

  test("writes a structured review decision artifact", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Looks good.\nPACT_COMPLETE\n",
    })

    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      schema: "pact-review-decision/v1",
      artifact_version: 1,
      loop_id: loop.loopID,
      round: 1,
      marker: "complete",
      parse_status: "complete_signal",
      review_path: join(loop.loopDir, "round-01-review.md"),
      feedback_path: join(loop.loopDir, "round-01-feedback.md"),
      resulting_status: "running",
      resulting_phase: "review",
    })
    expect(readFileSync(join(loop.loopDir, "round-01-feedback.md"), "utf-8")).toContain("Enter review phase")
  })

  test("forces reviewer complete to continue when patch apply check fails", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md", maxRounds: 3 })

    const decision = recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Looks acceptable.\nPACT_COMPLETE\n",
      forceContinue: {
        parseStatus: "patch_apply_failed",
        reason: "patch_apply_check_failed",
        feedback: "PACT patch apply check failed. Fix the patch before completion can be accepted.",
      },
    })

    expect(decision).toMatchObject({
      marker: "continue",
      parseStatus: "patch_apply_failed",
      terminalLine: "PACT_COMPLETE",
    })
    expect(readState(loop.loopDir)).toMatchObject({
      status: "running",
      phase: "implementation",
      current_round: 2,
    })
    const feedback = readFileSync(join(loop.loopDir, "round-01-feedback.md"), "utf-8")
    expect(feedback).toContain("PACT patch apply check failed")
    expect(feedback).not.toContain("PACT_COMPLETE")
  })

  test("forces reviewer complete to continue when build gate fails", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md", maxRounds: 3 })
    const verification = writeVerificationArtifact({
      loopDir: loop.loopDir,
      round: 1,
      command: "lolbench gate",
      status: "failed",
      buildStatus: "failed",
      logText: "TestRecord.java:152: error cannot infer type arguments\n",
      source: "lightweight",
    })

    const decision = recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Looks complete.\nPACT_COMPLETE\n",
      forceContinue: {
        parseStatus: "build_gate_failed",
        reason: "build_gate_failed",
        feedback: "Build gate failed; repair the compile error.",
        verification,
      },
    })

    expect(decision).toMatchObject({
      marker: "continue",
      parseStatus: "build_gate_failed",
      terminalLine: "PACT_COMPLETE",
    })
    expect(readState(loop.loopDir)).toMatchObject({
      status: "running",
      phase: "implementation",
      current_round: 2,
      worker_round_count: 1,
    })
    expect(readFileSync(join(loop.loopDir, "round-01-feedback.md"), "utf-8")).toContain("Build gate failed")
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      marker: "continue",
      raw_marker: "complete",
      accepted: false,
      blocked_by: "build_gate",
      parse_status: "build_gate_failed",
      verification_ref: artifactPaths(loop.loopDir, 1).verification,
    })
  })
})

describe("failure classification and round results", () => {
  test("classifies common round failures with stable categories", () => {
    expect(classifyRoundFailure({ missing_summary: true })).toBe("missing_summary")
    expect(classifyRoundFailure({ worker_failed: true })).toBe("worker_failed")
    expect(classifyRoundFailure({ reviewer_failed: true })).toBe("reviewer_failed")
    expect(classifyRoundFailure({ malformed_patch: true })).toBe("malformed_patch")
    expect(classifyRoundFailure({ patch_apply_status: "failed" })).toBe("patch_apply_failed")
    expect(classifyRoundFailure({ empty_patch: true })).toBe("empty_patch")
    expect(classifyRoundFailure({ tests_failed: true })).toBe("build_test_failed")
    expect(classifyRoundFailure({ build_gate_failed: true })).toBe("build_gate_failed")
    expect(classifyRoundFailure({ max_rounds_without_build_success: true })).toBe("max_rounds_without_build_success")
    expect(classifyRoundFailure({ verification_timeout: true })).toBe("verification_timeout")
    expect(classifyRoundFailure({ timed_out: true })).toBe("agent_timeout")
    expect(classifyRoundFailure({ max_rounds_reached: true })).toBe("max_rounds")
    expect(classifyRoundFailure({ status: "cancelled" })).toBe("cancelled")
    expect(classifyRoundFailure({})).toBe("unknown")
  })

  test("writes round result with derived failure category", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    const result = writeRoundResult({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      status: "stopped",
      failure: { max_rounds_reached: true },
      metrics: { review_ms: 12 },
      artifacts: { review_decision: join(loop.loopDir, "round-01-review-decision.json") },
      time: "2026-06-22T01:02:03.000Z",
    })

    expect(result.failure_category).toBe("max_rounds")
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-result.json"), "utf-8"))).toMatchObject({
      schema: "pact-round-result/v1",
      loop_id: loop.loopID,
      round: 1,
      status: "stopped",
      failure_category: "max_rounds",
      metrics: { review_ms: 12 },
    })
  })
})

describe("replay export", () => {
  test("fails clearly when required round artifacts are missing", () => {
    const project = tempProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })

    expect(() => exportReplayCase({ loopDir: loop.loopDir, round: 1 })).toThrow("Required PACT artifact missing")
  })

  test("exports a replay case from round artifacts", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    writeFileSync(join(loop.loopDir, "round-01-prompt.md"), "prompt\n", "utf-8")
    writeRoundSnapshot({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 1, stage: "pre" })
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      workerAgent: "pact-worker",
      reviewerBackend: "opencode-agent",
      promptPath: join(loop.loopDir, "round-01-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    capturePatchArtifact({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 1 })
    recordReviewDecision({
      loopDir: loop.loopDir,
      round: 1,
      reviewText: "Looks good.\nPACT_COMPLETE\n",
    })
    writeRoundResult({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      status: "complete",
      failure: null,
      time: "2026-06-22T01:02:03.000Z",
    })
    writeRoundSnapshot({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 1, stage: "post" })
    writeRoundTrajectory({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      entries: [
        {
          type: "driver",
          stream: "stdout",
          text: "token=secret-value\nworker output\n",
        },
      ],
      mode: "full-redact",
    })
    writeRoundEvidence({ loopDir: loop.loopDir, round: 1 })

    const replay = exportReplayCase({ loopDir: loop.loopDir, round: 1 })

    expect(replay).toMatchObject({
      schema: "pact-replay-case/v2",
      artifact_version: 2,
      loop_id: loop.loopID,
      round: 1,
      source_loop_id: loop.loopID,
      source_round: 1,
      project_root: project,
      plan: {
        sha256: sha256Text("# Plan\nFix the bug.\n"),
      },
      worker_prompt: {
        sha256: sha256Text("prompt\n"),
      },
      inputs: {
        plan_sha256: sha256Text("# Plan\nFix the bug.\n"),
        prompt_sha256: sha256Text("prompt\n"),
      },
      review: {
        marker: "complete",
      },
      review_decision: {
        marker: "complete",
      },
      expected_result: {
        status: "complete",
      },
      baseline_result: {
        status: "complete",
      },
    })
    expect(existsSync(join(loop.loopDir, "replay-case.json"))).toBe(true)
    expect(existsSync(join(loop.loopDir, "round-01-replay-case.json"))).toBe(true)
    expect(replay.artifacts).toMatchObject({
      pre_snapshot: join(loop.loopDir, "round-01-pre-snapshot.json"),
      post_snapshot: join(loop.loopDir, "round-01-post-snapshot.json"),
      trajectory: join(loop.loopDir, "round-01-trajectory.json"),
      evidence_json: join(loop.loopDir, "round-01-evidence.json"),
      evidence_markdown: join(loop.loopDir, "round-01-evidence.md"),
    })
    expect(readFileSync(join(loop.loopDir, "round-01-trajectory.json"), "utf-8")).not.toContain("secret-value")
    expect(readFileSync(join(loop.loopDir, "round-01-evidence.md"), "utf-8")).toContain("Round 01 Evidence")
  })

  test("exports replay feedback from the round context input", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    const previousFeedbackPath = join(loop.loopDir, "round-01-feedback.md")
    writeFileSync(previousFeedbackPath, "Previous round instructions.\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-02-prompt.md"), "round 2 prompt\n", "utf-8")
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 2,
      sessionID: "ses_round2",
      workerAgent: "pact-worker",
      reviewerBackend: "codex-cli",
      promptPath: join(loop.loopDir, "round-02-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
      feedbackPath: previousFeedbackPath,
    })
    capturePatchArtifact({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 2 })
    recordReviewDecision({ loopDir: loop.loopDir, round: 2, reviewText: "Looks good.\nPACT_COMPLETE\n" })
    writeRoundResult({ loopDir: loop.loopDir, loopID: loop.loopID, round: 2, status: "complete", failure: null })

    const replay = exportReplayCase({ loopDir: loop.loopDir, round: 2 })

    expect(replay.feedback).toMatchObject({
      path: previousFeedbackPath,
      sha256: sha256Text("Previous round instructions.\n"),
      text: "Previous round instructions.\n",
    })
    expect(replay.inputs.feedback_path).toBe(previousFeedbackPath)
  })

  test("round trajectory appends new entries and redacts persisted events", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    appendRoundEvent({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      type: "review_finished",
      data: { error: "api_key=event-secret" },
    })

    writeRoundTrajectory({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      entries: [{ type: "reviewer_failure", text: "token=entry-secret ZAI_API_KEY=prefixed-entry-secret" }],
      mode: "full-redact",
      time: "2026-06-22T01:02:03.000Z",
    })
    writeRoundTrajectory({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      entries: [{ type: "driver_invocation", stdout: "worker output\n" }],
      mode: "full-redact",
      time: "2026-06-22T01:02:04.000Z",
    })

    const trajectoryText = readFileSync(join(loop.loopDir, "round-01-trajectory.json"), "utf-8")
    const trajectory = JSON.parse(trajectoryText)
    expect(trajectory.entries).toHaveLength(2)
    expect(trajectory.entries[0]).toMatchObject({ type: "reviewer_failure" })
    expect(trajectory.entries[1]).toMatchObject({ type: "driver_invocation" })
    expect(trajectoryText).not.toContain("entry-secret")
    expect(trajectoryText).not.toContain("prefixed-entry-secret")
    expect(trajectoryText).not.toContain("event-secret")
    expect(trajectoryText).toContain("[REDACTED]")
  })
})

describe("artifact chain integration", () => {
  test("a fake round creates the required artifact chain", () => {
    const project = tempGitProject()
    const loop = createLoop({ projectRoot: project, planFile: "plan.md" })
    writeFileSync(join(loop.loopDir, "round-01-prompt.md"), "prompt\n", "utf-8")
    writeRoundState({ loopDir: loop.loopDir, loopID: loop.loopID, round: 1, phase: "round_started" })
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      workerAgent: "pact-worker",
      reviewerBackend: "opencode-agent",
      promptPath: join(loop.loopDir, "round-01-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    appendRoundEvent({ loopDir: loop.loopDir, loopID: loop.loopID, round: 1, type: "round_started" })
    writeRoundSnapshot({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 1, stage: "pre" })
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    capturePatchArtifact({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 1 })
    recordReviewDecision({ loopDir: loop.loopDir, round: 1, reviewText: "Looks good.\nPACT_COMPLETE\n" })
    writeRoundResult({ loopDir: loop.loopDir, loopID: loop.loopID, round: 1, status: "complete", failure: null })
    writeRoundSnapshot({ projectRoot: project, loopDir: loop.loopDir, loopID: loop.loopID, round: 1, stage: "post" })
    writeRoundTrajectory({ loopDir: loop.loopDir, loopID: loop.loopID, round: 1, entries: [], mode: "full-redact" })
    writeRoundEvidence({ loopDir: loop.loopDir, round: 1 })
    exportReplayCase({ loopDir: loop.loopDir, round: 1 })

    for (const filePath of [
      "loop-manifest.json",
      "source-plan.md",
      "round-00-state.json",
      "round-00-git-snapshot.json",
      "round-00-result.json",
      "round-01-state.json",
      "round-01-context.json",
      "round-01-events.jsonl",
      "round-01-pre-snapshot.json",
      "round-01-post-snapshot.json",
      "round-01-trajectory.json",
      "round-01-evidence.json",
      "round-01-evidence.md",
      "round-01-workspace.patch",
      "round-01-eval.patch",
      "round-01-patch-artifact.json",
      "round-01-review-decision.json",
      "round-01-result.json",
      "round-01-replay-case.json",
      "replay-case.json",
    ]) {
      expect(existsSync(join(loop.loopDir, filePath))).toBe(true)
    }
    expect(existsSync(join(loop.loopDir, ".round-history", ".git"))).toBe(true)
  })
})
