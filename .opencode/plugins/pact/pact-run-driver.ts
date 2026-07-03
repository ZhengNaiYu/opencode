import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { spawnSync as nodeSpawnSync } from "node:child_process"
import { cwd, env, exit, argv } from "node:process"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import {
  appendRoundEvent,
  applyApprovedGoalTrackerUpdates,
  applyPlannerArtifacts,
  applyReviewStatusDelta,
  artifactPaths,
  buildInitialWorkerPrompt,
  buildContinuationPrompt,
  buildFinalizePrompt,
  buildPlannerPrompt,
  buildPlannerRepairPrompt,
  buildReviewPhasePrompt,
  buildReviewPrompt,
  capturePatchArtifact,
  commitRoundHistory,
  createLoop,
  exportReplayCase,
  extractReviewStatusDelta,
  findActiveLoop,
  ensureGitInfoExclude,
  markWorkerRoundAttempted,
  markWorkerRoundCompleted,
  parsePlannerArtifacts,
  readState,
  redactText,
  recordFailedReviewDecision,
  recordReviewDecision,
  roundName,
  summaryPath,
  writeContinuationPackage,
  writeRoundContext,
  writeRoundEvidence,
  writeRoundResult,
  writeRoundSnapshot,
  writeRoundState,
  writeRoundTrajectory,
  writeState,
  writeVerificationArtifact,
  type FailureClassificationInput,
  type LoopStatus,
  type PactState,
  type PatchArtifact,
  type PlannerBackend,
  type PlannerValidationResult,
  type RoundVerificationArtifact,
  type ReviewerBackend,
  type SessionStrategy,
  validatePlannerArtifacts,
} from "./pact-core"

const OPENCODE_RUN_MAX_BUFFER = 100 * 1024 * 1024

type SpawnResult = {
  status: number | null
  stdout?: string
  stderr?: string
  error?: Error
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { cwd: string; input: string; encoding: "utf-8"; stdio: Array<"inherit" | "pipe">; maxBuffer: number },
) => SpawnResult

type WorkerRunner = "host" | "docker"
type ResumeMode = "round0"

type PactDriverResult = {
  status: LoopStatus | "no_loop" | "opencode_failed" | "missing_prompt" | "max_invocations"
  invocations: number
  loopDir?: string
  round?: number
  exitCode: number
}

type DriverReviewer = (
  prompt: string,
  input: { projectRoot: string; loopDir: string; round: number; state: PactState },
) => string

type DriverPlanner = (
  prompt: string,
  input: { projectRoot: string; loopDir: string; planFile: string; state: PactState; repair: boolean },
) => string

export function buildPactStartPrompt(input: {
  planFile: string
  maxRounds: number
  plannerBackend?: string
  plannerModel?: string
  reviewerBackend?: string
  reviewerModel?: string
  workerModel: string
  fullAlignmentInterval?: number
  sessionStrategy?: SessionStrategy
  roundBoundary?: "run_exit" | "session_idle"
  verificationCommand?: string
  verificationTimeoutMs?: number
}): string {
  const verificationLines = [
    input.verificationCommand ? `- verification_command=${JSON.stringify(input.verificationCommand)}` : undefined,
    input.verificationTimeoutMs ? `- verification_timeout_ms=${input.verificationTimeoutMs}` : undefined,
  ].filter(Boolean)
  return `Call the pact-start-loop tool with:
- plan_file="${input.planFile}"
- max_rounds=${input.maxRounds}
- planner_backend=${input.plannerBackend ?? "codex-cli"}
- planner_model=${input.plannerModel ?? "gpt-5.5"}
- reviewer_backend=${input.reviewerBackend ?? "codex-cli"}
- reviewer_model=${input.reviewerModel ?? "gpt-5.4-mini"}
- worker_backend=opencode-cli
- worker_model=${input.workerModel}
- worker_config_source=mini-swe-agent-env
- session_strategy=${input.sessionStrategy ?? "new-per-round"}
- round_boundary=${input.roundBoundary ?? "run_exit"}
- trajectory_mode=full-redact
- full_alignment_interval=${input.fullAlignmentInterval ?? 5}
${verificationLines.length ? `${verificationLines.join("\n")}\n` : ""}

After the tool returns, execute the returned first worker checkpoint. Each opencode run process exit is the round boundary.
`
}

export function runPactDriver(input: {
  projectRoot?: string
  planFile: string
  model: string
  maxRounds: number
  opencodeCommand?: string
  dockerCommand?: string
  containerOpencodeCommand?: string
  agent?: string
  variant?: string
  workerRunner?: WorkerRunner
  workerContainerImage?: string
  workerContainerWorkspace?: string
  workerPluginMount?: string
  workerContainerPluginMount?: string
  plannerBackend?: PlannerBackend
  plannerModel?: string
  reviewerBackend?: ReviewerBackend
  reviewerModel?: string
  fullAlignmentInterval?: number
  maxInvocations?: number
  sessionStrategy?: SessionStrategy
  verificationCommand?: string
  verificationTimeoutMs?: number
  resumeLoopDir?: string
  resumeMode?: ResumeMode
  spawnSync?: SpawnSyncLike
  planner?: DriverPlanner
  reviewer?: DriverReviewer
  log?: (message: string) => void
}): PactDriverResult {
  const projectRoot = resolve(input.projectRoot ?? cwd())
  const spawn = input.spawnSync ?? defaultSpawnSync
  const maxInvocations = input.maxInvocations ?? input.maxRounds + 4
  const workerRunner = input.workerRunner ?? "host"
  const workerContainerImage = input.workerContainerImage ?? env.LOLBENCH_AGENT_IMAGE_TAG ?? env.LOLBENCH_IMAGE_TAG
  if (workerRunner === "docker" && !workerContainerImage) {
    const log = input.log ?? console.error
    log("PACT docker worker runner requires --worker-container-image or LOLBENCH_AGENT_IMAGE_TAG")
    return { status: "opencode_failed", invocations: 0, exitCode: 2 }
  }
  let invocations = 0
  const initialized = initializeDriverLoop({
    projectRoot,
    planFile: input.planFile,
    maxRounds: input.maxRounds,
    plannerBackend: input.plannerBackend ?? "codex-cli",
    plannerModel: input.plannerModel ?? "gpt-5.5",
    reviewerBackend: input.reviewerBackend ?? "codex-cli",
    reviewerModel: input.reviewerModel ?? "gpt-5.4-mini",
    workerModel: input.model,
    workerConfigSource: "mini-swe-agent-env",
    fullAlignmentInterval: input.fullAlignmentInterval,
    sessionStrategy: input.sessionStrategy,
    verificationCommand: input.verificationCommand,
    verificationTimeoutMs: input.verificationTimeoutMs,
    resumeLoopDir: input.resumeLoopDir,
    resumeMode: input.resumeMode,
    planner: input.planner,
  })
  let loopDir = initialized.loopDir
  if (initialized.state.status !== "running") {
    return {
      status: initialized.state.status,
      invocations,
      loopDir,
      round: initialized.state.next_round ?? initialized.state.current_round,
      exitCode: 0,
    }
  }
  let nextPrompt = readFileSync(
    join(loopDir, `round-${roundName(initialized.state.next_round ?? initialized.state.current_round)}-prompt.md`),
    "utf-8",
  )
  let sessionID: string | undefined
  let sessionStrategy: SessionStrategy = input.sessionStrategy ?? initialized.state.session_strategy ?? "new-per-round"
  let promptRound = initialized.state.next_round ?? initialized.state.current_round

  while (invocations < maxInvocations) {
    const invokedRound = promptRound
    markWorkerRoundAttempted(loopDir, invokedRound)
    const opencodeArgs = buildOpencodeRunArgs({
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      sessionID: sessionStrategy === "same-session" ? sessionID : undefined,
    })
    const invocation = buildWorkerInvocation({
      runner: workerRunner,
      opencodeCommand: input.opencodeCommand ?? "opencode",
      dockerCommand: input.dockerCommand ?? "docker",
      containerOpencodeCommand: input.containerOpencodeCommand ?? "opencode",
      opencodeArgs,
      projectRoot,
      containerImage: workerContainerImage,
      containerWorkspace: input.workerContainerWorkspace ?? "/workspace/pact-workspace",
      workerPluginMount: input.workerPluginMount,
      workerContainerPluginMount: input.workerContainerPluginMount ?? "/opt/opencode-pact-plugins",
    })
    const result = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      input: nextPrompt,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: OPENCODE_RUN_MAX_BUFFER,
    })
    invocations++
    if (result.error || result.status !== 0) {
      const log = input.log ?? console.error
      log(formatOpenCodeFailure({ command: invocation.command, args: invocation.args, result }))
      return { status: "opencode_failed", invocations, exitCode: result.status ?? 1 }
    }

    let state = readState(loopDir)
    writeRoundTrajectory({
      loopDir,
      loopID: state.loop_id,
      round: invokedRound,
      sessionID: state.previous_round_session_id ?? state.active_round_session_id ?? state.active_session_id,
      mode: state.trajectory_mode,
      entries: [
        {
          type: "driver_invocation",
          command: invocation.command,
          args: invocation.args,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        },
      ],
    })
    state = finalizeRoundAfterRunExit({
      projectRoot,
      loopDir,
      round: invokedRound,
      reviewer: input.reviewer,
      agent: input.agent,
      model: input.model,
    })
    if (state.status !== "running") {
      return { status: state.status, invocations, loopDir, round: state.next_round ?? state.current_round, exitCode: 0 }
    }

    sessionStrategy = input.sessionStrategy ?? state.session_strategy ?? "new-per-round"
    sessionID = state.active_round_session_id ?? state.active_session_id
    const promptPath = join(loopDir, `round-${roundName(state.next_round ?? state.current_round)}-prompt.md`)
    if (!existsSync(promptPath) || (sessionStrategy === "same-session" && !sessionID)) {
      return {
        status: "missing_prompt",
        invocations,
        loopDir,
        round: state.next_round ?? state.current_round,
        exitCode: 2,
      }
    }
    nextPrompt = readFileSync(promptPath, "utf-8")
    promptRound = state.next_round ?? state.current_round
  }

  return {
    status: "max_invocations",
    invocations,
    loopDir,
    round: readState(loopDir).next_round ?? readState(loopDir).current_round,
    exitCode: 3,
  }
}

