import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type PlannerBackend = "opencode-agent" | "codex-cli"
export type ReviewerBackend = "opencode-agent" | "codex-cli"
export type WorkerBackend = "opencode-cli"
export type LoopStatus = "running" | "complete" | "stopped" | "cancelled"
export type LoopPhase = "implementation" | "full_alignment" | "review" | "finalize" | "complete" | "stopped"
export type ReviewMarker = "complete" | "continue"
export type SessionStrategy = "new-per-round" | "same-session"
export type TrajectoryMode = "structured" | "full-redact"
export type RoundBoundary = "session_idle" | "run_exit"

export type PactState = {
  version: 1 | 2
  status: LoopStatus
  phase: LoopPhase
  loop_id: string
  next_round?: number
  current_round: number
  max_rounds: number
  attempted_worker_rounds?: number
  completed_worker_rounds?: number
  reviewed_worker_rounds?: number
  worker_round_count?: number
  full_alignment_interval: number
  plan_file: string
  source_plan_file?: string
  source_plan_path?: string
  active_session_id?: string
  active_round_session_id?: string
  previous_round_session_id?: string
  session_strategy?: SessionStrategy
  round_boundary?: RoundBoundary
  trajectory_mode?: TrajectoryMode
  planner_backend: PlannerBackend
  planner_model?: string | null
  reviewer_backend: ReviewerBackend
  reviewer_model?: string | null
  worker_backend?: string
  worker_model?: string | null
  worker_config_source?: string | null
  verification_command?: string
  verification_timeout_ms?: number
  goal_tracker_immutable_sha256?: string
  base_commit?: string
  created_at: string
  updated_at: string
  last_review_marker?: ReviewMarker
  last_review_path?: string
  last_feedback_path?: string
  latest_build_success_round?: number
  first_public_build_success_round?: number
  last_verification_status?: VerificationStatus
  last_verification_build_status?: string
  stop_reason?: FailureCategory | string
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
  plannerBackend?: PlannerBackend
  plannerModel?: string | null
  reviewerBackend?: ReviewerBackend
  reviewerModel?: string | null
  workerBackend?: string
  workerModel?: string | null
  workerConfigSource?: string | null
  workerSessionID?: string
  sessionStrategy?: SessionStrategy
  roundBoundary?: RoundBoundary
  trajectoryMode?: TrajectoryMode
  fullAlignmentInterval?: number
  baseCommit?: string
  verificationCommand?: string
  verificationTimeoutMs?: number
}

export type PlannerArtifacts = {
  plan?: string
  todo: string
  goalTracker: string
  markerPresence?: {
    plan: boolean
    todo: boolean
    goalTracker: boolean
  }
}

export type PlannerValidationResult = {
  ok: boolean
  missing: string[]
  errors: string[]
}

type AcceptanceCriterion = {
  id: string
  text: string
  positive: string
  negative: string
}

type PlanTask = {
  id: string
  description: string
  targetAC: string
  tag: "coding" | "analyze"
  dependsOn: string
  status: "pending" | "active" | "complete" | "deferred"
}

export type ReviewDecision = {
  marker: ReviewMarker
  reason?: string
  parseStatus:
    | "complete_signal"
    | "deprecated_stop_signal"
    | "implicit_continue"
    | "deprecated_continue_signal"
    | "reviewer_timeout"
    | "reviewer_failed"
    | "patch_apply_failed"
    | "build_gate_failed"
  terminalLine: string
}

export type ArtifactPaths = {
  loopManifest: string
  roundState: string
  roundContext: string
  roundEvents: string
  preSnapshot: string
  postSnapshot: string
  trajectory: string
  evidenceJson: string
  evidenceMarkdown: string
  workspacePatch: string
  evalPatch: string
  testPatch: string
  patchArtifact: string
  verification: string
  verificationLog: string
  continuationPackage: string
  continuationPackageJson: string
  reviewDecision: string
  roundResult: string
  roundReplayCase: string
  replayCase: string
}

export type RoundPhase =
  | "round_started"
  | "worker_waiting"
  | "summary_missing"
  | "patch_captured"
  | "review_started"
  | "review_finished"
  | "round_finished"
  | "cancelled"

export type RoundStateArtifact = {
  schema: "pact-round-state/v1"
  artifact_version: 1
  loop_id: string
  round: number
  phase: RoundPhase
  loop_phase?: LoopPhase
  started_at: string
  updated_at: string
  summary_path: string
  review_path: string
  feedback_path: string
  result_path: string
  session_id?: string
  status?: LoopStatus
  notes?: string
}

export type RoundContextArtifact = {
  schema: "pact-round-context/v1"
  artifact_version: 1
  loop_id: string
  round: number
  session_id?: string
  worker_agent: string
  worker_backend?: string
  worker_model?: string | null
  worker_config_source?: string | null
  loop_phase?: LoopPhase
  planner_backend?: PlannerBackend
  planner_model?: string | null
  reviewer_backend: ReviewerBackend
  reviewer_model?: string | null
  prompt_path: string
  prompt_sha256: string
  todo_path: string
  todo_sha256: string
  goal_tracker_path: string
  goal_tracker_sha256: string
  feedback_path: string
  feedback_sha256: string
}

export type RoundEventType =
  | "round_started"
  | "tool_before"
  | "tool_after"
  | "summary_missing"
  | "patch_captured"
  | "review_started"
  | "review_finished"
  | "round_finished"
  | "replay_exported"
  | "cancelled"

export type RoundEventArtifact = {
  schema: "pact-event/v1"
  artifact_version: 1
  time: string
  loop_id: string
  round: number
  type: RoundEventType
  session_id?: string
  data?: unknown
}

export type ToolArgsSummary = {
  keys: string[]
}

export type ToolOutputSummary = {
  title?: string
  output_length: number
  metadata_keys: string[]
}

export type PatchMetadata = {
  path: string
  empty: boolean
  sha256: string
  bytes: number
  lines: number
  changed_files: string[]
}

export type ExcludedScaffoldingFile = {
  path: string
  sha256: string
  bytes: number
  lines: number
}

export type PatchArtifact = {
  schema: "pact-patch-artifact/v1"
  artifact_version: 1
  loop_id: string
  round: number
  captured_at: string
  primary_patch: "eval"
  workspace_patch: PatchMetadata
  eval_patch: PatchMetadata
  test_patch: PatchMetadata
  excluded_scaffolding_files?: ExcludedScaffoldingFile[]
  excluded_test_patch_files?: ExcludedScaffoldingFile[]
  checks: {
    apply_check: {
      status: "passed" | "failed" | "skipped"
      command: string
      stderr?: string
    }
  }
}

export type VerificationStatus = "not_run" | "passed" | "failed" | "timeout" | "infra_failed"

export type VerificationCounts = {
  passed: number
  total: number
}

export type RoundVerificationArtifact = {
  schema: "pact-round-verification/v1"
  artifact_version: 1
  round: number
  created_at: string
  command?: string
  source?: "lightweight" | "finalize"
  status: VerificationStatus
  exit_code?: number | null
  duration_ms?: number
  patch_sha256?: string
  applied?: boolean
  resolved?: boolean
  build_status?: string
  f2p?: VerificationCounts
  p2p?: VerificationCounts
  error_categories?: string[]
  failure_signature?: string
  log_path: string
  log_tail?: string
}

export type ContinuationPackageArtifact = {
  schema: "pact-continuation-package/v1"
  artifact_version: 1
  round: number
  next_round: number
  created_at: string
  loop_phase: LoopPhase
  worker_round_count: number
  max_rounds: number
  remaining_worker_rounds: number
  patch_sha256?: string
  changed_files: string[]
  latest_failure_signature?: string
  next_worker_instruction?: string
  feedback_path?: string
  verification?: {
    status: VerificationStatus
    build_status?: string
    path: string
  }
}

export type FailureCategory =
  | "planner_failed"
  | "missing_summary"
  | "worker_failed"
  | "reviewer_failed"
  | "empty_patch"
  | "malformed_patch"
  | "patch_apply_failed"
  | "build_test_failed"
  | "build_gate_failed"
  | "max_rounds_without_build_success"
  | "verification_timeout"
  | "agent_timeout"
  | "max_rounds"
  | "cancelled"
  | "unknown"

export type FailureClassificationInput = {
  status?: LoopStatus
  missing_summary?: boolean
  missingSummary?: boolean
  worker_failed?: boolean
  workerFailed?: boolean
  reviewer_failed?: boolean
  reviewerFailed?: boolean
  empty_patch?: boolean
  emptyPatch?: boolean
  malformed_patch?: boolean
  malformedPatch?: boolean
  patch_apply_status?: "passed" | "failed" | "skipped"
  patchApplyStatus?: "passed" | "failed" | "skipped"
  build_failed?: boolean
  buildFailed?: boolean
  tests_failed?: boolean
  testsFailed?: boolean
  build_gate_failed?: boolean
  buildGateFailed?: boolean
  max_rounds_without_build_success?: boolean
  maxRoundsWithoutBuildSuccess?: boolean
  verification_timeout?: boolean
  verificationTimeout?: boolean
  timed_out?: boolean
  timedOut?: boolean
  max_rounds_reached?: boolean
  maxRoundsReached?: boolean
  planner_failed?: boolean
  plannerFailed?: boolean
}

export type RoundResultArtifact = {
  schema: "pact-round-result/v1"
  artifact_version: 1
  loop_id: string
  round: number
  status: LoopStatus
  created_at: string
  failure_category: FailureCategory | null
  review_marker?: ReviewMarker
  loop_phase?: LoopPhase
  planner_backend?: PlannerBackend
  planner_model?: string | null
  reviewer_backend?: ReviewerBackend
  reviewer_model?: string | null
  worker_backend?: string
  worker_model?: string | null
  worker_config_source?: string | null
  metrics: Record<string, string | number | boolean | null>
  artifacts: Record<string, string>
}

export type ReviewDecisionArtifact = {
  schema: "pact-review-decision/v1"
  artifact_version: 1
  loop_id: string
  round: number
  marker: ReviewMarker
  parse_status: ReviewDecision["parseStatus"]
  terminal_line: string
  review_path: string
  feedback_path?: string
  raw_marker?: ReviewMarker
  accepted?: boolean
  blocked_by?: "patch_apply" | "build_gate"
  verification_ref?: string
  reviewer_backend?: ReviewerBackend
  reviewer_model?: string | null
  resulting_status: LoopStatus
  resulting_phase?: LoopPhase
  created_at: string
  reason?: string
}

export type ReplayCaseArtifact = {
  schema: "pact-replay-case/v1" | "pact-replay-case/v2"
  artifact_version: 1 | 2
  loop_id: string
  round: number
  source_loop_id: string
  source_round: number
  project_root: string
  case_id: string
  created_at: string
  plan: {
    path: string
    sha256: string
    text: string
  }
  round_context: RoundContextArtifact
  worker_prompt: {
    path: string
    sha256: string
    text: string
  }
  feedback: {
    path: string
    sha256: string
    text: string
  } | null
  patch_artifact: PatchArtifact
  review_decision: ReviewDecisionArtifact
  baseline_result: RoundResultArtifact
  inputs: {
    plan_path: string
    plan_sha256: string
    plan_text: string
    prompt_path: string
    prompt_sha256: string
    prompt_text: string
    feedback_path?: string
    feedback_sha256?: string
    feedback_text?: string
  }
  artifacts: Record<string, string>
  snapshots?: {
    pre?: unknown
    post?: unknown
  }
  trajectory?: unknown
  evidence?: unknown
  verification?: RoundVerificationArtifact
  continuation_package?: ContinuationPackageArtifact
  context: RoundContextArtifact
  patch: PatchArtifact
  review: ReviewDecisionArtifact
  expected_result: RoundResultArtifact
  events: {
    path: string
    sha256: string
    count: number
  }
}

export function formatLoopID(now = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-")
}

export function roundName(round: number): string {
  return String(round).padStart(2, "0")
}

export function artifactPaths(loopDir: string, round: number): ArtifactPaths {
  const roundPrefix = `round-${roundName(round)}`
  return {
    loopManifest: join(loopDir, "loop-manifest.json"),
    roundState: join(loopDir, `${roundPrefix}-state.json`),
    roundContext: join(loopDir, `${roundPrefix}-context.json`),
    roundEvents: join(loopDir, `${roundPrefix}-events.jsonl`),
    preSnapshot: join(loopDir, `${roundPrefix}-pre-snapshot.json`),
    postSnapshot: join(loopDir, `${roundPrefix}-post-snapshot.json`),
    trajectory: join(loopDir, `${roundPrefix}-trajectory.json`),
    evidenceJson: join(loopDir, `${roundPrefix}-evidence.json`),
    evidenceMarkdown: join(loopDir, `${roundPrefix}-evidence.md`),
    workspacePatch: join(loopDir, `${roundPrefix}-workspace.patch`),
    evalPatch: join(loopDir, `${roundPrefix}-eval.patch`),
    testPatch: join(loopDir, `${roundPrefix}-test.patch`),
    patchArtifact: join(loopDir, `${roundPrefix}-patch-artifact.json`),
    verification: join(loopDir, `${roundPrefix}-verification.json`),
    verificationLog: join(loopDir, `${roundPrefix}-verification.log`),
    continuationPackage: join(loopDir, `${roundPrefix}-continuation-package.md`),
    continuationPackageJson: join(loopDir, `${roundPrefix}-continuation-package.json`),
    reviewDecision: join(loopDir, `${roundPrefix}-review-decision.json`),
    roundResult: join(loopDir, `${roundPrefix}-result.json`),
    roundReplayCase: join(loopDir, `${roundPrefix}-replay-case.json`),
    replayCase: join(loopDir, "replay-case.json"),
  }
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8")
}

export function appendJsonLine(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, JSON.stringify(value) + "\n", "utf-8")
}

export function ensureGitInfoExclude(projectRoot: string, pattern = ".pact/"): boolean {
  try {
    const rawExcludePath = gitStdout(projectRoot, ["rev-parse", "--git-path", "info/exclude"]).trim()
    if (!rawExcludePath) return false
    const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : join(projectRoot, rawExcludePath)
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : ""
    const lines = current.split(/\r?\n/).map((line) => line.trim())
    if (lines.includes(pattern)) return true
    mkdirSync(dirname(excludePath), { recursive: true })
    const separator = current && !current.endsWith("\n") ? "\n" : ""
    appendFileSync(excludePath, `${separator}${pattern}\n`, "utf-8")
    return true
  } catch {
    return false
  }
}

