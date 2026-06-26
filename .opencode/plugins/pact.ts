import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, isAbsolute, join, relative } from "node:path"
import {
  appendRoundEvent,
  applyApprovedGoalTrackerUpdates,
  applyPlannerArtifacts,
  bindRoundSession,
  buildContinuationPrompt,
  buildFinalizePrompt,
  buildInitialWorkerPrompt,
  buildPlannerPrompt,
  buildPlannerRepairPrompt,
  buildReviewPhasePrompt,
  buildReviewPrompt,
  capturePatchArtifact,
  classifyRoundFailure,
  commitRoundHistory,
  createLoop,
  exportReplayCase,
  findActiveLoop,
  artifactPaths,
  isProtectedWrite,
  parsePlannerArtifacts,
  readState,
  redactText,
  validatePlannerArtifacts,
  recordFailedReviewDecision,
  recordReviewDecision,
  resolveProjectPath,
  roundName,
  summaryPath,
  summarizeToolArgs,
  summarizeToolOutput,
  writeRoundContext,
  writeRoundEvidence,
  writeRoundResult,
  writeRoundSnapshot,
  writeRoundState,
  writeRoundTrajectory,
  writeContinuationPackage,
  writeVerificationArtifact,
  writeState,
  type FailureClassificationInput,
  type LoopPhase,
  type LoopStatus,
  type PactState,
  type PatchArtifact,
  type PlannerBackend,
  type PlannerValidationResult,
  type RoundVerificationArtifact,
  type ReviewerBackend,
  type ReviewMarker,
  type RoundBoundary,
  type SessionStrategy,
  type TrajectoryMode,
  type WorkerBackend,
} from "./pact/pact-core"

export type PactPluginOptions = {
  plannerBackend?: PlannerBackend
  reviewerBackend?: ReviewerBackend
  maxRounds?: number
  plannerAgent?: string
  reviewerAgent?: string
  workerAgent?: string
  plannerModel?: string
  reviewerModel?: string
  workerBackend?: string
  workerModel?: string
  workerConfigSource?: string
  sessionStrategy?: SessionStrategy
  roundBoundary?: RoundBoundary
  trajectoryMode?: TrajectoryMode
  codexCommand?: string
  codexArgs?: string[]
  plannerCodexArgs?: string[]
  codexTimeoutMs?: number
  fullAlignmentInterval?: number
  benchmarkStrictNetwork?: boolean
  verificationCommand?: string
  verificationTimeoutMs?: number
}

type PromptClient = {
  session?: {
    create?: (input: Record<string, unknown>) => Promise<{ data?: { id?: string } }>
    prompt?: (input: Record<string, unknown>) => Promise<{ data?: { parts?: Array<Record<string, unknown>> } }>
  }
}

export const PACT_PLUGIN_DEFAULTS = {
  plannerAgent: "pact-planner",
  reviewerAgent: "pact-reviewer",
  workerAgent: "pact-worker",
  plannerBackend: "codex-cli" as PlannerBackend,
  plannerModel: "gpt-5.5",
  reviewerBackend: "codex-cli" as ReviewerBackend,
  reviewerModel: "gpt-5.4-mini",
  workerBackend: "opencode-cli" as WorkerBackend,
  workerModel: "zai-coding-plan/glm-5-turbo",
  workerConfigSource: "mini-swe-agent-env",
  codexTimeoutMs: 10 * 60 * 1000,
  verificationTimeoutMs: 30 * 60 * 1000,
  maxRounds: 8,
  fullAlignmentInterval: 5,
  sessionStrategy: "new-per-round" as SessionStrategy,
  roundBoundary: "session_idle" as RoundBoundary,
  trajectoryMode: "full-redact" as TrajectoryMode,
}