function initializeDriverLoop(input: {
  projectRoot: string
  planFile: string
  maxRounds: number
  plannerBackend: PlannerBackend
  plannerModel: string | null
  reviewerBackend: ReviewerBackend
  reviewerModel: string | null
  workerModel: string
  workerConfigSource?: string
  fullAlignmentInterval?: number
  sessionStrategy?: SessionStrategy
  verificationCommand?: string
  verificationTimeoutMs?: number
  resumeLoopDir?: string
  resumeMode?: ResumeMode
  planner?: DriverPlanner
}): { loopDir: string; state: PactState } {
  if (input.resumeLoopDir) {
    return initializeDriverLoopFromRound0(input)
  }
  const loop = createLoop({
    projectRoot: input.projectRoot,
    planFile: input.planFile,
    maxRounds: input.maxRounds,
    plannerBackend: input.plannerBackend,
    plannerModel: input.plannerModel,
    reviewerBackend: input.reviewerBackend,
    reviewerModel: input.reviewerModel,
    workerBackend: "opencode-cli",
    workerModel: input.workerModel,
    workerConfigSource: input.workerConfigSource,
    sessionStrategy: input.sessionStrategy ?? "new-per-round",
    roundBoundary: "run_exit",
    trajectoryMode: "full-redact",
    fullAlignmentInterval: input.fullAlignmentInterval,
    verificationCommand: input.verificationCommand,
    verificationTimeoutMs: input.verificationTimeoutMs,
  })
  const planContent = readFileSync(join(loop.loopDir, "source-plan.md"), "utf-8")
  try {
    const plannerPrompt = buildPlannerPrompt({ planPath: input.planFile, planContent })
    writeFileSync(join(loop.loopDir, "round-00-plan-prompt.md"), plannerPrompt, "utf-8")
    let plannerText = invokeDriverPlanner(plannerPrompt, {
      projectRoot: input.projectRoot,
      loopDir: loop.loopDir,
      planFile: input.planFile,
      state: readState(loop.loopDir),
      model: input.plannerModel ?? "gpt-5.5",
      planner: input.planner,
      repair: false,
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
      plannerText = invokeDriverPlanner(repairPrompt, {
        projectRoot: input.projectRoot,
        loopDir: loop.loopDir,
        planFile: input.planFile,
        state: readState(loop.loopDir),
        model: input.plannerModel ?? "gpt-5.5",
        planner: input.planner,
        repair: true,
      })
      writeFileSync(join(loop.loopDir, "round-00-plan-repair-output.md"), redactText(plannerText), "utf-8")
      artifacts = parsePlannerArtifacts(plannerText)
      validation = validatePlannerArtifacts(artifacts)
    }
    if (!validation.ok) {
      recordDriverPlannerFailure({
        loopDir: loop.loopDir,
        state: readState(loop.loopDir),
        plannerBackend: input.plannerBackend,
        plannerModel: input.plannerModel,
        validation,
        plannerOutput: plannerText,
      })
      return { loopDir: loop.loopDir, state: readState(loop.loopDir) }
    }
    applyPlannerArtifacts(loop.loopDir, artifacts)
    commitRoundHistory(loop.loopDir, 0, "round-00 canonical planning")
  } catch (err) {
    recordDriverPlannerFailure({
      loopDir: loop.loopDir,
      state: readState(loop.loopDir),
      plannerBackend: input.plannerBackend,
      plannerModel: input.plannerModel,
      error: err,
    })
    return { loopDir: loop.loopDir, state: readState(loop.loopDir) }
  }

  const state = readState(loop.loopDir)
  const prompt = buildInitialWorkerPrompt({
    loopDir: loop.loopDir,
    round: 1,
    todoPath: join(loop.loopDir, "todo.md"),
    goalTrackerPath: join(loop.loopDir, "goal-tracker.md"),
    workerPath: workerPathRenderer(input.projectRoot),
  })
  writeFileSync(join(loop.loopDir, "round-01-prompt.md"), prompt, "utf-8")
  ensureDriverRoundStartArtifacts({
    projectRoot: input.projectRoot,
    loopDir: loop.loopDir,
    state,
    round: 1,
    model: input.workerModel,
  })
  return { loopDir: loop.loopDir, state: readState(loop.loopDir) }
}

function initializeDriverLoopFromRound0(input: {
  projectRoot: string
  planFile: string
  maxRounds: number
  plannerBackend: PlannerBackend
  plannerModel: string | null
  reviewerBackend: ReviewerBackend
  reviewerModel: string | null
  workerModel: string
  workerConfigSource?: string
  fullAlignmentInterval?: number
  sessionStrategy?: SessionStrategy
  verificationCommand?: string
  verificationTimeoutMs?: number
  resumeLoopDir?: string
  resumeMode?: ResumeMode
}): { loopDir: string; state: PactState } {
  if (input.resumeMode && input.resumeMode !== "round0") {
    throw new Error(`Unsupported PACT resume mode: ${input.resumeMode}`)
  }
  const sourceLoopDir = resolve(input.resumeLoopDir ?? "")
  validateRound0ResumeSource(sourceLoopDir)
  ensureGitInfoExclude(input.projectRoot, ".pact/")
  ensureGitInfoExclude(input.projectRoot, "/*.patch")
  ensureGitInfoExclude(input.projectRoot, "/*.diff")
  const sourceState = readState(sourceLoopDir)
  const sourceLoopID = sourceState.loop_id || basename(sourceLoopDir)
  const loopDir = allocateResumeLoopDir(input.projectRoot, sourceLoopID)
  const loopID = basename(loopDir)
  copyRound0ResumePackage(sourceLoopDir, loopDir)

  const now = new Date().toISOString()
  const state: PactState = {
    ...sourceState,
    version: 2,
    status: "running",
    phase: "implementation",
    loop_id: loopID,
    next_round: 1,
    current_round: 1,
    max_rounds: input.maxRounds,
    attempted_worker_rounds: 0,
    completed_worker_rounds: 0,
    reviewed_worker_rounds: 0,
    worker_round_count: 0,
    full_alignment_interval: Math.max(2, input.fullAlignmentInterval ?? sourceState.full_alignment_interval ?? 5),
    plan_file: input.planFile,
    source_plan_file: input.planFile,
    source_plan_path: join(loopDir, "source-plan.md"),
    active_session_id: undefined,
    active_round_session_id: undefined,
    previous_round_session_id: undefined,
    session_strategy: input.sessionStrategy ?? sourceState.session_strategy ?? "new-per-round",
    round_boundary: "run_exit",
    trajectory_mode: sourceState.trajectory_mode ?? "full-redact",
    planner_backend: sourceState.planner_backend ?? input.plannerBackend,
    planner_model: sourceState.planner_model === undefined ? input.plannerModel : sourceState.planner_model,
    reviewer_backend: input.reviewerBackend,
    reviewer_model: input.reviewerModel,
    worker_backend: "opencode-cli",
    worker_model: input.workerModel,
    worker_config_source: input.workerConfigSource,
    verification_command: input.verificationCommand,
    verification_timeout_ms: input.verificationTimeoutMs,
    created_at: now,
    updated_at: now,
    last_review_marker: undefined,
    last_review_path: undefined,
    last_feedback_path: undefined,
    latest_build_success_round: undefined,
    first_public_build_success_round: undefined,
    last_verification_status: undefined,
    last_verification_build_status: undefined,
    stop_reason: undefined,
  }
  writeState(loopDir, state)
  writeResumeManifest({
    loopDir,
    loopID,
    sourceLoopDir,
    sourceLoopID,
    projectRoot: input.projectRoot,
    planFile: input.planFile,
    state,
  })
  const prompt = buildInitialWorkerPrompt({
    loopDir,
    round: 1,
    todoPath: join(loopDir, "todo.md"),
    goalTrackerPath: join(loopDir, "goal-tracker.md"),
    workerPath: workerPathRenderer(input.projectRoot),
  })
  writeFileSync(join(loopDir, "round-01-prompt.md"), prompt, "utf-8")
  ensureDriverRoundStartArtifacts({
    projectRoot: input.projectRoot,
    loopDir,
    state,
    round: 1,
    model: input.workerModel,
  })
  commitRoundHistory(loopDir, 0, "round-00 resumed from existing canonical planning")
  return { loopDir, state: readState(loopDir) }
}

function validateRound0ResumeSource(loopDir: string): void {
  const required = [
    "state.json",
    "loop-manifest.json",
    "source-plan.md",
    "plan.md",
    "todo.md",
    "goal-tracker.md",
    "round-00-result.json",
  ]
  const missing = required.filter((fileName) => !existsSync(join(loopDir, fileName)))
  if (missing.length) {
    throw new Error(`PACT round0 resume source is incomplete: ${missing.join(", ")} missing in ${loopDir}`)
  }
}

function allocateResumeLoopDir(projectRoot: string, sourceLoopID: string): string {
  const loopsRoot = join(projectRoot, ".pact", "loops")
  mkdirSync(loopsRoot, { recursive: true })
  const base = `${sourceLoopID}-resume`
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? "" : `-${String(attempt).padStart(2, "0")}`
    const loopDir = join(loopsRoot, `${base}${suffix}`)
    if (!existsSync(loopDir)) {
      mkdirSync(loopDir, { recursive: true })
      return loopDir
    }
  }
}

