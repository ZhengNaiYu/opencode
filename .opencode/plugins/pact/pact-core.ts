import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

export type ReviewerBackend = "opencode-agent" | "codex-cli"
export type LoopStatus = "running" | "complete" | "stopped" | "cancelled"
export type ReviewMarker = "complete" | "continue" | "stop"

export type PactState = {
  version: 1
  status: LoopStatus
  loop_id: string
  current_round: number
  max_rounds: number
  plan_file: string
  active_session_id?: string
  reviewer_backend: ReviewerBackend
  created_at: string
  updated_at: string
  last_review_marker?: ReviewMarker
  last_review_path?: string
  last_feedback_path?: string
}

export type LoopInfo = {
  loopID: string
  loopDir: string
  statePath: string
}

export type CreateLoopInput = {
  projectRoot: string
  planFile: string
  now?: Date
  maxRounds?: number
  reviewerBackend?: ReviewerBackend
  workerSessionID?: string
}

export type PlannerArtifacts = {
  todo: string
  goalTracker: string
}

export type ReviewDecision = {
  marker: ReviewMarker
  reason?: string
  parseStatus: "complete_signal" | "stop_signal" | "implicit_continue" | "deprecated_continue_signal"
  terminalLine: string
}

export function formatLoopID(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")
}

export function roundName(round: number): string {
  return String(round).padStart(2, "0")
}

export function readState(loopDir: string): PactState {
  return JSON.parse(readFileSync(join(loopDir, "state.json"), "utf-8")) as PactState
}