export const PactPlugin: Plugin = async ({ client, directory, worktree }, options?: PactPluginOptions) => {
  const projectRoot = worktree || directory || process.cwd()
  const cfg = { ...PACT_PLUGIN_DEFAULTS, ...options }
  const promptClient: PromptClient = client
  let processingIdle = false

  return {
    tool: {
      "pact-start-loop": tool({
        description: "Start a PACT reviewer-governed checkpoint loop from a plan file.",
        args: {
          plan_file: tool.schema.string().describe("Path to the plan markdown file, relative to the project root."),
          max_rounds: tool.schema.number().optional().describe("Maximum PACT rounds before stopping."),
          planner_backend: tool.schema.enum(["opencode-agent", "codex-cli"]).optional(),
          planner_model: tool.schema.string().optional(),
          reviewer_backend: tool.schema.enum(["opencode-agent", "codex-cli"]).optional(),
          reviewer_model: tool.schema.string().optional(),
          worker_backend: tool.schema.string().optional(),
          worker_model: tool.schema.string().optional(),
          worker_config_source: tool.schema.string().optional(),
          session_strategy: tool.schema.enum(["new-per-round", "same-session"]).optional(),
          round_boundary: tool.schema.enum(["session_idle", "run_exit"]).optional(),
          trajectory_mode: tool.schema.enum(["structured", "full-redact"]).optional(),
          full_alignment_interval: tool.schema.number().optional(),
          verification_command: tool.schema.string().optional(),
          verification_timeout_ms: tool.schema.number().optional(),
        },
        async execute(args, context) {
          const plannerBackend = args.planner_backend ?? cfg.plannerBackend
          const plannerModel =
            plannerBackend === "codex-cli" ? args.planner_model ?? plannerModelForBackend(plannerBackend, cfg) : null
          const reviewerBackend = args.reviewer_backend ?? cfg.reviewerBackend
          const reviewerModel =
            reviewerBackend === "codex-cli" ? args.reviewer_model ?? reviewerModelForBackend(reviewerBackend, cfg) : null
          const workerBackend = args.worker_backend ?? cfg.workerBackend ?? PACT_PLUGIN_DEFAULTS.workerBackend
          const workerModel = args.worker_model ?? cfg.workerModel ?? PACT_PLUGIN_DEFAULTS.workerModel
          const workerConfigSource =
            args.worker_config_source ?? cfg.workerConfigSource ?? PACT_PLUGIN_DEFAULTS.workerConfigSource
          const sessionStrategy = args.session_strategy ?? cfg.sessionStrategy ?? PACT_PLUGIN_DEFAULTS.sessionStrategy
          const roundBoundary = args.round_boundary ?? cfg.roundBoundary ?? PACT_PLUGIN_DEFAULTS.roundBoundary
          const trajectoryMode = args.trajectory_mode ?? cfg.trajectoryMode ?? PACT_PLUGIN_DEFAULTS.trajectoryMode
          const verificationCommand = args.verification_command ?? cfg.verificationCommand
          const verificationTimeoutMs = args.verification_timeout_ms ?? cfg.verificationTimeoutMs
          const loop = createLoop({
            projectRoot: context.worktree || context.directory || projectRoot,
            planFile: args.plan_file,
            maxRounds: args.max_rounds ?? cfg.maxRounds,
            plannerBackend,
            plannerModel,
            reviewerBackend,
            reviewerModel,
            workerBackend,
            workerModel,
            workerConfigSource,
            workerSessionID: context.sessionID,
            sessionStrategy,
            roundBoundary,
            trajectoryMode,
            fullAlignmentInterval: args.full_alignment_interval ?? cfg.fullAlignmentInterval,
            verificationCommand,
            verificationTimeoutMs,
          })
          const planContent = readFileSync(join(loop.loopDir, "source-plan.md"), "utf-8")

          try {
            const plannerPrompt = buildPlannerPrompt({ planPath: args.plan_file, planContent })
            writeFileSync(join(loop.loopDir, "round-00-plan-prompt.md"), plannerPrompt, "utf-8")
            let plannerText = await invokePlannerBackend({
              client: promptClient,
              cfg,
              plannerBackend,
              plannerModel,
              prompt: plannerPrompt,
              projectRoot: context.worktree || context.directory || projectRoot,
              parentSessionID: context.sessionID,
            })
            writeFileSync(join(loop.loopDir, "round-00-plan-output.md"), redactText(plannerText), "utf-8")
            let artifacts = parsePlannerArtifacts(plannerText)
            let validation = validatePlannerArtifacts(artifacts)
            if (!validation.ok) {
              const repairPrompt = buildPlannerRepairPrompt({
                previousOutput: plannerText,
                validation,
                sourcePlan: planContent,
              })
              writeFileSync(join(loop.loopDir, "round-00-plan-repair-prompt.md"), repairPrompt, "utf-8")
              plannerText = await invokePlannerBackend({
                client: promptClient,
                cfg,
                plannerBackend,
                plannerModel,
                prompt: repairPrompt,
                projectRoot: context.worktree || context.directory || projectRoot,
                parentSessionID: context.sessionID,
              })
              writeFileSync(join(loop.loopDir, "round-00-plan-repair-output.md"), redactText(plannerText), "utf-8")
              artifacts = parsePlannerArtifacts(plannerText)
              validation = validatePlannerArtifacts(artifacts)
            }
            if (!validation.ok) {
              recordPlannerFailure({
                loopDir: loop.loopDir,
                state: readState(loop.loopDir),
                plannerBackend,
                plannerModel,
                validation,
                plannerOutput: plannerText,
              })
              return {
                output: `PACT planner failed schema validation. Loop stopped.\n\nLoop: ${loop.loopDir}\n`,
                metadata: {
                  loopDir: loop.loopDir,
                  round: 0,
                  plannerBackend,
                  plannerModel,
                  reviewerBackend,
                  reviewerModel,
                  status: "stopped",
                },
              }
            }
            applyPlannerArtifacts(loop.loopDir, artifacts)
            commitRoundHistory(loop.loopDir, 0, "round-00 canonical planning")
          } catch (err) {
            recordPlannerFailure({
              loopDir: loop.loopDir,
              state: readState(loop.loopDir),
              plannerBackend,
              plannerModel,
              error: err,
            })
            return {
              output: `PACT planner failed. Loop stopped.\n\nLoop: ${loop.loopDir}\n`,
              metadata: {
                loopDir: loop.loopDir,
                round: 0,
                plannerBackend,
                plannerModel,
                reviewerBackend,
                reviewerModel,
                status: "stopped",
              },
            }
          }

          const prompt = buildInitialWorkerPrompt({
            loopDir: loop.loopDir,
            round: 1,
            todoPath: join(loop.loopDir, "todo.md"),
            goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
          })
          writeRoundStartArtifacts({
            loopDir: loop.loopDir,
            loopID: loop.loopID,
            round: 1,
            prompt,
            sessionID: context.sessionID,
            workerAgent: cfg.workerAgent,
            loopPhase: "implementation",
            plannerBackend,
            plannerModel,
            reviewerBackend,
            reviewerModel,
            workerBackend,
            workerModel,
            workerConfigSource,
          })
          writeRoundSnapshot({
            projectRoot: context.worktree || context.directory || projectRoot,
            loopDir: loop.loopDir,
            loopID: loop.loopID,
            round: 1,
            stage: "pre",
          })

          return {
            output: `PACT loop started.

Loop: ${loop.loopDir}
Round: 01
Planner backend: ${plannerBackend}
Planner model: ${plannerModel}
Reviewer backend: ${reviewerBackend}
Reviewer model: ${reviewerModel}
Worker backend: ${workerBackend}
Worker model: ${workerModel}
Session strategy: ${sessionStrategy}

Begin the first worker checkpoint now:

${prompt}
`,
            metadata: {
              loopDir: loop.loopDir,
              round: 1,
              plannerBackend,
              plannerModel,
              reviewerBackend,
              reviewerModel,
              workerBackend,
              workerModel,
              workerConfigSource,
              sessionStrategy,
              trajectoryMode,
            },
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
Phase: ${state.phase}
Round: ${roundName(state.current_round)} / ${state.max_rounds}
Last verdict: ${state.last_review_marker ?? "(none)"}
Planner: ${state.planner_backend ?? cfg.plannerBackend} / ${plannerModelFromState(state, cfg)}
Reviewer: ${state.reviewer_backend} / ${reviewerModelFromState(state, cfg)}
Worker: ${state.worker_backend ?? cfg.workerBackend ?? PACT_PLUGIN_DEFAULTS.workerBackend} / ${state.worker_model ?? cfg.workerModel ?? PACT_PLUGIN_DEFAULTS.workerModel}
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
          writeRoundState({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            phase: "cancelled",
            loopPhase: "stopped",
            sessionID: state.active_session_id,
            status: "cancelled",
          })
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            type: "cancelled",
            sessionID: state.active_session_id,
          })
          writeRoundResult({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            status: "cancelled",
            loopPhase: "stopped",
            failure: { status: "cancelled" },
            reviewMarker: state.last_review_marker,
            plannerBackend: state.planner_backend,
            plannerModel: plannerModelFromState(state, cfg),
            reviewerBackend: state.reviewer_backend,
            reviewerModel: reviewerModelFromState(state, cfg),
            metrics: roundMetrics(loop.loopDir, state.current_round, undefined, state.last_review_marker),
          })
          return `PACT loop cancelled: ${loop.loopDir}`
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (processingIdle) return

      const sessionID = eventSessionID(event)
      const loop = findActiveLoop(projectRoot)
      if (!loop) return

      let state = readState(loop.loopDir)
      if (state.round_boundary === "run_exit") return
      if (shouldBindIdleSession(loop.loopDir, state, sessionID)) {
        state = bindRoundSession(loop.loopDir, sessionID)
      }
      if (state.active_round_session_id && sessionID && state.active_round_session_id !== sessionID) return
      if (state.session_strategy === "new-per-round" && sessionID && !state.active_round_session_id) return

      const round = state.current_round
      if (state.phase === "finalize") {
        await handleFinalizeIdle({
          client: promptClient,
          cfg,
          projectRoot,
          loopDir: loop.loopDir,
          state,
          round,
        })
        return
      }
      const currentSummaryPath = summaryPath(loop.loopDir, round)
      const reviewPath = join(loop.loopDir, `round-${roundName(round)}-review.md`)
      if (existsSync(reviewPath)) return

      if (!existsSync(currentSummaryPath)) {
        const reminderPath = join(loop.loopDir, `round-${roundName(round)}-summary-reminder.md`)
        if (!existsSync(reminderPath)) {
          writeRoundState({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round,
            phase: "summary_missing",
            loopPhase: state.phase,
            sessionID: state.active_session_id,
            status: state.status,
            notes: `Missing round summary at ${currentSummaryPath}`,
          })
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round,
            type: "summary_missing",
            sessionID: state.active_session_id,
            data: { summary_path: currentSummaryPath },
          })
          writeRoundResult({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round,
            status: state.status,
            loopPhase: state.phase,
            failure: { missing_summary: true },
            reviewMarker: state.last_review_marker,
            plannerBackend: state.planner_backend,
            plannerModel: plannerModelFromState(state, cfg),
            reviewerBackend: state.reviewer_backend,
            reviewerModel: reviewerModelFromState(state, cfg),
            metrics: roundMetrics(loop.loopDir, round, undefined, state.last_review_marker),
          })
        }
        if (!existsSync(reminderPath) && state.active_session_id) {
          writeFileSync(reminderPath, `Reminder sent for missing round ${round} summary.\n`, "utf-8")
          await promptSession(
            promptClient,
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
        let workingState = state
        const reviewedSessionID = workingState.active_round_session_id ?? workingState.active_session_id
        const reviewKind = reviewKindForState(workingState, round)
        if (reviewKind === "full_alignment" && workingState.phase !== "full_alignment") {
          workingState.phase = "full_alignment"
          writeState(loop.loopDir, workingState)
        }
        let patchArtifact: PatchArtifact
        let verification: RoundVerificationArtifact | undefined
        try {
          patchArtifact = capturePatchArtifact({
            projectRoot,
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
          })
          writeRoundState({
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
            phase: "patch_captured",
            loopPhase: workingState.phase,
            sessionID: workingState.active_session_id,
            status: workingState.status,
          })
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
            type: "patch_captured",
            sessionID: workingState.active_session_id,
            data: {
              empty: patchArtifact.eval_patch.empty,
              changed_files: patchArtifact.eval_patch.changed_files,
              apply_check: patchArtifact.checks.apply_check.status,
            },
          })
          writeRoundSnapshot({
            projectRoot,
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
            stage: "post",
          })
          const verificationState = readState(loop.loopDir)
          verification = runVerificationCommand({
            cfg: verificationConfigForState(verificationState, cfg),
            projectRoot,
            loopDir: loop.loopDir,
            round,
            patchArtifact,
            source: "lightweight",
          })
          if (verification) {
            workingState = readState(loop.loopDir)
            workingState.last_verification_status = verification.status
            workingState.last_verification_build_status = verification.build_status
            if (verificationPassed(verification)) {
              workingState.latest_build_success_round ??= round
            }
            writeState(loop.loopDir, workingState)
            appendRoundEvent({
              loopDir: loop.loopDir,
              loopID: workingState.loop_id,
              round,
              type: "patch_captured",
              sessionID: workingState.active_session_id,
              data: {
                verification_status: verification.status,
                build_status: verification.build_status,
                failure_signature: verification.failure_signature,
              },
            })
          }
        } catch (err) {
          workingState.status = "stopped"
          workingState.phase = "stopped"
          writeState(loop.loopDir, workingState)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
            type: "patch_captured",
            sessionID: workingState.active_session_id,
            data: { status: "failed", error: redactText(safeUnknownText(err)) },
          })
          writeRoundState({
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
            phase: "round_finished",
            loopPhase: "stopped",
            sessionID: workingState.active_session_id,
            status: "stopped",
            notes: "Patch capture failed; loop stopped to avoid retrying the same failure.",
          })
          writeRoundResult({
            loopDir: loop.loopDir,
            loopID: workingState.loop_id,
            round,
            status: "stopped",
            loopPhase: "stopped",
            failure: { malformed_patch: true },
            reviewMarker: workingState.last_review_marker,
            plannerBackend: workingState.planner_backend,
            plannerModel: plannerModelFromState(workingState, cfg),
            reviewerBackend: workingState.reviewer_backend,
            reviewerModel: reviewerModelFromState(workingState, cfg),
            metrics: roundMetrics(loop.loopDir, round, undefined, workingState.last_review_marker),
          })
          return
        }
        writeRoundState({
          loopDir: loop.loopDir,
          loopID: workingState.loop_id,
          round,
          phase: "review_started",
          loopPhase: workingState.phase,
          sessionID: workingState.active_session_id,
          status: workingState.status,
        })
        appendRoundEvent({
          loopDir: loop.loopDir,
          loopID: workingState.loop_id,
          round,
          type: "review_started",
          sessionID: workingState.active_session_id,
          data: { summary_path: currentSummaryPath, review_kind: reviewKind },
        })
        const reviewPrompt = buildReviewPrompt({
          loopDir: loop.loopDir,
          round,
          summaryPath: currentSummaryPath,
          summary,
          evalPatchPath: patchArtifact.eval_patch.path,
          patchArtifactPath: join(loop.loopDir, `round-${roundName(round)}-patch-artifact.json`),
          verificationPath: verification ? artifactPaths(loop.loopDir, round).verification : undefined,
          reviewKind,
        })
        writeFileSync(join(loop.loopDir, `round-${roundName(round)}-review-prompt.md`), reviewPrompt, "utf-8")
        let reviewText: string
        const reviewerModel = reviewerModelFromState(workingState, cfg)
        try {
          reviewText =
            workingState.reviewer_backend === "codex-cli"
              ? invokeCodexReviewer(reviewPrompt, { ...cfg, reviewerModel: reviewerModel ?? undefined }, projectRoot)
              : await invokeOpenCodeAgent(promptClient, {
                  agent: cfg.reviewerAgent,
                  title: `PACT review round ${roundName(round)}`,
                  prompt: reviewPrompt,
                  parentSessionID: workingState.active_session_id,
                })
        } catch (err) {
          const failure = reviewerFailureForError(err)
          const failureCategory = classifyRoundFailure(failure)
          const parseStatus = failureCategory === "agent_timeout" ? "reviewer_timeout" : "reviewer_failed"
          const decision = recordFailedReviewDecision({
            loopDir: loop.loopDir,
            round,
            parseStatus,
            reviewerBackend: workingState.reviewer_backend,
            reviewerModel,
            error: err,
          })
          const failedState = readState(loop.loopDir)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: failedState.loop_id,
            round,
            type: "review_finished",
            sessionID: failedState.active_session_id,
            data: {
              status: "failed",
              parse_status: parseStatus,
              failure_category: failureCategory,
              error: String(err),
            },
          })
          writeRoundState({
            loopDir: loop.loopDir,
            loopID: failedState.loop_id,
            round,
            phase: "round_finished",
            loopPhase: failedState.phase,
            sessionID: failedState.active_session_id,
            status: failedState.status,
          })
          writeRoundResult({
            loopDir: loop.loopDir,
            loopID: failedState.loop_id,
            round,
            status: failedState.status,
            loopPhase: failedState.phase,
            failure,
            reviewMarker: decision.marker,
            plannerBackend: failedState.planner_backend,
            plannerModel: plannerModelFromState(failedState, cfg),
            reviewerBackend: failedState.reviewer_backend,
            reviewerModel,
            metrics: roundMetrics(loop.loopDir, round, patchArtifact, decision.marker),
          })
          ensureReplayRoundInputs({ loopDir: loop.loopDir, state: failedState, round, cfg })
          try {
            writeRoundTrajectory({
              loopDir: loop.loopDir,
              loopID: failedState.loop_id,
              round,
              sessionID: failedState.active_round_session_id ?? failedState.active_session_id,
              entries: [{ type: "reviewer_failure", text: String(err) }],
              mode: failedState.trajectory_mode,
            })
            writeRoundEvidence({ loopDir: loop.loopDir, round })
            exportReplayCase({ loopDir: loop.loopDir, round })
            appendRoundEvent({
              loopDir: loop.loopDir,
              loopID: failedState.loop_id,
              round,
              type: "replay_exported",
              sessionID: failedState.active_session_id,
              data: { replay_case: join(loop.loopDir, "replay-case.json") },
            })
          } catch (replayError) {
            appendRoundEvent({
              loopDir: loop.loopDir,
              loopID: failedState.loop_id,
              round,
              type: "replay_exported",
              sessionID: failedState.active_session_id,
              data: { status: "failed", error: String(replayError) },
            })
          }
          return
        }
        applyApprovedGoalTrackerUpdates({
          loopDir: loop.loopDir,
          round,
          reviewText,
          summaryText: summary,
        })
        const decision = recordReviewDecision({
          loopDir: loop.loopDir,
          round,
          reviewText,
          reviewerBackend: workingState.reviewer_backend,
          reviewerModel,
          forceContinue:
            patchArtifact.checks.apply_check.status === "failed"
              ? {
                  parseStatus: "patch_apply_failed",
                  reason: "patch_apply_check_failed",
                  feedback: `PACT patch apply check failed. Fix the patch before completion can be accepted.\n\n${patchArtifact.checks.apply_check.stderr ?? ""}`,
                }
              : verification && !verificationPassed(verification)
                ? {
                    parseStatus: "build_gate_failed",
                    reason: "build_gate_failed",
                    feedback: buildGateFeedback(verification),
                    verification,
                  }
              : undefined,
        })

        const nextState = readState(loop.loopDir)
        if (nextState.status === "stopped" && verification && !verificationPassed(verification)) {
          nextState.stop_reason = "max_rounds_without_build_success"
          writeState(loop.loopDir, nextState)
        }
        if (decision.marker === "continue") {
          writeContinuationPackage({
            loopDir: loop.loopDir,
            round,
            nextRound: nextState.current_round,
            maxRounds: nextState.max_rounds,
            workerRoundCount: nextState.worker_round_count ?? 0,
            loopPhase: nextState.phase,
            reviewText,
            verification,
            changedFiles: patchArtifact.eval_patch.changed_files,
            patchSha256: patchArtifact.eval_patch.sha256,
            feedbackPath: nextState.last_feedback_path,
          })
        }
          writeRoundState({
            loopDir: loop.loopDir,
            loopID: nextState.loop_id,
            round,
            phase: "round_finished",
            loopPhase: nextState.phase,
            sessionID: reviewedSessionID,
            status: nextState.status,
          })
        appendRoundEvent({
          loopDir: loop.loopDir,
            loopID: nextState.loop_id,
            round,
            type: "review_finished",
            sessionID: reviewedSessionID,
            data: { marker: decision.marker, parse_status: decision.parseStatus, resulting_phase: nextState.phase },
          })
        appendRoundEvent({
          loopDir: loop.loopDir,
            loopID: nextState.loop_id,
            round,
            type: "round_finished",
            sessionID: reviewedSessionID,
            data: { status: nextState.status, phase: nextState.phase },
          })
        writeRoundResult({
          loopDir: loop.loopDir,
          loopID: nextState.loop_id,
          round,
          status: nextState.status,
          loopPhase: nextState.phase,
          failure: roundFailure(decision.marker, nextState.status, round, nextState.max_rounds, patchArtifact, verification),
          reviewMarker: decision.marker,
          plannerBackend: nextState.planner_backend,
          plannerModel: plannerModelFromState(nextState, cfg),
          reviewerBackend: nextState.reviewer_backend,
          reviewerModel,
          metrics: roundMetrics(loop.loopDir, round, patchArtifact, decision.marker),
        })
        try {
          writeRoundTrajectory({
            loopDir: loop.loopDir,
            loopID: nextState.loop_id,
            round,
            sessionID: nextState.previous_round_session_id ?? nextState.active_round_session_id ?? nextState.active_session_id,
            mode: nextState.trajectory_mode,
          })
          writeRoundEvidence({ loopDir: loop.loopDir, round })
          exportReplayCase({ loopDir: loop.loopDir, round })
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: nextState.loop_id,
            round,
            type: "replay_exported",
            sessionID: reviewedSessionID,
            data: { replay_case: join(loop.loopDir, "replay-case.json") },
          })
        } catch (err) {
          appendRoundEvent({
            loopDir: loop.loopDir,
              loopID: nextState.loop_id,
              round,
              type: "replay_exported",
              sessionID: reviewedSessionID,
              data: { status: "failed", error: String(err) },
            })
        }
        await maybePromptNextPhase(promptClient, cfg, loop.loopDir, nextState, round)
      } finally {
        processingIdle = false
      }
    },

    "tool.execute.before": async (input, output) => {
      const args = output?.args ?? {}
      const loop =
        claimRoundSessionFromExpectedWrite(projectRoot, input.sessionID, input.tool, args) ??
        claimRoundSessionFromFirstWorkerEvent(projectRoot, input.sessionID) ??
        matchingActiveLoop(projectRoot, input.sessionID)
      if (loop) {
        const state = readState(loop.loopDir)
        appendRoundEvent({
          loopDir: loop.loopDir,
          loopID: state.loop_id,
          round: state.current_round,
          type: "tool_before",
          sessionID: input.sessionID,
          data: {
            tool: input.tool,
            call_id: input.callID,
            args: summarizeToolArgs(args),
          },
        })
      }
      const networkBlock = cfg.benchmarkStrictNetwork ? benchmarkNetworkBlock(input.tool, args) : undefined
      if (networkBlock) {
        if (loop) {
          const state = readState(loop.loopDir)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            type: "tool_before",
            sessionID: input.sessionID,
            data: {
              tool: input.tool,
              call_id: input.callID,
              status: "blocked",
              reason: "benchmark_strict_network",
              host: networkBlock.host,
            },
          })
        }
        throw new Error(`[PACT] blocked benchmark network access to ${networkBlock.host}`)
      }
      const commandBlock = cfg.benchmarkStrictNetwork ? benchmarkCommandBlock(projectRoot, input.tool, args) : undefined
      if (commandBlock) {
        if (loop) {
          const state = readState(loop.loopDir)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            type: "tool_before",
            sessionID: input.sessionID,
            data: {
              tool: input.tool,
              call_id: input.callID,
              status: "blocked",
              reason: commandBlock.reason,
              tests: commandBlock.tests,
              target: commandBlock.target,
            },
          })
        }
        if (commandBlock.reason === "benchmark_strict_broad_cpython_tests") {
          throw new Error(
            "[PACT] blocked broad CPython test command; run focused, bounded tests only in benchmark mode.",
          )
        }
        if (commandBlock.reason === "benchmark_strict_external_path") {
          throw new Error("[PACT] blocked workspace-external file access in benchmark mode.")
        }
        throw new Error(
          "[PACT] blocked benchmark-owned command; PACT owns patch export, git index state, and authoritative gates.",
        )
      }
      const pathBlock = cfg.benchmarkStrictNetwork ? benchmarkPathBlock(projectRoot, input.tool, args) : undefined
      if (pathBlock) {
        if (loop) {
          const state = readState(loop.loopDir)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            type: "tool_before",
            sessionID: input.sessionID,
            data: {
              tool: input.tool,
              call_id: input.callID,
              status: "blocked",
              reason: pathBlock.reason,
              path: pathBlock.path,
            },
          })
        }
        throw new Error("[PACT] blocked workspace-external file access in benchmark mode.")
      }
      const pactArtifactBlock = cfg.benchmarkStrictNetwork
        ? benchmarkPactArtifactReadBlock(projectRoot, input.tool, args)
        : undefined
      if (pactArtifactBlock) {
        if (loop) {
          const state = readState(loop.loopDir)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            type: "tool_before",
            sessionID: input.sessionID,
            data: {
              tool: input.tool,
              call_id: input.callID,
              status: "blocked",
              reason: pactArtifactBlock.reason,
              path: pactArtifactBlock.path,
            },
          })
        }
        throw new Error("[PACT] blocked reviewer-only PACT artifact; read only worker-safe PACT artifacts in benchmark mode.")
      }
      const toolBlock = cfg.benchmarkStrictNetwork ? benchmarkToolBlock(input.tool) : undefined
      if (toolBlock) {
        if (loop) {
          const state = readState(loop.loopDir)
          appendRoundEvent({
            loopDir: loop.loopDir,
            loopID: state.loop_id,
            round: state.current_round,
            type: "tool_before",
            sessionID: input.sessionID,
            data: {
              tool: input.tool,
              call_id: input.callID,
              status: "blocked",
              reason: toolBlock.reason,
            },
          })
        }
        throw new Error(
          "[PACT] benchmark mode blocks task/subagent delegation; do the work in the active session for observable replay.",
        )
      }
      if (!isFileWriteTool(input.tool)) return
      const filePaths = fileToolPaths(input.tool, args)
      if (!filePaths.length) return
      for (const filePath of filePaths) {
        const absolute = resolveProjectPath(projectRoot, filePath)
        const scaffoldingBlock = cfg.benchmarkStrictNetwork
          ? benchmarkScaffoldingPatchWriteBlock(projectRoot, absolute)
          : undefined
        if (scaffoldingBlock) {
          if (loop) {
            const state = readState(loop.loopDir)
            appendRoundEvent({
              loopDir: loop.loopDir,
              loopID: state.loop_id,
              round: state.current_round,
              type: "tool_before",
              sessionID: input.sessionID,
              data: {
                tool: input.tool,
                call_id: input.callID,
                status: "blocked",
                reason: scaffoldingBlock.reason,
                path: scaffoldingBlock.path,
              },
            })
          }
          throw new Error("[PACT] blocked benchmark-owned patch file; PACT owns patch export.")
        }
        if (isProtectedWrite(absolute)) {
          throw new Error(`[PACT] Protected ledger file cannot be modified by the worker: ${filePath}`)
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const loop = matchingActiveLoop(projectRoot, input.sessionID)
      if (!loop) return
      const state = readState(loop.loopDir)
      appendRoundEvent({
        loopDir: loop.loopDir,
        loopID: state.loop_id,
        round: state.current_round,
        type: "tool_after",
        sessionID: input.sessionID,
        data: {
          tool: input.tool,
          call_id: input.callID,
          args: summarizeToolArgs(input.args),
          output: summarizeToolOutput(output),
        },
      })
    },
  }
}

