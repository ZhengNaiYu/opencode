import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const agentDir = join(import.meta.dir, "..", "..", "agent")

function readAgentPrompt(name: string): string {
  return readFileSync(join(agentDir, name), "utf-8")
}

describe("PACT static agent prompts", () => {
  test("planner prompt uses the same three marker blocks as the dynamic planner schema", () => {
    const prompt = readAgentPrompt("pact-planner.md")

    expect(prompt).toContain("<<<PACT_PLAN>>>")
    expect(prompt).toContain("<<<END_PACT_PLAN>>>")
    expect(prompt).toContain("<<<PACT_TODO>>>")
    expect(prompt).toContain("<<<END_PACT_TODO>>>")
    expect(prompt).toContain("<<<PACT_GOAL_TRACKER>>>")
    expect(prompt).toContain("<<<END_PACT_GOAL_TRACKER>>>")
    expect(prompt).toContain("Return exactly three marker blocks")
    expect(prompt).not.toMatch(/exactly two marker blocks/i)
  })

  test("reviewer prompt is advisory and does not assign next-round worker instructions", () => {
    const prompt = readAgentPrompt("pact-reviewer.md")

    expect(prompt).toContain("advisory")
    expect(prompt).toContain("not task assignment")
    expect(prompt).toContain("### Suggested Priorities")
    expect(prompt).toContain("PACT_COMPLETE")
    expect(prompt).toContain("PACT_STOP")
    expect(prompt).not.toContain("Prefer small, direct fixes")
    expect(prompt).not.toMatch(/feedback for the next worker round/i)
  })

  test("worker prompt is Ultimate Goal first and prefers the broadest coherent objective", () => {
    const prompt = readAgentPrompt("pact-worker.md")

    expect(prompt).toContain("Ultimate Goal")
    expect(prompt).toContain("broadest coherent objective")
    expect(prompt).toContain("Reviewer guidance is evidence, not assignment")
    expect(prompt).toContain("Why This Objective")
    expect(prompt).toContain("Decide autonomously whether delegation is worth its cost")
    expect(prompt).toContain("pact-specialist")
    expect(prompt).not.toMatch(/smallest coherent task/i)
  })

  test("specialist prompt is read-only and returns evidence to the worker", () => {
    const prompt = readAgentPrompt("pact-specialist.md")

    expect(prompt).toContain('mode: subagent')
    expect(prompt).toContain('"*": deny')
    expect(prompt).toContain("read: allow")
    expect(prompt).toContain("read-only specialist")
    expect(prompt).toContain("Do not modify files")
  })
})