export function writeState(loopDir: string, state: PactState): void {
  state.updated_at = new Date().toISOString()
  writeFileSync(join(loopDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8")
}

export function createLoop(input: CreateLoopInput): LoopInfo {
  const now = input.now ?? new Date()
  const loopID = formatLoopID(now)
  const loopDir = join(input.projectRoot, ".pact", "loops", loopID)
  mkdirSync(loopDir, { recursive: true })

  const planSource = isAbsolute(input.planFile) ? input.planFile : join(input.projectRoot, input.planFile)
  if (!existsSync(planSource)) {
    throw new Error(`Plan file not found: ${input.planFile}`)
  }
  copyFileSync(planSource, join(loopDir, "plan.md"))
  writeFileSync(join(loopDir, "todo.md"), defaultTodo(), "utf-8")
  writeFileSync(join(loopDir, "goal-tracker.md"), defaultGoalTracker(input.planFile), "utf-8")

  const state: PactState = {
    version: 1,
    status: "running",
    loop_id: loopID,
    current_round: 1,
    max_rounds: input.maxRounds ?? 8,
    plan_file: input.planFile,
    active_session_id: input.workerSessionID,
    reviewer_backend: input.reviewerBackend ?? "opencode-agent",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }
  writeFileSync(join(loopDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8")

  return { loopID, loopDir, statePath: join(loopDir, "state.json") }
}

export function findActiveLoop(projectRoot: string): LoopInfo | undefined {
  const loopsRoot = join(projectRoot, ".pact", "loops")
  if (!existsSync(loopsRoot)) return undefined
  const loopIDs = readdirSync(loopsRoot)
    .filter((item) => statSync(join(loopsRoot, item)).isDirectory())
    .sort()
    .reverse()
  for (const loopID of loopIDs) {
    const loopDir = join(loopsRoot, loopID)
    const statePath = join(loopDir, "state.json")
    if (!existsSync(statePath)) continue
    const state = readState(loopDir)
    if (state.status === "running" && !existsSync(join(loopDir, "complete-state.md"))) {
      return { loopID, loopDir, statePath }
    }
  }
  return undefined
}

export function parsePlannerArtifacts(text: string): PlannerArtifacts {
  const todo = extractBlock(text, "PACT_TODO") ?? defaultTodo()
  const goalTracker = extractBlock(text, "PACT_GOAL_TRACKER") ?? defaultGoalTracker("plan.md")
  return { todo: todo.trim() + "\n", goalTracker: goalTracker.trim() + "\n" }
}

export function applyPlannerArtifacts(loopDir: string, artifacts: PlannerArtifacts): void {
  writeFileSync(join(loopDir, "todo.md"), artifacts.todo.trim() + "\n", "utf-8")
  writeFileSync(join(loopDir, "goal-tracker.md"), artifacts.goalTracker.trim() + "\n", "utf-8")
}

export function parseReviewDecision(text: string): ReviewDecision {
  const terminalLine = lastNonEmptyLine(text)
  if (terminalLine === "PACT_COMPLETE") {
    return { marker: "complete", parseStatus: "complete_signal", terminalLine }
  }
  if (terminalLine === "PACT_STOP") {
    return { marker: "stop", parseStatus: "stop_signal", terminalLine }
  }
  if (terminalLine === "PACT_CONTINUE") {
    return { marker: "continue", parseStatus: "deprecated_continue_signal", terminalLine }
  }
  return { marker: "continue", reason: "missing_terminal_signal", parseStatus: "implicit_continue", terminalLine }
}

export function recordReviewDecision(input: { loopDir: string; round: number; reviewText: string }): ReviewDecision {
  const reviewPath = join(input.loopDir, `round-${roundName(input.round)}-review.md`)
  writeFileSync(reviewPath, input.reviewText.trim() + "\n", "utf-8")
  const decision = parseReviewDecision(input.reviewText)
  const state = readState(input.loopDir)
  state.last_review_marker = decision.marker
  state.last_review_path = reviewPath

  if (decision.marker === "complete") {
    state.status = "complete"
    writeFileSync(join(input.loopDir, "complete-state.md"), `PACT completed after round ${input.round}.\n`, "utf-8")
  } else if (decision.marker === "stop") {
    state.status = "stopped"
    writeFileSync(join(input.loopDir, "stop-state.md"), `PACT stopped after round ${input.round}.\n`, "utf-8")
  } else {
    const feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
    writeFileSync(feedbackPath, feedbackText(input.reviewText, decision) + "\n", "utf-8")
    state.last_feedback_path = feedbackPath
    state.current_round = Math.min(input.round + 1, state.max_rounds)
    if (input.round >= state.max_rounds) {
      state.status = "stopped"
      writeFileSync(join(input.loopDir, "stop-state.md"), `PACT stopped after max round ${input.round}.\n`, "utf-8")
    }
  }
  writeState(input.loopDir, state)
  return decision
}

export function isProtectedWrite(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/")
  return (
    /\.pact\/loops\/[^/]+\/state\.json$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/round-\d+-review\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/round-\d+-feedback\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/complete-state\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/stop-state\.md$/.test(normalized)
  )
}

export function isImmutableGoalTrackerEdit(filePath: string, content: string): boolean {
  const normalized = filePath.replaceAll("\\", "/")
  if (!/\.pact\/loops\/[^/]+\/goal-tracker\.md$/.test(normalized)) return false
  return !content.includes("## MUTABLE")
}

export function buildPlannerPrompt(input: { planPath: string; planContent: string }): string {
  return `# PACT Planner

Create a concrete task ledger and goal tracker from the plan.

Plan path: ${input.planPath}

## Plan
${input.planContent}

Return exactly two marker blocks:

<<<PACT_TODO>>>
# Todo
- [ ] Task 1
<<<END_PACT_TODO>>>

<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE
### Ultimate Goal
...
### Acceptance Criteria
...
## MUTABLE
### Active Tasks
...
### Completed Items
(none)
### Deferred Items
(none)
### Plan Evolution Log
(none)
<<<END_PACT_GOAL_TRACKER>>>
`
}

export function buildInitialWorkerPrompt(input: {
  loopDir: string
  round: number
  todoPath: string
  goalTrackerPath: string
}): string {
  return `# PACT Round ${roundName(input.round)}

You are the PACT worker. Execute the next smallest coherent task from the ledger.

Read:
- Todo: ${input.todoPath}
- Goal tracker: ${input.goalTrackerPath}

Rules:
- Preserve the immutable goal and acceptance criteria.
- Make the smallest code changes that satisfy the active task.
- Update only the mutable section of goal-tracker.md.
- Before stopping, write an honest summary to ${join(input.loopDir, `round-${roundName(input.round)}-summary.md`)}.

The reviewer will inspect your summary and the repository state when this session goes idle.
`
}

export function buildContinuationPrompt(input: {
  loopDir: string
  round: number
  feedbackPath: string
  goalTrackerPath: string
}): string {
  return `# PACT Round ${roundName(input.round)} Continuation

The previous round did not pass review.

Read reviewer feedback:
- ${input.feedbackPath}

Read current goal tracker:
- ${input.goalTrackerPath}

Address the feedback with the smallest necessary changes. Before stopping, write an honest summary to ${join(
    input.loopDir,
    `round-${roundName(input.round)}-summary.md`,
  )}.
`
}

export function buildReviewPrompt(input: {
  loopDir: string
  round: number
  planPath?: string
  todoPath?: string
  goalTrackerPath?: string
  summaryPath: string
  summary: string
}): string {
  return `# PACT Review Round ${roundName(input.round)}

You are the independent PACT reviewer.

Review inputs:
- Plan: ${input.planPath ?? join(input.loopDir, "plan.md")}
- Todo: ${input.todoPath ?? join(input.loopDir, "todo.md")}
- Goal tracker: ${input.goalTrackerPath ?? join(input.loopDir, "goal-tracker.md")}
- Round summary: ${input.summaryPath}

## Round Summary
${input.summary}

Decide:
- PACT_COMPLETE: task and acceptance criteria are satisfied.
- PACT_STOP: blocked, unsafe, or needs user decision.

If the checkpoint needs another worker round, write actionable feedback only and do not add a continue marker.
End with PACT_COMPLETE or PACT_STOP only for those terminal states.
`
}

export function summaryPath(loopDir: string, round: number): string {
  return join(loopDir, `round-${roundName(round)}-summary.md`)
}

export function resolveProjectPath(projectRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath)
}

function defaultTodo(): string {
  return `# Todo

- [ ] TODO will be generated by pact-planner.
`
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const stripped = lines[index]?.trim() ?? ""
    if (stripped) return stripped
  }
  return ""
}

function feedbackText(text: string, decision: ReviewDecision): string {
  if (decision.parseStatus !== "deprecated_continue_signal") return text.trim()
  return stripFinalNonEmptyLine(text).trim()
}

function stripFinalNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    if ((lines[index] ?? "").trim()) {
      return lines.slice(0, index).join("\n")
    }
  }
  return text
}

function defaultGoalTracker(planFile: string): string {
  return `# Goal Tracker

## IMMUTABLE

### Ultimate Goal
Execute the plan: ${planFile}

### Acceptance Criteria
- The implementation satisfies the plan's observable requirements.

## MUTABLE

### Active Tasks
- [ ] Generate concrete tasks from the plan.

### Completed Items
(none)

### Deferred Items
(none)

### Plan Evolution Log
(none)
`
}

function extractBlock(text: string, name: string): string | undefined {
  const pattern = new RegExp(`<<<${name}>>>\\s*([\\s\\S]*?)\\s*<<<END_${name}>>>`)
  return pattern.exec(text)?.[1]
}