function ensureReplayRoundInputs(input: {
  loopDir: string
  state: PactState
  round: number
  cfg: PactPluginOptions
}): void {
  const promptPath = join(input.loopDir, `round-${roundName(input.round)}-prompt.md`)
  if (!existsSync(promptPath)) {
    writeFileSync(
      promptPath,
      `# PACT Round ${roundName(input.round)}\n\nPrompt was not captured before reviewer failure.\n`,
      "utf-8",
    )
  }
  const contextPath = join(input.loopDir, `round-${roundName(input.round)}-context.json`)
  if (existsSync(contextPath)) return
  const feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
  writeRoundContext({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.round,
    sessionID: input.state.active_session_id,
    workerAgent: input.cfg.workerAgent ?? PACT_PLUGIN_DEFAULTS.workerAgent,
    workerBackend: input.state.worker_backend ?? input.cfg.workerBackend,
    workerModel: input.state.worker_model ?? input.cfg.workerModel,
    workerConfigSource: input.state.worker_config_source ?? input.cfg.workerConfigSource,
    loopPhase: input.state.phase,
    plannerBackend: input.state.planner_backend,
    plannerModel: plannerModelFromState(input.state, input.cfg),
    reviewerBackend: input.state.reviewer_backend,
    reviewerModel: reviewerModelFromState(input.state, input.cfg),
    promptPath,
    todoPath: join(input.loopDir, "todo.md"),
    goalTrackerPath: join(input.loopDir, "goal-tracker.md"),
    feedbackPath: existsSync(feedbackPath) ? feedbackPath : undefined,
  })
}