function copyRound0ResumePackage(sourceLoopDir: string, targetLoopDir: string): void {
  for (const fileName of readdirSync(sourceLoopDir)) {
    const sourcePath = join(sourceLoopDir, fileName)
    const sourceStat = statSync(sourcePath)
    if (sourceStat.isDirectory()) {
      if (fileName === "spec-source") {
        copyDirectory(sourcePath, join(targetLoopDir, fileName))
      }
      continue
    }
    if (!sourceStat.isFile()) continue
    if (
      fileName === "source-plan.md" ||
      fileName === "plan.md" ||
      fileName === "todo.md" ||
      fileName === "goal-tracker.md" ||
      fileName.startsWith("spec-") ||
      fileName.startsWith("round-00-")
    ) {
      copyFileSync(sourcePath, join(targetLoopDir, fileName))
    }
  }
  copyFileSync(join(sourceLoopDir, "loop-manifest.json"), join(targetLoopDir, "resume-source-loop-manifest.json"))
}

function copyDirectory(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const fileName of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, fileName)
    const targetPath = join(targetDir, fileName)
    const sourceStat = statSync(sourcePath)
    if (sourceStat.isDirectory()) {
      copyDirectory(sourcePath, targetPath)
      continue
    }
    if (sourceStat.isFile()) copyFileSync(sourcePath, targetPath)
  }
}

