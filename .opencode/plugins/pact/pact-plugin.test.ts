import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import PactPluginModule, { PactPlugin, PACT_PLUGIN_DEFAULTS, invokeCodexPlanner, invokeCodexReviewer } from "../pact"
import { artifactPaths, createLoop, readState, sha256Text, writeRoundContext, writeState } from "./pact-core"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pact-plugin-test-"))
  tempDirs.push(dir)
  writeFileSync(join(dir, "plan.md"), "# Plan\nFix the bug.\n", "utf-8")
  writeFileSync(join(dir, "src.txt"), "before\n", "utf-8")
  return dir
}

function tempGitProject(): string {
  const dir = tempProject()
  execFileSync("git", ["init"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir })
  execFileSync("git", ["add", "plan.md", "src.txt"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir })
  return dir
}

function fakeCodex(project: string, output: string, status = 0): string {
  const scriptPath = join(project, `fake-codex-${Math.random().toString(16).slice(2)}.sh`)
  const capture = fakeCodexCapturePaths(project)
  const successBody = `cat <<'PACT_FAKE_CODEX_OUTPUT'\n${output}PACT_FAKE_CODEX_OUTPUT\n`
  const failureBody = `printf 'fake codex failed\\n' >&2\nexit ${status}\n`
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$PWD" > ${shellQuote(capture.cwd)}
: > ${shellQuote(capture.args)}
for arg in "$@"; do
  printf '%s\\n' "$arg" >> ${shellQuote(capture.args)}
done
cat > ${shellQuote(capture.stdin)}
${status === 0 ? successBody : failureBody}`,
    "utf-8",
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function fakeSlowCodex(project: string): string {
  const scriptPath = join(project, `fake-codex-slow-${Math.random().toString(16).slice(2)}.sh`)
  const capture = fakeCodexCapturePaths(project)
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$PWD" > ${shellQuote(capture.cwd)}
: > ${shellQuote(capture.args)}
for arg in "$@"; do
  printf '%s\\n' "$arg" >> ${shellQuote(capture.args)}
done
cat > ${shellQuote(capture.stdin)}
sleep 1
printf 'late review\\nPACT_COMPLETE\\n'
`,
    "utf-8",
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function fakeFailingCodex(project: string, stderr: string, status = 7): string {
  const scriptPath = join(project, `fake-codex-fail-${Math.random().toString(16).slice(2)}.sh`)
  const capture = fakeCodexCapturePaths(project)
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$PWD" > ${shellQuote(capture.cwd)}
: > ${shellQuote(capture.args)}
for arg in "$@"; do
  printf '%s\\n' "$arg" >> ${shellQuote(capture.args)}
done
cat > ${shellQuote(capture.stdin)}
cat <<'PACT_FAKE_CODEX_ERROR' >&2
${stderr}
PACT_FAKE_CODEX_ERROR
exit ${status}
`,
    "utf-8",
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function fakeVerificationCommand(project: string): string {
  const scriptPath = join(project, `fake-verify-${Math.random().toString(16).slice(2)}.sh`)
  writeFileSync(
    scriptPath,
    `#!/bin/sh
cat <<'PACT_FAKE_VERIFY_JSON'
{"status":"failed","applied":true,"resolved":false,"build_status":"failed","f2p":{"passed":0,"total":3},"p2p":{"passed":0,"total":3},"error_categories":["build_failure"]}
PACT_FAKE_VERIFY_JSON
cat <<'PACT_FAKE_VERIFY_LOG' >&2
TestRecord.java:152: error cannot infer type arguments for ConsumerRecord<>
PACT_FAKE_VERIFY_LOG
exit 1
`,
    "utf-8",
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function fakeCodexCapturePaths(project: string): { cwd: string; args: string; stdin: string } {
  return {
    cwd: join(project, "fake-codex-cwd.txt"),
    args: join(project, "fake-codex-args.txt"),
    stdin: join(project, "fake-codex-stdin.txt"),
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function validPlannerOutput(): string {
  return `<<<PACT_PLAN>>>
# Goal Description
Canonicalize the LoLBench task before implementation.

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | Worker has a canonical plan ledger | plan.md contains this canonical goal | source-plan.md alone is not treated as canonical |

## Path Boundaries
- Modify only files needed for the task.

## Dependencies
- None.

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Implement the task from the canonical ledger | AC-1 | coding | - |

## Pending Decisions
- None.
<<<END_PACT_PLAN>>>
<<<PACT_TODO>>>
# Todo
| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
| task-1 | Implement the task from the canonical ledger | AC-1 | coding | - | pending |
<<<END_PACT_TODO>>>
<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE SECTION
### Ultimate Goal
Canonicalize the LoLBench task before implementation.
### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
| AC-1 | Worker has a canonical plan ledger | plan.md contains this canonical goal | source-plan.md alone is not treated as canonical | pending |
## MUTABLE SECTION
#### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
| --- | --- | --- | --- |
#### Active Tasks
| Task | Target AC | Status | Tag | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| task-1 | AC-1 | pending | coding | worker | Implement the task from the canonical ledger |
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
`
}

function fakeClient(output = ""): {
  client: any
  creates: Array<Record<string, any>>
  prompts: Array<Record<string, any>>
} {
  const creates: Array<Record<string, any>> = []
  const prompts: Array<Record<string, any>> = []
  return {
    creates,
    prompts,
    client: {
      session: {
        async create(input: Record<string, any>) {
          creates.push(input)
          return { data: { id: `ses_created_${creates.length}` } }
        },
        async prompt(input: Record<string, any>) {
          prompts.push(input)
          return { data: { parts: [{ type: "text", text: output }] } }
        },
      },
    },
  }
}

describe("PACT Codex planner and reviewer", () => {
  test("exports a v1 server plugin module for OpenCode plugin loading", () => {
    expect(PactPluginModule).toMatchObject({ id: "pact", server: PactPlugin })
  })

  test("defaults to codex-cli planner with gpt-5.5 in the project root", () => {
    const project = tempGitProject()
    const command = fakeCodex(
      project,
      "<<<PACT_TODO>>>\n# Todo\n- [ ] First task\n<<<END_PACT_TODO>>>\n<<<PACT_GOAL_TRACKER>>>\n# Goal Tracker\n## IMMUTABLE\n### Ultimate Goal\nDo it.\n### Acceptance Criteria\n- Done.\n## MUTABLE\n### Active Tasks\n- [ ] First task\n### Completed Items\n(none)\n### Deferred Items\n(none)\n### Plan Evolution Log\n(none)\n<<<END_PACT_GOAL_TRACKER>>>\n",
    )
    const capture = fakeCodexCapturePaths(project)

    const output = invokeCodexPlanner("planner prompt", { codexCommand: command }, project)

    expect(PACT_PLUGIN_DEFAULTS.plannerBackend).toBe("codex-cli")
    expect(PACT_PLUGIN_DEFAULTS.plannerModel).toBe("gpt-5.5")
    expect(output).toContain("<<<PACT_TODO>>>")
    expect(realpathSync(readFileSync(capture.cwd, "utf-8").trim())).toBe(realpathSync(project))
    expect(readFileSync(capture.args, "utf-8").trimEnd().split("\n")).toEqual([
      "exec",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="medium"',
      "-C",
      project,
      "-",
    ])
    expect(readFileSync(capture.stdin, "utf-8")).toBe("planner prompt")
  })

  test("defaults to codex-cli reviewer with gpt-5.4-mini in the project root", () => {
    const project = tempGitProject()
    const command = fakeCodex(project, "Review ok.\nPACT_COMPLETE\n")
    const capture = fakeCodexCapturePaths(project)

    const output = invokeCodexReviewer("review prompt", { codexCommand: command }, project)

    expect(PACT_PLUGIN_DEFAULTS.reviewerBackend).toBe("codex-cli")
    expect(PACT_PLUGIN_DEFAULTS.reviewerModel).toBe("gpt-5.4-mini")
    expect(output).toBe("Review ok.\nPACT_COMPLETE\n")
    expect(realpathSync(readFileSync(capture.cwd, "utf-8").trim())).toBe(realpathSync(project))
    expect(readFileSync(capture.args, "utf-8").trimEnd().split("\n")).toEqual([
      "exec",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.4-mini",
      "-c",
      'model_reasoning_effort="medium"',
      "-C",
      project,
      "-",
    ])
    expect(readFileSync(capture.stdin, "utf-8")).toBe("review prompt")
  })

  test("keeps codexArgs override while still running in the project root", () => {
    const project = tempGitProject()
    const command = fakeCodex(project, "PACT_STOP\n")
    const capture = fakeCodexCapturePaths(project)

    invokeCodexReviewer("review prompt", { codexCommand: command, codexArgs: ["exec", "--custom", "-"] }, project)

    expect(realpathSync(readFileSync(capture.cwd, "utf-8").trim())).toBe(realpathSync(project))
    expect(readFileSync(capture.args, "utf-8").trimEnd().split("\n")).toEqual(["exec", "--custom", "-"])
  })

  test("pact-start-loop refreshes manifest hashes and round history after planner canonicalization", async () => {
    const project = tempGitProject()
    const command = fakeCodex(project, validPlannerOutput())
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      plannerBackend: "codex-cli",
    })

    const result = (await hooks.tool?.["pact-start-loop"].execute(
      { plan_file: "plan.md", max_rounds: 2, verification_command: "python3 gate.py pact-gate" },
      {
        sessionID: "ses_worker",
        messageID: "msg_1",
        abort: new AbortController().signal,
        metadata: async () => {},
        directory: project,
        worktree: project,
      } as any,
    )) as { metadata: { loopDir: string } }
    const loopDir = result.metadata.loopDir
    const canonicalPlan = readFileSync(join(loopDir, "plan.md"), "utf-8")
    const manifest = JSON.parse(readFileSync(join(loopDir, "loop-manifest.json"), "utf-8"))

    expect(canonicalPlan).toContain("Canonicalize the LoLBench task before implementation.")
    expect(manifest.plan_sha256).toBe(sha256Text(canonicalPlan))
    expect(manifest.goal_tracker_immutable_sha256).toBe(readState(loopDir).goal_tracker_immutable_sha256)
    expect(manifest.verification_enabled).toBe(true)
    expect(manifest.verification_command).toBe("python3 gate.py pact-gate")
    expect(existsSync(join(loopDir, ".round-history", "artifacts", "round-00-plan-output.md"))).toBe(true)
    expect(readFileSync(join(loopDir, ".round-history", "artifacts", "plan.md"), "utf-8")).toBe(canonicalPlan)
  })

  test("opencode-agent planner records and passes explicit OpenCode model refs", async () => {
    const project = tempGitProject()
    const { client, creates, prompts } = fakeClient(validPlannerOutput())
    const hooks = await PactPlugin({ client, directory: project, worktree: project } as any, {
      plannerBackend: "opencode-agent",
      plannerModel: "openrouter/z-ai/glm-5.2",
      reviewerBackend: "opencode-agent",
      reviewerModel: "openrouter/z-ai/glm-5.2",
    })

    const result = (await hooks.tool?.["pact-start-loop"].execute(
      { plan_file: "plan.md", max_rounds: 2 },
      {
        sessionID: "ses_worker",
        messageID: "msg_1",
        abort: new AbortController().signal,
        metadata: async () => {},
        directory: project,
        worktree: project,
      } as any,
    )) as { metadata: { loopDir: string; plannerModel: string | null; reviewerModel: string | null } }
    const loopDir = result.metadata.loopDir

    expect(result.metadata.plannerModel).toBe("openrouter/z-ai/glm-5.2")
    expect(result.metadata.reviewerModel).toBe("openrouter/z-ai/glm-5.2")
    expect(readState(loopDir)).toMatchObject({
      planner_backend: "opencode-agent",
      planner_model: "openrouter/z-ai/glm-5.2",
      reviewer_backend: "opencode-agent",
      reviewer_model: "openrouter/z-ai/glm-5.2",
    })
    expect(JSON.parse(readFileSync(join(loopDir, "loop-manifest.json"), "utf-8"))).toMatchObject({
      planner_backend: "opencode-agent",
      planner_model: "openrouter/z-ai/glm-5.2",
      reviewer_backend: "opencode-agent",
      reviewer_model: "openrouter/z-ai/glm-5.2",
    })
    expect(creates[0]?.body).toMatchObject({
      model: { providerID: "openrouter", id: "z-ai/glm-5.2" },
    })
    expect(prompts[0]?.body).toMatchObject({
      agent: "pact-planner",
      model: { providerID: "openrouter", id: "z-ai/glm-5.2" },
    })
  })

  test("planner failure artifacts redact secret-like errors", async () => {
    const project = tempGitProject()
    const command = fakeFailingCodex(project, "api_key=secret-value token=another-secret ZAI_API_KEY=prefixed-secret", 7)
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      plannerBackend: "codex-cli",
    })

    const result = (await hooks.tool?.["pact-start-loop"].execute(
      { plan_file: "plan.md", max_rounds: 2 },
      {
        sessionID: "ses_worker",
        messageID: "msg_1",
        abort: new AbortController().signal,
        metadata: async () => {},
        directory: project,
        worktree: project,
      } as any,
    )) as { metadata: { loopDir: string } }

    const plannerError = readFileSync(join(result.metadata.loopDir, "planner-error.md"), "utf-8")
    expect(plannerError).toContain("api_key=[REDACTED]")
    expect(plannerError).toContain("token=[REDACTED]")
    expect(plannerError).not.toContain("secret-value")
    expect(plannerError).not.toContain("another-secret")
  })

  test("planner validation failure redacts raw planner output", async () => {
    const project = tempGitProject()
    const command = fakeCodex(project, "invalid planner output api_key=secret-value token=another-secret ZAI_API_KEY=prefixed-secret\n")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      plannerBackend: "codex-cli",
    })

    const result = (await hooks.tool?.["pact-start-loop"].execute(
      { plan_file: "plan.md", max_rounds: 2 },
      {
        sessionID: "ses_worker",
        messageID: "msg_1",
        abort: new AbortController().signal,
        metadata: async () => {},
        directory: project,
        worktree: project,
      } as any,
    )) as { metadata: { loopDir: string } }

    for (const fileName of ["planner-error.md", "round-00-plan-output.md", "round-00-plan-repair-output.md"]) {
      const text = readFileSync(join(result.metadata.loopDir, fileName), "utf-8")
      expect(text).toContain("api_key=[REDACTED]")
      expect(text).toContain("token=[REDACTED]")
      expect(text).toContain("ZAI_API_KEY=[REDACTED]")
      expect(text).not.toContain("secret-value")
      expect(text).not.toContain("another-secret")
      expect(text).not.toContain("prefixed-secret")
    }
  })

  test("codex-cli implementation complete enters review phase with a review worker round", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-prompt.md"), "worker prompt\n", "utf-8")
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      workerAgent: "pact-worker",
      reviewerBackend: "codex-cli",
      promptPath: join(loop.loopDir, "round-01-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeCodex(project, "Review ok.\nPACT_COMPLETE\n")
    const { client, prompts } = fakeClient()
    const hooks = await PactPlugin({ client, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    for (const filePath of [
      "round-01-review.md",
      "round-01-review-decision.json",
      "round-01-result.json",
      "replay-case.json",
    ]) {
      expect(existsSync(join(loop.loopDir, filePath))).toBe(true)
    }
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-result.json"), "utf-8"))).toMatchObject({
      status: "running",
      failure_category: null,
      review_marker: "complete",
      loop_phase: "review",
      planner_backend: "codex-cli",
      planner_model: "gpt-5.5",
      reviewer_backend: "codex-cli",
      reviewer_model: "gpt-5.4-mini",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      reviewer_backend: "codex-cli",
      reviewer_model: "gpt-5.4-mini",
      resulting_phase: "review",
    })
    expect(readFileSync(join(loop.loopDir, "round-02-prompt.md"), "utf-8")).toContain("PACT Review Phase")
    expect(readFileSync(join(loop.loopDir, "round-02-prompt.md"), "utf-8")).not.toContain("PACT Finalize Phase")
    expect(prompts).toEqual([])
    expect(readState(loop.loopDir)).toMatchObject({
      previous_round_session_id: "ses_worker",
      active_round_session_id: undefined,
      phase: "review",
      current_round: 2,
    })
  })

  test("failing verification gate blocks reviewer complete and feeds next round", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
      maxRounds: 3,
    })
    writeFileSync(join(loop.loopDir, "round-01-prompt.md"), "worker prompt\n", "utf-8")
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 1,
      sessionID: "ses_worker",
      workerAgent: "pact-worker",
      reviewerBackend: "codex-cli",
      promptPath: join(loop.loopDir, "round-01-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeCodex(project, "Review ok.\nPACT_COMPLETE\n")
    const verifyCommand = fakeVerificationCommand(project)
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
      verificationCommand: verifyCommand,
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(readState(loop.loopDir)).toMatchObject({
      status: "running",
      phase: "implementation",
      current_round: 2,
      worker_round_count: 1,
    })
    expect(JSON.parse(readFileSync(artifactPaths(loop.loopDir, 1).verification, "utf-8"))).toMatchObject({
      status: "failed",
      build_status: "failed",
      error_categories: ["build_failure"],
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      marker: "continue",
      raw_marker: "complete",
      accepted: false,
      blocked_by: "build_gate",
      parse_status: "build_gate_failed",
    })
    const packageText = readFileSync(join(loop.loopDir, "round-01-continuation-package.md"), "utf-8")
    const nextPrompt = readFileSync(join(loop.loopDir, "round-02-prompt.md"), "utf-8")
    expect(packageText).not.toContain("TestRecord.java:152")
    expect(packageText).not.toContain("F2P")
    expect(packageText).not.toContain("P2P")
    expect(packageText).not.toContain("eval_tests.patch")
    expect(packageText).not.toContain("Latest Verification Log Tail")
    expect(packageText).toContain("Reviewer guidance is evidence, not assignment")
    expect(packageText).toContain("Do not modify PACT artifacts or run gates")
    expect(packageText).toContain("Changed workspace files to inspect for current behavior")
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-continuation-package.json"), "utf-8"))).not.toHaveProperty(
      "next_worker_instruction",
    )
    expect(nextPrompt).toContain("# PACT Round 02 Worker Prompt")
    expect(nextPrompt).toContain("## Current State Snapshot")
    expect(nextPrompt).not.toContain("TestRecord.java:152")
    expect(nextPrompt).not.toContain("F2P")
    expect(nextPrompt).not.toContain("P2P")
    expect(nextPrompt).not.toContain("eval_tests.patch")
  })

  test("deprecated PACT_STOP still continues the implementation loop", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeCodex(project, "Blocked but actionable.\nPACT_STOP\n")
    const { client, prompts } = fakeClient()
    const hooks = await PactPlugin({ client, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      marker: "continue",
      parse_status: "deprecated_stop_signal",
      resulting_phase: "implementation",
    })
    expect(readFileSync(join(loop.loopDir, "round-01-feedback.md"), "utf-8")).toBe("Blocked but actionable.\n")
    expect(readState(loop.loopDir)).toMatchObject({ status: "running", phase: "implementation", current_round: 2 })
    expect(readFileSync(join(loop.loopDir, "round-02-prompt.md"), "utf-8")).toContain("# PACT Round 02 Worker Prompt")
    expect(prompts).toEqual([])

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_unrelated" } } as any })
    expect(readState(loop.loopDir).active_round_session_id).toBeUndefined()
    expect(readState(loop.loopDir).active_session_id).toBeUndefined()
  })

  test("full alignment interval is based on worker round count instead of raw round number", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
      fullAlignmentInterval: 5,
      maxRounds: 10,
    })
    const state = readState(loop.loopDir)
    state.current_round = 6
    state.worker_round_count = 4
    state.phase = "implementation"
    state.active_session_id = "ses_worker"
    state.active_round_session_id = "ses_worker"
    writeState(loop.loopDir, state)
    writeFileSync(join(loop.loopDir, "round-06-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeCodex(project, "Needs alignment follow-up.\n")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(readFileSync(join(loop.loopDir, "round-06-review-prompt.md"), "utf-8")).toContain("Full Alignment Check")
    expect(readFileSync(join(loop.loopDir, "round-06-events.jsonl"), "utf-8")).toContain(
      '"review_kind":"full_alignment"',
    )
  })

  test("review phase complete enters finalize phase", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    const state = readState(loop.loopDir)
    state.phase = "review"
    state.current_round = 2
    state.previous_round_session_id = "ses_worker"
    state.active_round_session_id = undefined
    state.active_session_id = undefined
    writeState(loop.loopDir, state)
    writeFileSync(join(loop.loopDir, "round-02-prompt.md"), "review phase prompt\n", "utf-8")
    writeRoundContext({
      loopDir: loop.loopDir,
      loopID: loop.loopID,
      round: 2,
      sessionID: "ses_review",
      workerAgent: "pact-worker",
      loopPhase: "review",
      reviewerBackend: "codex-cli",
      promptPath: join(loop.loopDir, "round-02-prompt.md"),
      todoPath: join(loop.loopDir, "todo.md"),
      goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    })
    writeFileSync(join(loop.loopDir, "round-02-summary.md"), "Code review checkpoint summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeCodex(project, "Looks good.\nPACT_COMPLETE\n")
    const { client, prompts } = fakeClient()
    const hooks = await PactPlugin({ client, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_review" } } as any })
    expect(readState(loop.loopDir)).toMatchObject({ status: "running", phase: "finalize", current_round: 3 })
    expect(readFileSync(join(loop.loopDir, "round-03-prompt.md"), "utf-8")).toContain("PACT Finalize Phase")
    expect(prompts).toEqual([])
  })

  test("new worker sessions bind the finalize round and complete without a second review", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    const state = readState(loop.loopDir)
    state.phase = "finalize"
    state.current_round = 3
    state.previous_round_session_id = "ses_review"
    state.active_round_session_id = undefined
    state.active_session_id = undefined
    writeState(loop.loopDir, state)
    writeFileSync(join(loop.loopDir, "round-03-prompt.md"), "finalize phase prompt\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      reviewerBackend: "codex-cli",
    })

    writeFileSync(join(loop.loopDir, "finalize-summary.md"), "Final verification done.\n", "utf-8")
    await hooks["tool.execute.before"]?.(
      { tool: "bash", callID: "call_round3", sessionID: "ses_round3" } as any,
      { args: { command: "true" } } as any,
    )
    expect(readState(loop.loopDir)).toMatchObject({
      active_round_session_id: "ses_round3",
      active_session_id: "ses_round3",
    })
    await hooks["tool.execute.before"]?.(
      { tool: "write", callID: "call_round3_summary", sessionID: "ses_round3" } as any,
      {
        args: {
          filePath: join(loop.loopDir, "finalize-summary.md"),
          content: "Final verification done.\n",
        },
      } as any,
    )
    expect(readState(loop.loopDir)).toMatchObject({
      active_round_session_id: "ses_round3",
      active_session_id: "ses_round3",
    })
    const events = readFileSync(join(loop.loopDir, "round-03-events.jsonl"), "utf-8")
    expect(events).toContain('"call_id":"call_round3"')
    expect(events).toContain('"call_id":"call_round3_summary"')
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_round3" } } as any })

    expect(readState(loop.loopDir)).toMatchObject({ status: "complete", phase: "complete" })
    expect(existsSync(join(loop.loopDir, "complete-state.md"))).toBe(true)
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-03-result.json"), "utf-8"))).toMatchObject({
      status: "complete",
      loop_phase: "complete",
      failure_category: null,
    })
  })

  test("finalize verification failure returns to implementation with a continuation package", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
      maxRounds: 4,
    })
    const state = readState(loop.loopDir)
    state.phase = "finalize"
    state.current_round = 3
    state.worker_round_count = 2
    state.previous_round_session_id = "ses_review"
    state.active_round_session_id = "ses_round3"
    state.active_session_id = "ses_round3"
    writeState(loop.loopDir, state)
    writeFileSync(join(loop.loopDir, "round-03-prompt.md"), "finalize phase prompt\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-03-context.json"), JSON.stringify({
      schema: "pact-round-context/v1",
      artifact_version: 1,
      loop_id: loop.loopID,
      round: 3,
      session_id: "ses_round3",
      worker_agent: "pact-worker",
      reviewer_backend: "codex-cli",
      context_hashes: {},
      created_at: new Date().toISOString(),
      prompt_path: join(loop.loopDir, "round-03-prompt.md"),
      todo_path: join(loop.loopDir, "todo.md"),
      goal_tracker_path: join(loop.loopDir, "goal-tracker.md"),
    }, null, 2), "utf-8")
    writeFileSync(join(loop.loopDir, "finalize-summary.md"), "Final verification done.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "finalize tweak\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      reviewerBackend: "codex-cli",
      verificationCommand: fakeVerificationCommand(project),
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_round3" } } as any })

    expect(readState(loop.loopDir)).toMatchObject({
      status: "running",
      phase: "implementation",
      current_round: 4,
      worker_round_count: 2,
      last_verification_status: "failed",
      last_verification_build_status: "failed",
    })
    expect(existsSync(join(loop.loopDir, "complete-state.md"))).toBe(false)
    expect(JSON.parse(readFileSync(artifactPaths(loop.loopDir, 3).verification, "utf-8"))).toMatchObject({
      status: "failed",
      applied: true,
      build_status: "failed",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-03-result.json"), "utf-8"))).toMatchObject({
      status: "running",
      loop_phase: "implementation",
      failure_category: "build_gate_failed",
    })
    const packageText = readFileSync(join(loop.loopDir, "round-03-continuation-package.md"), "utf-8")
    const nextPrompt = readFileSync(join(loop.loopDir, "round-04-prompt.md"), "utf-8")
    expect(packageText).not.toContain("TestRecord.java:152")
    expect(packageText).not.toContain("Latest Verification Log Tail")
    expect(nextPrompt).not.toContain("TestRecord.java:152")
    expect(nextPrompt).toContain("## Current State Snapshot")
  })

  test("codex-cli reviewer failure writes reviewer_failed artifacts", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeCodex(project, "", 7)
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(readState(loop.loopDir)).toMatchObject({ status: "stopped", phase: "stopped" })
    expect(readFileSync(join(loop.loopDir, "round-01-review.md"), "utf-8")).toContain("Codex reviewer failed")
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      marker: "continue",
      parse_status: "reviewer_failed",
      reviewer_backend: "codex-cli",
      reviewer_model: "gpt-5.4-mini",
      resulting_status: "stopped",
      resulting_phase: "stopped",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-result.json"), "utf-8"))).toMatchObject({
      status: "stopped",
      failure_category: "reviewer_failed",
    })
    expect(existsSync(join(loop.loopDir, "replay-case.json"))).toBe(true)
    expect(readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")).toContain('"type":"review_finished"')
    expect(readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")).toContain('"status":"failed"')
  })

  test("codex-cli reviewer failure redacts secrets from replay artifacts", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeFailingCodex(project, "api_key=secret-value token=another-secret ZAI_API_KEY=prefixed-secret", 7)
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    for (const fileName of [
      "round-01-review.md",
      "round-01-review-decision.json",
      "round-01-events.jsonl",
      "round-01-trajectory.json",
      "round-01-replay-case.json",
      "replay-case.json",
    ]) {
      const text = readFileSync(join(loop.loopDir, fileName), "utf-8")
      expect(text).not.toContain("secret-value")
      expect(text).not.toContain("another-secret")
      expect(text).not.toContain("prefixed-secret")
    }
    expect(readFileSync(join(loop.loopDir, "round-01-trajectory.json"), "utf-8")).toContain("[REDACTED]")
  })

  test("codex-cli reviewer timeout writes agent_timeout artifacts", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      reviewerBackend: "codex-cli",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    appendFileSync(join(project, "src.txt"), "after\n", "utf-8")
    const command = fakeSlowCodex(project)
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      codexCommand: command,
      codexTimeoutMs: 20,
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(readState(loop.loopDir)).toMatchObject({ status: "stopped", phase: "stopped" })
    expect(readFileSync(join(loop.loopDir, "round-01-review.md"), "utf-8")).toContain("Codex reviewer timed out")
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-review-decision.json"), "utf-8"))).toMatchObject({
      marker: "continue",
      parse_status: "reviewer_timeout",
      resulting_status: "stopped",
      resulting_phase: "stopped",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-result.json"), "utf-8"))).toMatchObject({
      status: "stopped",
      failure_category: "agent_timeout",
      reviewer_backend: "codex-cli",
      reviewer_model: "gpt-5.4-mini",
    })
    expect(existsSync(join(loop.loopDir, "replay-case.json"))).toBe(true)
    expect(readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")).toContain(
      '"failure_category":"agent_timeout"',
    )
  })

  test("patch capture failure stops the loop instead of retrying forever", async () => {
    const project = tempProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      reviewerBackend: "codex-cli",
    })

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(readState(loop.loopDir)).toMatchObject({
      status: "stopped",
      phase: "stopped",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-state.json"), "utf-8"))).toMatchObject({
      status: "stopped",
      loop_phase: "stopped",
      notes: "Patch capture failed; loop stopped to avoid retrying the same failure.",
    })
    expect(JSON.parse(readFileSync(join(loop.loopDir, "round-01-result.json"), "utf-8"))).toMatchObject({
      status: "stopped",
      loop_phase: "stopped",
      failure_category: "malformed_patch",
    })
  })

  test("new-per-round loops bind the fresh worker session on the first observed tool event", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_round1",
      sessionStrategy: "new-per-round",
    })
    const state = readState(loop.loopDir)
    state.current_round = 2
    state.worker_round_count = 1
    state.previous_round_session_id = "ses_round1"
    state.active_round_session_id = undefined
    state.active_session_id = undefined
    writeState(loop.loopDir, state)
    writeFileSync(join(loop.loopDir, "round-02-prompt.md"), "continue\n", "utf-8")

    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await hooks["tool.execute.before"]?.(
      { tool: "read", callID: "call_first_read", sessionID: "ses_round2" } as any,
      { args: { filePath: "src.txt" } } as any,
    )

    let nextState = readState(loop.loopDir)
    expect(nextState).toMatchObject({
      active_round_session_id: "ses_round2",
      active_session_id: "ses_round2",
      previous_round_session_id: "ses_round1",
    })

    await hooks["tool.execute.before"]?.(
      { tool: "write", callID: "call_write_round2_summary", sessionID: "ses_round2" } as any,
      { args: { filePath: join(loop.loopDir, "round-02-summary.md"), content: "Worker summary.\n" } } as any,
    )

    nextState = readState(loop.loopDir)
    expect(nextState).toMatchObject({
      active_round_session_id: "ses_round2",
      active_session_id: "ses_round2",
      previous_round_session_id: "ses_round1",
    })
    const events = readFileSync(join(loop.loopDir, "round-02-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"read"')
    expect(events).toContain('"call_id":"call_first_read"')
    expect(events).toContain('"tool":"write"')
    expect(events).toContain('"call_id":"call_write_round2_summary"')
    expect(events).toContain('"session_id":"ses_round2"')
  })

  test("run-exit round boundary ignores session idle review hooks", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
      roundBoundary: "run_exit",
    } as any)
    writeFileSync(join(loop.loopDir, "round-01-summary.md"), "Worker summary.\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-01-contract.md"), "Worker contract.\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_worker" } } as any })

    expect(existsSync(join(loop.loopDir, "round-01-review.md"))).toBe(false)
    expect(readState(loop.loopDir)).toMatchObject({
      status: "running",
      phase: "implementation",
      current_round: 1,
    })
  })

  test("new-per-round loops bind when the expected summary is created by apply_patch", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_round1",
      sessionStrategy: "new-per-round",
    })
    const state = readState(loop.loopDir)
    state.current_round = 2
    state.worker_round_count = 1
    state.previous_round_session_id = "ses_round1"
    state.active_round_session_id = undefined
    state.active_session_id = undefined
    writeState(loop.loopDir, state)
    writeFileSync(join(loop.loopDir, "round-02-prompt.md"), "continue\n", "utf-8")
    const summaryFile = join(loop.loopDir, "round-02-summary.md")
    const patchText = `*** Begin Patch
*** Add File: ${summaryFile}
+Worker summary.
*** End Patch
`
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await hooks["tool.execute.before"]?.(
      { tool: "apply_patch", callID: "call_patch_summary", sessionID: "ses_round2" } as any,
      { args: { patchText } } as any,
    )

    expect(readState(loop.loopDir)).toMatchObject({
      active_round_session_id: "ses_round2",
      active_session_id: "ses_round2",
      previous_round_session_id: "ses_round1",
    })
    const events = readFileSync(join(loop.loopDir, "round-02-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"apply_patch"')
    expect(events).toContain('"call_id":"call_patch_summary"')
    expect(events).toContain('"session_id":"ses_round2"')
  })

  test("benchmark strict network mode blocks forbidden webfetch domains and records the attempt", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "webfetch", callID: "call_1", sessionID: "ses_worker" } as any,
        { args: { url: "https://raw.githubusercontent.com/python/cpython/main/Lib/tomllib/_parser.py" } } as any,
      ),
    ).rejects.toThrow("blocked benchmark network access")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"webfetch"')
    expect(events).toContain('"status":"blocked"')
    expect(events).toContain('"raw.githubusercontent.com"')
  })

  test("benchmark strict network mode blocks obvious shell downloads from forbidden hosts", async () => {
    const project = tempGitProject()
    createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_2", sessionID: "ses_worker" } as any,
        { args: { command: "python -c \"import urllib.request; urllib.request.urlopen('https://github.com/python/cpython')\"" } } as any,
      ),
    ).rejects.toThrow("blocked benchmark network access")
  })

  test("benchmark strict mode blocks broad CPython test suites and records the attempt", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_broad_tests", sessionID: "ses_worker" } as any,
        {
          args: {
            command:
              "./python.exe -m test test_grammar test_ast test_compile test_peg_generator test_pep646 test_subprocess test_threading -v",
          },
        } as any,
      ),
    ).rejects.toThrow("blocked broad CPython test command")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"bash"')
    expect(events).toContain('"status":"blocked"')
    expect(events).toContain('"reason":"benchmark_strict_broad_cpython_tests"')
    expect(events).toContain("test_subprocess")
  })

  test("benchmark strict mode blocks bare CPython test runs", async () => {
    const project = tempGitProject()
    createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_bare_tests", sessionID: "ses_worker" } as any,
        { args: { command: "./python -m test" } } as any,
      ),
    ).rejects.toThrow("blocked broad CPython test command")
  })

  test("benchmark strict mode allows focused CPython test commands", async () => {
    const project = tempGitProject()
    createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_focused_tests", sessionID: "ses_worker" } as any,
        { args: { command: "./python.exe -m test test_grammar test_ast -v" } } as any,
      ),
    ).resolves.toBeUndefined()
  })

  test("benchmark strict mode blocks worker-owned patch export and gate commands", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_patch_export", sessionID: "ses_worker" } as any,
        { args: { command: "git add Lib/tomllib && git diff --cached --no-color > solution.patch" } } as any,
      ),
    ).rejects.toThrow("blocked benchmark-owned command")

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_pact_gate", sessionID: "ses_worker" } as any,
        { args: { command: "PACT_PATCH_PATH=$(pwd)/solution.patch python3 scripts/lolbench_eval.py pact-gate" } } as any,
      ),
    ).rejects.toThrow("blocked benchmark-owned command")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"reason":"benchmark_strict_git_index"')
    expect(events).toContain('"reason":"benchmark_strict_pact_gate"')
  })

  test("benchmark strict mode blocks direct writes to harness-owned patch files", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", callID: "call_solution_patch", sessionID: "ses_worker" } as any,
        { args: { filePath: "solution.patch", content: "diff --git a/x b/x\n" } } as any,
      ),
    ).rejects.toThrow("blocked benchmark-owned patch file")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"reason":"benchmark_strict_scaffolding_patch"')
    expect(events).toContain('"solution.patch"')
  })

  test("benchmark strict mode blocks file reads outside the workspace and records the attempt", async () => {
    const project = tempGitProject()
    const outside = mkdtempSync(join(tmpdir(), "pact-plugin-outside-"))
    tempDirs.push(outside)
    const outsideFile = join(outside, "_parser.py")
    writeFileSync(outsideFile, "def loads(): pass\n", "utf-8")
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", callID: "call_external_read", sessionID: "ses_worker" } as any,
        { args: { filePath: outsideFile } } as any,
      ),
    ).rejects.toThrow("blocked workspace-external file access")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"read"')
    expect(events).toContain('"status":"blocked"')
    expect(events).toContain('"reason":"benchmark_strict_external_path"')
    expect(events).toContain("_parser.py")
  })

  test("benchmark strict mode blocks bash reads of LoLBench harness files outside the workspace", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", callID: "call_external_harness_read", sessionID: "ses_worker" } as any,
        {
          args: {
            command:
              "sed -n '70,200p' /Users/gujiazhen/Documents/cc_codes/benchmark/LoLBench/scripts/lolbench_eval.py",
          },
        } as any,
      ),
    ).rejects.toThrow("blocked workspace-external file access")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"bash"')
    expect(events).toContain('"status":"blocked"')
    expect(events).toContain('"reason":"benchmark_strict_external_path"')
    expect(events).toContain("lolbench_eval.py")
  })

  test("benchmark strict mode allows file reads inside the workspace", async () => {
    const project = tempGitProject()
    createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", callID: "call_workspace_read", sessionID: "ses_worker" } as any,
        { args: { filePath: "src.txt" } } as any,
      ),
    ).resolves.toBeUndefined()
  })

  test("benchmark strict mode blocks worker reads of reviewer-only PACT artifacts", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-continuation-package.md"), "safe package\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-01-feedback.md"), "F2P: 1/3\nP2P: 3/3\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-01-verification.json"), '{"f2p":{"passed":1,"total":3}}\n', "utf-8")
    writeFileSync(join(loop.loopDir, "round-01-verification.log"), "hidden eval test detail\n", "utf-8")
    writeFileSync(join(loop.loopDir, "round-01-review.md"), "reviewer-only output\n", "utf-8")
    writeFileSync(join(loop.loopDir, "replay-case.json"), '{"verification":{"log_tail":"hidden"}}\n', "utf-8")
    writeFileSync(join(loop.loopDir, "final-hidden-gate-summary.json"), '{"f2p":{"passed":1,"total":3}}\n', "utf-8")
    writeFileSync(join(loop.loopDir, "final-hidden-gate-orig.json"), '{"p2p":{"passed":3,"total":3}}\n', "utf-8")
    writeFileSync(join(loop.loopDir, "final-hidden-gate-orig.log"), "hidden final detail\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", callID: "call_safe_package", sessionID: "ses_worker" } as any,
        { args: { filePath: join(loop.loopDir, "round-01-continuation-package.md") } } as any,
      ),
    ).resolves.toBeUndefined()

    for (const [callID, fileName] of [
      ["call_feedback", "round-01-feedback.md"],
      ["call_verification", "round-01-verification.json"],
      ["call_verification_log", "round-01-verification.log"],
      ["call_review", "round-01-review.md"],
      ["call_replay", "replay-case.json"],
      ["call_final_hidden_summary", "final-hidden-gate-summary.json"],
      ["call_final_hidden_json", "final-hidden-gate-orig.json"],
      ["call_final_hidden_log", "final-hidden-gate-orig.log"],
    ] as const) {
      await expect(
        hooks["tool.execute.before"]?.(
          { tool: "read", callID, sessionID: "ses_worker" } as any,
          { args: { filePath: join(loop.loopDir, fileName) } } as any,
        ),
      ).rejects.toThrow("worker-safe PACT artifact")
    }

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "glob", callID: "call_glob_pact", sessionID: "ses_worker" } as any,
        { args: { path: join(project, ".pact"), pattern: "**/*" } } as any,
      ),
    ).rejects.toThrow("worker-safe PACT artifact")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"reason":"benchmark_strict_pact_artifact"')
    expect(events).toContain("round-01-verification.json")
  })

  test("benchmark strict mode blocks task delegation and records the attempt", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: true,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "task", callID: "call_task", sessionID: "ses_worker" } as any,
        {
          args: {
            description: "parallel analysis",
            prompt: "Inspect the repository in a subagent.",
            subagent_type: "general",
          },
        } as any,
      ),
    ).rejects.toThrow("blocks task/subagent delegation")

    const events = readFileSync(join(loop.loopDir, "round-01-events.jsonl"), "utf-8")
    expect(events).toContain('"tool":"task"')
    expect(events).toContain('"status":"blocked"')
    expect(events).toContain('"reason":"benchmark_strict_task_delegation"')
  })

  test("task delegation remains available outside benchmark strict mode", async () => {
    const project = tempGitProject()
    createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any, {
      benchmarkStrictNetwork: false,
    })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "task", callID: "call_task", sessionID: "ses_worker" } as any,
        { args: { description: "parallel analysis", prompt: "Inspect the repository.", subagent_type: "general" } } as any,
      ),
    ).resolves.toBeUndefined()
  })

  test("ledger protection blocks writes but still allows reading reviewer feedback", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    writeFileSync(join(loop.loopDir, "round-01-feedback.md"), "review feedback\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", callID: "call_read", sessionID: "ses_worker" } as any,
        { args: { filePath: join(loop.loopDir, "round-01-feedback.md") } } as any,
      ),
    ).resolves.toBeUndefined()

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", callID: "call_write", sessionID: "ses_worker" } as any,
        { args: { filePath: join(loop.loopDir, "round-01-feedback.md"), content: "bad edit\n" } } as any,
      ),
    ).rejects.toThrow("Protected ledger file")
  })

  test("ledger protection blocks apply_patch edits to protected artifacts", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const feedbackPath = join(loop.loopDir, "round-01-feedback.md")
    writeFileSync(feedbackPath, "review feedback\n", "utf-8")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "apply_patch", callID: "call_patch", sessionID: "ses_worker" } as any,
        {
          args: {
            patchText: `*** Begin Patch
*** Update File: ${feedbackPath}
@@
-review feedback
+bad edit
*** End Patch
`,
          },
        } as any,
      ),
    ).rejects.toThrow("Protected ledger file")
  })

  test("ledger protection blocks apply_patch edits to goal tracker", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const trackerPath = join(loop.loopDir, "goal-tracker.md")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "apply_patch", callID: "call_patch_tracker", sessionID: "ses_worker" } as any,
        {
          args: {
            patchText: `*** Begin Patch
*** Update File: ${trackerPath}
@@
-## IMMUTABLE SECTION
+## CHANGED IMMUTABLE SECTION
*** End Patch
`,
          },
        } as any,
      ),
    ).rejects.toThrow("goal-tracker.md")
  })

  test("ledger protection blocks edit and write mutations to goal tracker", async () => {
    const project = tempGitProject()
    const loop = createLoop({
      projectRoot: project,
      planFile: "plan.md",
      workerSessionID: "ses_worker",
    })
    const trackerPath = join(loop.loopDir, "goal-tracker.md")
    const hooks = await PactPlugin({ client: {}, directory: project, worktree: project } as any)

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", callID: "call_edit_tracker", sessionID: "ses_worker" } as any,
        {
          args: {
            filePath: trackerPath,
            oldString: "## IMMUTABLE SECTION",
            newString: "## CHANGED IMMUTABLE SECTION",
          },
        } as any,
      ),
    ).rejects.toThrow("goal-tracker.md")

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", callID: "call_empty_write_tracker", sessionID: "ses_worker" } as any,
        { args: { filePath: trackerPath, content: "" } } as any,
      ),
    ).rejects.toThrow("goal-tracker.md")

    const mutableOnlyChange = readFileSync(trackerPath, "utf-8").replace(
      "Initial plan ledger",
      "Worker-edited mutable ledger",
    )
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", callID: "call_mutable_write_tracker", sessionID: "ses_worker" } as any,
        { args: { filePath: trackerPath, content: mutableOnlyChange } } as any,
      ),
    ).rejects.toThrow("goal-tracker.md")
  })
})