function writeRoundStartArtifacts(input: {
  loopDir: string
  loopID: string
  round: number
  prompt: string
  sessionID?: string
  workerAgent: string
  workerBackend?: string
  workerModel?: string | null
  workerConfigSource?: string | null
  loopPhase?: LoopPhase
  plannerBackend?: PlannerBackend
  plannerModel?: string | null
  reviewerBackend: ReviewerBackend
  reviewerModel?: string | null
  feedbackPath?: string
}): void {
  const promptPath = join(input.loopDir, `round-${roundName(input.round)}-prompt.md`)
  writeFileSync(promptPath, input.prompt, "utf-8")
  writeRoundState({
    loopDir: input.loopDir,
    loopID: input.loopID,
    round: input.round,
    phase: "round_started",
    loopPhase: input.loopPhase,
    sessionID: input.sessionID,
    status: "running",
  })
  writeRoundContext({
    loopDir: input.loopDir,
    loopID: input.loopID,
    round: input.round,
    sessionID: input.sessionID,
    workerAgent: input.workerAgent,
    workerBackend: input.workerBackend,
    workerModel: input.workerModel,
    workerConfigSource: input.workerConfigSource,
    loopPhase: input.loopPhase,
    plannerBackend: input.plannerBackend,
    plannerModel: input.plannerModel,
    reviewerBackend: input.reviewerBackend,
    reviewerModel: input.reviewerModel,
    promptPath,
    todoPath: join(input.loopDir, "todo.md"),
    goalTrackerPath: join(input.loopDir, "goal-tracker.md"),
    feedbackPath: input.feedbackPath,
  })
  appendRoundEvent({
    loopDir: input.loopDir,
    loopID: input.loopID,
    round: input.round,
    type: "round_started",
    sessionID: input.sessionID,
    data: {
      prompt_path: promptPath,
      feedback_path: input.feedbackPath,
      phase: input.loopPhase,
      worker_backend: input.workerBackend,
      worker_model: input.workerModel,
      worker_config_source: input.workerConfigSource,
    },
  })
}

function matchingActiveLoop(projectRoot: string, sessionID?: string) {
  const loop = findActiveLoop(projectRoot)
  if (!loop) return undefined
  const state = readState(loop.loopDir)
  if (state.active_round_session_id && sessionID && state.active_round_session_id !== sessionID) return undefined
  if (sessionID && (state.active_round_session_id === sessionID || state.active_session_id === sessionID)) return loop
  if (!sessionID && state.session_strategy !== "new-per-round") return loop
  if (state.session_strategy === "new-per-round") return undefined
  return loop
}

