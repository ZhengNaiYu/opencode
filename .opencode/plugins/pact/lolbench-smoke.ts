import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type EnvLike = Record<string, string | undefined>

export type ZaiCodingPlanEnvValidation = {
  ok: boolean
  missing: string[]
  invalidBaseURL: boolean
  env_keys_loaded: string[]
}

export const DEFAULT_ZAI_CODING_PLAN_WORKER_MODEL = "zai-coding-plan/glm-5-turbo"
export const ZAI_CODING_PLAN_PROVIDER_ID = "zai-coding-plan"
export const ZAI_CODING_PLAN_CONFIG_SOURCE = "mini-swe-agent-env"
export const ZAI_CODING_PLAN_EXPECTED_BASE_URL = "https://api.z.ai/api/coding/paas/v4"
export const MINI_SWE_AGENT_ENV_PATH = join(homedir(), "Library", "Application Support", "mini-swe-agent", ".env")

type OpenCodePluginSpec = string | [string, Record<string, unknown>]

export function loadMiniSweAgentEnv(envPath = MINI_SWE_AGENT_ENV_PATH): EnvLike {
  if (!existsSync(envPath)) return {}
  return parseDotEnv(readFileSync(envPath, "utf-8"))
}

export function buildZaiCodingPlanSmokeConfig(input: {
  existing?: Record<string, unknown>
  pactPluginPath: string
  pactPluginOptions?: Record<string, unknown>
  requestedWorkerModel?: string
  env?: EnvLike
  envPath?: string
}): {
  config: Record<string, unknown>
  workerModel: string
  validation: ZaiCodingPlanEnvValidation
} {
  const env = input.env ?? loadMiniSweAgentEnv(input.envPath)
  const validation = validateZaiCodingPlanEnv(env)
  const workerModel = resolveZaiCodingPlanWorkerModel({
    requestedWorkerModel: input.requestedWorkerModel,
    env,
  })
  return {
    config: mergeOpenCodeConfigContent({
      existing: input.existing,
      zaiConfig: buildZaiCodingPlanConfigPatch(),
      pactPluginPath: input.pactPluginPath,
      pactPluginOptions: input.pactPluginOptions,
      workerModel,
    }),
    workerModel,
    validation,
  }
}

export function validateZaiCodingPlanEnv(env: EnvLike): ZaiCodingPlanEnvValidation {
  const missing = ["ZAI_API_KEY", "ZAI_API_BASE"].filter((key) => !env[key])
  const baseURL = env.ZAI_API_BASE?.trim() ?? ""
  const invalidBaseURL = Boolean(baseURL) && normalizeURL(baseURL) !== normalizeURL(ZAI_CODING_PLAN_EXPECTED_BASE_URL)
  return {
    ok: missing.length === 0 && !invalidBaseURL,
    missing,
    invalidBaseURL,
    env_keys_loaded: ["ZAI_API_KEY", "ZAI_API_BASE", "MSWEA_MODEL_NAME"].filter((key) => Boolean(env[key])),
  }
}

export function resolveZaiCodingPlanWorkerModel(input: {
  requestedWorkerModel?: string
  env: EnvLike
}): string {
  if (input.requestedWorkerModel) return normalizeZaiWorkerModel(input.requestedWorkerModel)
  const miniSweModel = input.env.MSWEA_MODEL_NAME?.trim()
  if (miniSweModel?.startsWith("zai/")) return `zai-coding-plan/${miniSweModel.slice("zai/".length)}`
  return DEFAULT_ZAI_CODING_PLAN_WORKER_MODEL
}

export function buildZaiCodingPlanConfigPatch(): Record<string, unknown> {
  return {
    provider: {
      [ZAI_CODING_PLAN_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ZAI Coding Plan",
        options: {
          baseURL: "{env:ZAI_API_BASE}",
          apiKey: "{env:ZAI_API_KEY}",
        },
        models: {
          "glm-5.2": {
            name: "GLM 5.2",
          },
          "glm-5.1": {
            name: "GLM 5.1",
          },
          "glm-5-turbo": {
            name: "GLM 5 Turbo",
          },
          "glm-4.7": {
            name: "GLM 4.7",
          },
        },
      },
    },
  }
}

export function mergeOpenCodeConfigContent(input: {
  existing?: Record<string, unknown>
  zaiConfig: Record<string, unknown>
  pactPluginPath: string
  pactPluginOptions?: Record<string, unknown>
  workerModel: string
}): Record<string, unknown> {
  const existing = input.existing ?? {}
  const provider = {
    ...(isRecord(existing.provider) ? existing.provider : {}),
    ...(isRecord(input.zaiConfig.provider) ? input.zaiConfig.provider : {}),
  }
  const plugin = normalizePluginArray(existing.plugin).filter((entry) => pluginPath(entry) !== input.pactPluginPath)
  plugin.push([
    input.pactPluginPath,
    {
      benchmarkStrictNetwork: true,
      ...input.pactPluginOptions,
      workerBackend: "opencode-cli",
      workerConfigSource: ZAI_CODING_PLAN_CONFIG_SOURCE,
      workerModel: input.workerModel,
    },
  ])
  return {
    ...existing,
    provider,
    plugin,
  }
}

function normalizeZaiWorkerModel(model: string): string {
  return model.startsWith("zai/") ? `zai-coding-plan/${model.slice("zai/".length)}` : model
}

function parseDotEnv(text: string): EnvLike {
  const env: EnvLike = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    let value = match[2]?.trim() ?? ""
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function normalizeURL(url: string): string {
  return url.replace(/\/+$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizePluginArray(value: unknown): OpenCodePluginSpec[] {
  if (!Array.isArray(value)) return []
  const plugins: OpenCodePluginSpec[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      plugins.push(entry)
      continue
    }
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue
    const options = isRecord(entry[1]) ? entry[1] : {}
    plugins.push([entry[0], options])
  }
  return plugins
}

function pluginPath(spec: OpenCodePluginSpec): string {
  return typeof spec === "string" ? spec : spec[0]
}