export function readState(loopDir: string): PactState {
  const state = JSON.parse(readFileSync(join(loopDir, "state.json"), "utf-8")) as PactState
  state.phase ??= state.status === "complete" ? "complete" : state.status === "stopped" ? "stopped" : "implementation"
  state.full_alignment_interval ??= 5
  const legacyRoundCount =
    state.worker_round_count ?? Math.max(0, Math.max(1, Number(state.current_round) || 1) - 1)
  state.next_round ??= state.current_round ?? 1
  state.current_round = state.next_round
  state.attempted_worker_rounds ??= legacyRoundCount
  state.completed_worker_rounds ??= legacyRoundCount
  state.reviewed_worker_rounds ??= legacyRoundCount
  state.worker_round_count ??= state.completed_worker_rounds
  state.session_strategy ??= "same-session"
  state.round_boundary ??= "session_idle"
  state.trajectory_mode ??= "structured"
  state.active_round_session_id ??= state.active_session_id
  return state
}

export function writeState(loopDir: string, state: PactState): void {
  if (state.next_round === undefined || state.current_round !== state.next_round) {
    state.next_round = state.current_round
  }
  state.current_round = state.next_round
  if (state.worker_round_count !== undefined && state.worker_round_count !== state.completed_worker_rounds) {
    state.completed_worker_rounds = state.worker_round_count
    state.reviewed_worker_rounds = Math.max(state.reviewed_worker_rounds ?? 0, state.worker_round_count)
    state.attempted_worker_rounds = Math.max(state.attempted_worker_rounds ?? 0, state.worker_round_count)
  }
  state.worker_round_count = state.completed_worker_rounds ?? state.worker_round_count ?? 0
  state.updated_at = new Date().toISOString()
  writeFileSync(join(loopDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8")
}

export function markWorkerRoundAttempted(loopDir: string, round: number): PactState {
  const state = readState(loopDir)
  markStateWorkerRoundAttempted(state, round)
  writeState(loopDir, state)
  return state
}

export function markWorkerRoundCompleted(loopDir: string, round: number): PactState {
  const state = readState(loopDir)
  markStateWorkerRoundAttempted(state, round)
  markStateWorkerRoundCompleted(state, round)
  writeState(loopDir, state)
  return state
}

function markStateWorkerRoundAttempted(state: PactState, round: number): void {
  state.attempted_worker_rounds = Math.max(state.attempted_worker_rounds ?? 0, round)
}

function markStateWorkerRoundCompleted(state: PactState, round: number): void {
  state.completed_worker_rounds = Math.max(state.completed_worker_rounds ?? 0, round)
  state.worker_round_count = state.completed_worker_rounds
}

function markStateWorkerRoundReviewed(state: PactState, round: number): void {
  state.reviewed_worker_rounds = Math.max(state.reviewed_worker_rounds ?? 0, round)
}

function setNextRoundCursor(state: PactState, round: number): void {
  state.next_round = round
  state.current_round = round
}

export function createLoop(input: CreateLoopInput): LoopInfo {
  const now = input.now ?? new Date()
  const baseLoopID = formatLoopID(now)
  let loopID = baseLoopID
  let loopDir = join(input.projectRoot, ".pact", "loops", loopID)
  for (let attempt = 2; existsSync(loopDir); attempt++) {
    loopID = `${baseLoopID}-${String(attempt).padStart(2, "0")}`
    loopDir = join(input.projectRoot, ".pact", "loops", loopID)
  }
  for (const pattern of GIT_INFO_EXCLUDE_PATTERNS) {
    ensureGitInfoExclude(input.projectRoot, pattern)
  }
  mkdirSync(loopDir, { recursive: true })

  const planSource = isAbsolute(input.planFile) ? input.planFile : join(input.projectRoot, input.planFile)
  if (!existsSync(planSource)) {
    throw new Error(`Plan file not found: ${input.planFile}`)
  }
  copyFileSync(planSource, join(loopDir, "source-plan.md"))
  copyFileSync(planSource, join(loopDir, "plan.md"))
  const planText = readFileSync(join(loopDir, "plan.md"), "utf-8")
  const initialArtifacts = normalizePlanLedger({ planPath: input.planFile, planContent: planText })
  writeFileSync(join(loopDir, "todo.md"), initialArtifacts.todo, "utf-8")
  writeFileSync(join(loopDir, "goal-tracker.md"), initialArtifacts.goalTracker, "utf-8")
  const goalTrackerImmutableSha = goalTrackerImmutableSha256(readFileSync(join(loopDir, "goal-tracker.md"), "utf-8"))
  const baseCommit = input.baseCommit ?? currentHeadCommit(input.projectRoot)
  const sessionStrategy = input.sessionStrategy ?? "new-per-round"
  const roundBoundary = input.roundBoundary ?? "session_idle"
  const trajectoryMode = input.trajectoryMode ?? "full-redact"

  const state: PactState = {
    version: 2,
    status: "running",
    phase: "implementation",
    loop_id: loopID,
    next_round: 1,
    current_round: 1,
    max_rounds: input.maxRounds ?? 8,
    attempted_worker_rounds: 0,
    completed_worker_rounds: 0,
    reviewed_worker_rounds: 0,
    worker_round_count: 0,
    full_alignment_interval: Math.max(2, input.fullAlignmentInterval ?? 5),
    plan_file: input.planFile,
    source_plan_file: input.planFile,
    source_plan_path: join(loopDir, "source-plan.md"),
    active_session_id: input.workerSessionID,
    active_round_session_id: input.workerSessionID,
    session_strategy: sessionStrategy,
    round_boundary: roundBoundary,
    trajectory_mode: trajectoryMode,
    planner_backend: input.plannerBackend ?? "codex-cli",
    planner_model: input.plannerModel,
    reviewer_backend: input.reviewerBackend ?? "codex-cli",
    reviewer_model: input.reviewerModel,
    worker_backend: input.workerBackend,
    worker_model: input.workerModel,
    worker_config_source: input.workerConfigSource,
    verification_command: input.verificationCommand,
    verification_timeout_ms: input.verificationTimeoutMs,
    goal_tracker_immutable_sha256: goalTrackerImmutableSha,
    base_commit: baseCommit,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }
  writeFileSync(join(loopDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8")
  writeJsonFile(artifactPaths(loopDir, 1).loopManifest, {
    schema: "pact-loop-manifest/v1",
    artifact_version: 2,
    loop_id: loopID,
    project_root: input.projectRoot,
    plan_file: input.planFile,
    source_plan_path: join(loopDir, "source-plan.md"),
    source_plan_sha256: sha256Text(readFileSync(join(loopDir, "source-plan.md"), "utf-8")),
    plan_sha256: sha256Text(readFileSync(join(loopDir, "plan.md"), "utf-8")),
    round0_enabled: true,
    max_rounds: state.max_rounds,
    next_round: state.next_round,
    current_round_deprecated_alias: state.current_round,
    attempted_worker_rounds: state.attempted_worker_rounds,
    completed_worker_rounds: state.completed_worker_rounds,
    reviewed_worker_rounds: state.reviewed_worker_rounds,
    full_alignment_interval: state.full_alignment_interval,
    session_strategy: sessionStrategy,
    round_boundary: roundBoundary,
    trajectory_mode: trajectoryMode,
    phase_config: {
      implementation: true,
      full_alignment: true,
      review: true,
      finalize: true,
      stop_hook: false,
      gate: roundBoundary,
    },
    planner_backend: state.planner_backend,
    planner_model: state.planner_model,
    reviewer_backend: state.reviewer_backend,
    reviewer_model: state.reviewer_model,
    worker_backend: state.worker_backend,
    worker_model: state.worker_model,
    worker_config_source: state.worker_config_source,
    verification_enabled: Boolean(state.verification_command),
    verification_command: state.verification_command,
    verification_timeout_ms: state.verification_timeout_ms,
    goal_tracker_immutable_sha256: state.goal_tracker_immutable_sha256,
    base_commit: state.base_commit,
    active_session_id: state.active_session_id,
    active_round_session_id: state.active_round_session_id,
    created_at: state.created_at,
  })
  writeRoundState({
    loopDir,
    loopID,
    round: 0,
    phase: "round_finished",
    loopPhase: "implementation",
    sessionID: state.active_round_session_id,
    status: "complete",
    notes: "Round 00 initializes the canonical plan, todo ledger, goal tracker, and base snapshot.",
  })
  writeRoundSnapshot({ projectRoot: input.projectRoot, loopDir, loopID, round: 0, stage: "git", time: now.toISOString() })
  writeRoundResult({
    loopDir,
    loopID,
    round: 0,
    status: "complete",
    loopPhase: "implementation",
    failure: null,
    plannerBackend: state.planner_backend,
    plannerModel: state.planner_model,
    reviewerBackend: state.reviewer_backend,
    reviewerModel: state.reviewer_model,
    workerBackend: state.worker_backend,
    workerModel: state.worker_model,
    workerConfigSource: state.worker_config_source,
    metrics: { round0: true },
    artifacts: {
      source_plan: join(loopDir, "source-plan.md"),
      canonical_plan: join(loopDir, "plan.md"),
      todo: join(loopDir, "todo.md"),
      goal_tracker: join(loopDir, "goal-tracker.md"),
      git_snapshot: join(loopDir, "round-00-git-snapshot.json"),
    },
    time: now.toISOString(),
  })
  commitRoundHistory(loopDir, 0, "round-00 initialization")

  return { loopID, loopDir, statePath: join(loopDir, "state.json") }
}

export function writeRoundState(input: {
  loopDir: string
  loopID: string
  round: number
  phase: RoundPhase
  loopPhase?: LoopPhase
  startedAt?: string
  updatedAt?: string
  sessionID?: string
  status?: LoopStatus
  notes?: string
}): RoundStateArtifact {
  const now = new Date().toISOString()
  const artifact: RoundStateArtifact = {
    schema: "pact-round-state/v1",
    artifact_version: 1,
    loop_id: input.loopID,
    round: input.round,
    phase: input.phase,
    loop_phase: input.loopPhase,
    started_at: input.startedAt ?? now,
    updated_at: input.updatedAt ?? now,
    summary_path: summaryPath(input.loopDir, input.round),
    review_path: join(input.loopDir, `round-${roundName(input.round)}-review.md`),
    feedback_path: join(input.loopDir, `round-${roundName(input.round)}-feedback.md`),
    result_path: artifactPaths(input.loopDir, input.round).roundResult,
    session_id: input.sessionID,
    status: input.status,
    notes: input.notes,
  }
  writeJsonFile(artifactPaths(input.loopDir, input.round).roundState, stripUndefined(artifact))
  return artifact
}

export function writeRoundContext(input: {
  loopDir: string
  loopID: string
  round: number
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
  promptPath: string
  todoPath: string
  goalTrackerPath: string
  feedbackPath?: string
}): RoundContextArtifact {
  const feedbackText =
    input.feedbackPath && existsSync(input.feedbackPath) ? readFileSync(input.feedbackPath, "utf-8") : ""
  const artifact: RoundContextArtifact = {
    schema: "pact-round-context/v1",
    artifact_version: 1,
    loop_id: input.loopID,
    round: input.round,
    session_id: input.sessionID,
    worker_agent: input.workerAgent,
    worker_backend: input.workerBackend,
    worker_model: input.workerModel,
    worker_config_source: input.workerConfigSource,
    loop_phase: input.loopPhase,
    planner_backend: input.plannerBackend,
    planner_model: input.plannerModel,
    reviewer_backend: input.reviewerBackend,
    reviewer_model: input.reviewerModel,
    prompt_path: input.promptPath,
    prompt_sha256: sha256Text(readFileSync(input.promptPath, "utf-8")),
    todo_path: input.todoPath,
    todo_sha256: sha256Text(readFileSync(input.todoPath, "utf-8")),
    goal_tracker_path: input.goalTrackerPath,
    goal_tracker_sha256: sha256Text(readFileSync(input.goalTrackerPath, "utf-8")),
    feedback_path: input.feedbackPath ?? "",
    feedback_sha256: sha256Text(feedbackText),
  }
  writeJsonFile(artifactPaths(input.loopDir, input.round).roundContext, stripUndefined(artifact))
  return artifact
}

export function appendRoundEvent(input: {
  loopDir: string
  loopID: string
  round: number
  type: RoundEventType
  sessionID?: string
  data?: unknown
  time?: string
}): RoundEventArtifact {
  const event: RoundEventArtifact = {
    schema: "pact-event/v1",
    artifact_version: 1,
    time: input.time ?? new Date().toISOString(),
    loop_id: input.loopID,
    round: input.round,
    type: input.type,
    session_id: input.sessionID,
    data: redactValue(input.data),
  }
  appendJsonLine(artifactPaths(input.loopDir, input.round).roundEvents, stripUndefined(event))
  return event
}

export function summarizeToolArgs(args: unknown): ToolArgsSummary {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { keys: [] }
  return { keys: Object.keys(args).sort() }
}

export function summarizeToolOutput(input: {
  title?: string
  output?: unknown
  metadata?: unknown
}): ToolOutputSummary {
  const outputText = typeof input.output === "string" ? input.output : JSON.stringify(input.output ?? "")
  const metadataKeys =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? Object.keys(input.metadata).sort()
      : []
  return {
    title: input.title,
    output_length: outputText.length,
    metadata_keys: metadataKeys,
  }
}

export function capturePatchArtifact(input: {
  projectRoot: string
  loopDir: string
  loopID: string
  round: number
  now?: Date
}): PatchArtifact {
  const paths = artifactPaths(input.loopDir, input.round)
  const workspaceExcludes = patchCaptureExcludePathspecs()
  const testPatchPaths = collectTestPatchPaths(input.projectRoot, workspaceExcludes)
  const evalExcludes = [...workspaceExcludes, ...testPatchPaths.map((filePath) => `:(exclude)${filePath}`)]
  const workspaceCapture = captureGitPatch(input.projectRoot, workspaceExcludes)
  const evalCapture = captureGitPatch(input.projectRoot, evalExcludes)
  const testCapture = captureGitPatchForPaths(input.projectRoot, testPatchPaths)
  const excludedScaffoldingFiles = collectExcludedScaffoldingFiles(input.projectRoot)
  const excludedTestPatchFiles = collectPathMetadata(input.projectRoot, testPatchPaths)
  const applyCheck = checkPatchApplies(input.projectRoot, evalCapture.patchText)

  writeFileSync(paths.workspacePatch, workspaceCapture.patchText, "utf-8")
  writeFileSync(paths.evalPatch, evalCapture.patchText, "utf-8")
  writeFileSync(paths.testPatch, testCapture.patchText, "utf-8")
  const workspaceMetadata = patchMetadata(paths.workspacePatch, workspaceCapture.patchText, workspaceCapture.changedFiles)
  const evalMetadata = patchMetadata(paths.evalPatch, evalCapture.patchText, evalCapture.changedFiles)
  const testMetadata = patchMetadata(paths.testPatch, testCapture.patchText, testCapture.changedFiles)
  const artifact: PatchArtifact = {
    schema: "pact-patch-artifact/v1",
    artifact_version: 1,
    loop_id: input.loopID,
    round: input.round,
    captured_at: (input.now ?? new Date()).toISOString(),
    primary_patch: "eval",
    workspace_patch: workspaceMetadata,
    eval_patch: evalMetadata,
    test_patch: testMetadata,
    excluded_scaffolding_files: excludedScaffoldingFiles,
    excluded_test_patch_files: excludedTestPatchFiles,
    checks: {
      apply_check: applyCheck,
    },
  }
  writeJsonFile(paths.patchArtifact, artifact)
  return artifact
}

export function classifyRoundFailure(input: FailureClassificationInput): FailureCategory {
  if (input.status === "cancelled") return "cancelled"
  if (input.planner_failed || input.plannerFailed) return "planner_failed"
  if (input.missing_summary || input.missingSummary) return "missing_summary"
  if (input.worker_failed || input.workerFailed) return "worker_failed"
  if (input.reviewer_failed || input.reviewerFailed) return "reviewer_failed"
  if (input.malformed_patch || input.malformedPatch) return "malformed_patch"
  if (input.patch_apply_status === "failed" || input.patchApplyStatus === "failed") return "patch_apply_failed"
  if (input.empty_patch || input.emptyPatch) return "empty_patch"
  if (input.build_failed || input.buildFailed || input.tests_failed || input.testsFailed) return "build_test_failed"
  if (input.build_gate_failed || input.buildGateFailed) return "build_gate_failed"
  if (input.verification_timeout || input.verificationTimeout) return "verification_timeout"
  if (input.timed_out || input.timedOut) return "agent_timeout"
  if (input.max_rounds_without_build_success || input.maxRoundsWithoutBuildSuccess) {
    return "max_rounds_without_build_success"
  }
  if (input.max_rounds_reached || input.maxRoundsReached) return "max_rounds"
  return "unknown"
}

export function writeRoundResult(input: {
  loopDir: string
  loopID: string
  round: number
  status: LoopStatus
  loopPhase?: LoopPhase
  failure?: FailureClassificationInput | null
  failureCategory?: FailureCategory | null
  reviewMarker?: ReviewMarker
  plannerBackend?: PlannerBackend
  plannerModel?: string | null
  reviewerBackend?: ReviewerBackend
  reviewerModel?: string | null
  workerBackend?: string
  workerModel?: string | null
  workerConfigSource?: string | null
  metrics?: Record<string, string | number | boolean | null>
  artifacts?: Record<string, string>
  time?: string
}): RoundResultArtifact {
  const failureCategory =
    input.failureCategory !== undefined
      ? input.failureCategory
      : input.failure === null
        ? null
        : classifyRoundFailure(input.failure ?? {})
  const state = existsSync(join(input.loopDir, "state.json")) ? readState(input.loopDir) : undefined
  const metrics: Record<string, string | number | boolean | null> = {
    next_round: state?.next_round ?? null,
    attempted_worker_rounds: state?.attempted_worker_rounds ?? null,
    completed_worker_rounds: state?.completed_worker_rounds ?? null,
    reviewed_worker_rounds: state?.reviewed_worker_rounds ?? null,
    ...(input.metrics ?? {}),
  }
  const artifact: RoundResultArtifact = {
    schema: "pact-round-result/v1",
    artifact_version: 1,
    loop_id: input.loopID,
    round: input.round,
    status: input.status,
    loop_phase: input.loopPhase,
    created_at: input.time ?? new Date().toISOString(),
    failure_category: failureCategory,
    review_marker: input.reviewMarker,
    planner_backend: input.plannerBackend,
    planner_model: input.plannerModel,
    reviewer_backend: input.reviewerBackend,
    reviewer_model: input.reviewerModel,
    worker_backend: input.workerBackend ?? state?.worker_backend,
    worker_model: input.workerModel ?? state?.worker_model,
    worker_config_source: input.workerConfigSource ?? state?.worker_config_source,
    metrics,
    artifacts: input.artifacts ?? defaultRoundArtifacts(input.loopDir, input.round),
  }
  writeJsonFile(artifactPaths(input.loopDir, input.round).roundResult, stripUndefined(artifact))
  return artifact
}

export function writeRoundSnapshot(input: {
  projectRoot: string
  loopDir: string
  loopID: string
  round: number
  stage: "pre" | "post" | "git"
  time?: string
}): Record<string, unknown> {
  const paths = artifactPaths(input.loopDir, input.round)
  const filePath =
    input.stage === "pre"
      ? paths.preSnapshot
      : input.stage === "post"
        ? paths.postSnapshot
        : join(input.loopDir, `round-${roundName(input.round)}-git-snapshot.json`)
  const status = safeGitStdout(input.projectRoot, ["status", "--short"])
  const changedFiles = safeGitStdout(input.projectRoot, ["diff", "--name-only", "HEAD", "--", "."])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
  const untrackedFiles = safeGitStdout(input.projectRoot, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
  const diffText = safeGitStdout(input.projectRoot, ["diff", "--binary", "HEAD", "--", "."])
  const artifact = {
    schema: "pact-git-snapshot/v1",
    artifact_version: 1,
    loop_id: input.loopID,
    round: input.round,
    stage: input.stage,
    created_at: input.time ?? new Date().toISOString(),
    project_root: input.projectRoot,
    head: currentHeadCommit(input.projectRoot) ?? null,
    status_short: status,
    changed_files: changedFiles,
    untracked_files: untrackedFiles,
    cumulative_patch: {
      sha256: sha256Text(diffText),
      bytes: Buffer.byteLength(diffText, "utf-8"),
      lines: countLines(diffText),
    },
  }
  writeJsonFile(filePath, artifact)
  return artifact
}

export function writeRoundTrajectory(input: {
  loopDir: string
  loopID: string
  round: number
  sessionID?: string
  entries?: Array<Record<string, unknown>>
  mode?: TrajectoryMode
  time?: string
}): Record<string, unknown> {
  const paths = artifactPaths(input.loopDir, input.round)
  const eventText = existsSync(paths.roundEvents) ? readFileSync(paths.roundEvents, "utf-8") : ""
  const events = eventText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => redactValue(JSON.parse(line)) as Record<string, unknown>)
  const existing = existsSync(paths.trajectory)
    ? (JSON.parse(readFileSync(paths.trajectory, "utf-8")) as { entries?: Array<Record<string, unknown>> })
    : undefined
  const existingEntries = Array.isArray(existing?.entries) ? existing.entries : []
  const newEntries = (input.entries ?? []).map((entry) => redactValue(entry) as Record<string, unknown>)
  const mode = input.mode ?? readState(input.loopDir).trajectory_mode ?? "structured"
  const artifact = {
    schema: "pact-round-trajectory/v1",
    artifact_version: 1,
    loop_id: input.loopID,
    round: input.round,
    session_id: input.sessionID,
    mode,
    created_at: input.time ?? new Date().toISOString(),
    event_count: events.length,
    events,
    entries: [...existingEntries, ...newEntries],
  }
  writeJsonFile(paths.trajectory, stripUndefined(artifact))
  return artifact
}

export function writeRoundEvidence(input: { loopDir: string; round: number; time?: string }): Record<string, unknown> {
  const paths = artifactPaths(input.loopDir, input.round)
  const files = {
    prompt: join(input.loopDir, `round-${roundName(input.round)}-prompt.md`),
    summary: summaryPath(input.loopDir, input.round),
    feedback: join(input.loopDir, `round-${roundName(input.round)}-feedback.md`),
    review: join(input.loopDir, `round-${roundName(input.round)}-review.md`),
    eval_patch: paths.evalPatch,
    test_patch: paths.testPatch,
    patch_artifact: paths.patchArtifact,
    verification: paths.verification,
    verification_log: paths.verificationLog,
    continuation_package: paths.continuationPackage,
    continuation_package_json: paths.continuationPackageJson,
    review_decision: paths.reviewDecision,
    result: paths.roundResult,
    pre_snapshot: paths.preSnapshot,
    post_snapshot: paths.postSnapshot,
    trajectory: paths.trajectory,
  }
  const artifact = {
    schema: "pact-round-evidence/v1",
    artifact_version: 1,
    round: input.round,
    created_at: input.time ?? new Date().toISOString(),
    files: Object.fromEntries(
      Object.entries(files).map(([key, filePath]) => [
        key,
        {
          path: filePath,
          exists: existsSync(filePath),
          sha256: existsSync(filePath) ? sha256Text(readFileSync(filePath, "utf-8")) : null,
        },
      ]),
    ),
  }
  writeJsonFile(paths.evidenceJson, artifact)
  const markdown = [
    `# Round ${roundName(input.round)} Evidence`,
    "",
    "| Artifact | Path | Present | SHA-256 |",
    "| --- | --- | --- | --- |",
    ...Object.entries(artifact.files).map(([key, value]) => {
      const item = value as { path: string; exists: boolean; sha256: string | null }
      return `| ${key} | ${item.path} | ${item.exists ? "yes" : "no"} | ${item.sha256 ?? "-"} |`
    }),
    "",
  ].join("\n")
  writeFileSync(paths.evidenceMarkdown, markdown, "utf-8")
  return artifact
}

export function writeVerificationArtifact(input: {
  loopDir: string
  round: number
  command?: string
  status: VerificationStatus
  exitCode?: number | null
  durationMs?: number
  patchSha256?: string
  applied?: boolean
  resolved?: boolean
  buildStatus?: string
  f2p?: VerificationCounts
  p2p?: VerificationCounts
  errorCategories?: string[]
  failureSignature?: string
  logText?: string
  source?: RoundVerificationArtifact["source"]
  time?: string
}): RoundVerificationArtifact {
  const paths = artifactPaths(input.loopDir, input.round)
  const logText = redactText(input.logText ?? "")
  writeFileSync(paths.verificationLog, logText, "utf-8")
  const logTail = tailLines(logText, 80)
  const artifact = stripUndefined({
    schema: "pact-round-verification/v1",
    artifact_version: 1,
    round: input.round,
    created_at: input.time ?? new Date().toISOString(),
    command: input.command,
    source: input.source,
    status: input.status,
    exit_code: input.exitCode,
    duration_ms: input.durationMs,
    patch_sha256: input.patchSha256,
    applied: input.applied,
    resolved: input.resolved,
    build_status: input.buildStatus,
    f2p: input.f2p,
    p2p: input.p2p,
    error_categories: input.errorCategories,
    failure_signature: input.failureSignature ?? firstUsefulLine(logTail),
    log_path: paths.verificationLog,
    log_tail: logTail || undefined,
  } satisfies RoundVerificationArtifact)
  writeJsonFile(paths.verification, artifact)
  return artifact
}

export function writeContinuationPackage(input: {
  loopDir: string
  round: number
  nextRound: number
  maxRounds: number
  workerRoundCount: number
  loopPhase: LoopPhase
  reviewText?: string
  verification?: RoundVerificationArtifact
  changedFiles?: string[]
  patchSha256?: string
  feedbackPath?: string
  time?: string
}): { artifact: ContinuationPackageArtifact; markdown: string } {
  const paths = artifactPaths(input.loopDir, input.round)
  const remainingWorkerRounds = Math.max(0, input.maxRounds - input.workerRoundCount)
  const rawNextWorkerInstruction = extractNextWorkerInstruction(input.reviewText ?? "")
  const nextWorkerInstruction = workerSafeNextInstruction(rawNextWorkerInstruction, {
    verification: input.verification,
    changedFiles: input.changedFiles ?? [],
  })
  const latestFailureSignature = workerSafeFailureSignature(input.verification?.failure_signature)
  const artifact = stripUndefined({
    schema: "pact-continuation-package/v1",
    artifact_version: 1,
    round: input.round,
    next_round: input.nextRound,
    created_at: input.time ?? new Date().toISOString(),
    loop_phase: input.loopPhase,
    worker_round_count: input.workerRoundCount,
    max_rounds: input.maxRounds,
    remaining_worker_rounds: remainingWorkerRounds,
    patch_sha256: input.patchSha256,
    changed_files: input.changedFiles ?? [],
    latest_failure_signature: latestFailureSignature,
    next_worker_instruction: nextWorkerInstruction,
    verification: input.verification
      ? {
          status: input.verification.status,
          build_status: input.verification.build_status,
        }
      : undefined,
  } satisfies ContinuationPackageArtifact)
  const markdown = buildCurrentStateSnapshot({
    loopDir: input.loopDir,
    reviewText: input.reviewText,
    changedFiles: input.changedFiles ?? [],
    suggestedFocus: nextWorkerInstruction,
  })
  writeJsonFile(paths.continuationPackageJson, artifact)
  writeFileSync(paths.continuationPackage, markdown, "utf-8")
  return { artifact, markdown }
}

function buildCurrentStateSnapshot(input: {
  loopDir: string
  reviewText?: string
  changedFiles?: string[]
  suggestedFocus?: string
}): string {
  const planPath = join(input.loopDir, "plan.md")
  const todoPath = join(input.loopDir, "todo.md")
  const goalTrackerPath = join(input.loopDir, "goal-tracker.md")
  const planText = existsSync(planPath) ? readFileSync(planPath, "utf-8") : ""
  const todoText = existsSync(todoPath) ? readFileSync(todoPath, "utf-8") : ""
  const goalTrackerText = existsSync(goalTrackerPath) ? readFileSync(goalTrackerPath, "utf-8") : ""
  const reviewerFeedback = reviewerFeedbackSnapshot(input.reviewText ?? "", input.suggestedFocus)

  return [
    "# PACT Current State Snapshot",
    "",
    "## Objective",
    snapshotObjective(input.loopDir),
    "",
    "## Acceptance Criteria Status",
    acceptanceCriteriaStatusSnapshot(goalTrackerText, planText),
    "",
    "## Task State",
    taskStateSnapshot(goalTrackerText, todoText),
    "",
    "## Reviewer Feedback To Incorporate",
    "### Constraints",
    reviewerFeedback.constraints,
    "",
    "### Blockers",
    reviewerFeedback.blockers,
    "",
    "### Evidence",
    reviewerFeedback.evidence,
    "",
    "### Suggested Focus",
    reviewerFeedback.suggestedFocus,
    "",
    "## Open Items",
    openItemsSnapshot(goalTrackerText),
    "",
    "## Current Workspace State",
    workspaceStateSnapshot(input.changedFiles ?? []),
    "",
  ].join("\n")
}

function snapshotObjective(loopDir: string, planPath?: string): string {
  const goalTrackerPath = join(loopDir, "goal-tracker.md")
  const goalTrackerText = existsSync(goalTrackerPath) ? readFileSync(goalTrackerPath, "utf-8") : ""
  const planText = existsSync(planPath ?? join(loopDir, "plan.md"))
    ? readFileSync(planPath ?? join(loopDir, "plan.md"), "utf-8")
    : ""
  return (
    sanitizeSnapshotBlock(extractMarkdownSection(goalTrackerText, "Ultimate Goal") ?? "") ||
    sanitizeSnapshotBlock(extractMarkdownSection(planText, "Goal Description") ?? "") ||
    sanitizeSnapshotBlock(extractFirstUsefulPlanLine(planText) ?? "") ||
    "Execute the current PACT plan."
  )
}

function acceptanceCriteriaStatusSnapshot(goalTrackerText: string, planText: string): string {
  const section =
    extractMarkdownSection(goalTrackerText, "Acceptance Criteria") ??
    extractMarkdownSection(planText, "Acceptance Criteria") ??
    ""
  const rows = markdownTableRows(section)
  const dataRows = rows.filter((row) => /^AC-\d+(?:\.\d+)?$/i.test(row[0]?.trim() ?? ""))
  const evidenceByAC = completedEvidenceByAC(goalTrackerText)
  const outputRows = dataRows.map((row) => {
    const ac = row[0]?.trim() || "AC-1"
    const criterion = row[1]?.trim() || "Current acceptance criterion"
    const status = row[4]?.trim() || row[2]?.trim() || "pending"
    const evidence = evidenceByAC.get(ac) ?? "-"
    const remainingGaps = /\b(?:complete|verified|done|resolved|passed)\b/i.test(status)
      ? "none recorded"
      : "See reviewer feedback, open items, and remaining task work."
    return `| ${escapeTableCell(ac)} | ${escapeTableCell(sanitizeSnapshotBlock(criterion))} | ${escapeTableCell(sanitizeSnapshotBlock(status))} | ${escapeTableCell(sanitizeSnapshotBlock(evidence))} | ${escapeTableCell(sanitizeSnapshotBlock(remainingGaps))} |`
  })

  return [
    "| AC | Criterion | Current Status | Evidence So Far | Remaining Gaps |",
    "| --- | --- | --- | --- | --- |",
    ...(outputRows.length
      ? outputRows
      : ["| AC-1 | Current plan requirements | pending | - | Read plan.md and goal-tracker.md. |"]),
  ].join("\n")
}

function taskStateSnapshot(goalTrackerText: string, todoText: string): string {
  const todoRows = markdownTableRows(todoText).filter((row) => /^task-\d+/i.test(row[0]?.trim() ?? ""))
  const activeRows = markdownTableRows(extractMarkdownSection(goalTrackerText, "Active Tasks") ?? "").filter((row) =>
    /^task-\d+/i.test(row[0]?.trim() ?? ""),
  )
  const rows = todoRows.length ? todoRows : activeRows
  const evidenceByTask = completedEvidenceByTask(goalTrackerText)
  const outputRows = rows.map((row) => {
    const task = row[0]?.trim() || "task-1"
    const fromTodo = todoRows.length > 0
    const description = fromTodo ? row[1]?.trim() || task : row[5]?.trim() || task
    const status = fromTodo ? row[5]?.trim() || "pending" : row[2]?.trim() || "pending"
    const evidence = evidenceByTask.get(task) ?? "-"
    const remainingWork = /\b(?:complete|verified|done|resolved|passed)\b/i.test(status)
      ? "none"
      : description || "Continue this task."
    return `| ${escapeTableCell(task)} | ${escapeTableCell(sanitizeSnapshotBlock(status))} | ${escapeTableCell(sanitizeSnapshotBlock(evidence))} | ${escapeTableCell(sanitizeSnapshotBlock(remainingWork))} |`
  })

  return [
    "| Task | Status | Evidence So Far | Remaining Work |",
    "| --- | --- | --- | --- |",
    ...(outputRows.length
      ? outputRows
      : ["| task-1 | pending | - | Choose the smallest coherent next step toward the objective. |"]),
  ].join("\n")
}

function reviewerFeedbackSnapshot(
  reviewText: string,
  suggestedFocus: string | undefined,
): { constraints: string; blockers: string; evidence: string; suggestedFocus: string } {
  const safeSuggestedFocus = sanitizeSnapshotBlock(suggestedFocus ?? "")
  const constraints = bulletList([
    "Do not modify PACT artifacts or run gates; make workspace-only source changes.",
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Constraints") ?? ""),
  ])
  const blockers = bulletList([
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Findings") ?? ""),
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Blocking Side Issues") ?? ""),
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Acceptance Criteria Audit") ?? ""),
  ])
  const evidence = bulletList([
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Claim Audit") ?? ""),
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Public Verification Gate") ?? ""),
    sanitizeSnapshotBlock(extractMarkdownSection(reviewText, "Goal Alignment Summary") ?? ""),
  ])
  const focusBody = safeSuggestedFocus
    ? `${safeSuggestedFocus}\n\nThis is guidance, not a replacement for the objective.`
    : "(none identified)\n\nThis is guidance, not a replacement for the objective."
  return {
    constraints,
    blockers,
    evidence,
    suggestedFocus: focusBody,
  }
}

function openItemsSnapshot(goalTrackerText: string): string {
  const openIssueRows = markdownTableRows(extractMarkdownSection(goalTrackerText, "Open Issues") ?? "").filter((row) =>
    row.some((cell) => cell.trim()),
  )
  const deferredRows = markdownTableRows(extractMarkdownSection(goalTrackerText, "Explicitly Deferred") ?? "").filter((row) =>
    row.some((cell) => cell.trim()),
  )
  const outputRows = [
    ...openIssueRows.map((row) => {
      const item = row[0]?.trim() || "open issue"
      const round = row[1]?.trim() || "-"
      const blocksAC = row[2]?.trim() || "-"
      const notes = row[3]?.trim() || "-"
      return `| ${escapeTableCell(sanitizeSnapshotBlock(item))} | ${escapeTableCell(sanitizeSnapshotBlock(blocksAC))} | ${escapeTableCell(sanitizeSnapshotBlock(`open since ${round}`))} | ${escapeTableCell(sanitizeSnapshotBlock(notes))} |`
    }),
    ...deferredRows.map((row) => {
      const item = row[0]?.trim() || "deferred item"
      const blocksAC = row[1]?.trim() || "-"
      const since = row[2]?.trim() || "-"
      const notes = [row[3], row[4]].filter(Boolean).join("; ") || "-"
      return `| ${escapeTableCell(sanitizeSnapshotBlock(item))} | ${escapeTableCell(sanitizeSnapshotBlock(blocksAC))} | ${escapeTableCell(sanitizeSnapshotBlock(`deferred since ${since}`))} | ${escapeTableCell(sanitizeSnapshotBlock(notes))} |`
    }),
  ]
  return [
    "| Item | Blocks AC | Status | Notes |",
    "| --- | --- | --- | --- |",
    ...(outputRows.length ? outputRows : ["| (none recorded) | - | - | - |"]),
  ].join("\n")
}

function workspaceStateSnapshot(changedFiles: string[]): string {
  const safeFiles = changedFiles
    .map((filePath) => sanitizeSnapshotBlock(filePath))
    .filter((filePath) => filePath && !isWorkerUnsafeLine(filePath))
    .slice(0, 25)
  if (!safeFiles.length) {
    return "- No changed files were recorded in the latest worker snapshot."
  }
  return ["- Changed workspace files to inspect for current behavior:", ...safeFiles.map((filePath) => `  - ${filePath}`)].join(
    "\n",
  )
}

function markdownTableRows(markdown: string): string[][] {
  const rows = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
    .filter((row) => !isMarkdownSeparatorRow(row))
  if (rows.length > 1 && !/^AC-\d+|^task-\d+/i.test(rows[0]?.[0] ?? "")) return rows.slice(1)
  return rows
}

function isMarkdownSeparatorRow(row: string[]): boolean {
  return row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function completedEvidenceByAC(goalTrackerText: string): Map<string, string> {
  const rows = markdownTableRows(extractMarkdownSection(goalTrackerText, "Completed and Verified") ?? "")
  const evidence = new Map<string, string>()
  for (const row of rows) {
    const ac = row[0]?.trim()
    const value = row[4]?.trim()
    if (ac && value) evidence.set(ac, value)
  }
  return evidence
}

function completedEvidenceByTask(goalTrackerText: string): Map<string, string> {
  const rows = markdownTableRows(extractMarkdownSection(goalTrackerText, "Completed and Verified") ?? "")
  const evidence = new Map<string, string>()
  for (const row of rows) {
    const task = row[1]?.trim()
    const value = row[4]?.trim()
    if (task && value) evidence.set(task, value)
  }
  return evidence
}

function bulletList(items: string[]): string {
  const bullets = items
    .flatMap((item) => item.split(/\r?\n/))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => `- ${line}`)
  return bullets.length ? bullets.join("\n") : "- (none identified)"
}

function sanitizeSnapshotBlock(text: string): string {
  return sanitizeWorkerFacingText(text).slice(0, 2000).trim()
}

export function exportReplayCase(input: {
  loopDir: string
  round?: number
  loopID?: string
  time?: string
}): ReplayCaseArtifact {
  const state = readState(input.loopDir)
  const round = input.round ?? state.current_round
  const loopID = input.loopID ?? state.loop_id
  const paths = artifactPaths(input.loopDir, round)
  const planPath = join(input.loopDir, "plan.md")
  const promptPath = join(input.loopDir, `round-${roundName(round)}-prompt.md`)
  const context = readJsonFile<RoundContextArtifact>(paths.roundContext)
  const feedbackPath = replayFeedbackPath(input.loopDir, context)
  const planText = readRequiredText(planPath)
  const promptText = readRequiredText(promptPath)
  const feedbackText = feedbackPath && existsSync(feedbackPath) ? readFileSync(feedbackPath, "utf-8") : undefined
  const eventText = existsSync(paths.roundEvents) ? readFileSync(paths.roundEvents, "utf-8") : ""
  const manifest = readJsonFile<{ project_root?: unknown }>(paths.loopManifest)
  const projectRoot = typeof manifest.project_root === "string" ? manifest.project_root : ""
  const patch = readJsonFile<PatchArtifact>(paths.patchArtifact)
  const review = readJsonFile<ReviewDecisionArtifact>(paths.reviewDecision)
  const result = readJsonFile<RoundResultArtifact>(paths.roundResult)
  const preSnapshot = existsSync(paths.preSnapshot) ? readJsonFile<unknown>(paths.preSnapshot) : undefined
  const postSnapshot = existsSync(paths.postSnapshot) ? readJsonFile<unknown>(paths.postSnapshot) : undefined
  const trajectory = existsSync(paths.trajectory) ? readJsonFile<unknown>(paths.trajectory) : undefined
  const evidence = existsSync(paths.evidenceJson) ? readJsonFile<unknown>(paths.evidenceJson) : undefined
  const verification = existsSync(paths.verification) ? readJsonFile<RoundVerificationArtifact>(paths.verification) : undefined
  const continuationPackage = existsSync(paths.continuationPackageJson)
    ? readJsonFile<ContinuationPackageArtifact>(paths.continuationPackageJson)
    : undefined
  const plan = {
    path: planPath,
    sha256: sha256Text(planText),
    text: planText,
  }
  const workerPrompt = {
    path: promptPath,
    sha256: sha256Text(promptText),
    text: promptText,
  }
  const feedback =
    !feedbackPath || feedbackText === undefined
      ? null
      : {
          path: feedbackPath,
          sha256: sha256Text(feedbackText),
          text: feedbackText,
  }
  const artifact: ReplayCaseArtifact = {
    schema: "pact-replay-case/v2",
    artifact_version: 2,
    loop_id: loopID,
    round,
    source_loop_id: loopID,
    source_round: round,
    project_root: projectRoot,
    case_id: `${loopID}-round-${roundName(round)}`,
    created_at: input.time ?? new Date().toISOString(),
    plan,
    round_context: context,
    worker_prompt: workerPrompt,
    feedback,
    patch_artifact: patch,
    review_decision: review,
    baseline_result: result,
    inputs: {
      plan_path: planPath,
      plan_sha256: plan.sha256,
      plan_text: planText,
      prompt_path: promptPath,
      prompt_sha256: workerPrompt.sha256,
      prompt_text: promptText,
      feedback_path: !feedbackPath || feedbackText === undefined ? undefined : feedbackPath,
      feedback_sha256: feedbackText === undefined ? undefined : sha256Text(feedbackText),
      feedback_text: feedbackText,
    },
    artifacts: defaultRoundArtifacts(input.loopDir, round),
    snapshots: stripUndefined({
      pre: preSnapshot,
      post: postSnapshot,
    }),
    trajectory,
    evidence,
    verification,
    continuation_package: continuationPackage,
    context,
    patch,
    review,
    expected_result: result,
    events: {
      path: paths.roundEvents,
      sha256: sha256Text(eventText),
      count: eventText ? eventText.trimEnd().split(/\r?\n/).length : 0,
    },
  }
  writeJsonFile(paths.roundReplayCase, stripUndefined(artifact))
  writeJsonFile(paths.replayCase, stripUndefined(artifact))
  commitRoundHistory(input.loopDir, round, `round-${roundName(round)} replay export`)
  return artifact
}

function replayFeedbackPath(loopDir: string, context: RoundContextArtifact): string | undefined {
  if (!context.feedback_path) return undefined
  return isAbsolute(context.feedback_path) ? context.feedback_path : join(loopDir, context.feedback_path)
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
  const plan = extractBlock(text, "PACT_PLAN")
  const todo = extractBlock(text, "PACT_TODO")
  const goalTracker = extractBlock(text, "PACT_GOAL_TRACKER")
  const sanitizedPlan = plan ? sanitizePlannerArtifactText(plan) : undefined
  const sanitizedTodo = sanitizePlannerArtifactText(todo ?? defaultTodo())
  const sanitizedGoalTracker = sanitizePlannerArtifactText(goalTracker ?? defaultGoalTracker("plan.md"))
  return {
    plan: sanitizedPlan?.trim() ? sanitizedPlan.trim() + "\n" : undefined,
    todo: normalizeTodoArtifact(sanitizedTodo).trim() + "\n",
    goalTracker: normalizeGoalTrackerArtifact(sanitizedGoalTracker, "plan.md").trim() + "\n",
    markerPresence: {
      plan: plan !== undefined,
      todo: todo !== undefined,
      goalTracker: goalTracker !== undefined,
    },
  }
}

export function applyPlannerArtifacts(loopDir: string, artifacts: PlannerArtifacts): void {
  if (artifacts.plan) {
    writeFileSync(join(loopDir, "plan.md"), sanitizePlannerArtifactText(artifacts.plan).trim() + "\n", "utf-8")
  }
  writeFileSync(join(loopDir, "todo.md"), normalizeTodoArtifact(sanitizePlannerArtifactText(artifacts.todo)).trim() + "\n", "utf-8")
  writeFileSync(
    join(loopDir, "goal-tracker.md"),
    normalizeGoalTrackerArtifact(sanitizePlannerArtifactText(artifacts.goalTracker), "plan.md").trim() + "\n",
    "utf-8",
  )
  refreshGoalTrackerImmutableHash(loopDir)
  refreshLoopManifest(loopDir)
}

export function refreshLoopManifest(loopDir: string): void {
  const manifestPath = artifactPaths(loopDir, 1).loopManifest
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>
  const state = readState(loopDir)
  const sourcePlanPath = join(loopDir, "source-plan.md")
  const planPath = join(loopDir, "plan.md")

  if (existsSync(sourcePlanPath)) {
    manifest.source_plan_sha256 = sha256Text(readFileSync(sourcePlanPath, "utf-8"))
  }
  if (existsSync(planPath)) {
    manifest.plan_sha256 = sha256Text(readFileSync(planPath, "utf-8"))
  }
  manifest.goal_tracker_immutable_sha256 = state.goal_tracker_immutable_sha256
  manifest.planner_backend = state.planner_backend
  manifest.planner_model = state.planner_model
  manifest.reviewer_backend = state.reviewer_backend
  manifest.reviewer_model = state.reviewer_model
  manifest.worker_backend = state.worker_backend
  manifest.worker_model = state.worker_model
  manifest.worker_config_source = state.worker_config_source
  manifest.active_session_id = state.active_session_id
  manifest.active_round_session_id = state.active_round_session_id
  writeJsonFile(manifestPath, stripUndefined(manifest))
}

export function validatePlannerArtifacts(artifacts: PlannerArtifacts): PlannerValidationResult {
  const missing: string[] = []
  const errors: string[] = []
  const plan = artifacts.plan ?? ""
  if (!plan.trim()) {
    missing.push("canonical_plan")
  }
  if (artifacts.markerPresence?.plan === false) missing.push("plan_marker")
  if (artifacts.markerPresence?.todo === false) missing.push("todo_marker")
  if (artifacts.markerPresence?.goalTracker === false) missing.push("goal_tracker_marker")
  for (const section of [
    "Goal Description",
    "Acceptance Criteria",
    "Path Boundaries",
    "Dependencies",
    "Task Breakdown",
    "Pending Decisions",
  ]) {
    if (!new RegExp(`^#{1,3}\\s+${escapeRegExp(section)}\\b`, "im").test(plan)) missing.push(section)
  }
  if (!/\bAC-\d+(?:\.\d+)?\b/.test(plan)) errors.push("canonical plan must contain AC-* identifiers")
  if (!/Positive Tests?/i.test(plan)) errors.push("canonical plan must include positive tests")
  if (!/Negative Tests?/i.test(plan)) errors.push("canonical plan must include negative tests")
  if (!/\| Task ID \| Description \| Target AC \| Tag \| Depends On/.test(plan)) {
    errors.push("canonical plan must include a task breakdown table")
  }
  if (!/\| Task ID \| Description \| Target AC \| Tag \| Depends On \| Status \|/.test(artifacts.todo)) {
    errors.push("todo must include the PACT task table")
  }
  if (!artifacts.goalTracker.includes("## IMMUTABLE SECTION")) missing.push("goal_tracker_immutable_section")
  if (!artifacts.goalTracker.includes("## MUTABLE SECTION")) missing.push("goal_tracker_mutable_section")
  if (!/\| AC \| Criterion \| Positive Tests \| Negative Tests \| Status \|/.test(artifacts.goalTracker)) {
    errors.push("goal tracker must include acceptance criteria with positive and negative tests")
  }
  return {
    ok: missing.length === 0 && errors.length === 0,
    missing: [...new Set(missing)],
    errors,
  }
}

export function buildPlannerRepairPrompt(input: {
  previousOutput: string
  validation: PlannerValidationResult
  sourcePlan?: string
}): string {
  return `# Repair the PACT planner output

The previous planner output did not satisfy the canonical PACT plan contract.

Missing:
${input.validation.missing.map((item) => `- ${item}`).join("\n") || "- (none)"}

Errors:
${input.validation.errors.map((item) => `- ${item}`).join("\n") || "- (none)"}

${input.sourcePlan ? `## Source Plan\n${input.sourcePlan}\n` : ""}

## Previous Output
${input.previousOutput}

Return the complete corrected output with exactly these three marker blocks:
- <<<PACT_PLAN>>> ... <<<END_PACT_PLAN>>>
- <<<PACT_TODO>>> ... <<<END_PACT_TODO>>>
- <<<PACT_GOAL_TRACKER>>> ... <<<END_PACT_GOAL_TRACKER>>>
`
}

export function parseReviewDecision(text: string): ReviewDecision {
  const terminalLine = lastNonEmptyLine(text)
  if (terminalLine === "PACT_COMPLETE") {
    return { marker: "complete", parseStatus: "complete_signal", terminalLine }
  }
  if (terminalLine === "PACT_STOP") {
    return {
      marker: "continue",
      reason: "deprecated_stop_signal_treated_as_continue",
      parseStatus: "deprecated_stop_signal",
      terminalLine,
    }
  }
  if (terminalLine === "PACT_CONTINUE") {
    return { marker: "continue", parseStatus: "deprecated_continue_signal", terminalLine }
  }
  return { marker: "continue", reason: "missing_terminal_signal", parseStatus: "implicit_continue", terminalLine }
}

export function recordReviewDecision(input: {
  loopDir: string
  round: number
  reviewText: string
  reviewerBackend?: ReviewerBackend
  reviewerModel?: string | null
  forceContinue?: {
    parseStatus: "patch_apply_failed" | "build_gate_failed"
    reason: string
    feedback: string
    verification?: RoundVerificationArtifact
  }
}): ReviewDecision {
  const reviewPath = join(input.loopDir, `round-${roundName(input.round)}-review.md`)
  writeFileSync(reviewPath, input.reviewText.trim() + "\n", "utf-8")
  const parsedDecision = parseReviewDecision(input.reviewText)
  const forcedContinue = input.forceContinue && parsedDecision.marker === "complete" ? input.forceContinue : undefined
  const decision =
    forcedContinue
      ? {
          marker: "continue" as const,
          reason: forcedContinue.reason,
          parseStatus: forcedContinue.parseStatus,
          terminalLine: parsedDecision.terminalLine,
        }
      : parsedDecision
  const state = readState(input.loopDir)
  let feedbackPath: string | undefined
  state.last_review_marker = decision.marker
  state.last_review_path = reviewPath
  const implementationWorkerRound = state.phase === "implementation" || state.phase === "full_alignment"
  if (implementationWorkerRound) {
    markStateWorkerRoundAttempted(state, input.round)
    markStateWorkerRoundCompleted(state, input.round)
    markStateWorkerRoundReviewed(state, input.round)
  }

  if (decision.marker === "complete") {
    if (state.phase === "finalize") {
      state.phase = "complete"
      state.status = "complete"
      writeFileSync(
        join(input.loopDir, "complete-state.md"),
        `PACT completed after finalize round ${input.round}.\n`,
        "utf-8",
      )
    } else if (implementationWorkerRound) {
      state.phase = "review"
      setNextRoundCursor(state, input.round + 1)
      advanceRoundSession(state)
      feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
      writeFileSync(feedbackPath, reviewPhaseFeedbackText(input.round), "utf-8")
      state.last_feedback_path = feedbackPath
    } else {
      state.phase = "finalize"
      setNextRoundCursor(state, input.round + 1)
      advanceRoundSession(state)
      feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
      writeFileSync(feedbackPath, finalizeFeedbackText(input.round), "utf-8")
      state.last_feedback_path = feedbackPath
    }
  } else {
    feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
    const feedback = forcedContinue
      ? `${forcedContinue.feedback.trim()}\n\nOriginal reviewer output:\n${stripFinalNonEmptyLine(input.reviewText).trim()}`
      : feedbackText(input.reviewText, decision)
    writeFileSync(feedbackPath, feedback + "\n", "utf-8")
    state.last_feedback_path = feedbackPath
    if (state.phase === "full_alignment" || state.phase === "review") {
      state.phase = "implementation"
    }
    setNextRoundCursor(state, input.round + 1)
    advanceRoundSession(state)
    const reviewedWorkerRounds = state.reviewed_worker_rounds ?? state.completed_worker_rounds ?? state.worker_round_count ?? 0
    if (implementationWorkerRound && reviewedWorkerRounds >= state.max_rounds) {
      state.phase = "stopped"
      state.status = "stopped"
      writeFileSync(join(input.loopDir, "stop-state.md"), `PACT stopped after max round ${input.round}.\n`, "utf-8")
    }
  }
  writeState(input.loopDir, state)
  writeJsonFile(
    artifactPaths(input.loopDir, input.round).reviewDecision,
    stripUndefined({
      schema: "pact-review-decision/v1",
      artifact_version: 1,
      loop_id: state.loop_id,
      round: input.round,
      marker: decision.marker,
      parse_status: decision.parseStatus,
      terminal_line: decision.terminalLine,
      review_path: reviewPath,
      feedback_path: feedbackPath,
      raw_marker: forcedContinue ? parsedDecision.marker : undefined,
      accepted: forcedContinue ? false : decision.marker === "complete",
      blocked_by: forcedContinue
        ? forcedContinue.parseStatus === "build_gate_failed"
          ? "build_gate"
          : "patch_apply"
        : undefined,
      verification_ref: forcedContinue?.verification ? artifactPaths(input.loopDir, input.round).verification : undefined,
      reviewer_backend: input.reviewerBackend,
      reviewer_model: input.reviewerModel,
      resulting_status: state.status,
      resulting_phase: state.phase,
      created_at: new Date().toISOString(),
      reason: decision.reason,
    } satisfies ReviewDecisionArtifact),
  )
  return decision
}

export function bindRoundSession(loopDir: string, sessionID?: string): PactState {
  const state = readState(loopDir)
  if (!sessionID) return state
  if (state.active_round_session_id === sessionID && state.active_session_id === sessionID) return state
  if (state.session_strategy === "new-per-round") {
    if (state.active_round_session_id && state.active_round_session_id !== sessionID) return state
    state.active_round_session_id = sessionID
    state.active_session_id = sessionID
    writeState(loopDir, state)
  }
  return state
}

function advanceRoundSession(state: PactState): void {
  const current = state.active_round_session_id ?? state.active_session_id
  if (current) state.previous_round_session_id = current
  if (state.session_strategy === "new-per-round") {
    state.active_round_session_id = undefined
    state.active_session_id = undefined
  } else {
    state.active_round_session_id = state.active_session_id
  }
}

export function recordFailedReviewDecision(input: {
  loopDir: string
  round: number
  parseStatus: "reviewer_timeout" | "reviewer_failed"
  reviewerBackend?: ReviewerBackend
  reviewerModel?: string | null
  error?: unknown
}): ReviewDecision {
  const reviewPath = join(input.loopDir, `round-${roundName(input.round)}-review.md`)
  const feedbackPath = join(input.loopDir, `round-${roundName(input.round)}-feedback.md`)
  const state = readState(input.loopDir)
  const errorSummary = safeErrorSummary(input.error)
  const title = input.parseStatus === "reviewer_timeout" ? "Codex reviewer timed out" : "Codex reviewer failed"
  const reviewText = `# PACT Review Failed

${title}.

Backend: ${input.reviewerBackend ?? state.reviewer_backend}
Model: ${input.reviewerModel ?? state.reviewer_model ?? "(unset)"}
Parse status: ${input.parseStatus}
Error: ${errorSummary || "(none)"}
`
  const feedbackText = `Reviewer did not complete for round ${roundName(input.round)}.

${title}.

The loop was stopped so artifacts can be inspected and replayed.
`
  writeFileSync(reviewPath, reviewText, "utf-8")
  writeFileSync(feedbackPath, feedbackText, "utf-8")

  const decision: ReviewDecision = {
    marker: "continue",
    parseStatus: input.parseStatus,
    terminalLine: "",
    reason: errorSummary || title,
  }
  state.status = "stopped"
  state.phase = "stopped"
  markStateWorkerRoundAttempted(state, input.round)
  markStateWorkerRoundCompleted(state, input.round)
  markStateWorkerRoundReviewed(state, input.round)
  setNextRoundCursor(state, input.round + 1)
  state.last_review_marker = "continue"
  state.last_review_path = reviewPath
  state.last_feedback_path = feedbackPath
  writeState(input.loopDir, state)
  writeJsonFile(
    artifactPaths(input.loopDir, input.round).reviewDecision,
    stripUndefined({
      schema: "pact-review-decision/v1",
      artifact_version: 1,
      loop_id: state.loop_id,
      round: input.round,
      marker: decision.marker,
      parse_status: decision.parseStatus,
      terminal_line: decision.terminalLine,
      review_path: reviewPath,
      feedback_path: feedbackPath,
      reviewer_backend: input.reviewerBackend ?? state.reviewer_backend,
      reviewer_model: input.reviewerModel ?? state.reviewer_model,
      resulting_status: state.status,
      resulting_phase: state.phase,
      created_at: new Date().toISOString(),
      reason: decision.reason,
    } satisfies ReviewDecisionArtifact),
  )
  return decision
}

export function isProtectedWrite(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/")
  return (
    /\.pact\/loops\/[^/]+\/state\.json$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/loop-manifest\.json$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/source-plan\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/plan\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/todo\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/goal-tracker\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/round-\d+-(?:state|context|patch-artifact|verification|continuation-package|review-decision|result|replay-case)\.json$/.test(
      normalized,
    ) ||
    /\.pact\/loops\/[^/]+\/round-\d+-(?:events|workspace|eval|test)\.(?:jsonl|patch)$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/round-\d+-review\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/round-\d+-feedback\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/round-\d+-evidence\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/complete-state\.md$/.test(normalized) ||
    /\.pact\/loops\/[^/]+\/stop-state\.md$/.test(normalized)
  )
}

export function isImmutableGoalTrackerEdit(filePath: string, content: string): boolean {
  const normalized = filePath.replaceAll("\\", "/")
  if (!/\.pact\/loops\/[^/]+\/goal-tracker\.md$/.test(normalized)) return false
  if (!content.includes("## MUTABLE SECTION")) return true
  const loopDir = normalized.replace(/\/goal-tracker\.md$/, "")
  const statePath = join(loopDir, "state.json")
  if (!existsSync(statePath)) return false
  const expected = readState(loopDir).goal_tracker_immutable_sha256
  if (!expected) return false
  return goalTrackerImmutableSha256(content) !== expected
}

export function buildPlannerPrompt(input: { planPath: string; planContent: string }): string {
  return `# PACT Planner

Create a Humanize-style PACT plan ledger and goal tracker from the plan.

Plan path: ${input.planPath}

## Plan
${input.planContent}

## Requirements
- Preserve all requirements from the input plan.
- Create acceptance criteria using AC-X or AC-X.Y identifiers.
- Include positive and negative tests for each acceptance criterion.
- Create a task breakdown table where every task maps to a target AC.
- Use task tags: coding or analyze.
- Do not include raw transcript content.
- PACT/harness owns final patch export. The worker edits the workspace only.
- Do not create acceptance criteria or tasks that ask the worker to generate, edit, stage, or inspect solution.patch or test.patch.
- If the input plan mentions solution.patch/test.patch, translate it into workspace-edit boundaries and harness-export validation.

Return exactly three marker blocks:

<<<PACT_PLAN>>>
# Goal Description
...

## Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests |
| --- | --- | --- | --- |
| AC-1 | ... | ... | ... |

## Path Boundaries
- ...

## Dependencies
- ...

## Task Breakdown
| Task ID | Description | Target AC | Tag | Depends On |
| --- | --- | --- | --- | --- |
| task-1 | Implement the smallest coherent checkpoint. | AC-1 | coding | - |

## Pending Decisions
- ...
<<<END_PACT_PLAN>>>

<<<PACT_TODO>>>
# Todo
| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
| task-1 | Implement the smallest coherent checkpoint. | AC-1 | coding | - | pending |
<<<END_PACT_TODO>>>

<<<PACT_GOAL_TRACKER>>>
# Goal Tracker
## IMMUTABLE SECTION
### Ultimate Goal
...
### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
| AC-1 | ... | ... | ... | pending |
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
<<<END_PACT_GOAL_TRACKER>>>
`
}

export function buildInitialWorkerPrompt(input: {
  loopDir: string
  round: number
  todoPath: string
  goalTrackerPath: string
}): string {
  const snapshot = buildCurrentStateSnapshot({
    loopDir: input.loopDir,
    changedFiles: [],
  })
  return `# PACT Round ${roundName(input.round)} Worker Prompt

## Objective
Complete the ultimate goal:
${snapshotObjective(input.loopDir)}

Satisfy all acceptance criteria below. Continue from the current workspace state.

## Current State Snapshot
${snapshot}

## Required Process

First action: write ${join(input.loopDir, `round-${roundName(input.round)}-contract.md`)} with:
- single mainline objective
- target ACs
- blocking issues
- queued out-of-scope issues
- success criteria

Do not edit source files, run tests, or inspect unrelated files before this contract exists. Missing contract is a reviewer-blocking defect.

Rules:
- Preserve the immutable goal and acceptance criteria.
- Make the smallest code changes that satisfy the active task.
- Do not use Task/subagent delegation; do the work in this session so PACT can observe and replay the round.
- Do not create or edit external validation-owned patch files; PACT owns patch export.
- Do not run external validation gates or validation-owned commands; PACT runs verification after the round.
- Do not stage, reset, commit, stash, or otherwise manage git index state.
- Do not directly edit todo.md, plan.md, source-plan.md, review artifacts, result artifacts, state artifacts, or replay artifacts.
- Do not directly edit the immutable section of goal-tracker.md.
- If goal tracker or todo ledger updates are needed, include a "Goal Tracker / Ledger Update Request" section in your summary.
- Before stopping, write an honest summary to ${join(input.loopDir, `round-${roundName(input.round)}-summary.md`)}.
- After writing the summary, stop work and return control to PACT. Do not keep coding, testing, or editing after the summary is written.
- Do not use web/code-host lookup.

## Reference Files
- Plan: ${join(input.loopDir, "plan.md")}
- Todo: ${input.todoPath}
- Goal tracker: ${input.goalTrackerPath}
- Pre-round snapshot: ${artifactPaths(input.loopDir, input.round).preSnapshot}

The reviewer will inspect your summary and the repository state when this bounded run ends.
`
}

export function buildContinuationPrompt(input: {
  loopDir: string
  round: number
  feedbackPath: string
  goalTrackerPath: string
  todoPath?: string
  planPath?: string
  preSnapshotPath?: string
  cumulativePatchPath?: string
  continuationPackagePath?: string
  continuationPackageText?: string
}): string {
  const packageText =
    input.continuationPackageText ??
    (input.continuationPackagePath && existsSync(input.continuationPackagePath)
      ? readFileSync(input.continuationPackagePath, "utf-8")
      : undefined)
  const snapshot =
    packageText ??
    buildCurrentStateSnapshot({
      loopDir: input.loopDir,
      changedFiles: [],
    })
  return `# PACT Round ${roundName(input.round)} Worker Prompt

The previous round did not pass review.

This prompt is self-contained for a fresh worker session. Do not rely on prior chat context.

## Objective
Complete the ultimate goal:
${snapshotObjective(input.loopDir, input.planPath)}

Satisfy all acceptance criteria below. Continue from the current workspace state.

## Current State Snapshot
${snapshot.trim()}

## Required Process

First action: write ${join(input.loopDir, `round-${roundName(input.round)}-contract.md`)} with:
- single mainline objective
- target ACs
- blocking issues
- queued out-of-scope issues
- success criteria

In the contract, choose your own smallest coherent plan for advancing the objective, considering reviewer feedback.
Do not edit source files, run tests, or inspect unrelated files before this contract exists. Missing contract is a reviewer-blocking defect.

Before stopping, write an honest summary to ${join(input.loopDir, `round-${roundName(input.round)}-summary.md`)}.
Summary must explain:
- what ACs/tasks you advanced
- what reviewer feedback you addressed
- what remains
- what was tested

After writing the summary, stop work and return control to PACT. Do not keep coding, testing, or editing after the summary is written.
Do not use Task/subagent delegation; do the work in this session so PACT can observe and replay the round.
Do not create or edit external validation-owned patch files; PACT owns patch export.
Do not run external validation gates or validation-owned commands; PACT runs verification after the round.
Do not stage, reset, commit, stash, or otherwise manage git index state.
Do not directly edit todo.md, plan.md, source-plan.md, review artifacts, result artifacts, state artifacts, or replay artifacts.
If goal tracker or todo ledger updates are needed, include a "Goal Tracker / Ledger Update Request" section in your summary instead of editing ledgers directly.
Do not use web/code-host lookup.

## Reference Files
- Plan: ${input.planPath ?? join(input.loopDir, "plan.md")}
- Todo: ${input.todoPath ?? join(input.loopDir, "todo.md")}
- Goal tracker: ${input.goalTrackerPath}
- Continuation package: ${input.continuationPackagePath ?? artifactPaths(input.loopDir, Math.max(1, input.round - 1)).continuationPackage}
- Pre-round snapshot: ${input.preSnapshotPath ?? artifactPaths(input.loopDir, input.round).preSnapshot}
- Previous review feedback: ${input.feedbackPath}
`
}

export function buildReviewPrompt(input: {
  loopDir: string
  round: number
  planPath?: string
  todoPath?: string
  goalTrackerPath?: string
  evalPatchPath?: string
  patchArtifactPath?: string
  verificationPath?: string
  summaryPath: string
  summary: string
  summaryStatus?: "present" | "missing"
  contractPath?: string
  contract?: string
  contractStatus?: "present" | "missing"
  reviewKind?: "implementation" | "full_alignment" | "review"
}): string {
  const kind = input.reviewKind ?? "implementation"
  const summaryStatus = input.summaryStatus ?? (input.summary.trim() ? "present" : "missing")
  const contractPath = input.contractPath ?? join(input.loopDir, `round-${roundName(input.round)}-contract.md`)
  const contractStatus = input.contractStatus ?? (input.contract?.trim() ? "present" : "missing")
  const fullAlignmentSection =
    kind === "full_alignment"
      ? `
## Full Alignment Check
This is a mandatory full alignment checkpoint.

Review recent round files in ${input.loopDir}:
- Previous round summaries: round-XX-summary.md
- Previous review results: round-XX-review.md
- Previous feedback: round-XX-feedback.md

Check for repeated findings, forgotten acceptance criteria, unjustified deferrals, and stalled progress.
If progress is stalled, still produce actionable continuation feedback. Do not use PACT_STOP.
`
      : ""
  const reviewPhaseSection =
    kind === "review"
      ? `
## Review Phase
The implementation reviewer already signaled PACT_COMPLETE. Now perform a code-review-oriented pass over the patch and repository state.
Focus on correctness, regressions, missing tests, and benchmark-facing patch quality.
`
      : ""
  return `# PACT Review Round ${roundName(input.round)}

You are the independent PACT reviewer.

## Authoritative Facts
- Plan: ${input.planPath ?? join(input.loopDir, "plan.md")}
- Todo: ${input.todoPath ?? join(input.loopDir, "todo.md")}
- Goal tracker: ${input.goalTrackerPath ?? join(input.loopDir, "goal-tracker.md")}
- Eval patch: ${input.evalPatchPath ?? artifactPaths(input.loopDir, input.round).evalPatch}
- Patch metadata: ${input.patchArtifactPath ?? artifactPaths(input.loopDir, input.round).patchArtifact}
- Public round verification: ${input.verificationPath ?? artifactPaths(input.loopDir, input.round).verification}

Treat the patch, changed files, goal tracker, and public verification artifact as facts. Hidden/final eval is not available during worker rounds and must not be inferred or copied into Next Worker Instructions.

## Worker Claims
- Round summary: ${input.summaryPath}
- Summary status: ${summaryStatus}
- Round contract: ${contractPath}
- Contract status: ${contractStatus}

Scope:
- Stay within the plan, todo, goal tracker, summary, eval patch, and changed files listed in patch metadata.
- Do not browse unrelated repository areas unless one of those inputs directly points you there.
- Keep output short and structured.
- This is the only reviewer pass for this worker round: include code-review checks for correctness, regressions, missing public/self tests, patch separation, and artifact quality.
- Public verification is authoritative when present for patch apply/build/public-check failures. Do not write PACT_COMPLETE if public verification reports failed/timeout/infra_failed or a failed build_status. The driver runs final hidden scoring only after your candidate PACT_COMPLETE.

## Round Summary
${summaryStatus === "present" ? input.summary : "(missing)"}

## Round Contract
${contractStatus === "present" ? input.contract : "(missing)"}

${fullAlignmentSection}${reviewPhaseSection}

## Output Format
Use exactly these sections:

### Decision Summary
State whether this checkpoint is complete or needs another worker round.

### Goal Alignment Summary
Use this compact line: ACs: X/Y addressed | Forgotten items: N | Unjustified deferrals: N

### Public Verification Gate
State public verification status/build_status if present, and whether this checkpoint is allowed to become a candidate for final hidden scoring.

### Claim Audit
Audit the worker summary as claims, not facts. Identify unsupported claims, missing summary, and mismatches against patch/verification.

### Contract Scope Audit
Audit the round contract as a worker claim. State whether it is too broad, too narrow, avoids required ACs, or correctly focuses the mainline.

### Acceptance Criteria Audit
Audit each AC from the goal tracker as MET, PARTIAL, NOT MET, or DEFERRED with evidence.

### Findings
List concrete issues. If none, write "(none)".

### Mainline Gaps
List unfinished mainline requirements based on authoritative facts.

### Blocking Side Issues
List side issues that block acceptance criteria or build/eval safety.

### Queued Side Issues
List non-blocking side issues that should be queued, not allowed to distract the next worker round.

### Goal Tracker Updates
If the worker summary includes a Goal Tracker Update Request, approve or reject it here.
Use "APPROVED" only when the requested mutable-section update is justified.
Never approve changes to the immutable section.

### Next Worker Instructions
If more work is needed, give singular, directive instructions for the next smallest checkpoint.

Only if all acceptance criteria and the current phase requirements are fully satisfied, write PACT_COMPLETE as the final non-empty line.
For any other outcome, do not write a terminal marker. PACT_STOP and PACT_CONTINUE are deprecated and will be treated as continuation feedback.
`
}

export function buildReviewPhasePrompt(input: {
  loopDir: string
  round: number
  feedbackPath: string
  goalTrackerPath: string
}): string {
  return `# PACT Review Phase ${roundName(input.round)}

The implementation phase has passed its reviewer gate. Now perform a code-review-focused checkpoint.

Read:
- Review phase instructions: ${input.feedbackPath}
- Goal tracker: ${input.goalTrackerPath}
- Plan: ${join(input.loopDir, "plan.md")}
- Patch artifacts from the previous round.

Fix review-phase issues only. Do not add unrelated features.
Before stopping, write an honest summary to ${summaryPath(input.loopDir, input.round)}.
`
}

export function buildFinalizePrompt(input: { loopDir: string; round: number; goalTrackerPath: string }): string {
  return `# PACT Finalize Phase

Review and finalize the PACT loop.

Read:
- Goal tracker: ${input.goalTrackerPath}
- Plan: ${join(input.loopDir, "plan.md")}
- Latest review artifacts under ${input.loopDir}

Only do final verification, cleanup, and functionality-preserving simplification if needed.
Do not use Task/subagent delegation; do the work in this session so PACT can observe and replay the round.
Before stopping, write the final summary to ${join(input.loopDir, "finalize-summary.md")}.
`
}

export function summaryPath(loopDir: string, round: number): string {
  return join(loopDir, `round-${roundName(round)}-summary.md`)
}

export function resolveProjectPath(projectRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath)
}

export function normalizePlanLedger(input: { planPath: string; planContent: string }): PlannerArtifacts {
  const goal = sanitizePlannerArtifactText(
    extractFirstUsefulPlanLine(input.planContent) ?? `Execute the plan: ${input.planPath}`,
  )
  const acRows = extractAcceptanceCriteria(input.planContent)
  const criteria = acRows.length
    ? acRows.map((criterion) => ({
        ...criterion,
        text: sanitizePlannerArtifactText(criterion.text),
        positive: sanitizePlannerArtifactText(criterion.positive),
        negative: sanitizePlannerArtifactText(criterion.negative),
      }))
    : [
        {
          id: "AC-1",
          text: "The implementation satisfies the plan's observable requirements.",
          positive: "Plan-facing behavior passes available checks.",
          negative: "Incomplete or unrelated changes are rejected.",
        },
      ]
  const taskRows = extractTaskRows(input.planContent, criteria).map((task) => ({
    ...task,
    description: sanitizeTaskDescription(task.description),
  }))
  return {
    todo: renderTodo(taskRows),
    goalTracker: renderGoalTracker({
      goal,
      criteria,
      tasks: taskRows,
    }),
  }
}

function sanitizePlannerArtifactText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const sanitizedLine = sanitizePatchArtifactNames(line)
      if (!isWorkerOwnedPatchTask(line)) return sanitizedLine
      if (!line.trim().startsWith("|")) return "Keep implementation and optional test changes separable for PACT/harness patch export."
      const cells = line.split("|")
      return cells
        .map((cell, index) =>
          index > 0 && isWorkerOwnedPatchTask(cell)
            ? " Keep implementation and optional test changes separable for PACT/harness patch export "
            : sanitizePatchArtifactNames(cell),
        )
        .join("|")
    })
    .join("\n")
}

function sanitizeTaskDescription(description: string): string {
  if (isWorkerOwnedPatchTask(description)) {
    return "Keep implementation and optional test changes separable for PACT/harness patch export."
  }
  return sanitizePatchArtifactNames(description)
}

function sanitizePatchArtifactNames(text: string): string {
  return text
    .replace(/`?solution\.patch`?/gi, "PACT/harness-owned implementation patch artifact")
    .replace(/`?test\.patch`?/gi, "PACT/harness-owned optional-test patch artifact")
}

function isWorkerOwnedPatchTask(text: string): boolean {
  if (!/\b(?:solution|test)\.patch\b/i.test(text)) return false
  return /\b(?:generate|create|write|edit|stage|inspect|export|produce)\b/i.test(text)
}

export function goalTrackerImmutableSha256(text: string): string {
  return sha256Text(goalTrackerImmutableSection(text))
}

export function refreshGoalTrackerImmutableHash(loopDir: string): string {
  const hash = goalTrackerImmutableSha256(readFileSync(join(loopDir, "goal-tracker.md"), "utf-8"))
  const state = readState(loopDir)
  state.goal_tracker_immutable_sha256 = hash
  writeState(loopDir, state)
  return hash
}

export function applyApprovedGoalTrackerUpdates(input: {
  loopDir: string
  round: number
  reviewText: string
  summaryText?: string
}): boolean {
  const section = extractMarkdownSection(input.reviewText, "Goal Tracker Updates")
  if (!section || !hasExplicitGoalTrackerApproval(section)) return false
  const trackerPath = join(input.loopDir, "goal-tracker.md")
  const current = readFileSync(trackerPath, "utf-8")
  const requested = input.summaryText
    ? extractMarkdownSection(input.summaryText, "Goal Tracker Update Request")
    : undefined
  const updateText = requested?.trim() || section.trim()
  const row = `| ${input.round} | Reviewer-approved goal tracker update | ${escapeTableCell(
    compactOneLine(updateText),
  )} | See round-${roundName(input.round)} review |`
  let next = appendTableRow(current, "#### Plan Evolution Log", row)
  const completed = completedTaskUpdate(current, updateText, input.round)
  if (completed) {
    next = appendTableRow(next, "### Completed and Verified", completed.row)
    next = markActiveTaskStatus(next, completed.task, "complete")
  }
  writeFileSync(trackerPath, next, "utf-8")
  return true
}

function hasExplicitGoalTrackerApproval(section: string): boolean {
  return section.split(/\r?\n/).some((line) => {
    const marker = line
      .trim()
      .replace(/^[-*+]\s*/, "")
      .trim()
    return /^APPROVED(?:[.:]|$)/i.test(marker)
  })
}

function defaultTodo(): string {
  return renderTodo([
    {
      id: "task-1",
      description: "Generate concrete tasks from the plan.",
      targetAC: "AC-1",
      tag: "coding",
      dependsOn: "-",
      status: "pending",
    },
  ])
}

function defaultGoalTracker(planFile: string): string {
  return renderGoalTracker({
    goal: `Execute the plan: ${planFile}`,
    criteria: [
      {
        id: "AC-1",
        text: "The implementation satisfies the plan's observable requirements.",
        positive: "Plan-facing behavior passes available checks.",
        negative: "Incomplete or unrelated changes are rejected.",
      },
    ],
    tasks: [
      {
        id: "task-1",
        description: "Generate concrete tasks from the plan.",
        targetAC: "AC-1",
        tag: "coding",
        dependsOn: "-",
        status: "pending",
      },
    ],
  })
}

function normalizeTodoArtifact(text: string): string {
  if (/\| Task ID \| Description \| Target AC \| Tag \| Depends On \| Status \|/.test(text)) return text
  const tasks: PlanTask[] = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+\[[ xX]\]\s*/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((description, index) => ({
      id: `task-${index + 1}`,
      description,
      targetAC: "AC-1",
      tag: "coding" as const,
      dependsOn: "-",
      status: "pending" as const,
    }))
  return renderTodo(
    tasks.length
      ? tasks
      : [
          {
            id: "task-1",
            description: "Implement the smallest coherent checkpoint.",
            targetAC: "AC-1",
            tag: "coding",
            dependsOn: "-",
            status: "pending",
          },
        ],
  )
}

function normalizeGoalTrackerArtifact(text: string, planFile: string): string {
  if (text.includes("## IMMUTABLE SECTION") && text.includes("## MUTABLE SECTION"))
    return ensureGoalTrackerTables(normalizeGoalTrackerHeadings(text))
  const migrated = text.replace("## IMMUTABLE", "## IMMUTABLE SECTION").replace("## MUTABLE", "## MUTABLE SECTION")
  if (migrated.includes("## IMMUTABLE SECTION") && migrated.includes("## MUTABLE SECTION"))
    return ensureGoalTrackerTables(normalizeGoalTrackerHeadings(migrated))
  return defaultGoalTracker(planFile)
}

function renderTodo(tasks: PlanTask[]): string {
  return `# Todo

| Task ID | Description | Target AC | Tag | Depends On | Status |
| --- | --- | --- | --- | --- | --- |
${tasks.map((task) => `| ${task.id} | ${escapeTableCell(task.description)} | ${task.targetAC} | ${task.tag} | ${task.dependsOn} | ${task.status} |`).join("\n")}
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
  if (decision.parseStatus !== "deprecated_continue_signal" && decision.parseStatus !== "deprecated_stop_signal") {
    return text.trim()
  }
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

function renderGoalTracker(input: { goal: string; criteria: AcceptanceCriterion[]; tasks: PlanTask[] }): string {
  return `# Goal Tracker

<!--
This file tracks the ultimate goal, acceptance criteria, and plan evolution.

RULES:
- IMMUTABLE SECTION: do not modify after loop initialization.
- MUTABLE SECTION: updates must preserve evidence and justification.
- Every task must map to an acceptance criterion.
- Deferred items require explicit justification.
-->

## IMMUTABLE SECTION

### Ultimate Goal
${input.goal}

### Acceptance Criteria
| AC | Criterion | Positive Tests | Negative Tests | Status |
| --- | --- | --- | --- | --- |
${input.criteria.map((criterion) => `| ${criterion.id} | ${escapeTableCell(criterion.text)} | ${escapeTableCell(criterion.positive)} | ${escapeTableCell(criterion.negative)} | pending |`).join("\n")}

## MUTABLE SECTION

### Plan Version: 1 (Updated: Round 1)

#### Plan Evolution Log
| Round | Change | Reason | Impact on AC |
| --- | --- | --- | --- |
| 1 | Initial plan ledger | Planner initialization | - |

#### Active Tasks
| Task | Target AC | Status | Tag | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
${input.tasks.map((task) => `| ${task.id} | ${task.targetAC} | ${task.status} | ${task.tag} | worker | ${escapeTableCell(task.description)} |`).join("\n")}

### Completed and Verified
| AC | Task | Completed Round | Verified Round | Evidence |
| --- | --- | --- | --- | --- |

### Explicitly Deferred
| Task | Original AC | Deferred Since | Justification | When to Reconsider |
| --- | --- | --- | --- | --- |

### Open Issues
| Issue | Discovered Round | Blocking AC | Resolution Path |
| --- | --- | --- | --- |
`
}

function extractFirstUsefulPlanLine(planContent: string): string | undefined {
  return planContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("```"))
}

function extractAcceptanceCriteria(planContent: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = []
  for (const line of planContent.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?(AC-\d+(?:\.\d+)?)[\s:.-]+(.+)$/.exec(line)
    if (!match) continue
    criteria.push({
      id: match[1] ?? `AC-${criteria.length + 1}`,
      text: (match[2] ?? "").trim(),
      positive: "Expected behavior passes relevant checks.",
      negative: "Missing or incorrect behavior is rejected.",
    })
  }
  return criteria
}

function extractTaskRows(planContent: string, criteria: AcceptanceCriterion[]): PlanTask[] {
  const lines = planContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[ xX]\]/.test(line))
  if (!lines.length) {
    return [
      {
        id: "task-1",
        description: "Implement the smallest coherent checkpoint.",
        targetAC: criteria[0]?.id ?? "AC-1",
        tag: "coding",
        dependsOn: "-",
        status: "pending",
      },
    ]
  }
  return lines.map((line, index) => {
    const description = line.replace(/^[-*]\s+\[[ xX]\]\s*/, "")
    return {
      id: `task-${index + 1}`,
      description,
      targetAC: criteria[index]?.id ?? criteria[0]?.id ?? "AC-1",
      tag: "coding",
      dependsOn: index === 0 ? "-" : `task-${index}`,
      status: "pending",
    }
  })
}

function ensureGoalTrackerTables(text: string): string {
  let next = text.trimEnd()
  const requiredSections = [
    "#### Plan Evolution Log",
    "#### Active Tasks",
    "### Completed and Verified",
    "### Explicitly Deferred",
    "### Open Issues",
  ]
  for (const section of requiredSections) {
    if (!hasMarkdownHeading(next, section)) {
      next += `\n\n${section}\n${defaultSectionTable(section)}`
    }
  }
  return `${next}\n`
}

function normalizeGoalTrackerHeadings(text: string): string {
  return text.replace(/^###\s+(Plan Evolution Log|Active Tasks)\s*$/gm, "#### $1")
}

function defaultSectionTable(section: string): string {
  if (section === "#### Plan Evolution Log")
    return "| Round | Change | Reason | Impact on AC |\n| --- | --- | --- | --- |"
  if (section === "#### Active Tasks")
    return "| Task | Target AC | Status | Tag | Owner | Notes |\n| --- | --- | --- | --- | --- | --- |"
  if (section === "### Completed and Verified")
    return "| AC | Task | Completed Round | Verified Round | Evidence |\n| --- | --- | --- | --- | --- |"
  if (section === "### Explicitly Deferred")
    return "| Task | Original AC | Deferred Since | Justification | When to Reconsider |\n| --- | --- | --- | --- | --- |"
  return "| Issue | Discovered Round | Blocking AC | Resolution Path |\n| --- | --- | --- | --- |"
}

function goalTrackerImmutableSection(text: string): string {
  const start = text.search(/^## IMMUTABLE SECTION\b/m)
  if (start < 0) return ""
  const rest = text.slice(start)
  const end = rest.search(/^## MUTABLE SECTION\b/m)
  return (end < 0 ? rest : rest.slice(0, end)).trim() + "\n"
}

function extractMarkdownSection(text: string, heading: string): string | undefined {
  const pattern = new RegExp(`^#{2,4}\\s+${escapeRegExp(heading)}\\s*$`, "im")
  const match = pattern.exec(text)
  if (!match || match.index === undefined) return undefined
  const afterHeading = text.slice(match.index + match[0].length)
  const nextHeading = /\n#{2,4}\s+/.exec(afterHeading)
  return (nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading).trim()
}

function appendTableRow(text: string, heading: string, row: string): string {
  const lines = text.trimEnd().split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => isMarkdownHeading(line, heading))
  if (headingIndex < 0) return `${text.trimEnd()}\n\n${heading}\n${row}\n`
  let insertIndex = headingIndex + 1
  while (insertIndex < lines.length && !/^#{2,4}\s+/.test(lines[insertIndex] ?? "")) {
    insertIndex++
  }
  lines.splice(insertIndex, 0, row)
  return lines.join("\n") + "\n"
}

function hasMarkdownHeading(text: string, heading: string): boolean {
  return text.split(/\r?\n/).some((line) => isMarkdownHeading(line, heading))
}

function isMarkdownHeading(line: string, heading: string): boolean {
  const label = heading.replace(/^#+\s+/, "")
  return new RegExp(`^#{2,4}\\s+${escapeRegExp(label)}\\s*$`).test(line.trim())
}

function completedTaskUpdate(
  trackerText: string,
  updateText: string,
  round: number,
): { task: string; row: string } | undefined {
  const task = /\b(task-\d+)\b/i.exec(updateText)?.[1]
  if (!task || !/\bcomplete\b/i.test(updateText)) return undefined
  const ac = taskTargetAC(trackerText, task) ?? "AC-1"
  const evidence = /evidence\s*:\s*(.+)$/i.exec(updateText)?.[1]?.trim() ?? compactOneLine(updateText)
  return {
    task,
    row: `| ${ac} | ${task} | ${round} | ${round} | ${escapeTableCell(evidence)} |`,
  }
}

function taskTargetAC(trackerText: string, task: string): string | undefined {
  const escaped = escapeRegExp(task)
  const pattern = new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*(AC-\\d+(?:\\.\\d+)?)\\s*\\|`, "im")
  return pattern.exec(trackerText)?.[1]
}

function markActiveTaskStatus(text: string, task: string, status: string): string {
  const escaped = escapeRegExp(task)
  return text.replace(
    new RegExp(`^(\\|\\s*${escaped}\\s*\\|\\s*AC-\\d+(?:\\.\\d+)?\\s*\\|\\s*)[^|\\n]*(\\|.*)$`, "im"),
    (_match, prefix, tail) => `${prefix}${status} ${tail}`,
  )
}

function escapeTableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim()
}

function compactOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500)
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trim()
}

function firstUsefulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 500)
}

function extractNextWorkerInstruction(text: string): string | undefined {
  const match = /### Next Worker Instructions?\s*([\s\S]*?)(?:\n### |\nPACT_COMPLETE\s*$|$)/i.exec(text)
  if (!match) return undefined
  const body = (match[1] ?? "").trim()
  const terminal = lastNonEmptyLine(body)
  const clean =
    terminal === "PACT_COMPLETE" || terminal === "PACT_STOP" || terminal === "PACT_CONTINUE"
      ? stripFinalNonEmptyLine(body)
      : body
  return compactOneLine(clean)
}

function workerSafeNextInstruction(
  instruction: string | undefined,
  input: { verification?: RoundVerificationArtifact; changedFiles: string[] },
): string | undefined {
  const text = sanitizeWorkerFacingInstruction(compactOneLine(instruction ?? ""))
  if (!text && input.verification?.status && input.verification.status !== "passed") {
    return "Use the worker-safe continuation package and changed files to make workspace-only source changes, then write the round summary."
  }
  if (!text) return undefined
  if (!mentionsHarnessOwnedWork(instruction ?? "")) return text

  const paths = input.changedFiles.filter((filePath) => /(?:^|\/)(?:test|Lib\/test)\b/i.test(filePath)).slice(0, 4)
  const pathText = paths.length ? ` Changed test-like paths to inspect cautiously: ${paths.join(", ")}.` : ""
  return compactOneLine(
    `Use the worker-safe continuation package and changed files to make workspace-only source changes.${pathText} Then write the round summary.`,
  )
}

function workerSafeFailureSignature(signature: string | undefined): string | undefined {
  const text = sanitizeWorkerFacingInstruction(compactOneLine(signature ?? ""))
  if (!text || text === "[redacted worker-unsafe benchmark/eval detail]") return undefined
  if (!/[A-Za-z0-9]/.test(text)) return undefined
  if (/^[{}\[\](),.;:\s-]+$/.test(text)) return undefined
  return text
}

function sanitizeWorkerFacingInstruction(text: string): string {
  const safe = redactText(text)
    .replace(/\bForwardRef\s*\([^)]*\)/g, "future-annotations behavior")
    .replace(/\b(?:F2P|P2P)\b/gi, "source validation")
    .replace(/\b(?:test|unittest)(?:\.[A-Za-z_][\w]*)*\.test_[A-Za-z_][\w]*\b/gi, "redacted test case")
    .replace(/\b[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.test_[A-Za-z_][\w]*\b/g, "redacted test case")
    .replace(/\bfocused evaluation\b/gi, "focused source/public checks")
    .replace(/\beval failure\b/gi, "validation failure")
  return sanitizeWorkerFacingText(safe)
}

function mentionsHarnessOwnedWork(text: string): boolean {
  return /\b(?:PACT\s+)?patch artifacts?\b/i.test(text) ||
    /\b(?:re)?run\b[\s\S]*\b(?:PACT\s+)?gate\b/i.test(text) ||
    /\b(?:PACT\s+)?gate\b[\s\S]*\b(?:re)?run\b/i.test(text) ||
    /\beval patch\b[\s\S]*\bincremental delta\b/i.test(text) ||
    /\beval failure\b/i.test(text) ||
    /\b(?:workspace_patch|eval_patch|patch-artifact|solution\.patch|test\.patch|lolbench_eval\.py)\b/i.test(text)
}

export function sanitizeWorkerFacingText(text: string): string {
  const redactedLine = "[redacted worker-unsafe benchmark/eval detail]"
  const lines = redactText(text)
    .split(/\r?\n/)
    .map((line) => (isWorkerUnsafeLine(line) ? redactedLine : line))
  return lines
    .join("\n")
    .replace(new RegExp(`(?:${escapeRegExp(redactedLine)}\\n?){2,}`, "g"), `${redactedLine}\n`)
    .trim()
}

function isWorkerUnsafeLine(line: string): boolean {
  return (
    /\b(?:eval_tests\.patch|F2P|P2P|hidden[/-]?eval|final-hidden-gate|Docker grade|lolbench_eval\.py|pact-gate|LOLBENCH_|TestRecord\.java:\d+|Latest Verification Log Tail|eval failure)\b/i.test(
      line,
    ) ||
    /\b(?:test|unittest)(?:\.[A-Za-z_][\w]*)*\.test_[A-Za-z_][\w]*\b/i.test(line) ||
    /\b[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.test_[A-Za-z_][\w]*\b/.test(line) ||
    /\bverification\s+(?:shows?|reports?|reveals?|indicates?|says?|found|failed|error)\b/i.test(line) ||
    /\b(?:unparses|round-?trips?)\s+as\b/i.test(line) ||
    /\bForwardRef\s*\(/.test(line) ||
    /\bround-\d+-verification\.(?:json|log)\b/i.test(line) ||
    /\bverification\.(?:json|log)\b/i.test(line) ||
    /\bverification (?:artifact|log)\b/i.test(line) ||
    /\bharness\b/i.test(line) ||
    /\bpatch export\b/i.test(line) ||
    /\beval patch\b/i.test(line)
  )
}

function safeErrorSummary(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "")
  return redactText(compactOneLine(text))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function finalizeFeedbackText(round: number): string {
  return `Implementation review completed after round ${round}. Enter finalize phase and write finalize-summary.md after final verification.\n`
}

function reviewPhaseFeedbackText(round: number): string {
  return `Implementation reviewer accepted round ${round}. Enter review phase and perform one code-review-focused checkpoint before finalization.\n`
}

function currentHeadCommit(projectRoot: string): string | undefined {
  try {
    return gitStdout(projectRoot, ["rev-parse", "HEAD"]).trim() || undefined
  } catch {
    return undefined
  }
}

function extractBlock(text: string, name: string): string | undefined {
  const pattern = new RegExp(`<<<${name}>>>\\s*([\\s\\S]*?)\\s*<<<END_${name}>>>`)
  return pattern.exec(text)?.[1]
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readRequiredText(filePath)) as T
}

function readRequiredText(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Required PACT artifact missing: ${filePath}`)
  }
  return readFileSync(filePath, "utf-8")
}

function defaultRoundArtifacts(loopDir: string, round: number): Record<string, string> {
  const paths = artifactPaths(loopDir, round)
  return {
    loop_manifest: paths.loopManifest,
    round_state: paths.roundState,
    round_context: paths.roundContext,
    round_events: paths.roundEvents,
    pre_snapshot: paths.preSnapshot,
    post_snapshot: paths.postSnapshot,
    trajectory: paths.trajectory,
    evidence_json: paths.evidenceJson,
    evidence_markdown: paths.evidenceMarkdown,
    workspace_patch: paths.workspacePatch,
    eval_patch: paths.evalPatch,
    test_patch: paths.testPatch,
    patch_artifact: paths.patchArtifact,
    verification: paths.verification,
    verification_log: paths.verificationLog,
    continuation_package: paths.continuationPackage,
    continuation_package_json: paths.continuationPackageJson,
    review_decision: paths.reviewDecision,
    round_result: paths.roundResult,
    round_replay_case: paths.roundReplayCase,
  }
}

const GIT_INFO_EXCLUDE_PATTERNS = [".pact/", "/*.patch", "/*.diff"] as const
const PATCH_CAPTURE_EXCLUDES = [
  ":(exclude).pact/**",
  ":(exclude,top,glob)*.patch",
  ":(exclude,top,glob)*.diff",
] as const
const BENCHMARK_SCAFFOLDING_EXTENSIONS = [".patch", ".diff"] as const

function patchCaptureExcludePathspecs(): string[] {
  return [...PATCH_CAPTURE_EXCLUDES]
}

export function extractPatchChangedPaths(text: string): string[] {
  const paths = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line)
    if (diffMatch) {
      addSafePatchPath(paths, diffMatch[1])
      addSafePatchPath(paths, diffMatch[2])
      continue
    }
    const plusMinusMatch = /^(?:---|\+\+\+) (?:a|b)\/(.+?)\s*$/.exec(line)
    if (plusMinusMatch) {
      addSafePatchPath(paths, plusMinusMatch[1])
      continue
    }
    const renameMatch = /^rename (?:from|to) (.+?)\s*$/.exec(line)
    if (renameMatch) {
      addSafePatchPath(paths, renameMatch[1])
    }
  }
  return [...paths].sort()
}

function addSafePatchPath(paths: Set<string>, filePath: string | undefined): void {
  if (!filePath || filePath === "/dev/null") return
  const normalized = filePath.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return
  paths.add(normalized)
}

function collectTestPatchPaths(projectRoot: string, excludes: string[]): string[] {
  return Array.from(new Set([...collectRootTestPatchPaths(projectRoot), ...collectChangedProjectTestPaths(projectRoot, excludes)])).sort()
}

function collectRootTestPatchPaths(projectRoot: string): string[] {
  const testPatchPath = join(projectRoot, "test.patch")
  if (!existsSync(testPatchPath)) return []
  return extractPatchChangedPaths(readFileSync(testPatchPath, "utf-8"))
}

function collectChangedProjectTestPaths(projectRoot: string, excludes: string[]): string[] {
  const changedFiles = [
    ...gitStdout(projectRoot, ["diff", "--name-only", "HEAD", "--", ".", ...excludes])
      .split(/\r?\n/)
      .filter(Boolean),
    ...gitStdout(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...excludes])
      .split("\0")
      .filter(Boolean),
  ]
  return Array.from(new Set(changedFiles.filter(isConventionalProjectTestPath))).sort()
}

function isConventionalProjectTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/")
  return (
    /^Lib\/test\//.test(normalized) ||
    /(^|\/)(?:test|tests|__tests__)\/.+/.test(normalized) ||
    /(^|\/)test_[^/]+$/.test(normalized) ||
    /(^|\/)[^/]+(?:_test|\.test)\.[^/]+$/.test(normalized)
  )
}

function collectExcludedScaffoldingFiles(projectRoot: string): ExcludedScaffoldingFile[] {
  return readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((filePath) => BENCHMARK_SCAFFOLDING_EXTENSIONS.some((extension) => filePath.endsWith(extension)))
    .sort()
    .map((filePath) => {
      const text = readFileSync(join(projectRoot, filePath), "utf-8")
      return {
        path: filePath,
        sha256: sha256Text(text),
        bytes: Buffer.byteLength(text, "utf-8"),
        lines: countLines(text),
      }
    })
}

function collectPathMetadata(projectRoot: string, filePaths: string[]): ExcludedScaffoldingFile[] {
  return filePaths.map((filePath) => {
    const absolute = join(projectRoot, filePath)
    const text = existsSync(absolute) ? readFileSync(absolute, "utf-8") : ""
    return {
      path: filePath,
      sha256: sha256Text(text),
      bytes: Buffer.byteLength(text, "utf-8"),
      lines: countLines(text),
    }
  })
}

