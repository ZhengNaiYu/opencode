import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildZaiCodingPlanSmokeConfig,
  buildZaiCodingPlanConfigPatch,
  loadMiniSweAgentEnv,
  mergeOpenCodeConfigContent,
  resolveZaiCodingPlanWorkerModel,
  validateZaiCodingPlanEnv,
} from "./lolbench-smoke"

describe("LoLBench ZAI Coding Plan smoke config", () => {
  test("builds an OpenAI-compatible provider with env placeholders", () => {
    const patch = buildZaiCodingPlanConfigPatch()

    expect(patch).toMatchObject({
      provider: {
        "zai-coding-plan": {
          npm: "@ai-sdk/openai-compatible",
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
          },
        },
      },
    })
  })

  test("maps mini-swe-agent ZAI model names only when no explicit worker model is provided", () => {
    expect(
      resolveZaiCodingPlanWorkerModel({
        requestedWorkerModel: "zai-coding-plan/glm-5-turbo",
        env: { MSWEA_MODEL_NAME: "zai/glm-4.7" },
      }),
    ).toBe("zai-coding-plan/glm-5-turbo")
    expect(
      resolveZaiCodingPlanWorkerModel({
        env: { MSWEA_MODEL_NAME: "zai/glm-4.7" },
      }),
    ).toBe("zai-coding-plan/glm-4.7")
    expect(resolveZaiCodingPlanWorkerModel({ env: {} })).toBe("zai-coding-plan/glm-5-turbo")
  })

  test("validates the coding plan endpoint and merges plugin worker metadata", () => {
    expect(
      validateZaiCodingPlanEnv({
        ZAI_API_KEY: "secret-key-value",
        ZAI_API_BASE: "https://open.bigmodel.cn/api/paas/v4",
      }),
    ).toMatchObject({
      ok: false,
      missing: [],
      invalidBaseURL: true,
    })

    const merged = mergeOpenCodeConfigContent({
      existing: {
        plugin: ["@scope/existing-plugin", ["/existing/plugin.ts", { reviewerBackend: "codex-cli" }], ["/pact.ts", { old: true }]],
        share: "disabled",
      },
      zaiConfig: buildZaiCodingPlanConfigPatch(),
      pactPluginPath: "/pact.ts",
      pactPluginOptions: {
        reviewerBackend: "codex-cli",
      },
      workerModel: "zai-coding-plan/glm-5-turbo",
    })

    expect(merged.provider?.["zai-coding-plan"]).toBeDefined()
    expect(merged.agent?.["pact-specialist"]).toMatchObject({
      mode: "subagent",
      permission: { "*": "deny", read: "allow" },
    })
    expect(merged.plugin).toEqual([
      "@scope/existing-plugin",
      ["/existing/plugin.ts", { reviewerBackend: "codex-cli" }],
      [
        "/pact.ts",
        {
          benchmarkStrictNetwork: true,
          reviewerBackend: "codex-cli",
          workerBackend: "opencode-cli",
          workerConfigSource: "mini-swe-agent-env",
          workerModel: "zai-coding-plan/glm-5-turbo",
        },
      ],
    ])
  })

  test("loads mini-swe-agent dotenv and builds smoke config without leaking secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "pact-lolbench-env-"))
    try {
      const envPath = join(dir, ".env")
      writeFileSync(
        envPath,
        [
          "# mini-swe config",
          "export ZAI_API_KEY=secret-key-value",
          'ZAI_API_BASE="https://api.z.ai/api/coding/paas/v4"',
          "MSWEA_MODEL_NAME=zai/glm-4.7",
          "",
        ].join("\n"),
        "utf-8",
      )

      expect(loadMiniSweAgentEnv(envPath)).toMatchObject({
        ZAI_API_KEY: "secret-key-value",
        ZAI_API_BASE: "https://api.z.ai/api/coding/paas/v4",
        MSWEA_MODEL_NAME: "zai/glm-4.7",
      })

      const built = buildZaiCodingPlanSmokeConfig({
        envPath,
        pactPluginPath: "/pact.ts",
        pactPluginOptions: { reviewerBackend: "codex-cli" },
      })

      expect(built.validation).toMatchObject({ ok: true, env_keys_loaded: ["ZAI_API_KEY", "ZAI_API_BASE", "MSWEA_MODEL_NAME"] })
      expect(built.workerModel).toBe("zai-coding-plan/glm-4.7")
      expect(JSON.stringify(built.config)).not.toContain("secret-key-value")
      expect(built.config.plugin).toEqual([
        [
          "/pact.ts",
          {
            benchmarkStrictNetwork: true,
            reviewerBackend: "codex-cli",
            workerBackend: "opencode-cli",
            workerConfigSource: "mini-swe-agent-env",
            workerModel: "zai-coding-plan/glm-4.7",
          },
        ],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
