import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { spawnSync as nodeSpawnSync } from "node:child_process"
import { cwd, exit, argv } from "node:process"
import { basename, join, resolve } from "node:path"

import { findActiveLoop, readState, roundName, writeRoundTrajectory, type LoopStatus, type SessionStrategy } from "./pact-core"

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

type PactDriverResult = {
  status: LoopStatus | "no_loop" | "opencode_failed" | "missing_prompt" | "max_invocations"
  invocations: number
  loopDir?: string
  round?: number
  exitCode: number
}

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
}): string {
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
- trajectory_mode=full-redact
- full_alignment_interval=${input.fullAlignmentInterval ?? 5}

After the tool returns, execute the returned first worker checkpoint. Before each idle point, write the required PACT summary file.
`
}

export function runPactDriver(input: {
  projectRoot?: string
  planFile: string
  model: string
  maxRounds: number
  opencodeCommand?: string
  agent?: string
  variant?: string
  fullAlignmentInterval?: number
  maxInvocations?: number
  sessionStrategy?: SessionStrategy
  spawnSync?: SpawnSyncLike
}): PactDriverResult {
  const projectRoot = resolve(input.projectRoot ?? cwd())
  const command = input.opencodeCommand ?? "opencode"
  const spawn = input.spawnSync ?? defaultSpawnSync
  const maxInvocations = input.maxInvocations ?? input.maxRounds + 4
  let invocations = 0
  let nextPrompt = buildPactStartPrompt({
    planFile: input.planFile,
    maxRounds: input.maxRounds,
    workerModel: input.model,
    fullAlignmentInterval: input.fullAlignmentInterval,
    sessionStrategy: input.sessionStrategy,
  })
  let sessionID: string | undefined
  let sessionStrategy: SessionStrategy = input.sessionStrategy ?? "new-per-round"
  let promptRound = 1
  let loopDir: string | undefined
  const preexistingLoopIDs = listLoopIDs(projectRoot)

  while (invocations < maxInvocations) {
    const invokedRound = promptRound
    const args = buildOpencodeRunArgs({
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      sessionID: sessionStrategy === "same-session" ? sessionID : undefined,
    })
    const result = spawn(command, args, {
      cwd: projectRoot,
      input: nextPrompt,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: OPENCODE_RUN_MAX_BUFFER,
    })
    invocations++
    if (result.error || result.status !== 0) {
      return { status: "opencode_failed", invocations, exitCode: result.status ?? 1 }
    }

    const loop = loopDir ? { loopDir } : findNewLoop(projectRoot, preexistingLoopIDs)
    if (!loop) return { status: "no_loop", invocations, exitCode: 0 }
    loopDir = loop.loopDir
    const state = readState(loop.loopDir)
    writeRoundTrajectory({
      loopDir: loop.loopDir,
      loopID: state.loop_id,
      round: invokedRound,
      sessionID: state.previous_round_session_id ?? state.active_round_session_id ?? state.active_session_id,
      mode: state.trajectory_mode,
      entries: [
        {
          type: "driver_invocation",
          command,
          args,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        },
      ],
    })
    if (state.status !== "running") {
      return { status: state.status, invocations, loopDir: loop.loopDir, round: state.current_round, exitCode: 0 }
    }

    sessionStrategy = input.sessionStrategy ?? state.session_strategy ?? "new-per-round"
    sessionID = state.active_round_session_id ?? state.active_session_id
    const promptPath = join(loop.loopDir, `round-${roundName(state.current_round)}-prompt.md`)
    if (!existsSync(promptPath) || (sessionStrategy === "same-session" && !sessionID)) {
      return { status: "missing_prompt", invocations, loopDir: loop.loopDir, round: state.current_round, exitCode: 2 }
    }
    nextPrompt = readFileSync(promptPath, "utf-8")
    promptRound = state.current_round
  }

  const loop = loopDir ? { loopDir } : findNewLoop(projectRoot, preexistingLoopIDs)
  return {
    status: "max_invocations",
    invocations,
    loopDir: loop?.loopDir,
    round: loop ? readState(loop.loopDir).current_round : undefined,
    exitCode: 3,
  }
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

function cliArgs(raw: string[]): {
  projectRoot: string
  planFile: string
  model: string
  maxRounds: number
  opencodeCommand?: string
  agent?: string
  variant?: string
  fullAlignmentInterval?: number
  sessionStrategy?: SessionStrategy
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
    maxRounds: Number(parsed["max-rounds"] ?? 5),
    opencodeCommand: parsed["opencode-command"],
    agent: parsed.agent,
    variant: parsed.variant,
    sessionStrategy: parsed["session-strategy"] === "same-session" ? "same-session" : "new-per-round",
    fullAlignmentInterval: parsed["full-alignment-interval"]
      ? Number(parsed["full-alignment-interval"])
      : undefined,
  }
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
