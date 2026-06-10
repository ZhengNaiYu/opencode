import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import {
  applyPlannerArtifacts,
  buildContinuationPrompt,
  buildInitialWorkerPrompt,
  buildPlannerPrompt,
  buildReviewPrompt,
  createLoop,
  findActiveLoop,
  isImmutableGoalTrackerEdit,
  isProtectedWrite,
  parsePlannerArtifacts,
  readState,
  recordReviewDecision,
  resolveProjectPath,
  roundName,
  summaryPath,
  writeState,
  type ReviewerBackend,
} from "./pact/pact-core"

type PactPluginOptions = {
  reviewerBackend?: ReviewerBackend
  maxRounds?: number
  plannerAgent?: string
  reviewerAgent?: string
  workerAgent?: string
  codexCommand?: string
  codexArgs?: string[]
}

type PromptClient = {
  session?: {
    create?: (input: Record<string, unknown>) => Promise<{ data?: { id?: string } }>
    prompt?: (input: Record<string, unknown>) => Promise<{ data?: { parts?: Array<Record<string, unknown>> } }>
  }
}

const DEFAULTS = {
  plannerAgent: "pact-planner",
  reviewerAgent: "pact-reviewer",
  workerAgent: "pact-worker",
  reviewerBackend: "opencode-agent" as ReviewerBackend,
  maxRounds: 8,
}