function captureGitPatch(projectRoot: string, excludes: string[]): { patchText: string; changedFiles: string[] } {
  const trackedPatch = gitStdout(projectRoot, ["diff", "--binary", "HEAD", "--", ".", ...excludes])
  const untrackedFiles = gitStdout(projectRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ...excludes,
  ])
    .split("\0")
    .filter(Boolean)
    .sort()
  const untrackedPatch = untrackedFiles
    .map((file) => gitDiffNoIndex(projectRoot, file))
    .filter(Boolean)
    .join("")
  const patchText = joinPatchParts([trackedPatch, untrackedPatch])
  const changedFiles = [
    ...gitStdout(projectRoot, ["diff", "--name-only", "HEAD", "--", ".", ...excludes])
      .split(/\r?\n/)
      .filter(Boolean),
    ...untrackedFiles,
  ].sort()
  return { patchText, changedFiles }
}

function captureGitPatchForPaths(projectRoot: string, filePaths: string[]): { patchText: string; changedFiles: string[] } {
  const paths = Array.from(new Set(filePaths.filter((filePath) => filePath && !filePath.startsWith("/")))).sort()
  if (!paths.length) return { patchText: "", changedFiles: [] }
  const trackedPatch = gitStdout(projectRoot, ["diff", "--binary", "HEAD", "--", ...paths])
  const untrackedFiles = gitStdout(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths])
    .split("\0")
    .filter(Boolean)
    .sort()
  const untrackedPatch = untrackedFiles
    .map((file) => gitDiffNoIndex(projectRoot, file))
    .filter(Boolean)
    .join("")
  const patchText = joinPatchParts([trackedPatch, untrackedPatch])
  const changedFiles = [
    ...gitStdout(projectRoot, ["diff", "--name-only", "HEAD", "--", ...paths])
      .split(/\r?\n/)
      .filter(Boolean),
    ...untrackedFiles,
  ].sort()
  return { patchText, changedFiles }
}