function claimRoundSessionFromExpectedWrite(
  projectRoot: string,
  sessionID: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (!sessionID || !isFileWriteTool(toolName)) return undefined
  const loop = findActiveLoop(projectRoot)
  if (!loop) return undefined
  const state = readState(loop.loopDir)
  if (state.session_strategy !== "new-per-round") return undefined
  if (state.active_round_session_id) return undefined
  const expectedPath =
    state.phase === "finalize" ? join(loop.loopDir, "finalize-summary.md") : summaryPath(loop.loopDir, state.current_round)
  const writesExpectedSummary = fileToolPaths(toolName, args).some(
    (filePath) => resolveProjectPath(projectRoot, filePath) === expectedPath,
  )
  if (!writesExpectedSummary) return undefined
  const nextState = bindRoundSession(loop.loopDir, sessionID)
  return nextState.active_round_session_id === sessionID ? loop : undefined
}

function claimRoundSessionFromFirstWorkerEvent(projectRoot: string, sessionID: string | undefined) {
  if (!sessionID) return undefined
  const loop = findActiveLoop(projectRoot)
  if (!loop) return undefined
  const state = readState(loop.loopDir)
  if (state.session_strategy !== "new-per-round") return undefined
  if (state.active_round_session_id || state.active_session_id) return undefined
  const promptPath = join(loop.loopDir, `round-${roundName(state.current_round)}-prompt.md`)
  if (!existsSync(promptPath)) return undefined
  const nextState = bindRoundSession(loop.loopDir, sessionID)
  return nextState.active_round_session_id === sessionID ? loop : undefined
}

function shouldBindIdleSession(loopDir: string, state: PactState, sessionID?: string): boolean {
  if (!sessionID) return false
  if (state.session_strategy !== "new-per-round") return true
  if (state.active_round_session_id) return true
  if (state.phase === "finalize") return existsSync(join(loopDir, "finalize-summary.md"))
  return existsSync(summaryPath(loopDir, state.current_round))
}

async function maybePromptNextPhase(
  client: PromptClient,
  cfg: PactPluginOptions,
  loopDir: string,
  state: PactState,
  reviewedRound: number,
): Promise<void> {
  if (state.status !== "running") return
  const feedbackPath = join(loopDir, `round-${roundName(reviewedRound)}-feedback.md`)
  const goalTrackerPath = join(loopDir, "goal-tracker.md")
  let prompt: string | undefined
  if (state.phase === "finalize") {
    prompt = buildFinalizePrompt({ loopDir, round: state.current_round, goalTrackerPath })
  } else if (state.phase === "review") {
    prompt = buildReviewPhasePrompt({
      loopDir,
      round: state.current_round,
      feedbackPath,
      goalTrackerPath,
    })
  } else if (state.phase === "implementation") {
    const continuationPackagePath = artifactPaths(loopDir, reviewedRound).continuationPackage
    prompt = buildContinuationPrompt({
      loopDir,
      round: state.current_round,
      feedbackPath,
      goalTrackerPath,
      continuationPackagePath,
    })
  }
  if (!prompt) return
  const sessionID =
    state.session_strategy === "same-session" ? (state.active_round_session_id ?? state.active_session_id) : undefined
  writeRoundStartArtifacts({
    loopDir,
    loopID: state.loop_id,
    round: state.current_round,
    prompt,
    sessionID,
    workerAgent: cfg.workerAgent ?? PACT_PLUGIN_DEFAULTS.workerAgent,
    loopPhase: state.phase,
    plannerBackend: state.planner_backend,
    plannerModel: plannerModelFromState(state, cfg),
    reviewerBackend: state.reviewer_backend,
    reviewerModel: reviewerModelFromState(state, cfg),
    workerBackend: state.worker_backend ?? cfg.workerBackend,
    workerModel: state.worker_model ?? cfg.workerModel,
    workerConfigSource: state.worker_config_source ?? cfg.workerConfigSource,
    feedbackPath,
  })
  const manifestProjectRoot = objectProperty(
    JSON.parse(readFileSync(join(loopDir, "loop-manifest.json"), "utf-8")),
    "project_root",
  )
  if (typeof manifestProjectRoot === "string") {
    writeRoundSnapshot({
      projectRoot: manifestProjectRoot,
      loopDir,
      loopID: state.loop_id,
      round: state.current_round,
      stage: "pre",
    })
  }
  if (state.session_strategy === "same-session" && sessionID) {
    await promptSession(client, sessionID, cfg.workerAgent ?? PACT_PLUGIN_DEFAULTS.workerAgent, prompt)
  }
}

async function handleFinalizeIdle(input: {
  client: PromptClient
  cfg: PactPluginOptions
  projectRoot: string
  loopDir: string
  state: PactState
  round: number
}): Promise<void> {
  const finalizeSummaryPath = join(input.loopDir, "finalize-summary.md")
  const goalTrackerPath = join(input.loopDir, "goal-tracker.md")
  if (!existsSync(finalizeSummaryPath)) {
    const promptPath = join(input.loopDir, `round-${roundName(input.round)}-prompt.md`)
    if (!existsSync(promptPath) && input.state.active_session_id) {
      const prompt = buildFinalizePrompt({ loopDir: input.loopDir, round: input.round, goalTrackerPath })
      writeRoundStartArtifacts({
        loopDir: input.loopDir,
        loopID: input.state.loop_id,
        round: input.round,
        prompt,
        sessionID: input.state.active_session_id,
        workerAgent: input.cfg.workerAgent ?? PACT_PLUGIN_DEFAULTS.workerAgent,
        loopPhase: "finalize",
        plannerBackend: input.state.planner_backend,
        plannerModel: plannerModelFromState(input.state, input.cfg),
        reviewerBackend: input.state.reviewer_backend,
        reviewerModel: reviewerModelFromState(input.state, input.cfg),
        workerBackend: input.state.worker_backend ?? input.cfg.workerBackend,
        workerModel: input.state.worker_model ?? input.cfg.workerModel,
        workerConfigSource: input.state.worker_config_source ?? input.cfg.workerConfigSource,
      })
      await promptSession(
        input.client,
        input.state.active_session_id,
        input.cfg.workerAgent ?? PACT_PLUGIN_DEFAULTS.workerAgent,
        prompt,
      )
    }
    return
  }

  let finalizePatchArtifact: PatchArtifact | undefined
  let finalizeVerification: RoundVerificationArtifact | undefined
  const loopCfg = verificationConfigForState(input.state, input.cfg)
  if (loopCfg.verificationCommand) {
    finalizePatchArtifact = capturePatchArtifact({
      projectRoot: input.projectRoot,
      loopDir: input.loopDir,
      round: input.round,
    })
    finalizeVerification = runVerificationCommand({
      cfg: loopCfg,
      projectRoot: input.projectRoot,
      loopDir: input.loopDir,
      round: input.round,
      patchArtifact: finalizePatchArtifact,
      source: "finalize",
    })
    if (finalizeVerification) {
      input.state.last_verification_status = finalizeVerification.status
      input.state.last_verification_build_status = finalizeVerification.build_status
      if (verificationPassed(finalizeVerification)) {
        input.state.latest_build_success_round ??= input.round
      }
      appendRoundEvent({
        loopDir: input.loopDir,
        loopID: input.state.loop_id,
        round: input.round,
        type: "patch_captured",
        sessionID: input.state.active_round_session_id ?? input.state.active_session_id,
        data: {
          verification_status: finalizeVerification.status,
          build_status: finalizeVerification.build_status,
          failure_signature: finalizeVerification.failure_signature,
        },
      })
    }
    if (finalizeVerification && !verificationPassed(finalizeVerification)) {
      const feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
      const feedback = buildGateFeedback(finalizeVerification)
      writeFileSync(feedbackPath, feedback, "utf-8")
      const exhausted = (input.state.worker_round_count ?? 0) >= input.state.max_rounds
      input.state.previous_round_session_id = input.state.active_round_session_id ?? input.state.active_session_id
      input.state.active_round_session_id = undefined
      input.state.active_session_id = undefined
      input.state.last_feedback_path = feedbackPath
      input.state.status = exhausted ? "stopped" : "running"
      input.state.phase = exhausted ? "stopped" : "implementation"
      if (exhausted) {
        input.state.stop_reason = "max_rounds_without_build_success"
      } else {
        input.state.current_round = input.round + 1
      }
      writeState(input.loopDir, input.state)
      if (!exhausted) {
        writeContinuationPackage({
          loopDir: input.loopDir,
          round: input.round,
          nextRound: input.state.current_round,
          maxRounds: input.state.max_rounds,
          workerRoundCount: input.state.worker_round_count ?? 0,
          loopPhase: input.state.phase,
          reviewText: feedback,
          verification: finalizeVerification,
          changedFiles: finalizePatchArtifact.eval_patch.changed_files,
          patchSha256: finalizePatchArtifact.eval_patch.sha256,
          feedbackPath,
        })
      }
      writeRoundState({
        loopDir: input.loopDir,
        loopID: input.state.loop_id,
        round: input.round,
        phase: "round_finished",
        loopPhase: input.state.phase,
        sessionID: input.state.previous_round_session_id,
        status: input.state.status,
      })
      appendRoundEvent({
        loopDir: input.loopDir,
        loopID: input.state.loop_id,
        round: input.round,
        type: "round_finished",
        sessionID: input.state.previous_round_session_id,
        data: {
          status: input.state.status,
          phase: input.state.phase,
          reason: "build_gate_failed",
          verification: artifactPaths(input.loopDir, input.round).verification,
        },
      })
      writeRoundResult({
        loopDir: input.loopDir,
        loopID: input.state.loop_id,
        round: input.round,
        status: input.state.status,
        loopPhase: input.state.phase,
        failure: exhausted ? { max_rounds_without_build_success: true } : { build_gate_failed: true },
        reviewMarker: input.state.last_review_marker,
        plannerBackend: input.state.planner_backend,
        plannerModel: plannerModelFromState(input.state, input.cfg),
        reviewerBackend: input.state.reviewer_backend,
        reviewerModel: reviewerModelFromState(input.state, input.cfg),
        metrics: roundMetrics(input.loopDir, input.round, finalizePatchArtifact, input.state.last_review_marker),
      })
      writeRoundTrajectory({
        loopDir: input.loopDir,
        loopID: input.state.loop_id,
        round: input.round,
        sessionID: input.state.previous_round_session_id,
        mode: input.state.trajectory_mode,
      })
      writeRoundEvidence({ loopDir: input.loopDir, round: input.round })
      try {
        exportReplayCase({ loopDir: input.loopDir, round: input.round })
      } catch {
        // Finalize has no reviewer decision artifact; keep verification/result artifacts authoritative.
      }
      if (!exhausted) {
        await maybePromptNextPhase(input.client, input.cfg, input.loopDir, input.state, input.round)
      }
      return
    }
  }

  input.state.status = "complete"
  input.state.phase = "complete"
  writeState(input.loopDir, input.state)
  writeFileSync(join(input.loopDir, "complete-state.md"), `PACT finalized after round ${input.round}.\n`, "utf-8")
  writeRoundState({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.round,
    phase: "round_finished",
    loopPhase: "complete",
    sessionID: input.state.active_session_id,
    status: "complete",
  })
  appendRoundEvent({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.round,
    type: "round_finished",
    sessionID: input.state.active_session_id,
    data: { status: "complete", phase: "complete", finalize_summary: finalizeSummaryPath },
  })
  writeRoundResult({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.round,
    status: "complete",
    loopPhase: "complete",
    failure: null,
    reviewMarker: input.state.last_review_marker,
    plannerBackend: input.state.planner_backend,
    plannerModel: plannerModelFromState(input.state, input.cfg),
    reviewerBackend: input.state.reviewer_backend,
    reviewerModel: reviewerModelFromState(input.state, input.cfg),
    metrics: roundMetrics(input.loopDir, input.round, finalizePatchArtifact, input.state.last_review_marker),
  })
  writeRoundTrajectory({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.round,
    sessionID: input.state.active_round_session_id ?? input.state.active_session_id,
    mode: input.state.trajectory_mode,
  })
  writeRoundEvidence({ loopDir: input.loopDir, round: input.round })
  try {
    exportReplayCase({ loopDir: input.loopDir, round: input.round })
  } catch {
    // Finalize may not have a patch artifact; the round result is still authoritative.
  }
}

