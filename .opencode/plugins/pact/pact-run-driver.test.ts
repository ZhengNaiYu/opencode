import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  const parent = mkdtempSync(join(tmpdir(), "pact-driver-worktree-parent-"))
  tempDirs.push(parent)
  const dir = join(parent, "worktree")
  const branch = `pact-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir], { cwd: base })
  return dir
}

function gitInfoExcludeText(projectRoot: string): string {
  const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: projectRoot,
    encoding: "utf-8",
  }).trim()
  return readFileSync(excludePath, "utf-8")
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

  test("parses round0 resume loop from CLI or environment", () => {
    const oldResume = process.env.PACT_RESUME_LOOP_DIR
    const oldMode = process.env.PACT_RESUME_MODE
    process.env.PACT_RESUME_LOOP_DIR = "/tmp/archive/loops/L"
    process.env.PACT_RESUME_MODE = "round0"
    try {
      const fromEnv = cliArgs(["--plan-file", "/tmp/PROMPT.md"])
      expect(fromEnv.resumeLoopDir).toBe("/tmp/archive/loops/L")
      expect(fromEnv.resumeMode).toBe("round0")

      const fromCli = cliArgs([
        "--plan-file",
        "/tmp/PROMPT.md",
        "--resume-loop",
        "/tmp/other/loops/M",
        "--resume-mode",
        "round0",
      ])
      expect(fromCli.resumeLoopDir).toBe("/tmp/other/loops/M")
      expect(fromCli.resumeMode).toBe("round0")
    } finally {
      if (oldResume === undefined) delete process.env.PACT_RESUME_LOOP_DIR
      else process.env.PACT_RESUME_LOOP_DIR = oldResume
      if (oldMode === undefined) delete process.env.PACT_RESUME_MODE
      else process.env.PACT_RESUME_MODE = oldMode
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
    const calls: Array<{ command: string; args: string[]; input: string; maxBuffer?: number }> = []
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
        calls.push({ command, args, input: options.input, maxBuffer: options.maxBuffer })
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
    expect(calls[1]?.args).toEqual(["run", "--dangerously-skip-permissions", "-m", "zai-coding-plan/glm-5-turbo"])
    expect(calls[1]?.input).toBe("finalize phase prompt\n")
    expect(existsSync(join(loopDir, "round-01-trajectory.json"))).toBe(true)
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).toContain("worker log")
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).not.toContain("secret-value")
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
    writeFileSync(join(sourceLoop.loopDir, "round-01-prompt.md"), "stale old prompt\n", "utf-8")

    const calls: Array<{ input: string }> = []
    const result = runPactDriver({
      projectRoot: project,
      planFile: join(project, "plan.md"),
      model: "zai-coding-plan/glm-5-turbo",
      maxRounds: 1,
      opencodeCommand: "fake-opencode",
      maxInvocations: 1,
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
    expect(calls[0]?.input).toContain(join(result.loopDir!, "plan.md"))
    const excludeText = gitInfoExcludeText(project)
    expect(excludeText).toContain(".pact/")
    expect(excludeText).toContain("/*.patch")
    expect(excludeText).toContain("/*.diff")
    const state = readState(result.loopDir!)
    expect(state.next_round).toBe(2)
    expect(state.attempted_worker_rounds).toBe(1)
    expect(state.completed_worker_rounds).toBe(1)
    const manifest = readFileSync(join(result.loopDir!, "loop-manifest.json"), "utf-8")
    expect(manifest).toContain('"resume_mode": "round0"')
    expect(manifest).toContain(sourceLoop.loopID)
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
    const oldMem = process.env.LOLBENCH_MEM
    const oldCpus = process.env.LOLBENCH_CPUS
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pluginPath] })
    process.env.ZAI_API_KEY = "test-zai-key"
    process.env.ZAI_API_BASE = "https://api.z.ai/api/coding/paas/v4"
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
      expect(calls[0]?.args).toContain("lolbench/cpython-agent:1")
      expect(calls[0]?.args).toContain("-v")
      expect(calls[0]?.args).toContain(`${project}:/workspace/pact-workspace`)
      expect(calls[0]?.args).toContain(`${pluginDir}:/opt/opencode-pact-plugins:ro`)
      expect(calls[0]?.args).toContain("ZAI_API_KEY")
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
    } finally {
      if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = oldConfig
      if (oldZaiKey === undefined) delete process.env.ZAI_API_KEY
      else process.env.ZAI_API_KEY = oldZaiKey
      if (oldZaiBase === undefined) delete process.env.ZAI_API_BASE
      else process.env.ZAI_API_BASE = oldZaiBase
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
    writeFileSync(plannerOutputPath, validPlannerOutput(), "utf-8")
    writeFileSync(join(binDir, "codex"), `#!/bin/sh\ncat >/dev/null\ncat ${JSON.stringify(plannerOutputPath)}\n`, "utf-8")
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

### Next Worker Instructions
Continue from the source diff and fix the remaining mainline gap.
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
    expect(readFileSync(join(loopDir, "round-02-prompt.md"), "utf-8")).toContain("Current Round Package Summary")
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).toContain("worker exited without idle review")
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
        "python3 -c 'import json; print(json.dumps({\"status\":\"failed\",\"build_status\":\"ok\",\"failure_signature\":\"test_future.py failed\",\"f2p\":{\"passed\":2,\"total\":6},\"p2p\":{\"passed\":18,\"total\":18}}, indent=2))'",
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