function gitStdout(projectRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with status ${result.status}: ${result.stderr}`)
  }
  return result.stdout
}

function safeGitStdout(projectRoot: string, args: string[]): string {
  try {
    return gitStdout(projectRoot, args)
  } catch {
    return ""
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value)
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/api[_-]?key|authorization|token|secret|password/i.test(key)) return [key, "[REDACTED]"]
      return [key, redactValue(item)]
    }),
  )
}

export function redactText(text: string): string {
  const secretKey = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|authorization|token|secret|password)`
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(
      new RegExp(`(["']?)\\b(${secretKey})\\b\\1\\s*([:=])\\s*(["'])(?:(?!\\4).)*\\4`, "gi"),
      "$1$2$1$3$4[REDACTED]$4",
    )
    .replace(new RegExp(`(["']?)\\b(${secretKey})\\b\\1\\s*[:=]\\s*[^,\\s;}]+`, "gi"), "$1$2$1=[REDACTED]")
}

export function commitRoundHistory(loopDir: string, round: number, message: string): void {
  const historyDir = join(loopDir, ".round-history")
  const artifactDir = join(historyDir, "artifacts")
  try {
    mkdirSync(artifactDir, { recursive: true })
    for (const fileName of readdirSync(loopDir)) {
      const filePath = join(loopDir, fileName)
      if (!statSync(filePath).isFile()) continue
      if (
        fileName === "loop-manifest.json" ||
        fileName === "source-plan.md" ||
        fileName === "plan.md" ||
        fileName === "todo.md" ||
        fileName === "goal-tracker.md" ||
        fileName.startsWith(`round-${roundName(round)}`)
      ) {
        copyFileSync(filePath, join(artifactDir, fileName))
      }
    }
    if (!existsSync(join(historyDir, ".git"))) {
      spawnSync("git", ["init"], { cwd: historyDir, encoding: "utf-8" })
      spawnSync("git", ["config", "user.email", "pact@example.invalid"], { cwd: historyDir, encoding: "utf-8" })
      spawnSync("git", ["config", "user.name", "PACT"], { cwd: historyDir, encoding: "utf-8" })
    }
    spawnSync("git", ["add", "artifacts"], { cwd: historyDir, encoding: "utf-8" })
    spawnSync("git", ["commit", "--allow-empty", "-m", message], { cwd: historyDir, encoding: "utf-8" })
  } catch {
    // Round history is observability-only; primary artifacts remain authoritative.
  }
}

