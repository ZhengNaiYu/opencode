import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { importSpecBundle } from "./pact-spec-importer"

const tempDirs: string[] = []
const cpythonTrialBundleRoot =
  "/Users/gujiazhen/Documents/cc_codes/benchmark/lolbench_trial-outputs-reme-1dot2_v14_opencode/gpt-5.5"
const pep709Bundle =
  `${cpythonTrialBundleRoot}/CPython_PEP-709_Inlined-comprehensions_PR-101441`

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeSyntheticBundle(
  bundleDir: string,
  input?: {
    deliveryOnlyRequirements?: boolean
    emptyRequirementInventory?: boolean
    genericLastLocalization?: boolean
  },
): void {
  const sectionsDir = join(bundleDir, "enhanced_requirement_sections")
  mkdirSync(sectionsDir, { recursive: true })
  writeFileSync(join(sectionsDir, "01_problem_understanding.md"), "## Problem Understanding\nBuild the feature.\n", "utf-8")
  writeFileSync(join(sectionsDir, "08_implementation_anchors.md"), "## Implementation Anchors\n- `Lib/feature.py`\n", "utf-8")
  writeFileSync(
    join(sectionsDir, "09_decomposed_implementation_steps.md"),
    `## Decomposed Implementation Steps
- [ ] \`STEP-001\` Preserve patch artifact scope [REQ-001]
  Group: GRP-001; depends_on: none
  Action: Put implementation changes in solution.patch.
  Rationale: Benchmark artifact compatibility.
  Anchors: none
  Checks: solution.patch contains no test-only diffs.
  Risk if skipped: The final artifact may fail the benchmark delivery contract.
  Confidence: 1.0; source=original_req; hard_requirement=True
- [ ] \`STEP-002\` Implement reusable runtime behavior [REQ-002, REQ-003]
  Group: GRP-002; depends_on: STEP-001
  Action: Add the runtime behavior in the existing library integration point.
  Rationale: This is the user-visible feature.
  Anchors: Lib/feature.py, Lib/test/test_feature.py
  Checks: Runtime constructor exposes the new behavior.; Existing callers keep working.
  Risk if skipped: The feature is not implemented.
  Confidence: 0.94; source=original_req; hard_requirement=True
`,
    "utf-8",
  )
  writeFileSync(join(sectionsDir, "13_formal_verification_checklist.md"), "## Formal Verification Checklist\n- Runtime behavior works.\n", "utf-8")
  writeFileSync(
    join(sectionsDir, "14_requirement_inventory.md"),
    input?.emptyRequirementInventory
      ? "## Requirement Inventory\n"
      : `## Requirement Inventory
- \`REQ-001\` (constraint, explicit, confidence=1.0): Make implementation changes in the project source tree.
- \`REQ-002\` (behavior, explicit, confidence=1.0): Add the runtime behavior.
- \`REQ-003\` (compatibility, explicit, confidence=0.9): Existing callers keep working.
`,
    "utf-8",
  )
  writeFileSync(
    join(sectionsDir, "15_decomposed_requirements.md"),
    input?.deliveryOnlyRequirements
      ? `## Decomposed Requirements
- **Patch Artifact Scope** [REQ-001]: Implementation work must be delivered through solution.patch rather than an unspecified alternate format.
- **Deliverable Validation** [REQ-001]: Final completion requires checking that solution.patch exists and contains the implementation changes.
`
      : `## Decomposed Requirements
- **Runtime behavior** [REQ-002]: Add the user-visible runtime behavior.
- **Compatibility** [REQ-003]: Preserve existing caller behavior.
`,
    "utf-8",
  )
  writeFileSync(join(sectionsDir, "20_edge_cases.md"), "## Edge Cases\n- Existing callers remain compatible.\n", "utf-8")
  writeFileSync(join(sectionsDir, "21_anti_patterns.md"), "## Anti-Patterns\n- Do not create a parallel subsystem.\n", "utf-8")
  writeFileSync(join(sectionsDir, "29_original_requirement.md"), "## Original Requirement\nImplement the synthetic feature.\n", "utf-8")
  if (input?.genericLastLocalization) {
    writeFileSync(
      join(sectionsDir, "31_function_targets.md"),
      `## Function Targets

## Likely Implementation Surfaces
- Should Inspect: \`Lib/feature.py\`.
`,
      "utf-8",
    )
  } else {
    writeFileSync(
      join(sectionsDir, "30_semantic_search_code_localization.md"),
      `## Semantic Search Code Localization Supplement

## Semantic Search Source: Likely Implementation Surfaces
- Should Inspect: \`Lib/feature.py\`.
`,
      "utf-8",
    )
  }
}