function reviewKindForState(state: PactState, round: number): "implementation" | "full_alignment" | "review" {
  if (state.phase === "review") return "review"
  if (state.phase === "full_alignment") return "full_alignment"
  const interval = state.full_alignment_interval || 5
  const workerRound = (state.worker_round_count ?? Math.max(0, round - 1)) + 1
  if (state.phase === "implementation" && interval > 1 && workerRound > 0 && workerRound % interval === 0) {
    return "full_alignment"
  }
  return "implementation"
}

function roundFailure(
  marker: ReviewMarker,
  status: LoopStatus,
  round: number,
  maxRounds: number,
  patchArtifact: PatchArtifact,
  verification?: RoundVerificationArtifact,
): FailureClassificationInput | null {
  if (marker === "complete") return null
  if (status === "cancelled") return { status: "cancelled" }
  if (patchArtifact.checks.apply_check.status === "failed") return { patch_apply_status: "failed" }
  if (patchArtifact.eval_patch.empty) return { empty_patch: true }
  if (status === "stopped" && verification && !verificationPassed(verification)) {
    return { max_rounds_without_build_success: true }
  }
  if (status === "stopped" && marker === "continue" && round >= maxRounds) return { max_rounds_reached: true }
  return {}
}

function runVerificationCommand(input: {
  cfg: PactPluginOptions
  projectRoot: string
  loopDir: string
  round: number
  patchArtifact: PatchArtifact
  source: RoundVerificationArtifact["source"]
}): RoundVerificationArtifact | undefined {
  const command = input.cfg.verificationCommand
  if (!command) return undefined
  const started = Date.now()
  const paths = artifactPaths(input.loopDir, input.round)
  const result = spawnSync(command, {
    cwd: input.projectRoot,
    shell: true,
    encoding: "utf-8",
    timeout: input.cfg.verificationTimeoutMs ?? PACT_PLUGIN_DEFAULTS.verificationTimeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      PACT_LOOP_DIR: input.loopDir,
      PACT_ROUND: String(input.round),
      PACT_PATCH_PATH: input.patchArtifact.eval_patch.path,
      PACT_PATCH_ARTIFACT: paths.patchArtifact,
      PACT_VERIFICATION_PATH: paths.verification,
      PACT_VERIFICATION_LOG: paths.verificationLog,
      PACT_PROJECT_ROOT: input.projectRoot,
    },
  })
  const stdout = String(result.stdout ?? "")
  const stderr = String(result.stderr ?? "")
  const parsed = parseVerificationStdout(stdout)
  const timedOut = Boolean(result.error && /timed out|ETIMEDOUT/i.test(String(result.error)))
  const status =
    timedOut
      ? "timeout"
      : verificationStatusFrom(parsed.status, result.status)
  const logText = [
    parsed.rawJson ? "" : stdout,
    stderr,
    result.error ? String(result.error) : "",
  ]
    .filter(Boolean)
    .join("\n")
  return writeVerificationArtifact({
    loopDir: input.loopDir,
    round: input.round,
    command,
    status,
    exitCode: result.status,
    durationMs: Date.now() - started,
    patchSha256: input.patchArtifact.eval_patch.sha256,
    applied: parsed.applied,
    resolved: parsed.resolved,
    buildStatus: parsed.buildStatus,
    f2p: parsed.f2p,
    p2p: parsed.p2p,
    errorCategories: parsed.errorCategories,
    failureSignature: parsed.failureSignature,
    logText,
    source: input.source,
  })
}

function verificationPassed(verification: RoundVerificationArtifact): boolean {
  if (verification.status !== "passed") return false
  if (verification.applied === false) return false
  if (!verification.build_status) return true
  return ["success", "passed", "ok", "built"].includes(verification.build_status)
}

