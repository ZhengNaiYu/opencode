import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLoop, readState, writeState } from "./pact-core"
import { buildPactStartPrompt, runPactDriver } from "./pact-run-driver"

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

describe("PACT run driver", () => {
  test("builds an explicit start prompt from LoLBench inputs", () => {
    const prompt = buildPactStartPrompt({
      planFile: "/tmp/PROMPT.md",
      maxRounds: 5,
      workerModel: "zai-coding-plan/glm-5-turbo",
    })

    expect(prompt).toContain('plan_file="/tmp/PROMPT.md"')
    expect(prompt).toContain("max_rounds=5")
    expect(prompt).toContain("planner_backend=codex-cli")
    expect(prompt).toContain("reviewer_backend=codex-cli")
    expect(prompt).toContain("worker_model=zai-coding-plan/glm-5-turbo")
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
      spawnSync(command, args, options) {
        calls.push({ command, args, input: options.input, maxBuffer: options.maxBuffer })
        if (calls.length === 1) {
          const loop = createLoop({
            projectRoot: project,
            planFile: join(project, "plan.md"),
            workerSessionID: "ses_worker",
            maxRounds: 5,
          })
          loopDir = loop.loopDir
          const state = readState(loop.loopDir)
          state.phase = "finalize"
          state.current_round = 2
          state.previous_round_session_id = "ses_worker"
          state.active_session_id = undefined
          state.active_round_session_id = undefined
          writeState(loop.loopDir, state)
          writeFileSync(join(loop.loopDir, "round-02-prompt.md"), "finalize phase prompt\n", "utf-8")
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
    expect(calls[0]?.input).toContain("pact-start-loop")
    expect(calls[0]?.maxBuffer).toBeGreaterThanOrEqual(50 * 1024 * 1024)
    expect(calls[1]?.args).toEqual(["run", "--dangerously-skip-permissions", "-m", "zai-coding-plan/glm-5-turbo"])
    expect(calls[1]?.input).toBe("finalize phase prompt\n")
    expect(existsSync(join(loopDir, "round-01-trajectory.json"))).toBe(true)
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).toContain("worker log")
    expect(readFileSync(join(loopDir, "round-01-trajectory.json"), "utf-8")).not.toContain("secret-value")
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
      spawnSync(_command, args, options) {
        calls.push({ args, input: options.input })
        if (calls.length === 1) {
          const loop = createLoop({
            projectRoot: project,
            planFile: join(project, "plan.md"),
            workerSessionID: "ses_worker",
            sessionStrategy: "same-session",
          })
          loopDir = loop.loopDir
          const state = readState(loop.loopDir)
          state.current_round = 2
          writeState(loop.loopDir, state)
          writeFileSync(join(loop.loopDir, "round-02-prompt.md"), "same session prompt\n", "utf-8")
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

  test("does not reuse a stale loop when the start invocation creates no loop", () => {
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
      spawnSync() {
        return { status: 0, stdout: "no pact loop was created\n", stderr: "" }
      },
    })

    expect(result).toMatchObject({
      status: "no_loop",
      invocations: 1,
      exitCode: 0,
    })
    expect(result.loopDir).toBeUndefined()
  })
})