export const PactPlugin: Plugin = async ({ client, directory, worktree }, options?: PactPluginOptions) => {
  const projectRoot = worktree || directory || process.cwd()
  const cfg = { ...DEFAULTS, ...(options ?? {}) }
  let processingIdle = false

  return {
    tool: {
      "pact-start-loop": tool({
        description: "Start a PACT reviewer-governed checkpoint loop from a plan file.",
        args: {
          plan_file: tool.schema.string().describe("Path to the plan markdown file, relative to the project root."),
          max_rounds: tool.schema.number().optional().describe("Maximum PACT rounds before stopping."),
          reviewer_backend: tool.schema.enum(["opencode-agent", "codex-cli"]).optional(),
        },
        async execute(args, context) {
          const reviewerBackend = (args.reviewer_backend ?? cfg.reviewerBackend) as ReviewerBackend
          const loop = createLoop({
            projectRoot: context.worktree || context.directory || projectRoot,
            planFile: args.plan_file,
            maxRounds: args.max_rounds ?? cfg.maxRounds,
            reviewerBackend,
            workerSessionID: context.sessionID,
          })
          const planContent = readFileSync(join(loop.loopDir, "plan.md"), "utf-8")

          try {
            const plannerPrompt = buildPlannerPrompt({ planPath: args.plan_file, planContent })
            const plannerText = await invokeOpenCodeAgent(client as PromptClient, {
              agent: cfg.plannerAgent,
              title: "PACT planner",
              prompt: plannerPrompt,
              parentSessionID: context.sessionID,
            })
            applyPlannerArtifacts(loop.loopDir, parsePlannerArtifacts(plannerText))
          } catch (err) {
            writeFileSync(
              join(loop.loopDir, "planner-error.md"),
              `Planner failed, using template defaults.\n\n${String(err)}\n`,
              "utf-8",
            )
          }

          const prompt = buildInitialWorkerPrompt({
            loopDir: loop.loopDir,
            round: 1,
            todoPath: join(loop.loopDir, "todo.md"),
            goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
          })

          return {
            output: `PACT loop started.

Loop: ${loop.loopDir}
Round: 01
Reviewer backend: ${reviewerBackend}

Begin the first worker checkpoint now:

${prompt}
`,
            metadata: { loopDir: loop.loopDir, round: 1, reviewerBackend },
          }
        },
      }),

      "pact-status": tool({
        description: "Show the active PACT loop status.",
        args: {},
        async execute(_args, context) {
          const loop = findActiveLoop(context.worktree || context.directory || projectRoot)
          if (!loop) return "No active PACT loop."
          const state = readState(loop.loopDir)
          return `PACT status
Loop: ${loop.loopDir}
Status: ${state.status}
Round: ${roundName(state.current_round)} / ${state.max_rounds}
Reviewer: ${state.reviewer_backend}
Last verdict: ${state.last_review_marker ?? "(none)"}
Todo: ${join(loop.loopDir, "todo.md")}
Goal tracker: ${join(loop.loopDir, "goal-tracker.md")}
`
        },
      }),

      "pact-cancel": tool({
        description: "Cancel the active PACT loop.",
        args: {},
        async execute(_args, context) {
          const loop = findActiveLoop(context.worktree || context.directory || projectRoot)
          if (!loop) return "No active PACT loop."
          const state = readState(loop.loopDir)
          state.status = "cancelled"
          writeState(loop.loopDir, state)
          writeFileSync(join(loop.loopDir, "cancel-state.md"), "PACT loop cancelled by user.\n", "utf-8")
          return `PACT loop cancelled: ${loop.loopDir}`
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (processingIdle) return

      const sessionID = (event as any)?.properties?.sessionID || (event as any)?.sessionID
      const loop = findActiveLoop(projectRoot)
      if (!loop) return

      const state = readState(loop.loopDir)
      if (state.active_session_id && sessionID && state.active_session_id !== sessionID) return

      const round = state.current_round
      const currentSummaryPath = summaryPath(loop.loopDir, round)
      const reviewPath = join(loop.loopDir, `round-${roundName(round)}-review.md`)
      if (existsSync(reviewPath)) return

      if (!existsSync(currentSummaryPath)) {
        const reminderPath = join(loop.loopDir, `round-${roundName(round)}-summary-reminder.md`)
        if (!existsSync(reminderPath) && state.active_session_id) {
          writeFileSync(reminderPath, `Reminder sent for missing round ${round} summary.\n`, "utf-8")
          await promptSession(
            client as PromptClient,
            state.active_session_id,
            cfg.workerAgent,
            `PACT is waiting for your round summary. Before stopping, write an honest summary to ${currentSummaryPath}.`,
          )
        }
        return
      }

      processingIdle = true
      try {
        const summary = readFileSync(currentSummaryPath, "utf-8")
        const reviewPrompt = buildReviewPrompt({
          loopDir: loop.loopDir,
          round,
          summaryPath: currentSummaryPath,
          summary,
        })
        const reviewText =
          state.reviewer_backend === "codex-cli"
            ? invokeCodexReviewer(reviewPrompt, cfg)
            : await invokeOpenCodeAgent(client as PromptClient, {
                agent: cfg.reviewerAgent,
                title: `PACT review round ${roundName(round)}`,
                prompt: reviewPrompt,
                parentSessionID: state.active_session_id,
              })
        const decision = recordReviewDecision({ loopDir: loop.loopDir, round, reviewText })

        const nextState = readState(loop.loopDir)
        if (decision.marker === "continue" && nextState.status === "running" && nextState.active_session_id) {
          await promptSession(
            client as PromptClient,
            nextState.active_session_id,
            cfg.workerAgent,
            buildContinuationPrompt({
              loopDir: loop.loopDir,
              round: nextState.current_round,
              feedbackPath: join(loop.loopDir, `round-${roundName(round)}-feedback.md`),
              goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
            }),
          )
        }
      } finally {
        processingIdle = false
      }
    },

    "tool.execute.before": async (input, output) => {
      const args = output?.args ?? {}
      const filePath = String(args.filePath || args.path || args.file || "")
      if (!filePath) return
      const absolute = resolveProjectPath(projectRoot, filePath)
      if (isProtectedWrite(absolute)) {
        throw new Error(`[PACT] Protected ledger file cannot be modified by the worker: ${filePath}`)
      }
      const content = typeof args.content === "string" ? args.content : ""
      if (content && isImmutableGoalTrackerEdit(absolute, content)) {
        throw new Error(`[PACT] goal-tracker.md must preserve the immutable goal/acceptance criteria section.`)
      }
    },
  }
}

async function invokeOpenCodeAgent(
  client: PromptClient,
  input: { agent: string; title: string; prompt: string; parentSessionID?: string },
): Promise<string> {
  if (!client.session?.create || !client.session?.prompt) {
    throw new Error("OpenCode client session API is unavailable")
  }
  const created = await client.session.create({
    body: { parentID: input.parentSessionID, title: input.title },
  })
  const sessionID = created.data?.id
  if (!sessionID) throw new Error(`Failed to create ${input.agent} session`)
  const result = await client.session.prompt({
    path: { id: sessionID },
    body: {
      agent: input.agent,
      parts: [{ type: "text", text: input.prompt }],
    },
  })
  return extractTextParts(result)
}

async function promptSession(client: PromptClient, sessionID: string, agent: string, prompt: string): Promise<void> {
  if (!client.session?.prompt) {
    throw new Error("OpenCode client prompt API is unavailable")
  }
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      agent,
      parts: [{ type: "text", text: prompt }],
    },
  })
}

function invokeCodexReviewer(prompt: string, cfg: PactPluginOptions): string {
  const command = cfg.codexCommand ?? "codex"
  const args = cfg.codexArgs ?? ["exec", "--skip-git-repo-check", "-"]
  const result = spawnSync(command, args, {
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Codex reviewer failed with status ${result.status}: ${result.stderr}`)
  }
  return result.stdout || result.stderr || "Codex reviewer returned no content."
}

function extractTextParts(result: { data?: { parts?: Array<Record<string, unknown>> } }): string {
  const parts = result.data?.parts ?? []
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim()
  return text || "No text content returned by reviewer."
}

export default PactPlugin