function buildGateFeedback(verification: RoundVerificationArtifact): string {
  return [
    "PACT build/eval gate failed. Completion is blocked until verification passes with build_status=success.",
    `Verification status: ${verification.status}`,
    verification.applied === undefined ? undefined : `Patch applied: ${verification.applied}`,
    verification.build_status ? `Build status: ${verification.build_status}` : undefined,
    verification.failure_signature ? `Failure signature: ${verification.failure_signature}` : undefined,
    verification.log_tail ? `\nLatest verification log tail:\n${verification.log_tail}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

function parseVerificationStdout(stdout: string): {
  rawJson?: Record<string, unknown>
  status?: unknown
  buildStatus?: string
  applied?: boolean
  resolved?: boolean
  f2p?: { passed: number; total: number }
  p2p?: { passed: number; total: number }
  errorCategories?: string[]
  failureSignature?: string
} {
  const text = stdout.trim()
  if (!text) return {}
  const candidate = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{") && line.endsWith("}"))
  if (!candidate) return {}
  try {
    const json = JSON.parse(candidate) as Record<string, unknown>
    const build = objectProperty(json, "build")
    return {
      rawJson: json,
      status: json.status,
      buildStatus: stringProperty(json, "build_status") ?? (isRecord(build) ? stringProperty(build, "status") : undefined),
      applied: booleanProperty(json, "applied"),
      resolved: booleanProperty(json, "resolved"),
      f2p: countsProperty(json, "f2p"),
      p2p: countsProperty(json, "p2p"),
      errorCategories: arrayStringProperty(json, "error_categories"),
      failureSignature: stringProperty(json, "failure_signature"),
    }
  } catch {
    return {}
  }
}

function verificationStatusFrom(status: unknown, exitStatus: number | null): RoundVerificationArtifact["status"] {
  if (status === "passed" || status === "success" || status === "ok") return "passed"
  if (status === "timeout") return "timeout"
  if (status === "infra_failed") return "infra_failed"
  if (status === "failed" || status === "failure") return "failed"
  return exitStatus === 0 ? "passed" : "failed"
}

function countsProperty(record: Record<string, unknown>, key: string): { passed: number; total: number } | undefined {
  const value = objectProperty(record, key)
  if (!isRecord(value)) return undefined
  const passed = numberProperty(value, "passed")
  const total = numberProperty(value, "total")
  if (passed === undefined || total === undefined) return undefined
  return { passed, total }
}

function arrayStringProperty(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function roundMetrics(
  loopDir: string,
  round: number,
  patchArtifact: PatchArtifact | undefined,
  reviewMarker: ReviewMarker | undefined,
): Record<string, string | number | boolean | null> {
  return {
    patch_empty: patchArtifact?.eval_patch.empty ?? null,
    workspace_patch_lines: patchArtifact?.workspace_patch.lines ?? null,
    eval_patch_lines: patchArtifact?.eval_patch.lines ?? null,
    changed_file_count: patchArtifact?.eval_patch.changed_files.length ?? null,
    tool_event_count: countToolEvents(loopDir, round),
    review_marker: reviewMarker ?? null,
  }
}

function countToolEvents(loopDir: string, round: number): number {
  const eventsPath = join(loopDir, `round-${roundName(round)}-events.jsonl`)
  if (!existsSync(eventsPath)) return 0
  return readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.includes('"type":"tool_')).length
}

const BENCHMARK_FORBIDDEN_HOSTS = [
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "gist.github.com",
  "objects.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "patch-diff.githubusercontent.com",
  "www.python.org",
  "python.org",
  "docs.python.org",
  "pypi.org",
  "files.pythonhosted.org",
  "pythonhosted.org",
] as const

function benchmarkNetworkBlock(tool: string, args: unknown): { host: string } | undefined {
  if (!["webfetch", "websearch", "bash"].includes(tool)) return undefined
  const text = collectStrings(args).join("\n")
  if (!text) return undefined
  const host = forbiddenBenchmarkHost(text)
  if (!host) return undefined
  return { host }
}

function benchmarkCommandBlock(
  projectRoot: string,
  tool: string,
  args: unknown,
): { reason: string; tests?: string[]; target?: string } | undefined {
  if (tool !== "bash") return undefined
  const command = shellCommandText(args)
  if (/\bgit\s+(?:add|reset|commit|stash|clean|checkout|switch)\b/i.test(command)) {
    return { reason: "benchmark_strict_git_index", target: "git-index" }
  }
  if (/\blolbench_eval\.py\b[\s\S]*\bpact-gate\b/i.test(command) || /\bpact-gate\b[\s\S]*\blolbench_eval\.py\b/i.test(command)) {
    return { reason: "benchmark_strict_pact_gate", target: "pact-gate" }
  }
  if (/\b(?:solution|test)\.patch\b/i.test(command)) {
    return { reason: "benchmark_strict_scaffolding_patch", target: "benchmark-patch-file" }
  }
  const externalPath = benchmarkShellExternalPath(projectRoot, command)
  if (externalPath) {
    return { reason: "benchmark_strict_external_path", target: externalPath }
  }
  if (!/(\bpython(?:\d+(?:\.\d+)?)?(?:\.exe)?\b|\b\.\/python(?:\.exe)?\b).*?\s-m\s+test\b/i.test(command)) {
    return undefined
  }
  const tests = Array.from(new Set(command.match(/\btest_[A-Za-z0-9_]+\b/g) ?? []))
  const hasHighRiskTest = tests.some((name) => HIGH_RISK_CPYTHON_TESTS.has(name))
  if (!hasHighRiskTest && tests.length > 0 && tests.length <= 6) return undefined
  return { reason: "benchmark_strict_broad_cpython_tests", tests }
}

function benchmarkShellExternalPath(projectRoot: string, command: string): string | undefined {
  if (!/\b(?:cat|sed|head|tail|grep|rg|ls|find|awk|perl)\b/.test(command)) return undefined
  const absolutePaths = command.match(/\/[^\s'"`|;&)]+/g) ?? []
  for (const rawPath of absolutePaths) {
    const absolutePath = rawPath.replace(/[,:.]+$/, "")
    if (isInsideProject(projectRoot, absolutePath)) continue
    if (absolutePath.includes("/LoLBench/") || absolutePath.endsWith("/lolbench_eval.py")) {
      return basename(absolutePath) || absolutePath
    }
  }
  return undefined
}

const HIGH_RISK_CPYTHON_TESTS = new Set(["test_subprocess", "test_threading"])

const BENCHMARK_PATH_TOOLS = new Set(["read", "write", "edit", "grep", "glob"])

function benchmarkPathBlock(
  projectRoot: string,
  tool: string,
  args: unknown,
): { reason: string; path: string } | undefined {
  if (!BENCHMARK_PATH_TOOLS.has(tool)) return undefined
  const filePath = fileToolPath(args)
  if (!filePath) return undefined
  const absolute = resolveProjectPath(projectRoot, filePath)
  if (isInsideProject(projectRoot, absolute)) return undefined
  return { reason: "benchmark_strict_external_path", path: basename(absolute) || filePath }
}

function benchmarkPactArtifactReadBlock(
  projectRoot: string,
  tool: string,
  args: unknown,
): { reason: string; path: string } | undefined {
  if (tool === "bash") return benchmarkPactArtifactShellReadBlock(projectRoot, shellCommandText(args))
  if (!["read", "grep", "glob"].includes(tool)) return undefined
  const paths = fileToolPaths(tool, args)
  const text = collectStrings(args).join("\n")
  if (tool === "glob" && /\B\.pact(?:\/|$)|(?:^|\/)\.pact(?:\/|$)/.test(text)) {
    return { reason: "benchmark_strict_pact_artifact", path: ".pact" }
  }
  for (const filePath of paths) {
    const absolute = resolveProjectPath(projectRoot, filePath)
    if (!isInsideProject(projectRoot, absolute)) continue
    const relativePath = relative(projectRoot, absolute).replaceAll("\\", "/")
    if (relativePath === ".pact") return { reason: "benchmark_strict_pact_artifact", path: relativePath }
    if (!relativePath.startsWith(".pact/")) continue
    if (tool !== "read" || !isWorkerReadablePactArtifact(relativePath)) {
      return { reason: "benchmark_strict_pact_artifact", path: relativePath }
    }
  }
  return undefined
}

function benchmarkPactArtifactShellReadBlock(
  projectRoot: string,
  command: string,
): { reason: string; path: string } | undefined {
  if (!/\b(?:cat|sed|head|tail|grep|rg|ls|find|awk|perl)\b/.test(command)) return undefined
  if (!/(^|[\s'"`])\.pact(?:\/|[\s'"`]|$)/.test(command)) return undefined
  const absolutePaths = command.match(/\/[^\s'"`|;&)]+/g) ?? []
  for (const rawPath of absolutePaths) {
    const absolutePath = rawPath.replace(/[,:.]+$/, "")
    if (!isInsideProject(projectRoot, absolutePath)) continue
    const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/")
    if (relativePath.startsWith(".pact/") && !isWorkerReadablePactArtifact(relativePath)) {
      return { reason: "benchmark_strict_pact_artifact", path: relativePath }
    }
  }
  return { reason: "benchmark_strict_pact_artifact", path: ".pact" }
}

function isWorkerReadablePactArtifact(relativePath: string): boolean {
  return (
    /^\.pact\/loops\/[^/]+\/(?:plan|todo|goal-tracker|source-plan)\.md$/.test(relativePath) ||
    /^\.pact\/loops\/[^/]+\/round-\d+-(?:prompt|continuation-package|contract|summary)\.md$/.test(relativePath) ||
    /^\.pact\/loops\/[^/]+\/round-\d+-pre-snapshot\.json$/.test(relativePath)
  )
}

function benchmarkToolBlock(tool: string): { reason: string } | undefined {
  if (tool !== "task") return undefined
  return { reason: "benchmark_strict_task_delegation" }
}

function benchmarkScaffoldingPatchWriteBlock(
  projectRoot: string,
  absolutePath: string,
): { reason: string; path: string } | undefined {
  if (!isInsideProject(projectRoot, absolutePath)) return undefined
  const relativePath = relative(projectRoot, absolutePath)
  if (relativePath === "solution.patch" || relativePath === "test.patch") {
    return { reason: "benchmark_strict_scaffolding_patch", path: relativePath }
  }
  return undefined
}

function isFileWriteTool(tool: string): boolean {
  return tool === "write" || tool === "edit" || tool === "apply_patch"
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item))
  return Object.values(value).flatMap((item) => collectStrings(item))
}

function shellCommandText(args: unknown): string {
  const command = objectProperty(args, "command")
  if (typeof command === "string") return command
  return collectStrings(args).join("\n")
}

function fileToolPath(args: unknown): string | undefined {
  return fileToolPaths("write", args)[0]
}

function fileToolPaths(tool: string, args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return []
  if (tool === "apply_patch") {
    const patchText = objectProperty(args, "patchText")
    return patchToolPaths(typeof patchText === "string" ? patchText : "")
  }
  for (const key of ["filePath", "path", "file"]) {
    const value = objectProperty(args, key)
    if (typeof value === "string" && value.trim()) return [value]
  }
  return []
}

function eventSessionID(event: unknown): string | undefined {
  const nested = objectProperty(objectProperty(event, "properties"), "sessionID")
  if (typeof nested === "string") return nested
  const direct = objectProperty(event, "sessionID")
  return typeof direct === "string" ? direct : undefined
}

function objectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key]
  return typeof item === "string" ? item : undefined
}

function numberProperty(value: Record<string, unknown>, key: string): number | undefined {
  const item = value[key]
  return typeof item === "number" ? item : undefined
}

function booleanProperty(value: Record<string, unknown>, key: string): boolean | undefined {
  const item = value[key]
  return typeof item === "boolean" ? item : undefined
}

function patchToolPaths(patchText: string): string[] {
  const paths = new Set<string>()
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/.exec(line) ?? /^\*\*\* Move to:\s+(.+?)\s*$/.exec(line)
    if (match?.[1]) paths.add(match[1])
  }
  return [...paths]
}