function writeResumeManifest(input: {
  loopDir: string
  loopID: string
  sourceLoopDir: string
  sourceLoopID: string
  projectRoot: string
  planFile: string
  state: PactState
}): void {
  let sourceManifest: Record<string, unknown> = {}
  try {
    sourceManifest = JSON.parse(readFileSync(join(input.sourceLoopDir, "loop-manifest.json"), "utf-8"))
  } catch {
    sourceManifest = {}
  }
  const manifest = {
    ...sourceManifest,
    loop_id: input.loopID,
    project_root: input.projectRoot,
    plan_file: input.planFile,
    source_plan_path: join(input.loopDir, "source-plan.md"),
    resume_mode: "round0",
    resume_source_loop: input.sourceLoopDir,
    resume_source_loop_id: input.sourceLoopID,
    round0_reused: true,
    max_rounds: input.state.max_rounds,
    next_round: input.state.next_round,
    current_round_deprecated_alias: input.state.current_round,
    attempted_worker_rounds: input.state.attempted_worker_rounds,
    completed_worker_rounds: input.state.completed_worker_rounds,
    reviewed_worker_rounds: input.state.reviewed_worker_rounds,
    full_alignment_interval: input.state.full_alignment_interval,
    session_strategy: input.state.session_strategy,
    round_boundary: input.state.round_boundary,
    trajectory_mode: input.state.trajectory_mode,
    planner_backend: input.state.planner_backend,
    planner_model: input.state.planner_model,
    reviewer_backend: input.state.reviewer_backend,
    reviewer_model: input.state.reviewer_model,
    worker_backend: input.state.worker_backend,
    worker_model: input.state.worker_model,
    worker_config_source: input.state.worker_config_source,
    verification_enabled: Boolean(input.state.verification_command),
    verification_command: input.state.verification_command,
    verification_timeout_ms: input.state.verification_timeout_ms,
    active_session_id: undefined,
    active_round_session_id: undefined,
    created_at: input.state.created_at,
  }
  writeFileSync(join(input.loopDir, "loop-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8")
}

function invokeDriverPlanner(
  prompt: string,
  input: {
    projectRoot: string
    loopDir: string
    planFile: string
    state: PactState
    model: string
    planner?: DriverPlanner
    repair: boolean
  },
): string {
  if (input.planner) {
    return input.planner(prompt, {
      projectRoot: input.projectRoot,
      loopDir: input.loopDir,
      planFile: input.planFile,
      state: input.state,
      repair: input.repair,
    })
  }
  return invokeDriverCodexPlanner(prompt, input.projectRoot, input.model)
}

function recordDriverPlannerFailure(input: {
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
    input.error ? `Error: ${redactText(String(input.error))}` : undefined,
    "",
    input.plannerOutput ? "## Planner Output\n" + redactText(input.plannerOutput) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
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
    reviewerModel: state.reviewer_model,
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

function formatOpenCodeFailure(input: { command: string; args: string[]; result: SpawnResult }): string {
  const parts = [
    "OpenCode worker invocation failed.",
    `command: ${input.command} ${input.args.join(" ")}`,
    `status: ${input.result.status ?? "unknown"}`,
    input.result.error ? `error: ${String(input.result.error)}` : undefined,
    input.result.stdout ? `stdout:\n${input.result.stdout}` : undefined,
    input.result.stderr ? `stderr:\n${input.result.stderr}` : undefined,
  ].filter((line): line is string => Boolean(line))
  return truncateLog(redactText(parts.join("\n")), 6000)
}

function truncateLog(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`
}

function currentRoundSessionID(state: PactState): string | undefined {
  return state.active_round_session_id ?? state.active_session_id ?? state.previous_round_session_id
}

function finalizeRoundAfterRunExit(input: {
  projectRoot: string
  loopDir: string
  round: number
  reviewer?: DriverReviewer
  agent?: string
  model: string
}): PactState {
  const initialState = readState(input.loopDir)
  if (initialState.status !== "running") return initialState
  if ((initialState.next_round ?? initialState.current_round) !== input.round) return initialState
  const paths = artifactPaths(input.loopDir, input.round)
  if (existsSync(paths.reviewDecision)) return initialState

  ensureDriverRoundStartArtifacts({
    projectRoot: input.projectRoot,
    loopDir: input.loopDir,
    state: initialState,
    round: input.round,
    agent: input.agent,
    model: input.model,
  })

  const currentSummaryPath =
    initialState.phase === "finalize"
      ? join(input.loopDir, "finalize-summary.md")
      : summaryPath(input.loopDir, input.round)
  const summaryExists = existsSync(currentSummaryPath)
  const summary = summaryExists ? readFileSync(currentSummaryPath, "utf-8") : ""
  const contractPath = join(input.loopDir, `round-${roundName(input.round)}-contract.md`)
  const contractExists = existsSync(contractPath)
  const contract = contractExists ? readFileSync(contractPath, "utf-8") : ""

  if (!summaryExists) {
    appendRoundEvent({
      loopDir: input.loopDir,
      loopID: initialState.loop_id,
      round: input.round,
      type: "summary_missing",
      sessionID: currentRoundSessionID(initialState),
      data: { summary_path: currentSummaryPath },
    })
  }

  const patchArtifact = capturePatchArtifact({
    projectRoot: input.projectRoot,
    loopDir: input.loopDir,
    loopID: initialState.loop_id,
    round: input.round,
  })
  markWorkerRoundCompleted(input.loopDir, input.round)
  const verification = runDriverVerification({
    projectRoot: input.projectRoot,
    loopDir: input.loopDir,
    state: initialState,
    round: input.round,
    patchArtifact,
  })
  if (verification) {
    const verificationState = readState(input.loopDir)
    verificationState.last_verification_status = verification.status
    verificationState.last_verification_build_status = verification.build_status
    if (driverVerificationPassed(verification)) {
      verificationState.latest_build_success_round ??= input.round
      verificationState.first_public_build_success_round ??= input.round
    }
    writeState(input.loopDir, verificationState)
  }
  appendRoundEvent({
    loopDir: input.loopDir,
    loopID: initialState.loop_id,
    round: input.round,
    type: "patch_captured",
    sessionID: currentRoundSessionID(initialState),
    data: {
      workspace_patch: patchArtifact.workspace_patch.path,
      eval_patch: patchArtifact.eval_patch.path,
      test_patch: patchArtifact.test_patch.path,
      changed_files: patchArtifact.eval_patch.changed_files,
      verification_status: verification?.status,
      build_status: verification?.build_status,
    },
  })

  appendRoundEvent({
    loopDir: input.loopDir,
    loopID: initialState.loop_id,
    round: input.round,
    type: "review_started",
    sessionID: currentRoundSessionID(initialState),
    data: {
      round_boundary: "run_exit",
      summary_status: summaryExists ? "present" : "missing",
      contract_status: contractExists ? "present" : "missing",
    },
  })
  writeRoundState({
    loopDir: input.loopDir,
    loopID: initialState.loop_id,
    round: input.round,
    phase: "review_started",
    loopPhase: initialState.phase,
    sessionID: currentRoundSessionID(initialState),
    status: initialState.status,
  })

  const reviewPrompt = buildReviewPrompt({
    loopDir: input.loopDir,
    round: input.round,
    summaryPath: currentSummaryPath,
    summary,
    summaryStatus: summaryExists ? "present" : "missing",
    contractPath,
    contract,
    contractStatus: contractExists ? "present" : "missing",
    evalPatchPath: patchArtifact.eval_patch.path,
    patchArtifactPath: paths.patchArtifact,
    verificationPath: verification ? paths.verification : undefined,
    reviewKind:
      initialState.phase === "full_alignment"
        ? "full_alignment"
        : initialState.phase === "review"
          ? "review"
          : "implementation",
  })
  writeFileSync(join(input.loopDir, `round-${roundName(input.round)}-review-prompt.md`), reviewPrompt, "utf-8")

  let reviewText: string
  try {
    reviewText =
      input.reviewer?.(reviewPrompt, {
        projectRoot: input.projectRoot,
        loopDir: input.loopDir,
        round: input.round,
        state: initialState,
      }) ?? invokeDriverCodexReviewer(reviewPrompt, input.projectRoot, initialState.reviewer_model ?? "gpt-5.4-mini")
  } catch (err) {
    const decision = recordFailedReviewDecision({
      loopDir: input.loopDir,
      round: input.round,
      parseStatus: /timed out|ETIMEDOUT/i.test(String(err)) ? "reviewer_timeout" : "reviewer_failed",
      reviewerBackend: initialState.reviewer_backend,
      reviewerModel: initialState.reviewer_model,
      error: err,
    })
    const failedState = readState(input.loopDir)
    appendRoundEvent({
      loopDir: input.loopDir,
      loopID: failedState.loop_id,
      round: input.round,
      type: "review_finished",
      sessionID:
        failedState.previous_round_session_id ?? failedState.active_round_session_id ?? failedState.active_session_id,
      data: { status: "failed", parse_status: decision.parseStatus },
    })
    writeRoundResult({
      loopDir: input.loopDir,
      loopID: failedState.loop_id,
      round: input.round,
      status: failedState.status,
      loopPhase: failedState.phase,
      failure: decision.parseStatus === "reviewer_timeout" ? { timed_out: true } : { reviewer_failed: true },
      reviewMarker: decision.marker,
      plannerBackend: failedState.planner_backend,
      plannerModel: failedState.planner_model,
      reviewerBackend: failedState.reviewer_backend,
      reviewerModel: failedState.reviewer_model,
      metrics: driverRoundMetrics(input.loopDir, input.round, patchArtifact, decision.marker),
    })
    finalizeDriverEvidence(input.loopDir, input.round)
    return failedState
  }

  const forceContinue =
    patchArtifact.checks.apply_check.status === "failed"
      ? {
          parseStatus: "patch_apply_failed" as const,
          reason: "patch_apply_check_failed",
          feedback: `PACT patch apply check failed. Fix source changes so the exported patch applies cleanly.`,
        }
      : verification && !driverVerificationPassed(verification)
        ? {
            parseStatus: "build_gate_failed" as const,
            reason: "build_gate_failed",
            feedback: driverBuildGateFeedback(verification),
            verification,
          }
        : undefined
  const decision = recordReviewDecision({
    loopDir: input.loopDir,
    round: input.round,
    reviewText,
    reviewerBackend: initialState.reviewer_backend,
    reviewerModel: initialState.reviewer_model,
    forceContinue,
  })
  const gateAllowed = !forceContinue
  const statusDelta = extractReviewStatusDelta(reviewText)
  const appliedStatusDelta = applyReviewStatusDelta({
    loopDir: input.loopDir,
    round: input.round,
    delta: statusDelta,
    gateAllowed,
  })
  if (!appliedStatusDelta && gateAllowed) {
    applyApprovedGoalTrackerUpdates({
      loopDir: input.loopDir,
      round: input.round,
      reviewText,
      summaryText: summary,
    })
  }
  let nextState = readState(input.loopDir)
  const finalHiddenGate =
    decision.marker === "complete" &&
    (initialState.phase === "implementation" || initialState.phase === "full_alignment")
      ? runFinalHiddenGate({
          projectRoot: input.projectRoot,
          loopDir: input.loopDir,
          state: nextState,
          round: input.round,
          patchArtifact,
        })
      : undefined
  if (finalHiddenGate && finalHiddenGate.status !== "passed") {
    nextState = stopAfterFinalHiddenGateFailure({
      loopDir: input.loopDir,
      state: nextState,
      round: input.round,
      summary: finalHiddenGate,
    })
  }
  if (decision.marker === "continue") {
    writeContinuationPackage({
      loopDir: input.loopDir,
      round: input.round,
      nextRound: nextState.next_round ?? nextState.current_round,
      maxRounds: nextState.max_rounds,
      workerRoundCount: nextState.completed_worker_rounds ?? nextState.worker_round_count ?? 0,
      loopPhase: nextState.phase,
      reviewText,
      verification,
      changedFiles: patchArtifact.eval_patch.changed_files,
      patchSha256: patchArtifact.eval_patch.sha256,
      feedbackPath: nextState.last_feedback_path,
      gateAllowed,
    })
  }
  writeRoundState({
    loopDir: input.loopDir,
    loopID: nextState.loop_id,
    round: input.round,
    phase: "round_finished",
    loopPhase: nextState.phase,
    sessionID: nextState.previous_round_session_id ?? nextState.active_round_session_id ?? nextState.active_session_id,
    status: nextState.status,
  })
  appendRoundEvent({
    loopDir: input.loopDir,
    loopID: nextState.loop_id,
    round: input.round,
    type: "review_finished",
    sessionID: nextState.previous_round_session_id ?? nextState.active_round_session_id ?? nextState.active_session_id,
    data: { marker: decision.marker, parse_status: decision.parseStatus, resulting_phase: nextState.phase },
  })
  appendRoundEvent({
    loopDir: input.loopDir,
    loopID: nextState.loop_id,
    round: input.round,
    type: "round_finished",
    sessionID: nextState.previous_round_session_id ?? nextState.active_round_session_id ?? nextState.active_session_id,
    data: { status: nextState.status, phase: nextState.phase },
  })
  const failure =
    finalHiddenGate && finalHiddenGate.status !== "passed"
      ? { build_gate_failed: true }
      : driverRoundFailure(
          decision.marker,
          nextState.status,
          input.round,
          nextState.max_rounds,
          patchArtifact,
          verification,
        )
  const roundResult = writeRoundResult({
    loopDir: input.loopDir,
    loopID: nextState.loop_id,
    round: input.round,
    status: nextState.status,
    loopPhase: nextState.phase,
    failure,
    reviewMarker: decision.marker,
    plannerBackend: nextState.planner_backend,
    plannerModel: nextState.planner_model,
    reviewerBackend: nextState.reviewer_backend,
    reviewerModel: nextState.reviewer_model,
    metrics: driverRoundMetrics(input.loopDir, input.round, patchArtifact, decision.marker),
  })
  if (nextState.status === "stopped" && roundResult.failure_category && !nextState.stop_reason) {
    nextState.stop_reason = roundResult.failure_category
    writeState(input.loopDir, nextState)
  }
  writeRoundSnapshot({
    projectRoot: input.projectRoot,
    loopDir: input.loopDir,
    loopID: nextState.loop_id,
    round: input.round,
    stage: "post",
  })
  finalizeDriverEvidence(input.loopDir, input.round)
  writeNextPromptAfterDriverRound({
    projectRoot: input.projectRoot,
    loopDir: input.loopDir,
    state: nextState,
    reviewedRound: input.round,
    agent: input.agent,
    model: input.model,
  })
  return readState(input.loopDir)
}

function ensureDriverRoundStartArtifacts(input: {
  projectRoot: string
  loopDir: string
  state: PactState
  round: number
  agent?: string
  model: string
}): void {
  const promptPath = join(input.loopDir, `round-${roundName(input.round)}-prompt.md`)
  if (!existsSync(promptPath)) return
  const paths = artifactPaths(input.loopDir, input.round)
  const sessionID =
    input.state.session_strategy === "same-session"
      ? (input.state.active_round_session_id ?? input.state.active_session_id)
      : undefined
  if (!existsSync(paths.roundState)) {
    writeRoundState({
      loopDir: input.loopDir,
      loopID: input.state.loop_id,
      round: input.round,
      phase: "round_started",
      loopPhase: input.state.phase,
      sessionID,
      status: input.state.status,
      notes: "Driver-owned run-exit round boundary.",
    })
  }
  if (!existsSync(paths.roundContext)) {
    writeRoundContext({
      loopDir: input.loopDir,
      loopID: input.state.loop_id,
      round: input.round,
      sessionID,
      workerAgent: input.agent ?? "build",
      workerBackend: input.state.worker_backend,
      workerModel: input.state.worker_model ?? input.model,
      workerConfigSource: input.state.worker_config_source,
      loopPhase: input.state.phase,
      plannerBackend: input.state.planner_backend,
      plannerModel: input.state.planner_model,
      reviewerBackend: input.state.reviewer_backend,
      reviewerModel: input.state.reviewer_model,
      promptPath,
      todoPath: join(input.loopDir, "todo.md"),
      goalTrackerPath: join(input.loopDir, "goal-tracker.md"),
      feedbackPath: input.state.last_feedback_path,
    })
  }
  if (!existsSync(paths.preSnapshot)) {
    writeRoundSnapshot({
      projectRoot: input.projectRoot,
      loopDir: input.loopDir,
      loopID: input.state.loop_id,
      round: input.round,
      stage: "pre",
    })
  }
}

function writeNextPromptAfterDriverRound(input: {
  projectRoot: string
  loopDir: string
  state: PactState
  reviewedRound: number
  agent?: string
  model: string
}): void {
  if (input.state.status !== "running") return
  const workerPath = workerPathRenderer(input.projectRoot)
  const feedbackPath =
    input.state.last_feedback_path ?? join(input.loopDir, `round-${roundName(input.reviewedRound)}-feedback.md`)
  const goalTrackerPath = join(input.loopDir, "goal-tracker.md")
  let prompt: string | undefined
  if (input.state.phase === "finalize") {
    prompt = buildFinalizePrompt({ loopDir: input.loopDir, round: input.state.current_round, goalTrackerPath, workerPath })
  } else if (input.state.phase === "review") {
    prompt = buildReviewPhasePrompt({
      loopDir: input.loopDir,
      round: input.state.current_round,
      feedbackPath,
      goalTrackerPath,
      workerPath,
    })
  } else if (input.state.phase === "implementation") {
    prompt = buildContinuationPrompt({
      loopDir: input.loopDir,
      round: input.state.current_round,
      feedbackPath,
      goalTrackerPath,
      continuationPackagePath: artifactPaths(input.loopDir, input.reviewedRound).continuationPackage,
      workerPath,
    })
  }
  if (!prompt) return
  const promptPath = join(input.loopDir, `round-${roundName(input.state.current_round)}-prompt.md`)
  writeFileSync(promptPath, prompt, "utf-8")
  const sessionID =
    input.state.session_strategy === "same-session"
      ? (input.state.active_round_session_id ?? input.state.active_session_id)
      : undefined
  writeRoundState({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.state.current_round,
    phase: "round_started",
    loopPhase: input.state.phase,
    sessionID,
    status: input.state.status,
  })
  writeRoundContext({
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.state.current_round,
    sessionID,
    workerAgent: input.agent ?? "build",
    workerBackend: input.state.worker_backend,
    workerModel: input.state.worker_model ?? input.model,
    workerConfigSource: input.state.worker_config_source,
    loopPhase: input.state.phase,
    plannerBackend: input.state.planner_backend,
    plannerModel: input.state.planner_model,
    reviewerBackend: input.state.reviewer_backend,
    reviewerModel: input.state.reviewer_model,
    promptPath,
    todoPath: join(input.loopDir, "todo.md"),
    goalTrackerPath,
    feedbackPath,
  })
  writeRoundSnapshot({
    projectRoot: input.projectRoot,
    loopDir: input.loopDir,
    loopID: input.state.loop_id,
    round: input.state.current_round,
    stage: "pre",
  })
}

function workerPathRenderer(projectRoot: string): (path: string) => string {
  return (path: string): string => {
    const rel = relative(projectRoot, path)
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel
    if (!rel) return "."
    return path
  }
}

function runDriverVerification(input: {
  projectRoot: string
  loopDir: string
  state: PactState
  round: number
  patchArtifact: PatchArtifact
}): RoundVerificationArtifact | undefined {
  const command = input.state.verification_command
  if (!command) return undefined
  const started = Date.now()
  const paths = artifactPaths(input.loopDir, input.round)
  const result = nodeSpawnSync(command, {
    cwd: input.projectRoot,
    shell: true,
    encoding: "utf-8",
    timeout: input.state.verification_timeout_ms ?? 600000,
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
  const parsed = parseDriverVerificationOutput(stdout)
  const timedOut = Boolean(result.error && /timed out|ETIMEDOUT/i.test(String(result.error)))
  return writeVerificationArtifact({
    loopDir: input.loopDir,
    round: input.round,
    command,
    status: timedOut ? "timeout" : (parsed.status ?? (result.status === 0 ? "passed" : "failed")),
    exitCode: result.status,
    durationMs: Date.now() - started,
    patchSha256: input.patchArtifact.eval_patch.sha256,
    applied: parsed.applied,
    resolved: parsed.resolved,
    buildStatus: parsed.build_status,
    f2p: parsed.f2p,
    p2p: parsed.p2p,
    errorCategories: parsed.error_categories,
    failureSignature: parsed.failure_signature,
    logText: [parsed.rawJson ? "" : stdout, stderr, result.error ? String(result.error) : ""]
      .filter(Boolean)
      .join("\n"),
    source: "lightweight",
  })
}

type FinalHiddenGateSuiteResult = {
  suite: string
  status: "passed" | "failed" | "timeout" | "infra_failed"
  applied?: boolean
  resolved?: boolean
  build_status?: string
  f2p?: { passed: number; total: number }
  p2p?: { passed: number; total: number }
  error_categories?: string[]
  failure_signature?: string
  diagnostic_signature?: string
  patch_sha256: string
  duration_ms: number
  artifact_path: string
  log_path: string
}

type FinalHiddenGateSummary = {
  schema: "pact-final-hidden-gate-summary/v1"
  artifact_version: 1
  round: number
  created_at: string
  status: "passed" | "failed"
  suites: string[]
  patch_sha256: string
  results: FinalHiddenGateSuiteResult[]
  failure_signature?: string
  diagnostic_signature?: string
}

function runFinalHiddenGate(input: {
  projectRoot: string
  loopDir: string
  state: PactState
  round: number
  patchArtifact: PatchArtifact
}): FinalHiddenGateSummary | undefined {
  const command = defaultFinalHiddenGateCommand()
  if (!command) return undefined
  const suites = finalHiddenGateSuites()
  const results = suites.map((suite) =>
    runFinalHiddenGateSuite({
      projectRoot: input.projectRoot,
      loopDir: input.loopDir,
      round: input.round,
      suite,
      command,
      patchArtifact: input.patchArtifact,
      timeoutMs: input.state.verification_timeout_ms ?? 600000,
    }),
  )
  const status = results.every(finalHiddenGateSuitePassed) ? "passed" : "failed"
  const firstFailure = results.find((result) => !finalHiddenGateSuitePassed(result))
  const summary: FinalHiddenGateSummary = cleanJson({
    schema: "pact-final-hidden-gate-summary/v1",
    artifact_version: 1,
    round: input.round,
    created_at: new Date().toISOString(),
    status,
    suites,
    patch_sha256: input.patchArtifact.eval_patch.sha256,
    results,
    failure_signature: firstFailure?.failure_signature,
    diagnostic_signature: firstFailure?.diagnostic_signature,
  })
  writeFileSync(join(input.loopDir, "final-hidden-gate-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8")
  writeFileSync(
    join(input.loopDir, "final-result.json"),
    JSON.stringify(
      cleanJson({
        schema: "pact-final-result/v1",
        artifact_version: 1,
        round: input.round,
        status,
        resolved: status === "passed",
        stop_reason: status === "passed" ? undefined : "final_hidden_gate_failed",
        final_hidden_gate_summary: join(input.loopDir, "final-hidden-gate-summary.json"),
        patch_sha256: input.patchArtifact.eval_patch.sha256,
        created_at: new Date().toISOString(),
      }),
      null,
      2,
    ) + "\n",
    "utf-8",
  )
  return summary
}

function runFinalHiddenGateSuite(input: {
  projectRoot: string
  loopDir: string
  round: number
  suite: string
  command: string
  patchArtifact: PatchArtifact
  timeoutMs: number
}): FinalHiddenGateSuiteResult {
  const started = Date.now()
  const suiteID = safeArtifactID(input.suite)
  const jsonPath = join(input.loopDir, `final-hidden-gate-${suiteID}.json`)
  const logPath = join(input.loopDir, `final-hidden-gate-${suiteID}.log`)
  const result = nodeSpawnSync(input.command, {
    cwd: input.projectRoot,
    shell: true,
    encoding: "utf-8",
    timeout: input.timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      PACT_LOOP_DIR: input.loopDir,
      PACT_ROUND: `final-${roundName(input.round)}`,
      PACT_PATCH_PATH: input.patchArtifact.eval_patch.path,
      PACT_PATCH_ARTIFACT: artifactPaths(input.loopDir, input.round).patchArtifact,
      PACT_PROJECT_ROOT: input.projectRoot,
      LOLBENCH_GATE_SUITE: input.suite,
    },
  })
  const stdout = String(result.stdout ?? "")
  const stderr = String(result.stderr ?? "")
  const timedOut = Boolean(result.error && /timed out|ETIMEDOUT/i.test(String(result.error)))
  const parsed = parseDriverVerificationOutput(stdout)
  const status = timedOut
    ? "timeout"
    : parsed.status === "passed" && result.status === 0
      ? "passed"
      : result.status === 0 && parsed.resolved === true
        ? "passed"
        : "failed"
  const logText = redactText(
    [parsed.rawJson ? "" : stdout, stderr, result.error ? String(result.error) : ""].filter(Boolean).join("\n"),
  )
  writeFileSync(logPath, logText, "utf-8")
  const artifact: FinalHiddenGateSuiteResult = cleanJson({
    suite: input.suite,
    status,
    applied: parsed.applied,
    resolved: parsed.resolved,
    build_status: parsed.build_status,
    f2p: parsed.f2p,
    p2p: parsed.p2p,
    error_categories: parsed.error_categories,
    failure_signature: parsed.failure_signature,
    diagnostic_signature: parsed.failure_signature,
    patch_sha256: input.patchArtifact.eval_patch.sha256,
    duration_ms: Date.now() - started,
    artifact_path: jsonPath,
    log_path: logPath,
  })
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n", "utf-8")
  return artifact
}

function stopAfterFinalHiddenGateFailure(input: {
  loopDir: string
  state: PactState
  round: number
  summary: FinalHiddenGateSummary
}): PactState {
  const state = { ...input.state }
  state.status = "stopped"
  state.phase = "stopped"
  state.stop_reason = "final_hidden_gate_failed"
  writeFileSync(
    join(input.loopDir, "stop-state.md"),
    `PACT stopped after final hidden gate failed for round ${input.round}.\n\nSee final-hidden-gate-summary.json.\n`,
    "utf-8",
  )
  writeState(input.loopDir, state)
  return readState(input.loopDir)
}

function finalHiddenGateSuitePassed(result: FinalHiddenGateSuiteResult): boolean {
  if (result.status !== "passed") return false
  if (result.applied === false) return false
  if (result.resolved !== true) return false
  if (!result.build_status) return true
  return ["success", "passed", "ok", "built"].includes(result.build_status)
}

function defaultFinalHiddenGateCommand(): string | undefined {
  if (env.PACT_FINAL_HIDDEN_GATE_COMMAND) return env.PACT_FINAL_HIDDEN_GATE_COMMAND
  if (!env.LOLBENCH_REPO_ROOT) return undefined
  return `python3 ${shellQuote(join(env.LOLBENCH_REPO_ROOT, "scripts", "lolbench_eval.py"))} pact-gate`
}

function finalHiddenGateSuites(): string[] {
  const raw = env.LOLBENCH_FINAL_GATE_SUITES ?? env.LOLBENCH_GATE_SUITE ?? "orig"
  const suites = raw
    .split(/[,\s]+/)
    .map((suite) => suite.trim())
    .filter(Boolean)
  return suites.length ? suites : ["orig"]
}

function safeArtifactID(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-") || "suite"
}

function cleanJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cleanJson(item)).filter((item) => item !== undefined) as T
  }
  if (!value || typeof value !== "object") return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue
    output[key] = cleanJson(child)
  }
  return output as T
}

function parseDriverVerificationOutput(stdout: string): {
  rawJson?: Record<string, unknown>
  status?: "not_run" | "passed" | "failed" | "timeout" | "infra_failed"
  build_status?: string
  applied?: boolean
  resolved?: boolean
  f2p?: { passed: number; total: number }
  p2p?: { passed: number; total: number }
  error_categories?: string[]
  failure_signature?: string
} {
  const json = lastJsonObject(stdout)
  if (!json) return {}
  const build = isRecord(json.build) ? json.build : undefined
  return {
    rawJson: json,
    status: normalizeVerificationStatus(json.status),
    build_status: stringValue(json.build_status) ?? (build ? stringValue(build.status) : undefined),
    applied: booleanValue(json.applied),
    resolved: booleanValue(json.resolved),
    f2p: countsValue(json.f2p),
    p2p: countsValue(json.p2p),
    error_categories: arrayStringValue(json.error_categories),
    failure_signature: stringValue(json.failure_signature) ?? stringValue(json.error) ?? stringValue(json.message),
  }
}

function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmedText = text.trim()
  const direct = parseJsonRecord(trimmedText)
  if (direct) return direct
  let fallback: Record<string, unknown> | undefined
  for (let index = trimmedText.lastIndexOf("{"); index >= 0; index = trimmedText.lastIndexOf("{", index - 1)) {
    const parsed = parseJsonRecord(trimmedText.slice(index))
    if (!parsed) continue
    if (isVerificationJson(parsed)) return parsed
    fallback ??= parsed
  }
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue
    const parsed = parseJsonRecord(trimmed)
    if (!parsed) continue
    if (isVerificationJson(parsed)) return parsed
    fallback ??= parsed
  }
  return fallback
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isVerificationJson(value: Record<string, unknown>): boolean {
  return (
    "status" in value ||
    "build_status" in value ||
    "failure_signature" in value ||
    "f2p" in value ||
    "p2p" in value ||
    "error_categories" in value
  )
}

function normalizeVerificationStatus(
  value: unknown,
): "not_run" | "passed" | "failed" | "timeout" | "infra_failed" | undefined {
  if (
    value === "not_run" ||
    value === "passed" ||
    value === "failed" ||
    value === "timeout" ||
    value === "infra_failed"
  ) {
    return value
  }
  if (value === "success" || value === true) return "passed"
  if (value === "error" || value === false) return "failed"
  return undefined
}

function driverVerificationPassed(verification: RoundVerificationArtifact): boolean {
  if (verification.status !== "passed") return false
  if (verification.applied === false) return false
  if (!verification.build_status) return true
  return ["success", "passed", "ok", "built"].includes(verification.build_status)
}

function driverBuildGateFeedback(verification: RoundVerificationArtifact): string {
  return [
    "PACT verification gate failed. Completion is blocked until source changes pass verification.",
    `Verification status: ${verification.status}`,
    verification.applied === undefined ? undefined : `Patch applied: ${verification.applied}`,
    verification.build_status ? `Build status: ${verification.build_status}` : undefined,
    verification.error_categories?.length ? `Error categories: ${verification.error_categories.join(", ")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

function driverRoundFailure(
  marker: "complete" | "continue",
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
  if (verification?.status === "timeout") return { verification_timeout: true }
  if (status === "stopped" && verification && !driverVerificationPassed(verification)) {
    return { max_rounds_without_build_success: true }
  }
  if (status === "stopped" && round >= maxRounds) return { max_rounds_reached: true }
  return {}
}

function driverRoundMetrics(
  loopDir: string,
  round: number,
  patchArtifact: PatchArtifact | undefined,
  reviewMarker: "complete" | "continue" | undefined,
): Record<string, string | number | boolean | null> {
  const eventsPath = artifactPaths(loopDir, round).roundEvents
  const toolEventCount = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.includes('"type":"tool_')).length
    : 0
  return {
    patch_empty: patchArtifact?.eval_patch.empty ?? null,
    workspace_patch_lines: patchArtifact?.workspace_patch.lines ?? null,
    eval_patch_lines: patchArtifact?.eval_patch.lines ?? null,
    test_patch_lines: patchArtifact?.test_patch.lines ?? null,
    changed_file_count: patchArtifact?.eval_patch.changed_files.length ?? null,
    tool_event_count: toolEventCount,
    review_marker: reviewMarker ?? null,
  }
}

function finalizeDriverEvidence(loopDir: string, round: number): void {
  try {
    writeRoundEvidence({ loopDir, round })
    exportReplayCase({ loopDir, round })
  } catch (err) {
    const state = readState(loopDir)
    appendRoundEvent({
      loopDir,
      loopID: state.loop_id,
      round,
      type: "replay_exported",
      sessionID: state.previous_round_session_id ?? state.active_round_session_id ?? state.active_session_id,
      data: { status: "failed", error: String(err) },
    })
    return
  }
  const state = readState(loopDir)
  appendRoundEvent({
    loopDir,
    loopID: state.loop_id,
    round,
    type: "replay_exported",
    sessionID: state.previous_round_session_id ?? state.active_round_session_id ?? state.active_session_id,
    data: { replay_case: artifactPaths(loopDir, round).roundReplayCase },
  })
}

function invokeDriverCodexPlanner(prompt: string, projectRoot: string, model: string): string {
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="medium"',
    "-C",
    projectRoot,
    "-",
  ]
  const timeout = Number(env.PACT_CODEX_TIMEOUT_MS ?? 600000)
  const result = nodeSpawnSync("codex", args, {
    cwd: projectRoot,
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Codex planner failed with status ${result.status}: ${result.stderr}`)
  return result.stdout || result.stderr || "Codex planner returned no content."
}

function invokeDriverCodexReviewer(prompt: string, projectRoot: string, model: string): string {
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="medium"',
    "-C",
    projectRoot,
    "-",
  ]
  const timeout = Number(env.PACT_CODEX_TIMEOUT_MS ?? 600000)
  const result = nodeSpawnSync("codex", args, {
    cwd: projectRoot,
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Codex reviewer failed with status ${result.status}: ${result.stderr}`)
  return result.stdout || result.stderr || "Codex reviewer returned no content."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function countsValue(value: unknown): { passed: number; total: number } | undefined {
  if (!isRecord(value)) return undefined
  const passed = typeof value.passed === "number" ? value.passed : undefined
  const total = typeof value.total === "number" ? value.total : undefined
  return passed === undefined || total === undefined ? undefined : { passed, total }
}

function arrayStringValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
}

function findNewLoop(projectRoot: string, preexistingLoopIDs: Set<string>): { loopDir: string } | undefined {
  const active = findActiveLoop(projectRoot)
  if (active && !preexistingLoopIDs.has(basename(active.loopDir))) return active
  return findLatestLoop(projectRoot, preexistingLoopIDs)
}

function findLatestLoop(projectRoot: string, preexistingLoopIDs: Set<string>): { loopDir: string } | undefined {
  const loopsRoot = join(projectRoot, ".pact", "loops")
  if (!existsSync(loopsRoot)) return undefined
  const loopID = readdirSync(loopsRoot)
    .filter((item) => statSync(join(loopsRoot, item)).isDirectory())
    .filter((item) => !preexistingLoopIDs.has(item))
    .sort()
    .at(-1)
  if (!loopID) return undefined
  const loopDir = join(loopsRoot, loopID)
  if (!existsSync(join(loopDir, "state.json"))) return undefined
  return { loopDir }
}

function listLoopIDs(projectRoot: string): Set<string> {
  const loopsRoot = join(projectRoot, ".pact", "loops")
  if (!existsSync(loopsRoot)) return new Set()
  return new Set(readdirSync(loopsRoot).filter((item) => statSync(join(loopsRoot, item)).isDirectory()))
}

function buildWorkerInvocation(input: {
  runner: WorkerRunner
  opencodeCommand: string
  dockerCommand: string
  containerOpencodeCommand: string
  opencodeArgs: string[]
  projectRoot: string
  containerImage?: string
  containerWorkspace: string
  workerPluginMount?: string
  workerContainerPluginMount: string
}): { command: string; args: string[] } {
  if (input.runner === "host") {
    return { command: input.opencodeCommand, args: input.opencodeArgs }
  }
  if (!input.containerImage) throw new Error("Missing worker container image")
  const args = [
    "run",
    "--rm",
    "-i",
    ...dockerResourceArgs(),
    ...dockerBlackholeHostArgs(),
    "-e",
    `WORKSPACE=${input.containerWorkspace}`,
    "-e",
    `PACT_PROJECT_ROOT=${input.containerWorkspace}`,
    "-v",
    `${input.projectRoot}:${input.containerWorkspace}`,
    "-w",
    input.containerWorkspace,
    "--entrypoint",
    "",
  ]
  const envArgs = dockerWorkerEnvArgs(input)
  args.push(...envArgs)
  const pluginMount = input.workerPluginMount ?? inferredPluginMount()
  if (pluginMount) args.push("-v", `${pluginMount}:${input.workerContainerPluginMount}:ro`)
  args.push(input.containerImage, input.containerOpencodeCommand, ...input.opencodeArgs)
  return { command: input.dockerCommand, args }
}

function dockerResourceArgs(): string[] {
  const args: string[] = []
  if (env.LOLBENCH_MEM) args.push("--memory", env.LOLBENCH_MEM)
  if (env.LOLBENCH_CPUS) args.push("--cpus", env.LOLBENCH_CPUS)
  return args
}

function dockerWorkerEnvArgs(input: { workerPluginMount?: string; workerContainerPluginMount: string }): string[] {
  const args: string[] = []
  for (const name of ["ZAI_API_KEY", "ZAI_API_BASE", "OPENCODE_CONFIG", "MSWEA_MODEL_NAME"]) {
    if (env[name]) args.push("-e", name)
  }
  const config = containerOpenCodeConfig(input)
  if (config) args.push("-e", `OPENCODE_CONFIG_CONTENT=${config}`)
  const pluginPath = containerPluginPath(input)
  if (pluginPath) args.push("-e", `PACT_PLUGIN_PATH=${pluginPath}`)
  return args
}

function containerOpenCodeConfig(input: {
  workerPluginMount?: string
  workerContainerPluginMount: string
}): string | undefined {
  const config = env.OPENCODE_CONFIG_CONTENT
  if (!config) return undefined
  const hostPluginMount = input.workerPluginMount ?? inferredPluginMount()
  if (!hostPluginMount) return config
  return config.split(hostPluginMount).join(input.workerContainerPluginMount)
}

function containerPluginPath(input: {
  workerPluginMount?: string
  workerContainerPluginMount: string
}): string | undefined {
  const pluginPath = env.PACT_PLUGIN_PATH
  const hostPluginMount = input.workerPluginMount ?? inferredPluginMount()
  if (!pluginPath || !hostPluginMount || !pluginPath.startsWith(hostPluginMount)) return undefined
  return input.workerContainerPluginMount + pluginPath.slice(hostPluginMount.length)
}

function inferredPluginMount(): string | undefined {
  const pluginPath = env.PACT_PLUGIN_PATH
  if (!pluginPath) return undefined
  return pluginPath.endsWith("/pact.ts") ? pluginPath.slice(0, -"/pact.ts".length) : undefined
}

function dockerBlackholeHostArgs(): string[] {
  const hosts = [
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
    "gist.github.com",
    "objects.githubusercontent.com",
    "gitlab.com",
    "bitbucket.org",
    "www.python.org",
    "python.org",
    "docs.python.org",
    "pypi.org",
    "files.pythonhosted.org",
    "pythonhosted.org",
  ]
  return hosts.flatMap((host) => ["--add-host", `${host}:127.0.0.1`])
}

function buildOpencodeRunArgs(input: {
  model: string
  agent?: string
  variant?: string
  sessionID?: string
}): string[] {
  const args = ["run", "--dangerously-skip-permissions", "-m", input.model]
  if (input.agent) args.push("--agent", input.agent)
  if (input.variant) args.push("--variant", input.variant)
  if (input.sessionID) args.push("-s", input.sessionID)
  return args
}

function defaultSpawnSync(
  command: string,
  args: string[],
  options: { cwd: string; input: string; encoding: "utf-8"; stdio: Array<"inherit" | "pipe">; maxBuffer: number },
): SpawnResult {
  return nodeSpawnSync(command, args, options)
}

export function cliArgs(raw: string[]): {
  projectRoot: string
  planFile: string
  model: string
  maxRounds: number
  opencodeCommand?: string
  dockerCommand?: string
  containerOpencodeCommand?: string
  agent?: string
  variant?: string
  workerRunner?: WorkerRunner
  workerContainerImage?: string
  workerContainerWorkspace?: string
  workerPluginMount?: string
  workerContainerPluginMount?: string
  plannerModel?: string
  reviewerModel?: string
  fullAlignmentInterval?: number
  sessionStrategy?: SessionStrategy
  verificationCommand?: string
  verificationTimeoutMs?: number
  resumeLoopDir?: string
  resumeMode?: ResumeMode
} {
  const args = [...raw]
  const parsed: Record<string, string | undefined> = {}
  while (args.length) {
    const key = args.shift()
    if (!key?.startsWith("--")) continue
    parsed[key.slice(2)] = args.shift()
  }
  const projectRoot = parsed["project-root"] ?? process.env.WORKSPACE ?? cwd()
  const planFile = parsed["plan-file"] ?? process.env.PROMPT_FILE
  if (!planFile) throw new Error("Missing --plan-file or PROMPT_FILE")
  return {
    projectRoot,
    planFile,
    model: parsed.model ?? "zai-coding-plan/glm-5-turbo",
    maxRounds: Number(parsed["max-rounds"] ?? 12),
    opencodeCommand: parsed["opencode-command"],
    dockerCommand: parsed["docker-command"],
    containerOpencodeCommand: parsed["container-opencode-command"],
    agent: parsed.agent,
    variant: parsed.variant,
    workerRunner: (parsed["worker-runner"] ?? env.PACT_WORKER_RUNNER) === "docker" ? "docker" : "host",
    workerContainerImage: parsed["worker-container-image"] ?? env.LOLBENCH_AGENT_IMAGE_TAG,
    workerContainerWorkspace: parsed["worker-container-workspace"],
    workerPluginMount: parsed["worker-plugin-mount"],
    workerContainerPluginMount: parsed["worker-container-plugin-mount"],
    plannerModel: parsed["planner-model"],
    reviewerModel: parsed["reviewer-model"],
    verificationCommand: defaultVerificationCommand(parsed),
    verificationTimeoutMs: parsed["verification-timeout-ms"] ? Number(parsed["verification-timeout-ms"]) : undefined,
    resumeLoopDir: parsed["resume-loop"] ?? env.PACT_RESUME_LOOP_DIR,
    resumeMode: parseResumeMode(parsed["resume-mode"] ?? env.PACT_RESUME_MODE),
    sessionStrategy: parsed["session-strategy"] === "same-session" ? "same-session" : "new-per-round",
    fullAlignmentInterval: parsed["full-alignment-interval"] ? Number(parsed["full-alignment-interval"]) : undefined,
  }
}

function parseResumeMode(value: string | undefined): ResumeMode | undefined {
  if (value === undefined || value === "") return undefined
  if (value === "round0") return "round0"
  throw new Error(`Unsupported PACT resume mode: ${value}`)
}

function defaultVerificationCommand(parsed: Record<string, string | undefined>): string | undefined {
  if (parsed["verification-command"] !== undefined) return parsed["verification-command"]
  if (env.PACT_VERIFICATION_COMMAND) return env.PACT_VERIFICATION_COMMAND
  if (!env.LOLBENCH_REPO_ROOT) return undefined
  return `python3 ${shellQuote(join(env.LOLBENCH_REPO_ROOT, "scripts", "lolbench_eval.py"))} pact-public-check`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

if (import.meta.main) {
  try {
    const result = runPactDriver(cliArgs(argv.slice(2)))
    exit(result.exitCode)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    exit(2)
  }
}
