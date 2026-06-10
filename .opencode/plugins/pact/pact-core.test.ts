import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLoop, parseReviewDecision, readState, recordReviewDecision } from "./pact-core"

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

  test("accepts PACT_STOP only as the final non-empty line", () => {
    expect(parseReviewDecision("Blocked.\nPACT_STOP\n")).toMatchObject({
      marker: "stop",
      parseStatus: "stop_signal",
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
})
