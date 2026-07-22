import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLoop, readState, writeState } from "./pact-core"
import { buildPactStartPrompt, cliArgs, runPactDriver } from "./pact-run-driver"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pact-driver-test-"))
  tempDirs.push(dir)
  writeFileSync(join(dir, "plan.md"), "# Plan\nFix the bug.\n", "utf-8")
  writeFileSync(join(dir, "src.txt"), "before\n", "utf-8")
  execFileSync("git", ["init"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir })
  execFileSync("git", ["add", "plan.md", "src.txt"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir })
  return dir
}

function tempGitWorktreeProject(): string {
  const base = tempGitProject()
  return tempGitWorktreeFor(base)
}

function tempGitWorktreeFor(base: string): string {
  const parent = mkdtempSync(join(tmpdir(), "pact-driver-worktree-parent-"))
  tempDirs.push(parent)
  const dir = join(parent, "worktree")
  const branch = `pact-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  execFileSync("git", ["worktree", "add", "-b", branch, dir], { cwd: base })
  return dir
}

function gitInfoExcludeText(projectRoot: string): string {
  const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: projectRoot,
    encoding: "utf-8",
  }).trim()
  return readFileSync(excludePath, "utf-8")
}

function replayLoopDir(projectRoot: string): string {
  const loopsRoot = join(projectRoot, ".pact", "loops")
  const loopID = readdirSync(loopsRoot)
    .filter((item) => item.includes("-resume-r"))
    .sort()
    .at(-1)
  if (!loopID) throw new Error("replay loop was not initialized")
  return join(loopsRoot, loopID)
}

function validPlannerOutput(): string {
  return `<<<PACT_PLAN>>>
# Goal Description
Fix the requested behavior.

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | Source behavior is corrected. | Existing or focused public checks pass. | The old broken behavior is not preserved. |

## Positive Tests
- Exercise the corrected source behavior.

## Negative Tests
- Exercise the old broken behavior.

## Path Boundaries
- Edit source files only.

## Dependencies
- None.

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Fix the source behavior. | AC-1 | coding | - |

## Pending Decisions
- None.
<<<END_PACT_PLAN>>>
<<<PACT_TODO>>>
# Todo
| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
| task-1 | Fix the source behavior. | AC-1 | coding | - | pending |
<<<END_PACT_TODO>>>
<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE SECTION
### Ultimate Goal
Fix the requested behavior.
### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
| AC-1 | Source behavior is corrected. | Existing or focused public checks pass. | The old broken behavior is not preserved. | pending |
## MUTABLE SECTION
### Plan Version: 1 (Updated: Round 1)
### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
| --- | --- | --- | --- |
| 1 | Initial plan ledger | Planner initialization | - |
### Active Tasks
| Task | Target AC | Status | Tag | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| task-1 | AC-1 | pending | coding | worker | - |
### Completed and Verified
| AC | Task | Completed Round | Verified Round | Evidence |
| --- | --- | --- | --- | --- |
### Explicitly Deferred
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
| --- | --- | --- | --- | --- |
### Open Issues
| Issue | Discovered Round | Blocking AC | Resolution Path |
| --- | --- | --- | --- |
<<<END_PACT_GOAL_TRACKER>>>`
}

describe("PACT run driver", () => {
  test("defaults LoLBench worker budget to twelve rounds", () => {
    const parsed = cliArgs(["--plan-file", "/tmp/PROMPT.md"])

    expect(parsed.maxRounds).toBe(12)
    expect(parsed.model).toBe("zai-coding-plan/glm-5-turbo")
  })

  test("parses planner and reviewer models from CLI", () => {
    const parsed = cliArgs([
      "--plan-file",
      "/tmp/PROMPT.md",
      "--planner-model",
      "gpt-5.5",
      "--reviewer-model",
      "gpt-5.5",
    ])

    expect(parsed.plannerModel).toBe("gpt-5.5")
    expect(parsed.reviewerModel).toBe("gpt-5.5")
  })

  test("parses JSON worker output for observable Harbor runs", () => {
    const parsed = cliArgs([
      "--plan-file",
      "/tmp/PROMPT.md",
      "--worker-output-format",
      "json",
      "--worker-opencode-command",
      "/opt/opencode-observed",
    ])

    expect(parsed.workerOutputFormat).toBe("json")
    expect(parsed.workerOpencodeCommand).toBe("/opt/opencode-observed")
    expect(() =>
      cliArgs(["--plan-file", "/tmp/PROMPT.md", "--worker-output-format", "xml"]),
    ).toThrow("Unsupported PACT worker output format: xml")
  })

  test("rejects OpenRouter chat as a planner or reviewer backend", () => {
    expect(() =>
      cliArgs([
        "--plan-file",
        "/tmp/PROMPT.md",
        "--planner-backend",
        "openrouter-chat",
        "--planner-model",
        "openai/gpt-5.5",
      ]),
    ).toThrow("Unsupported PACT planner backend: openrouter-chat")
    expect(() =>
      cliArgs(["--plan-file", "/tmp/PROMPT.md", "--reviewer", "openrouter-chat", "--reviewer-model", "openai/gpt-5.5"]),
    ).toThrow("Unsupported PACT reviewer backend: openrouter-chat")
  })

  test("parses OpenCode planner and reviewer backends with agents from CLI aliases", () => {
    const parsed = cliArgs([
      "--plan-file",
      "/tmp/PROMPT.md",
      "--planner-backend",
      "opencode-cli",
      "--planner-agent",
      "pact-planner",
      "--planner-model",
      "openrouter/z-ai/glm-5.2",
      "--reviewer",
      "opencode-cli",
      "--reviewer-agent",
      "pact-reviewer",
      "--reviewer-model",
      "openrouter/z-ai/glm-5.2",
      "--worker-agent",
      "pact-worker",
    ])

    expect(parsed.plannerBackend).toBe("opencode-cli")
    expect(parsed.plannerAgent).toBe("pact-planner")
    expect(parsed.plannerModel).toBe("openrouter/z-ai/glm-5.2")
    expect(parsed.reviewerBackend).toBe("opencode-cli")
    expect(parsed.reviewerAgent).toBe("pact-reviewer")
    expect(parsed.reviewerModel).toBe("openrouter/z-ai/glm-5.2")
    expect(parsed.agent).toBe("pact-worker")
  })

  test("defaults worker runner from PACT env", () => {
    const oldRunner = process.env.PACT_WORKER_RUNNER
    const oldImage = process.env.LOLBENCH_AGENT_IMAGE_TAG
    process.env.PACT_WORKER_RUNNER = "docker"
    process.env.LOLBENCH_AGENT_IMAGE_TAG = "lolbench/cpython-agent:1"
    try {
      const parsed = cliArgs(["--plan-file", "/tmp/PROMPT.md"])

      expect(parsed.workerRunner).toBe("docker")
      expect(parsed.workerContainerImage).toBe("lolbench/cpython-agent:1")
    } finally {
      if (oldRunner === undefined) delete process.env.PACT_WORKER_RUNNER
      else process.env.PACT_WORKER_RUNNER = oldRunner
      if (oldImage === undefined) delete process.env.LOLBENCH_AGENT_IMAGE_TAG
      else process.env.LOLBENCH_AGENT_IMAGE_TAG = oldImage
    }
  })

  test("defaults LoLBench round verification to public-only check", () => {
    const oldRepoRoot = process.env.LOLBENCH_REPO_ROOT
    const oldCommand = process.env.PACT_VERIFICATION_COMMAND
    process.env.LOLBENCH_REPO_ROOT = "/tmp/lolbench"
    delete process.env.PACT_VERIFICATION_COMMAND
    try {
      const parsed = cliArgs(["--plan-file", "/tmp/PROMPT.md"])

      expect(parsed.verificationCommand).toBe("python3 '/tmp/lolbench/scripts/lolbench_eval.py' pact-public-check")
    } finally {
      if (oldRepoRoot === undefined) delete process.env.LOLBENCH_REPO_ROOT
      else process.env.LOLBENCH_REPO_ROOT = oldRepoRoot
      if (oldCommand === undefined) delete process.env.PACT_VERIFICATION_COMMAND
      else process.env.PACT_VERIFICATION_COMMAND = oldCommand
    }
  })

  test("parses round0 and round checkpoint resume inputs", () => {
    const oldResume = process.env.PACT_RESUME_LOOP_DIR
    const oldMode = process.env.PACT_RESUME_MODE
    const oldRound = process.env.PACT_RESUME_ROUND
    process.env.PACT_RESUME_LOOP_DIR = "/tmp/archive/loops/L"
    process.env.PACT_RESUME_MODE = "round"
    process.env.PACT_RESUME_ROUND = "3"
    try {
      const fromEnv = cliArgs(["--plan-file", "/tmp/PROMPT.md"])
      expect(fromEnv.resumeLoopDir).toBe("/tmp/archive/loops/L")
      expect(fromEnv.resumeMode).toBe("round")
      expect(fromEnv.resumeRound).toBe(3)

      const fromCli = cliArgs([
        "--plan-file",
        "/tmp/PROMPT.md",
        "--resume-loop",
        "/tmp/other/loops/M",
        "--resume-mode",
        "round",
        "--resume-round",
        "1",
      ])
      expect(fromCli.resumeLoopDir).toBe("/tmp/other/loops/M")
      expect(fromCli.resumeMode).toBe("round")
      expect(fromCli.resumeRound).toBe(1)

      process.env.PACT_RESUME_ROUND = ""
      const round0 = cliArgs(["--plan-file", "/tmp/PROMPT.md", "--resume-mode", "round0"])
      expect(round0.resumeMode).toBe("round0")
      expect(round0.resumeRound).toBeUndefined()
    } finally {
      if (oldResume === undefined) delete process.env.PACT_RESUME_LOOP_DIR
      else process.env.PACT_RESUME_LOOP_DIR = oldResume
      if (oldMode === undefined) delete process.env.PACT_RESUME_MODE
      else process.env.PACT_RESUME_MODE = oldMode
      if (oldRound === undefined) delete process.env.PACT_RESUME_ROUND
      else process.env.PACT_RESUME_ROUND = oldRound
    }
  })

  test("builds an explicit start prompt from LoLBench inputs", () => {
    const prompt = buildPactStartPrompt({
      planFile: "/tmp/PROMPT.md",
      maxRounds: 5,
      workerModel: "zai-coding-plan/glm-5-turbo",
      verificationCommand: "python3 '/tmp/lolbench/scripts/lolbench_eval.py' pact-gate",
      verificationTimeoutMs: 600000,
    })

    expect(prompt).toContain('plan_file="/tmp/PROMPT.md"')
    expect(prompt).toContain("max_rounds=5")
    expect(prompt).toContain("planner_backend=codex-cli")
    expect(prompt).toContain("reviewer_backend=codex-cli")
    expect(prompt).toContain("worker_model=zai-coding-plan/glm-5-turbo")
    expect(prompt).toContain("round_boundary=run_exit")
    expect(prompt).toContain("verification_command=\"python3 '/tmp/lolbench/scripts/lolbench_eval.py' pact-gate\"")
    expect(prompt).toContain("verification_timeout_ms=600000")
  })

  test("starts a fresh OpenCode session for the finalize follow-up by default", () => {
    const project = tempGitProject()
    const calls: Array<{ command: string; args: string[]; input: string; maxBuffer?: number; timeout?: number }> = []
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 5,
      opencodeCommand: "fake-opencode",
      maxInvocations: 3,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      spawnSync(command, args, options) {
        calls.push({
          command,
          args,
          input: options.input,
          maxBuffer: options.maxBuffer,
          timeout: options.timeout,
        })
        if (calls.length === 1) {
          const state = readState(loopDir)
          state.phase = "finalize"
          state.current_round = 2
          state.previous_round_session_id = "ses_worker"
          state.active_session_id = undefined
          state.active_round_session_id = undefined
          writeState(loopDir, state)
          writeFileSync(join(loopDir, "round-02-prompt.md"), "finalize phase prompt\n", "utf-8")
        } else {
          const state = readState(loopDir)
          state.status = "complete"
          state.phase = "complete"
          writeState(loopDir, state)
          appendFileSync(join(loopDir, "complete-state.md"), "done\n", "utf-8")
        }
        return { status: 0, stdout: "api_key=secret-value\nworker log\n", stderr: "token=secret-value\n" }
      },
    })

    expect(result.status).toBe("complete")
    expect(result.invocations).toBe(2)
    expect(calls[0]?.args).toEqual(["run", "--dangerously-skip-permissions", "-m", "zai-coding-plan/glm-5-turbo"])
    expect(calls[0]?.input).toContain("# PACT Round 01")
    expect(calls[0]?.maxBuffer).toBeGreaterThanOrEqual(50 * 1024 * 1024)
    expect(calls[0]?.timeout).toBeGreaterThan(0)
    expect(calls[1]?.args).toEqual(["run", "--dangerously-skip-permissions", "-m", "zai-coding-plan/glm-5-turbo"])
    expect(calls[1]?.input).toBe("finalize phase prompt\n")
    expect(existsSync(join(loopDir, "round-01-trajectory.json"))).toBe(true)
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).toContain("worker log")
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).not.toContain("secret-value")
  })

  test("classifies a worker wrapper timeout without entering review", () => {
    const project = tempGitProject()
    const logs: string[] = []

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 1,
      planner() {
        return validPlannerOutput()
      },
      reviewer() {
        throw new Error("reviewer must not run after a worker timeout")
      },
      spawnSync() {
        return { status: 124, stdout: "", stderr: "observed-run timeout" }
      },
      log(message) {
        logs.push(message)
      },
    })

    expect(result.status).toBe("worker_timeout")
    expect(result.exitCode).toBe(124)
    expect(result.invocations).toBe(1)
    expect(logs.some((line) => line.includes("starting worker round 1"))).toBe(true)
    expect(logs.some((line) => line.includes("status=124"))).toBe(true)
  })

  test("driver owns Round00 initialization before the first worker run", () => {
    const project = tempGitProject()
    const calls: Array<{ input: string }> = []
    const reviewPrompts: string[] = []

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 1,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
      planner() {
        return validPlannerOutput()
      },
      reviewer(prompt) {
        reviewPrompts.push(prompt)
        return `### Decision Summary
Continue.

### Next Worker Instructions
Continue source changes.
`
      },
      spawnSync(_command, _args, options) {
        calls.push({ input: options.input })
        appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
        return { status: 0, stdout: "worker run\n", stderr: "" }
      },
    })

    expect(result.status).toBe("stopped")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).not.toContain("pact-start-loop")
    expect(calls[0]?.input).toContain("# PACT Round 01")
    expect(reviewPrompts).toHaveLength(1)
    expect(result.loopDir).toBeDefined()
    expect(existsSync(join(result.loopDir!, "round-00-plan-output.md"))).toBe(true)
    expect(existsSync(join(result.loopDir!, "round-01-prompt.md"))).toBe(true)
    expect(readState(result.loopDir!).worker_round_count).toBe(1)
  })

  test("resumes from an existing Round00 package without invoking planner", () => {
    const sourceProject = tempGitProject()
    const project = tempGitWorktreeProject()
    const sourceLoop = createLoop({
      projectRoot: sourceProject,
      planFile: join(sourceProject, "plan.md"),
      maxRounds: 3,
      plannerBackend: "codex-cli",
      plannerModel: "gpt-5.5",
      reviewerBackend: "codex-cli",
      reviewerModel: "gpt-5.4-mini",
      workerBackend: "opencode-cli",
      workerModel: "zai-coding-plan/glm-5-turbo",
      sessionStrategy: "new-per-round",
      roundBoundary: "run_exit",
      trajectoryMode: "full-redact",
    })
    writeFileSync(join(sourceLoop.loopDir, "plan.md"), "# Goal Description\nResume canonical plan.\n", "utf-8")
    writeFileSync(join(sourceLoop.loopDir, "todo.md"), "# Todo\n| Task ID | Description |\n", "utf-8")
    writeFileSync(
      join(sourceLoop.loopDir, "goal-tracker.md"),
      "# Goal Tracker\n## IMMUTABLE SECTION\n### Ultimate Goal\nResume.\n### Acceptance Criteria\nAC-1\n## MUTABLE SECTION\n",
      "utf-8",
    )
    const sourceState = readState(sourceLoop.loopDir)
    sourceState.planner_backend = "spec-import"
    sourceState.planner_model = null
    writeState(sourceLoop.loopDir, sourceState)
    mkdirSync(join(sourceLoop.loopDir, "spec-source", "enhanced_requirement_sections"), { recursive: true })
    writeFileSync(
      join(sourceLoop.loopDir, "spec-source", "enhanced_requirement_sections", "30_semantic_search_code_localization.md"),
      "## Semantic Search Code Localization Supplement\n",
      "utf-8",
    )
    writeFileSync(join(sourceLoop.loopDir, "spec-code-localization.md"), "## Copied Localization\n", "utf-8")
    writeFileSync(
      join(sourceLoop.loopDir, "target-surface-contract.md"),
      "# Target Surface Contract\n\n## Hard Target Surface Status Gate\n",
      "utf-8",
    )
    writeFileSync(
      join(sourceLoop.loopDir, "target-surfaces.json"),
      '{"schema":"pact-target-surfaces/v2","surfaces":[]}\n',
      "utf-8",
    )
    writeFileSync(
      join(sourceLoop.loopDir, "spec-input-manifest.json"),
      JSON.stringify(
        {
          schema: "pact-spec-input-manifest/v1",
          copied_evidence_dir: join(sourceLoop.loopDir, "spec-source", "enhanced_requirement_sections"),
          code_localization_file: join(sourceLoop.loopDir, "spec-code-localization.md"),
          target_surfaces_file: join(sourceLoop.loopDir, "target-surfaces.json"),
          target_surface_contract_file: join(sourceLoop.loopDir, "target-surface-contract.md"),
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    )
    writeFileSync(join(sourceLoop.loopDir, "round-01-prompt.md"), "stale old prompt\n", "utf-8")

    const calls: Array<{ input: string }> = []
    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 1,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
      plannerBackend: "codex-cli",
      resumeLoopDir: sourceLoop.loopDir,
      resumeMode: "round0",
      planner() {
        throw new Error("planner should not be called for round0 resume")
      },
      reviewer() {
        return "### Decision Summary\nContinue.\n"
      },
      spawnSync(_command, _args, options) {
        calls.push({ input: options.input })
        appendFileSync(join(project, "src.txt"), "worker change after resume\n", "utf-8")
        return { status: 0, stdout: "worker run\n", stderr: "" }
      },
    })

    expect(result.status).toBe("stopped")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toContain("# PACT Round 01")
    expect(calls[0]?.input).not.toContain("stale old prompt")
    expect(result.loopDir).toBeDefined()
    expect(result.loopDir).not.toBe(sourceLoop.loopDir)
    expect(existsSync(join(result.loopDir!, "round-00-result.json"))).toBe(true)
    expect(existsSync(join(result.loopDir!, "round-01-prompt.md"))).toBe(true)
    expect(readFileSync(join(result.loopDir!, "plan.md"), "utf-8")).toContain("Resume canonical plan")
    expect(calls[0]?.input).toContain(".pact/loops/")
    expect(calls[0]?.input).toContain("/plan.md")
    expect(calls[0]?.input).not.toContain(result.loopDir!)
    const roundContext = JSON.parse(readFileSync(join(result.loopDir!, "round-01-context.json"), "utf-8"))
    expect(roundContext.prompt_path).toBe(join(result.loopDir!, "round-01-prompt.md"))
    const excludeText = gitInfoExcludeText(project)
    expect(excludeText).toContain(".pact/")
    expect(excludeText).toContain("/*.patch")
    expect(excludeText).toContain("/*.diff")
    const state = readState(result.loopDir!)
    expect(state.next_round).toBe(2)
    expect(state.planner_backend).toBe("spec-import")
    expect(state.planner_model).toBeNull()
    expect(state.attempted_worker_rounds).toBe(1)
    expect(state.completed_worker_rounds).toBe(1)
    const manifest = readFileSync(join(result.loopDir!, "loop-manifest.json"), "utf-8")
    expect(manifest).toContain('"resume_mode": "round0"')
    expect(manifest).toContain(sourceLoop.loopID)
    expect(manifest).toContain('"planner_backend": "spec-import"')
    expect(manifest).toContain('"planner_model": null')
    expect(existsSync(join(result.loopDir!, "spec-source", "enhanced_requirement_sections"))).toBe(true)
    expect(existsSync(join(result.loopDir!, "spec-code-localization.md"))).toBe(true)
    expect(existsSync(join(result.loopDir!, "target-surface-contract.md"))).toBe(true)
    expect(existsSync(join(result.loopDir!, "target-surfaces.json"))).toBe(true)
    expect(calls[0]?.input).toContain("Spec input manifest")
    expect(calls[0]?.input).toContain("Spec evidence directory")
    expect(calls[0]?.input).toContain("Spec code localization")
    expect(calls[0]?.input).toContain("Target surface contract")
    expect(calls[0]?.input).toContain("Hard Target Surface Completion Gate")
  })

  test("resumes from a verified round checkpoint in a fresh workspace", () => {
    const sourceProject = tempGitProject()
    const project = tempGitWorktreeFor(sourceProject)
    let sourceLoopDir = ""
    const source = runPactDriver({
      projectRoot: sourceProject,
      planFile: join(sourceProject, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 3,
      maxInvocations: 1,
      opencodeCommand: "fake-opencode",
      planner(_prompt, context) {
        sourceLoopDir = context.loopDir
        return validPlannerOutput()
      },
      reviewer() {
        return "### Decision Summary\nContinue.\n"
      },
      spawnSync() {
        appendFileSync(join(sourceProject, "src.txt"), "round one change\n", "utf-8")
        writeFileSync(join(sourceLoopDir, "round-01-summary.md"), "# Round 01 Summary\nImplemented round one.\n", "utf-8")
        return { status: 0, stdout: "worker run\n", stderr: "" }
      },
    })

    expect(source.status).toBe("max_invocations")
    expect(existsSync(join(sourceLoopDir, "round-01-checkpoint.json"))).toBe(true)
    expect(existsSync(join(sourceLoopDir, "round-01-plan-post.md"))).toBe(true)
    const checkpoint = JSON.parse(readFileSync(join(sourceLoopDir, "round-01-checkpoint.json"), "utf-8"))
    expect(checkpoint.next_round).toBe(2)
    expect(checkpoint.state.completed_worker_rounds).toBe(1)
    writeFileSync(join(sourceLoopDir, "plan.md"), "# Later round plan that must not leak\n", "utf-8")

    const planPostPath = join(sourceLoopDir, "round-01-plan-post.md")
    const planPost = readFileSync(planPostPath, "utf-8")
    writeFileSync(planPostPath, `${planPost}\ntampered\n`, "utf-8")
    expect(() =>
      runPactDriver({
        projectRoot: project,
        planFile: join(project, "plan.md"),
        model: "zai-coding-plan/glm-5-turbo",
        maxRounds: 2,
        resumeLoopDir: sourceLoopDir,
        resumeMode: "round",
        resumeRound: 1,
      }),
    ).toThrow("plan ledger hash mismatch")
    writeFileSync(planPostPath, planPost, "utf-8")

    const mismatchedProject = tempGitWorktreeFor(sourceProject)
    appendFileSync(join(mismatchedProject, "src.txt"), "different base\n", "utf-8")
    execFileSync("git", ["add", "src.txt"], { cwd: mismatchedProject })
    execFileSync("git", ["commit", "-m", "different base"], { cwd: mismatchedProject })
    expect(() =>
      runPactDriver({
        projectRoot: mismatchedProject,
        planFile: join(mismatchedProject, "plan.md"),
        model: "zai-coding-plan/glm-5-turbo",
        maxRounds: 2,
        resumeLoopDir: sourceLoopDir,
        resumeMode: "round",
        resumeRound: 1,
      }),
    ).toThrow("base commit mismatch")

    const calls: Array<{ input: string; workspaceBeforeRound: string }> = []
    const replay = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 2,
      maxInvocations: 1,
      opencodeCommand: "fake-opencode",
      resumeLoopDir: sourceLoopDir,
      resumeMode: "round",
      resumeRound: 1,
      planner() {
        throw new Error("planner should not be called for round checkpoint resume")
      },
      reviewer() {
        return "### Decision Summary\nContinue.\n"
      },
      spawnSync(_command, _args, options) {
        calls.push({ input: options.input, workspaceBeforeRound: readFileSync(join(project, "src.txt"), "utf-8") })
        appendFileSync(join(project, "src.txt"), "round two change\n", "utf-8")
        writeFileSync(
          join(replayLoopDir(project), "round-02-summary.md"),
          "# Round 02 Summary\nImplemented round two.\n",
          "utf-8",
        )
        return { status: 0, stdout: "worker replay\n", stderr: "" }
      },
    })

    expect(replay.status).toBe("stopped")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toContain("# PACT Round 02")
    expect(calls[0]?.workspaceBeforeRound).toBe("before\nround one change\n")
    expect(replay.loopDir).toBeDefined()
    expect(readFileSync(join(replay.loopDir!, "plan.md"), "utf-8")).not.toContain("Later round plan")
    expect(readState(replay.loopDir!).completed_worker_rounds).toBe(2)
    const manifest = JSON.parse(readFileSync(join(replay.loopDir!, "loop-manifest.json"), "utf-8"))
    expect(manifest.resume_mode).toBe("round")
    expect(manifest.resume_source_round).toBe(1)
    expect(manifest.resume_source_loop_id).toBe(checkpoint.loop_id)
    expect(manifest.inherited_worker_rounds).toBe(1)
    expect(existsSync(join(replay.loopDir!, "resume-source-round-checkpoint.json"))).toBe(true)
  })

  test("OpenCode planner and reviewer backends use explicit models and agents", () => {
    const project = tempGitProject()
    const calls: Array<{ args: string[]; input: string }> = []
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "openrouter/z-ai/glm-5.2",
      maxRounds: 1,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
      plannerBackend: "opencode-cli",
      plannerAgent: "pact-planner",
      plannerModel: "openrouter/z-ai/glm-5.2",
      reviewerBackend: "opencode-cli",
      reviewerAgent: "pact-reviewer",
      reviewerModel: "openrouter/z-ai/glm-5.2",
      workerAgent: "pact-worker",
      workerOutputFormat: "json",
      spawnSync(_command, args, options) {
        calls.push({ args, input: options.input })
        if (calls.length === 1) {
          return { status: 0, stdout: validPlannerOutput(), stderr: "" }
        }
        if (calls.length === 2) {
          loopDir = join(project, ".pact", "loops", "missing")
          appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
          return { status: 0, stdout: "worker\n", stderr: "" }
        }
        return { status: 0, stdout: "### Decision Summary\nContinue.\n", stderr: "" }
      },
    })

    expect(result.status).toBe("stopped")
    expect(calls[0]?.args).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "-m",
      "openrouter/z-ai/glm-5.2",
      "--agent",
      "pact-planner",
    ])
    expect(calls[1]?.args).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "-m",
      "openrouter/z-ai/glm-5.2",
      "--agent",
      "pact-worker",
      "--format",
      "json",
      "--thinking",
    ])
    expect(calls[2]?.args).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "-m",
      "openrouter/z-ai/glm-5.2",
      "--agent",
      "pact-reviewer",
    ])
    expect(JSON.parse(readFileSync(join(result.loopDir!, "round-01-result.json"), "utf-8"))).toMatchObject({
      planner_backend: "opencode-cli",
      planner_model: "openrouter/z-ai/glm-5.2",
      reviewer_backend: "opencode-cli",
      reviewer_model: "openrouter/z-ai/glm-5.2",
    })
  })

  test("docker worker runner wraps each OpenCode round in a container", () => {
    const project = tempGitProject()
    const pluginDir = mkdtempSync(join(tmpdir(), "pact-plugin-mount-"))
    tempDirs.push(pluginDir)
    const pluginPath = join(pluginDir, "pact.ts")
    writeFileSync(pluginPath, "export default {}\n", "utf-8")
    const oldConfig = process.env.OPENCODE_CONFIG_CONTENT
    const oldZaiKey = process.env.ZAI_API_KEY
    const oldZaiBase = process.env.ZAI_API_BASE
    const oldOpenRouterKey = process.env.OPENROUTER_API_KEY
    const oldOpenRouterBase = process.env.OPENROUTER_BASE_URL
    const oldOpencodeConfig = process.env.OPENCODE_CONFIG
    const oldMem = process.env.LOLBENCH_MEM
    const oldCpus = process.env.LOLBENCH_CPUS
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pluginPath] })
    process.env.ZAI_API_KEY = "test-zai-key"
    process.env.ZAI_API_BASE = "https://api.z.ai/api/coding/paas/v4"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
    process.env.OPENCODE_CONFIG = "/root/.config/opencode/opencode.json"
    process.env.LOLBENCH_MEM = "7g"
    process.env.LOLBENCH_CPUS = "4"
    const calls: Array<{ command: string; args: string[]; input: string }> = []

    try {
      const result = runPactDriver({
        projectRoot: project,
        planFile: join(project, "plan.md"),
        model: "zai-coding-plan/glm-5-turbo",
        maxRounds: 1,
        workerRunner: "docker",
        workerContainerImage: "lolbench/cpython-agent:1",
        workerPluginMount: pluginDir,
        planner() {
          return validPlannerOutput()
        },
        reviewer() {
          return "### Decision Summary\nContinue.\n"
        },
        spawnSync(command, args, options) {
          calls.push({ command, args, input: options.input })
          appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
          return { status: 0, stdout: "container worker\n", stderr: "" }
        },
      })

      expect(result.status).toBe("stopped")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe("docker")
      expect(calls[0]?.args).toContain("run")
      expect(calls[0]?.args).toContain("-i")
      expect(calls[0]?.args).toContain("--memory")
      expect(calls[0]?.args).toContain("7g")
      expect(calls[0]?.args).toContain("--cpus")
      expect(calls[0]?.args).toContain("4")
      expect(calls[0]?.args).toContain("api.github.com:127.0.0.1")
      expect(calls[0]?.args).toContain("lolbench/cpython-agent:1")
      expect(calls[0]?.args).toContain("-v")
      expect(calls[0]?.args).toContain(`${project}:/workspace/pact-workspace`)
      expect(calls[0]?.args).toContain(`${pluginDir}:/opt/opencode-pact-plugins:ro`)
      const entrypointIndex = calls[0]!.args.indexOf("--entrypoint")
      expect(entrypointIndex).toBeGreaterThan(-1)
      expect(calls[0]?.args[entrypointIndex + 1]).toBe("")
      expect(calls[0]?.args).toContain("ZAI_API_KEY")
      expect(calls[0]?.args).toContain("OPENROUTER_API_KEY")
      expect(calls[0]?.args).toContain("OPENROUTER_BASE_URL")
      expect(calls[0]?.args).toContain("OPENCODE_CONFIG")
      const configArg = calls[0]?.args.find((arg) => arg.startsWith("OPENCODE_CONFIG_CONTENT=")) ?? ""
      expect(configArg).toContain("/opt/opencode-pact-plugins/pact.ts")
      expect(configArg).not.toContain(pluginDir)
      const imageIndex = calls[0]!.args.indexOf("lolbench/cpython-agent:1")
      expect(calls[0]?.args.slice(imageIndex + 1)).toEqual([
        "opencode",
        "run",
        "--dangerously-skip-permissions",
        "-m",
        "zai-coding-plan/glm-5-turbo",
      ])
      expect(calls[0]?.input).toContain("# PACT Round 01")
      expect(calls[0]?.input).not.toContain(project)
      expect(calls[0]?.input).toContain(".pact/loops/")
      expect(calls[0]?.input).toContain("round-01-contract.md")
    } finally {
      if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = oldConfig
      if (oldZaiKey === undefined) delete process.env.ZAI_API_KEY
      else process.env.ZAI_API_KEY = oldZaiKey
      if (oldZaiBase === undefined) delete process.env.ZAI_API_BASE
      else process.env.ZAI_API_BASE = oldZaiBase
      if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = oldOpenRouterKey
      if (oldOpenRouterBase === undefined) delete process.env.OPENROUTER_BASE_URL
      else process.env.OPENROUTER_BASE_URL = oldOpenRouterBase
      if (oldOpencodeConfig === undefined) delete process.env.OPENCODE_CONFIG
      else process.env.OPENCODE_CONFIG = oldOpencodeConfig
      if (oldMem === undefined) delete process.env.LOLBENCH_MEM
      else process.env.LOLBENCH_MEM = oldMem
      if (oldCpus === undefined) delete process.env.LOLBENCH_CPUS
      else process.env.LOLBENCH_CPUS = oldCpus
    }
  })

  test("driver default planner invokes codex before the first worker run", () => {
    const project = tempGitProject()
    const binDir = mkdtempSync(join(tmpdir(), "pact-driver-codex-bin-"))
    tempDirs.push(binDir)
    const oldPath = process.env.PATH
    const plannerOutputPath = join(binDir, "planner-output.txt")
    const plannerArgsPath = join(binDir, "planner-args.txt")
    writeFileSync(plannerOutputPath, validPlannerOutput(), "utf-8")
    writeFileSync(
      join(binDir, "codex"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(plannerArgsPath)}\ncat >/dev/null\ncat ${JSON.stringify(plannerOutputPath)}\n`,
      "utf-8",
    )
    chmodSync(join(binDir, "codex"), 0o755)
    process.env.PATH = `${binDir}:${oldPath ?? ""}`
    try {
      const calls: Array<{ input: string }> = []
      const result = runPactDriver({
        projectRoot: project,
        planFile: join(project, "plan.md"),
        model: "zai-coding-plan/glm-5-turbo",
        maxRounds: 1,
        opencodeCommand: "fake-opencode",
        maxInvocations: 1,
        reviewer() {
          return `### Decision Summary
Continue.
`
        },
        spawnSync(_command, _args, options) {
          calls.push({ input: options.input })
          appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
          return { status: 0, stdout: "worker run\n", stderr: "" }
        },
      })

      expect(result.status).toBe("stopped")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toContain("# PACT Round 01")
      expect(readFileSync(join(result.loopDir!, "round-00-plan-output.md"), "utf-8")).toContain("<<<PACT_PLAN>>>")
      const plannerArgs = readFileSync(plannerArgsPath, "utf-8").split("\n")
      expect(plannerArgs).toContain("--sandbox")
      expect(plannerArgs).toContain("read-only")
      const state = readState(result.loopDir!)
      expect(state.stop_reason).toBe("max_rounds")
      expect(readFileSync(join(result.loopDir!, "round-01-result.json"), "utf-8")).toContain(
        '"failure_category": "max_rounds"',
      )
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
    }
  })

  test("driver finalizes a run-exit round without waiting for session idle", () => {
    const project = tempGitProject()
    const calls: Array<{ command: string; args: string[]; input: string }> = []
    const reviewPrompts: string[] = []
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 2,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      reviewer(prompt) {
        reviewPrompts.push(prompt)
        return `### Decision Summary
Needs another round.

### Goal Alignment Summary
ACs: 0/1 addressed | Forgotten items: 0 | Unjustified deferrals: 0

### Progress Audit
- The source change is only partially complete.

### Acceptance Criteria Audit
AC-1: PARTIAL.

### Unresolved Mainline Gaps
- Source behavior still needs the mainline fix.

### Defects and Regressions
(none)

### Suggested Priorities
- Inspect src.txt and complete the source behavior fix; this is advisory, not assignment.
`
      },
      spawnSync(command, args, options) {
        calls.push({ command, args, input: options.input })
        appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
        return { status: 0, stdout: "worker exited without idle review\n", stderr: "" }
      },
    })

    expect(result.status).toBe("max_invocations")
    expect(calls).toHaveLength(1)
    expect(reviewPrompts).toHaveLength(1)
    expect(reviewPrompts[0]).toContain("Summary status: missing")
    expect(reviewPrompts[0]).toContain("Contract status: missing")
    expect(existsSync(join(loopDir, "round-01-review.md"))).toBe(true)
    expect(existsSync(join(loopDir, "round-01-review-decision.json"))).toBe(true)
    expect(existsSync(join(loopDir, "round-01-result.json"))).toBe(true)
    expect(existsSync(join(loopDir, "round-02-prompt.md"))).toBe(true)
    const reviewDecision = JSON.parse(readFileSync(join(loopDir, "round-01-review-decision.json"), "utf-8"))
    expect(reviewDecision.review_guidance).toMatchObject({
      role: "advisory",
      suggestedPriorities: expect.stringContaining("Inspect src.txt"),
    })
    expect(reviewDecision).not.toHaveProperty("next_worker_instruction")
    const roundTwoPrompt = readFileSync(join(loopDir, "round-02-prompt.md"), "utf-8")
    expect(roundTwoPrompt).toContain("# PACT Round 02 Worker Prompt")
    expect(roundTwoPrompt).toContain("## Current State Snapshot")
    expect(roundTwoPrompt).toContain("Reviewer guidance is evidence, not assignment")
    expect(roundTwoPrompt).toContain("### Suggested Priorities")
    expect(roundTwoPrompt).toContain("Inspect src.txt")
    expect(roundTwoPrompt).toContain("make as much correct progress toward the Ultimate Goal")
    expect(roundTwoPrompt).not.toContain("## Next Worker Instruction")
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).toContain(
      "worker exited without idle review",
    )
  })

  test("failed public verification blocks reviewer-approved completion ledger updates", () => {
    const project = tempGitProject()
    const fakeGate = join(project, "fake-public-gate.py")
    writeFileSync(
      fakeGate,
      `#!/usr/bin/env python3
import json
print(json.dumps({"status":"failed","applied":True,"build_status":"failed","error_categories":["build_failure"]}))
raise SystemExit(1)
`,
      "utf-8",
    )
    chmodSync(fakeGate, 0o755)
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 2,
      opencodeCommand: "fake-opencode",
      verificationCommand: `python3 ${JSON.stringify(fakeGate)}`,
      maxInvocations: 1,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      reviewer() {
        return `### Decision Summary
Looks complete, but the gate will override this.

### Goal Tracker Updates
APPROVED

### Status Delta
\`\`\`json
{"role":"reviewer_confirmed","ac":{"AC-1":"met"},"tasks":{"task-1":"complete"},"approved":["task-1 completed with public tests"]}
\`\`\`

PACT_COMPLETE
`
      },
      spawnSync() {
        appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
        writeFileSync(
          join(loopDir, "round-01-summary.md"),
          "## Goal Tracker Update Request\nMark task-1 complete with evidence: tests pass.\n",
          "utf-8",
        )
        return { status: 0, stdout: "worker exited\n", stderr: "" }
      },
    })

    expect(result.status).toBe("max_invocations")
    const tracker = readFileSync(join(loopDir, "goal-tracker.md"), "utf-8")
    expect(tracker).not.toContain("| task-1 | AC-1 | complete | coding | worker |")
    expect(tracker).not.toContain("| AC-1 | task-1 | 1 | 1 |")
    expect(readFileSync(join(loopDir, "round-01-review-decision.json"), "utf-8")).toContain("build_gate_failed")
    expect(readFileSync(join(loopDir, "round-02-prompt.md"), "utf-8")).toContain("Verification status: failed")
  })

  test("reviewer candidate complete triggers final hidden gate and stops unresolved without next prompt", () => {
    const project = tempGitProject()
    const fakeLolbench = mkdtempSync(join(tmpdir(), "pact-fake-lolbench-"))
    tempDirs.push(fakeLolbench)
    const scriptsDir = join(fakeLolbench, "scripts")
    execFileSync("mkdir", ["-p", scriptsDir])
    const fakeEval = join(scriptsDir, "lolbench_eval.py")
    writeFileSync(
      fakeEval,
      `#!/usr/bin/env python3
import json, sys
mode = sys.argv[1]
if mode == "pact-public-check":
    print(json.dumps({"status":"passed","applied":True,"source":"public"}))
    raise SystemExit(0)
if mode == "pact-gate":
    sys.stderr.write("hidden suite failed with private assertion details\\n")
    print(json.dumps({
        "status":"failed",
        "applied":True,
        "resolved":False,
        "build_status":"ok",
        "f2p":{"passed":1,"total":2},
        "p2p":{"passed":2,"total":2},
        "error_categories":["test_failure"],
        "failure_signature":"applied=true build=ok resolved=false f2p=1/2 p2p=2/2"
    }))
    raise SystemExit(1)
raise SystemExit(2)
`,
      "utf-8",
    )
    chmodSync(fakeEval, 0o755)
    const oldRepoRoot = process.env.LOLBENCH_REPO_ROOT
    const oldImage = process.env.LOLBENCH_IMAGE_TAG
    const oldRunDir = process.env.LOLBENCH_RUN_DIR
    const oldSuites = process.env.LOLBENCH_FINAL_GATE_SUITES
    process.env.LOLBENCH_REPO_ROOT = fakeLolbench
    process.env.LOLBENCH_IMAGE_TAG = "fake-image:1"
    process.env.LOLBENCH_RUN_DIR = project
    process.env.LOLBENCH_FINAL_GATE_SUITES = "orig"
    let loopDir = ""
    try {
      const result = runPactDriver({
        projectRoot: project,
        planFile: join(project, "plan.md"),
        model: "zai-coding-plan/glm-5-turbo",
        maxRounds: 3,
        opencodeCommand: "fake-opencode",
        maxInvocations: 1,
        planner(_prompt, context) {
          loopDir = context.loopDir
          return validPlannerOutput()
        },
        reviewer() {
          return `### Decision Summary
Candidate looks complete.

PACT_COMPLETE
`
        },
        verificationCommand: `python3 ${JSON.stringify(fakeEval)} pact-public-check`,
        spawnSync() {
          appendFileSync(join(project, "src.txt"), "candidate change\n", "utf-8")
          return { status: 0, stdout: "worker\n", stderr: "" }
        },
      })

      expect(result.status).toBe("stopped")
      const state = readState(loopDir)
      expect(state.phase).toBe("stopped")
      expect(state.stop_reason).toBe("final_hidden_gate_failed")
      expect(existsSync(join(loopDir, "final-hidden-gate-orig.json"))).toBe(true)
      expect(existsSync(join(loopDir, "final-hidden-gate-orig.log"))).toBe(true)
      expect(existsSync(join(loopDir, "final-hidden-gate-summary.json"))).toBe(true)
      expect(existsSync(join(loopDir, "final-result.json"))).toBe(true)
      expect(existsSync(join(loopDir, "round-02-prompt.md"))).toBe(false)
      expect(readFileSync(join(loopDir, "round-01-verification.json"), "utf-8")).not.toContain("f2p")
    } finally {
      if (oldRepoRoot === undefined) delete process.env.LOLBENCH_REPO_ROOT
      else process.env.LOLBENCH_REPO_ROOT = oldRepoRoot
      if (oldImage === undefined) delete process.env.LOLBENCH_IMAGE_TAG
      else process.env.LOLBENCH_IMAGE_TAG = oldImage
      if (oldRunDir === undefined) delete process.env.LOLBENCH_RUN_DIR
      else process.env.LOLBENCH_RUN_DIR = oldRunDir
      if (oldSuites === undefined) delete process.env.LOLBENCH_FINAL_GATE_SUITES
      else process.env.LOLBENCH_FINAL_GATE_SUITES = oldSuites
    }
  })

  test("reviewer failure after worker exit updates attempted completed and reviewed counters", () => {
    const project = tempGitProject()
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 3,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      reviewer() {
        throw new Error("reviewer unavailable")
      },
      spawnSync() {
        appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
        return { status: 0, stdout: "worker\n", stderr: "" }
      },
    })

    expect(result.status).toBe("stopped")
    const state = readState(loopDir)
    expect(state.next_round).toBe(2)
    expect(state.current_round).toBe(2)
    expect(state.attempted_worker_rounds).toBe(1)
    expect(state.completed_worker_rounds).toBe(1)
    expect(state.reviewed_worker_rounds).toBe(1)
    expect(state.worker_round_count).toBe(1)
  })

  test("run-exit capture and review events use the active round session, not the previous one", () => {
    const project = tempGitProject()
    let loopDir = ""
    let calls = 0

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 3,
      opencodeCommand: "fake-opencode",
      maxInvocations: 2,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      reviewer() {
        return `### Decision Summary
Continue.

### Next Worker Instructions
Continue source changes.
`
      },
      spawnSync() {
        calls++
        if (calls === 1) {
          appendFileSync(join(project, "src.txt"), "round one change\n", "utf-8")
        } else {
          const state = readState(loopDir)
          state.previous_round_session_id = "ses_round1"
          state.active_round_session_id = "ses_round2"
          state.active_session_id = "ses_round2"
          writeState(loopDir, state)
          appendFileSync(join(project, "src.txt"), "round two change\n", "utf-8")
        }
        return { status: 0, stdout: `worker ${calls}\n`, stderr: "" }
      },
    })

    expect(result.status).toBe("max_invocations")
    const events = readFileSync(join(loopDir, "round-02-events.jsonl"), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; session_id?: string })
    expect(events.find((event) => event.type === "patch_captured")?.session_id).toBe("ses_round2")
    expect(events.find((event) => event.type === "review_started")?.session_id).toBe("ses_round2")
  })

  test("driver verification parses pretty JSON failure signatures", () => {
    const project = tempGitProject()
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 1,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      reviewer() {
        return `### Decision Summary
Continue.
`
      },
      verificationCommand:
        'python3 -c \'import json; print(json.dumps({"status":"failed","build_status":"ok","failure_signature":"test_future.py failed","f2p":{"passed":2,"total":6},"p2p":{"passed":18,"total":18}}, indent=2))\'',
      spawnSync(command) {
        appendFileSync(join(project, "src.txt"), "worker change\n", "utf-8")
        return { status: 0, stdout: "worker\n", stderr: "" }
      },
    })

    expect(result.status).toBe("stopped")
    const verification = JSON.parse(readFileSync(join(loopDir, "round-01-verification.json"), "utf-8")) as {
      failure_signature?: string
    }
    expect(verification.failure_signature).toBe("test_future.py failed")
  })

  test("reports redacted OpenCode spawn failures", () => {
    const project = tempGitProject()
    const logs: string[] = []

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 1,
      opencodeCommand: "fake-opencode",
      planner() {
        return validPlannerOutput()
      },
      log(message) {
        logs.push(message)
      },
      spawnSync() {
        return {
          status: 1,
          stdout: "worker stdout api_key=secret-value\n",
          stderr: "ReferenceError: require is not defined\nTOKEN=secret-value\n",
        }
      },
    })

    expect(result.status).toBe("opencode_failed")
    expect(logs.join("\n")).toContain("OpenCode worker invocation failed")
    expect(logs.join("\n")).toContain("ReferenceError")
    expect(logs.join("\n")).not.toContain("secret-value")
  })

  test("can explicitly opt in to same-session continuation", () => {
    const project = tempGitProject()
    const calls: Array<{ args: string[]; input: string }> = []
    let loopDir = ""

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 2,
      sessionStrategy: "same-session",
      opencodeCommand: "fake-opencode",
      maxInvocations: 2,
      planner(_prompt, context) {
        loopDir = context.loopDir
        return validPlannerOutput()
      },
      spawnSync(_command, args, options) {
        calls.push({ args, input: options.input })
        if (calls.length === 1) {
          const state = readState(loopDir)
          state.current_round = 2
          state.previous_round_session_id = "ses_worker"
          state.active_round_session_id = "ses_worker"
          state.active_session_id = "ses_worker"
          writeState(loopDir, state)
          writeFileSync(join(loopDir, "round-02-prompt.md"), "same session prompt\n", "utf-8")
        } else {
          const state = readState(loopDir)
          state.status = "complete"
          state.phase = "complete"
          writeState(loopDir, state)
        }
        return { status: 0, stdout: "", stderr: "" }
      },
    })

    expect(result.status).toBe("complete")
    expect(calls[1]?.args).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "-m",
      "zai-coding-plan/glm-5-turbo",
      "-s",
      "ses_worker",
    ])
  })

  test("does not reuse a stale loop when driver-owned planner fails", () => {
    const project = tempGitProject()
    const stale = createLoop({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      workerSessionID: "ses_old",
    })
    const staleState = readState(stale.loopDir)
    staleState.status = "complete"
    staleState.phase = "complete"
    writeState(stale.loopDir, staleState)

    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 2,
      opencodeCommand: "fake-opencode",
      planner() {
        return "not a valid planner output"
      },
      spawnSync() {
        throw new Error("worker should not run after planner failure")
      },
    })

    expect(result.status).toBe("stopped")
    expect(result.invocations).toBe(0)
    expect(result.exitCode).toBe(0)
    expect(result.loopDir).toBeDefined()
    expect(result.loopDir).not.toBe(stale.loopDir)
    expect(readFileSync(join(result.loopDir!, "planner-error.md"), "utf-8")).toContain("PACT Planner Failed")
  })
})