function isInsideProject(projectRoot: string, absolutePath: string): boolean {
  const rel = relative(projectRoot, absolutePath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function forbiddenBenchmarkHost(text: string): string | undefined {
  const lower = text.toLowerCase()
  for (const host of BENCHMARK_FORBIDDEN_HOSTS) {
    const escaped = host.replaceAll(".", "\\.")
    const hostPattern = new RegExp(`(^|[^a-z0-9.-])${escaped}(:|/|\\b)`, "i")
    if (hostPattern.test(lower)) return host
  }
  return undefined
}

class CodexReviewerInvocationError extends Error {
  constructor(
    message: string,
    readonly failure: FailureClassificationInput,
  ) {
    super(message)
    this.name = "CodexReviewerInvocationError"
  }
}

async function invokePlannerBackend(input: {
  client: PromptClient
  cfg: PactPluginOptions
  plannerBackend: PlannerBackend
  plannerModel: string | null
  prompt: string
  projectRoot: string
  parentSessionID?: string
}): Promise<string> {
  if (input.plannerBackend === "codex-cli") {
    return invokeCodexPlanner(input.prompt, { ...input.cfg, plannerModel: input.plannerModel ?? undefined }, input.projectRoot)
  }
  return invokeOpenCodeAgent(input.client, {
    agent: input.cfg.plannerAgent ?? PACT_PLUGIN_DEFAULTS.plannerAgent,
    title: "PACT planner",
    prompt: input.prompt,
    parentSessionID: input.parentSessionID,
  })
}

function recordPlannerFailure(input: {
  loopDir: string
  state: PactState
  plannerBackend: PlannerBackend
  plannerModel: string | null
  validation?: PlannerValidationResult
  plannerOutput?: string
  error?: unknown
}): void {
  const state = input.state
  state.status = "stopped"
  state.phase = "stopped"
  writeState(input.loopDir, state)
  const detail = [
    "# PACT Planner Failed",
    "",
    `Backend: ${input.plannerBackend}`,
    `Model: ${input.plannerModel ?? "(unset)"}`,
    input.validation ? `Missing: ${input.validation.missing.join(", ") || "(none)"}` : undefined,
    input.validation ? `Errors: ${input.validation.errors.join("; ") || "(none)"}` : undefined,
    input.error ? `Error: ${redactText(safeUnknownText(input.error))}` : undefined,
    "",
    input.plannerOutput ? "## Planner Output\n" + redactText(input.plannerOutput) : undefined,
  ]
    .filter(Boolean)
    .join("\n")
  writeFileSync(join(input.loopDir, "planner-error.md"), detail.trim() + "\n", "utf-8")
  writeRoundState({
    loopDir: input.loopDir,
    loopID: state.loop_id,
    round: 0,
    phase: "round_finished",
    loopPhase: "stopped",
    sessionID: state.active_round_session_id ?? state.active_session_id,
    status: "stopped",
    notes: "Round 00 planner failed schema validation or invocation.",
  })
  writeRoundResult({
    loopDir: input.loopDir,
    loopID: state.loop_id,
    round: 0,
    status: "stopped",
    loopPhase: "stopped",
    failure: { planner_failed: true },
    plannerBackend: input.plannerBackend,
    plannerModel: input.plannerModel,
    reviewerBackend: state.reviewer_backend,
    reviewerModel: reviewerModelFromState(state, {}),
    metrics: {
      missing_count: input.validation?.missing.length ?? null,
      error_count: input.validation?.errors.length ?? null,
    },
    artifacts: {
      source_plan: join(input.loopDir, "source-plan.md"),
      planner_error: join(input.loopDir, "planner-error.md"),
    },
  })
}

function reviewerFailureForError(error: unknown): FailureClassificationInput {
  if (error instanceof CodexReviewerInvocationError) return error.failure
  return { reviewer_failed: true }
}

function plannerModelFromState(
  state: { planner_backend?: PlannerBackend; planner_model?: string | null },
  cfg: PactPluginOptions,
): string | null {
  const backend = state.planner_backend ?? cfg.plannerBackend ?? PACT_PLUGIN_DEFAULTS.plannerBackend
  return state.planner_model ?? plannerModelForBackend(backend, cfg)
}

function reviewerModelFromState(
  state: { reviewer_backend: ReviewerBackend; reviewer_model?: string | null },
  cfg: PactPluginOptions,
): string | null {
  return state.reviewer_model ?? reviewerModelForBackend(state.reviewer_backend, cfg)
}

function verificationConfigForState(state: PactState, cfg: PactPluginOptions): PactPluginOptions {
  return {
    ...cfg,
    verificationCommand: state.verification_command ?? cfg.verificationCommand,
    verificationTimeoutMs: state.verification_timeout_ms ?? cfg.verificationTimeoutMs,
  }
}

function plannerModelForBackend(backend: PlannerBackend, cfg: PactPluginOptions): string | null {
  if (backend !== "codex-cli") return null
  return codexModelFromArgs(cfg.plannerCodexArgs) ?? cfg.plannerModel ?? PACT_PLUGIN_DEFAULTS.plannerModel
}

function reviewerModelForBackend(backend: ReviewerBackend, cfg: PactPluginOptions): string | null {
  if (backend !== "codex-cli") return null
  return codexModelFromArgs(cfg.codexArgs) ?? cfg.reviewerModel ?? PACT_PLUGIN_DEFAULTS.reviewerModel
}

function codexModelFromArgs(args?: string[]): string | undefined {
  if (!args) return undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if ((arg === "-m" || arg === "--model") && args[index + 1]) return args[index + 1]
    if (arg?.startsWith("--model=")) return arg.slice("--model=".length)
  }
  return undefined
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function safeUnknownText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
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

export function invokeCodexPlanner(prompt: string, cfg: PactPluginOptions, projectRoot: string): string {
  const command = cfg.codexCommand ?? "codex"
  const model = plannerModelForBackend("codex-cli", cfg) ?? PACT_PLUGIN_DEFAULTS.plannerModel
  const args = cfg.plannerCodexArgs ?? defaultCodexExecArgs(model, projectRoot)
  const timeout = cfg.codexTimeoutMs ?? PACT_PLUGIN_DEFAULTS.codexTimeoutMs
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
  })
  if (result.error) {
    if (errorCode(result.error) === "ETIMEDOUT") {
      throw new Error(`Codex planner timed out after ${timeout}ms`)
    }
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Codex planner failed with status ${result.status}: ${result.stderr}`)
  }
  return result.stdout || result.stderr || "Codex planner returned no content."
}

export function invokeCodexReviewer(prompt: string, cfg: PactPluginOptions, projectRoot: string): string {
  const command = cfg.codexCommand ?? "codex"
  const model = reviewerModelForBackend("codex-cli", cfg) ?? PACT_PLUGIN_DEFAULTS.reviewerModel
  const args = cfg.codexArgs ?? defaultCodexExecArgs(model, projectRoot)
  const timeout = cfg.codexTimeoutMs ?? PACT_PLUGIN_DEFAULTS.codexTimeoutMs
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
  })
  if (result.error) {
    if (errorCode(result.error) === "ETIMEDOUT") {
      throw new CodexReviewerInvocationError(`Codex reviewer timed out after ${timeout}ms`, { timed_out: true })
    }
    throw result.error
  }
  if (result.status !== 0) {
    throw new CodexReviewerInvocationError(`Codex reviewer failed with status ${result.status}: ${result.stderr}`, {
      reviewer_failed: true,
    })
  }
  return result.stdout || result.stderr || "Codex reviewer returned no content."
}

function defaultCodexExecArgs(model: string, projectRoot: string): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="medium"',
    "-C",
    projectRoot,
    "-",
  ]
}

function extractTextParts(result: { data?: { parts?: Array<Record<string, unknown>> } }): string {
  const parts = result.data?.parts ?? []
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim()
  return text || "No text content returned by reviewer."
}

const PactPluginModule: PluginModule = {
  id: "pact",
  server: PactPlugin,
}

export default PactPluginModule