const realBundleTest = existsSync(pep709Bundle) ? test : test.skip
const allCpythonBundlesTest = existsSync(cpythonTrialBundleRoot) ? test : test.skip

describe("PACT spec importer", () => {
  test("generates round0 artifacts from a markdown-only section bundle and exposes copied evidence", () => {
    const projectRoot = tempDir("pact-spec-project-")
    const planFile = join(projectRoot, "prompt.md")
    writeFileSync(planFile, "Original LoLBench prompt placeholder.\n", "utf-8")
    const bundleDir = tempDir("pact-markdown-bundle-")
    writeSyntheticBundle(bundleDir)
    const outputLoopDir = join(projectRoot, ".pact", "loops", "spec-import-markdown-test")

    importSpecBundle({
      bundleDir,
      outputLoopDir,
      projectRoot,
      planFile,
      loopID: "spec-import-markdown-test",
      maxRounds: 5,
      now: new Date("2026-07-03T00:00:00.000Z"),
    })

    expect(existsSync(join(outputLoopDir, "spec-source", "enhanced_requirement_sections"))).toBe(true)
    expect(existsSync(join(outputLoopDir, "spec-code-localization.md"))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(outputLoopDir, "spec-input-manifest.json"), "utf-8"))
    expect(manifest).toMatchObject({
      schema: "pact-spec-input-manifest/v1",
      artifact_generation_strategy: "markdown-sections-v2",
      copied_evidence_dir: join(outputLoopDir, "spec-source", "enhanced_requirement_sections"),
      code_localization_file: join(outputLoopDir, "spec-code-localization.md"),
    })

    const plan = readFileSync(join(outputLoopDir, "plan.md"), "utf-8")
    expect(plan).toContain("Implement the synthetic feature")
    expect(plan).toContain("Runtime behavior")
    expect(plan).toContain("Compatibility")
    expect(plan).toContain("## Spec Evidence")
    expect(plan).toContain("spec-source/enhanced_requirement_sections")
    expect(plan).not.toContain("PEP 709")

    const todo = readFileSync(join(outputLoopDir, "todo.md"), "utf-8")
    expect(todo).toContain("STEP-002")
    expect(todo).not.toContain("STEP-001")
    expect(todo).not.toContain("Put implementation changes in solution.patch")

    expect(existsSync(join(outputLoopDir, "target-surfaces.json"))).toBe(true)
    expect(existsSync(join(outputLoopDir, "target-surface-contract.md"))).toBe(true)
    for (const fileName of [
      "behavioral-contract.md",
      "coverage-obligation.json",
      "ultimate-goal-checklist.json",
      "reviewer-audit-checklist.md",
    ]) {
      expect(existsSync(join(outputLoopDir, fileName))).toBe(true)
    }
    const contract = readFileSync(join(outputLoopDir, "target-surface-contract.md"), "utf-8")
    expect(contract).toContain("Hard Target Surface Status Gate")
    expect(contract).toContain("CHANGED")
    expect(contract).toContain("BASE_PROVEN_EQUIVALENT")
    expect(contract).not.toContain("JUSTIFIED_NO_DIFF")
    const behavioralContract = readFileSync(join(outputLoopDir, "behavioral-contract.md"), "utf-8")
    expect(behavioralContract).toContain("Runtime behavior")
    expect(behavioralContract).toContain("Compatibility")
    expect(behavioralContract).toContain("Lib/feature.py")
    const coverageObligation = JSON.parse(readFileSync(join(outputLoopDir, "coverage-obligation.json"), "utf-8"))
    expect(coverageObligation.obligations).toContainEqual(
      expect.objectContaining({
        id: "BO-001",
        title: "Runtime behavior",
        status: "UNVERIFIED",
      }),
    )
    expect(coverageObligation.obligations).not.toContainEqual(
      expect.objectContaining({ title: "Patch Artifact Scope" }),
    )
    const checklist = JSON.parse(readFileSync(join(outputLoopDir, "ultimate-goal-checklist.json"), "utf-8"))
    expect(checklist.checks).toContainEqual(expect.objectContaining({ id: "UG-001", status: "UNVERIFIED" }))
    expect(readFileSync(join(outputLoopDir, "reviewer-audit-checklist.md"), "utf-8")).toContain(
      "Base-Equivalence Proof Audit",
    )
  })

  test("falls back to implementation steps when decomposed requirements are delivery-only", () => {
    const projectRoot = tempDir("pact-spec-project-")
    const planFile = join(projectRoot, "prompt.md")
    writeFileSync(planFile, "Original LoLBench prompt placeholder.\n", "utf-8")
    const bundleDir = tempDir("pact-delivery-only-bundle-")
    writeSyntheticBundle(bundleDir, { deliveryOnlyRequirements: true, emptyRequirementInventory: true })
    const outputLoopDir = join(projectRoot, ".pact", "loops", "spec-import-fallback-test")

    importSpecBundle({
      bundleDir,
      outputLoopDir,
      projectRoot,
      planFile,
      loopID: "spec-import-fallback-test",
      maxRounds: 5,
      now: new Date("2026-07-03T00:00:00.000Z"),
    })

    const plan = readFileSync(join(outputLoopDir, "plan.md"), "utf-8")
    expect(plan).toContain("Implement reusable runtime behavior")
    expect(plan).not.toContain("| AC-1 | Patch Artifact Scope")
    expect(plan).not.toContain("checking that solution.patch exists")

    const round0 = JSON.parse(readFileSync(join(outputLoopDir, "round-00-result.json"), "utf-8"))
    expect(round0.metrics).toMatchObject({
      round0: true,
      imported_groups: 1,
      imported_tasks: 1,
    })
  })

  test("uses the highest numbered code-like section as code localization when no fixed semantic slug exists", () => {
    const projectRoot = tempDir("pact-spec-project-")
    const planFile = join(projectRoot, "prompt.md")
    writeFileSync(planFile, "Original LoLBench prompt placeholder.\n", "utf-8")
    const bundleDir = tempDir("pact-generic-localization-bundle-")
    writeSyntheticBundle(bundleDir, { genericLastLocalization: true })
    const outputLoopDir = join(projectRoot, ".pact", "loops", "spec-import-generic-localization-test")

    importSpecBundle({
      bundleDir,
      outputLoopDir,
      projectRoot,
      planFile,
      loopID: "spec-import-generic-localization-test",
      maxRounds: 5,
      now: new Date("2026-07-03T00:00:00.000Z"),
    })

    const manifest = JSON.parse(readFileSync(join(outputLoopDir, "spec-input-manifest.json"), "utf-8"))
    expect(manifest.core_sections.code_localization).toBe(join(outputLoopDir, "spec-code-localization.md"))
    expect(readFileSync(join(outputLoopDir, "spec-code-localization.md"), "utf-8")).toContain("Function Targets")
  })

  realBundleTest("generates a round0 resume source from the PEP-709 decomposition bundle", () => {
    const projectRoot = tempDir("pact-spec-project-")
    const planFile = join(projectRoot, "prompt.md")
    writeFileSync(planFile, "Original LoLBench prompt placeholder.\n", "utf-8")
    const outputLoopDir = join(projectRoot, ".pact", "loops", "spec-import-pep709-test")

    const result = importSpecBundle({
      bundleDir: pep709Bundle,
      outputLoopDir,
      projectRoot,
      planFile,
      loopID: "spec-import-pep709-test",
      maxRounds: 5,
      reviewerModel: "gpt-5.5",
      workerModel: "zai-coding-plan/glm-5.2",
      now: new Date("2026-06-30T00:00:00.000Z"),
    })

    expect(result.loopDir).toBe(outputLoopDir)
    for (const fileName of [
      "state.json",
      "loop-manifest.json",
      "source-plan.md",
      "plan.md",
      "todo.md",
      "goal-tracker.md",
      "round-00-result.json",
    ]) {
      expect(existsSync(join(outputLoopDir, fileName))).toBe(true)
    }

    const state = JSON.parse(readFileSync(join(outputLoopDir, "state.json"), "utf-8"))
    expect(state).toMatchObject({
      version: 2,
      status: "running",
      phase: "implementation",
      loop_id: "spec-import-pep709-test",
      next_round: 1,
      current_round: 1,
      max_rounds: 5,
      planner_backend: "spec-import",
      planner_model: null,
      reviewer_model: "gpt-5.5",
      worker_model: "zai-coding-plan/glm-5.2",
    })

    const manifest = JSON.parse(readFileSync(join(outputLoopDir, "loop-manifest.json"), "utf-8"))
    expect(manifest).toMatchObject({
      round0_source: "spec-import",
      spec_bundle_dir: pep709Bundle,
      planner_backend: "spec-import",
      artifact_generation_strategy: "markdown-sections-v2",
    })

    expect(existsSync(join(outputLoopDir, "spec-source", "enhanced_requirement_sections"))).toBe(true)
    expect(existsSync(join(outputLoopDir, "spec-code-localization.md"))).toBe(true)

    const plan = readFileSync(join(outputLoopDir, "plan.md"), "utf-8")
    expect(plan).toContain("Core inline comprehension compilation")
    expect(plan).toContain("Iteration variable isolation")
    expect(plan).toContain("Scope forms and comprehension variants")
    expect(plan).toContain("Observable compatibility changes")
    expect(plan).not.toContain("Patch packaging and validation scope")
    expect(plan).toContain("## Spec Evidence")
    expect(plan).toContain("spec-source/enhanced_requirement_sections")
    expect(plan).toContain("## Imported Formal Verification Checklist")
    expect(plan).not.toContain("Implementation changes are delivered in `solution.patch`")
    expect(plan).not.toContain("solution.patch contains no test-only diffs")

    const todo = readFileSync(join(outputLoopDir, "todo.md"), "utf-8")
    for (const step of ["STEP-001", "STEP-002", "STEP-003", "STEP-004", "STEP-005", "STEP-006"]) {
      expect(todo).toContain(step)
    }
    expect(todo).not.toContain("STEP-007")
    expect(todo).not.toContain("Put implementation changes in solution.patch")
    expect(todo).not.toContain("solution.patch contains no test-only diffs")

    const tracker = readFileSync(join(outputLoopDir, "goal-tracker.md"), "utf-8")
    expect(tracker).toContain("### Imported Formal Verification Checklist")
    expect(tracker).toContain("### Imported Edge Cases")
    expect(tracker).toContain("### Imported Anti-Patterns")
    expect(tracker).toContain("G(compile(list|dict|set comprehension)")
    expect(tracker).toContain("Inlining generator expressions")
    expect(tracker).not.toContain("Implementation changes are delivered in `solution.patch`")
    expect(tracker).not.toContain("solution.patch contains no test-only diffs")

    const workerFacing = [
      "source-plan.md",
      "plan.md",
      "todo.md",
      "goal-tracker.md",
      "round-00-result.json",
    ]
      .map((fileName) => readFileSync(join(outputLoopDir, fileName), "utf-8"))
      .join("\n")
    expect(workerFacing).not.toContain("diff --git a/solution.patch")
    expect(workerFacing).not.toContain("diff --git a/Python/compile.c")
    expect(workerFacing).not.toContain("+++ b/solution.patch")

    const round0 = JSON.parse(readFileSync(join(outputLoopDir, "round-00-result.json"), "utf-8"))
    expect(round0.metrics).toMatchObject({
      round0: true,
      imported_groups: 4,
      imported_tasks: 6,
    })
  })

  allCpythonBundlesTest("generates round0 resume sources for all CPython markdown section bundles", () => {
    const projectRoot = tempDir("pact-spec-project-")
    const planFile = join(projectRoot, "prompt.md")
    writeFileSync(planFile, "Original LoLBench prompt placeholder.\n", "utf-8")
    const outputRoot = join(projectRoot, ".pact", "loops")
    const caseDirs = readdirSync(cpythonTrialBundleRoot)
      .map((entry) => join(cpythonTrialBundleRoot, entry))
      .filter((entry) => statSync(entry).isDirectory() && existsSync(join(entry, "enhanced_requirement_sections")))
      .sort()

    expect(caseDirs.length).toBeGreaterThanOrEqual(11)

    for (const bundleDir of caseDirs) {
      const caseID = bundleDir.split("/").at(-1) ?? "unknown-case"
      const outputLoopDir = join(outputRoot, caseID, "spec-import-round0")
      importSpecBundle({
        bundleDir,
        outputLoopDir,
        projectRoot,
        planFile,
        loopID: `${caseID}-spec-import`,
        maxRounds: 5,
        now: new Date("2026-07-03T00:00:00.000Z"),
      })

      const state = JSON.parse(readFileSync(join(outputLoopDir, "state.json"), "utf-8"))
      expect(state).toMatchObject({
        next_round: 1,
        planner_backend: "spec-import",
        planner_model: null,
      })

      const manifest = JSON.parse(readFileSync(join(outputLoopDir, "spec-input-manifest.json"), "utf-8"))
      expect(manifest.artifact_generation_strategy).toBe("markdown-sections-v2")
      expect(manifest.section_files.length).toBeGreaterThan(8)
      expect(manifest.code_localization_file).toBe(join(outputLoopDir, "spec-code-localization.md"))
      expect(existsSync(join(outputLoopDir, "spec-source", "enhanced_requirement_sections"))).toBe(true)
      expect(existsSync(join(outputLoopDir, "spec-code-localization.md"))).toBe(true)

      const round0 = JSON.parse(readFileSync(join(outputLoopDir, "round-00-result.json"), "utf-8"))
      expect(round0.metrics.imported_tasks).toBeGreaterThan(0)
      expect(round0.metrics.imported_sections).toBe(manifest.section_files.length)

      const plan = readFileSync(join(outputLoopDir, "plan.md"), "utf-8")
      expect(plan).toContain("## Spec Evidence")
      expect(plan).toContain("spec-source/enhanced_requirement_sections")
      expect(plan).not.toContain("diff --git a/solution.patch")
    }
  })
})