function gitDiffNoIndex(projectRoot: string, filePath: string): string {
  const result = spawnSync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", filePath], {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status === 0 || result.status === 1) return result.stdout
  throw new Error(`git diff --no-index failed for ${filePath}: ${result.stderr}`)
}

function joinPatchParts(parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map((part) => (part.endsWith("\n") ? part : `${part}\n`))
    .join("")
}

function checkPatchApplies(projectRoot: string, patchText: string): PatchArtifact["checks"]["apply_check"] {
  const command = "git apply --reverse --check --whitespace=nowarn -"
  if (!patchText) return { status: "skipped", command }
  const result = spawnSync("git", ["apply", "--reverse", "--check", "--whitespace=nowarn", "-"], {
    cwd: projectRoot,
    input: patchText,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) {
    return { status: "failed", command, stderr: String(result.error) }
  }
  if (result.status === 0) return { status: "passed", command }
  return { status: "failed", command, stderr: result.stderr.trim() }
}

function patchMetadata(path: string, patchText: string, changedFiles: string[]): PatchMetadata {
  return {
    path,
    empty: patchText.length === 0,
    sha256: sha256Text(patchText),
    bytes: Buffer.byteLength(patchText, "utf-8"),
    lines: countLines(patchText),
    changed_files: [...changedFiles],
  }
}

function countLines(text: string): number {
  if (!text) return 0
  const trimmedFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text
  return trimmedFinalNewline.split(/\r?\n/).length
}
