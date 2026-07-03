import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, join, resolve } from "node:path"

import {
  artifactPaths,
  commitRoundHistory,
  goalTrackerImmutableSha256,
  sha256Text,
  writeJsonFile,
} from "./pact-core"

type SectionFile = {
  number: number
  slug: string
  fileName: string
  sourcePath: string
  loopPath: string
  content: string
}

type RequirementGroup = {
  id: string
  title: string
  reqs: string[]
  criterion: string
  sourceStepID?: string
}

type TodoSeed = {
  step_id: string
  group_id: string
  title: string
  action: string
  depends_on: string[]
  reqs: string[]
  anchors: string[]
  checks: string[]
  hard_requirement: boolean
}

export type SpecImportInput = {
  bundleDir: string
  outputLoopDir: string
  projectRoot: string
  planFile: string
  loopID?: string
  maxRounds?: number
  reviewerModel?: string | null
  workerModel?: string | null
  workerConfigSource?: string | null
  sessionStrategy?: "new-per-round" | "same-session"
  fullAlignmentInterval?: number
  verificationCommand?: string
  verificationTimeoutMs?: number
  now?: Date
}

export type SpecImportResult = {
  loopDir: string
  loopID: string
  generatedFiles: string[]
  excludedFiles: string[]
}

type BundleData = {
  bundleDir: string
  sectionsDir: string
  copiedSectionsDir: string
  sections: SectionFile[]
  originalRequirement: string
  groups: RequirementGroup[]
  todoSeed: TodoSeed[]
  codeLocalization?: SectionFile
}

const excludedFiles = [
  "patch_final.diff",
  "opencode_output_build.jsonl",
  "trajectory_build.json",
  "solution.patch",
  "test.patch",
]

const copiedSectionsRelativeDir = "spec-source/enhanced_requirement_sections"

export function importSpecBundle(input: SpecImportInput): SpecImportResult {
  const bundleDir = resolve(input.bundleDir)
  const outputLoopDir = resolve(input.outputLoopDir)
  const projectRoot = resolve(input.projectRoot)
  const loopID = input.loopID ?? basename(outputLoopDir)
  const now = input.now ?? new Date()
  const data = readBundle({ bundleDir, outputLoopDir })

  mkdirSync(outputLoopDir, { recursive: true })
  copySectionEvidence(data.sectionsDir, join(outputLoopDir, copiedSectionsRelativeDir))

  const sourcePlan = renderSourcePlan(data)
  const plan = renderPlan(data)
  const todo = renderTodo(data)
  const goalTracker = renderGoalTracker(data)
  const goalTrackerHash = goalTrackerImmutableSha256(goalTracker)
  const baseCommit = currentHeadCommit(projectRoot)
  const state = {
    version: 2,
    status: "running",
    phase: "implementation",
    loop_id: loopID,
    next_round: 1,
    current_round: 1,
    max_rounds: input.maxRounds ?? 5,
    attempted_worker_rounds: 0,
    completed_worker_rounds: 0,
    reviewed_worker_rounds: 0,
    worker_round_count: 0,
    full_alignment_interval: Math.max(2, input.fullAlignmentInterval ?? 5),
    plan_file: input.planFile,
    source_plan_file: input.planFile,
    source_plan_path: join(outputLoopDir, "source-plan.md"),
    session_strategy: input.sessionStrategy ?? "new-per-round",
    round_boundary: "run_exit",
    trajectory_mode: "full-redact",
    planner_backend: "spec-import",
    planner_model: null,
    reviewer_backend: "codex-cli",
    reviewer_model: input.reviewerModel ?? "gpt-5.5",
    worker_backend: "opencode-cli",
    worker_model: input.workerModel ?? "zai-coding-plan/glm-5.2",
    worker_config_source: input.workerConfigSource,
    verification_command: input.verificationCommand,
    verification_timeout_ms: input.verificationTimeoutMs,
    goal_tracker_immutable_sha256: goalTrackerHash,
    base_commit: baseCommit,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    spec_import: {
      schema: "pact-spec-import/v1",
      bundle_dir: bundleDir,
      artifact_generation_strategy: "markdown-sections-v2",
      copied_evidence_dir: join(outputLoopDir, copiedSectionsRelativeDir),
      code_localization_file: data.codeLocalization ? join(outputLoopDir, "spec-code-localization.md") : undefined,
      excluded_files: excludedFiles,
    },
  }

  writeFileSync(join(outputLoopDir, "source-plan.md"), sourcePlan, "utf-8")
  writeFileSync(join(outputLoopDir, "plan.md"), plan, "utf-8")
  writeFileSync(join(outputLoopDir, "todo.md"), todo, "utf-8")
  writeFileSync(join(outputLoopDir, "goal-tracker.md"), goalTracker, "utf-8")
  writeFileSync(join(outputLoopDir, "spec-implementation-anchors.md"), sectionText(data, "implementation_anchors"), "utf-8")
  writeFileSync(join(outputLoopDir, "spec-decomposed-steps.md"), sectionText(data, "decomposed_implementation_steps"), "utf-8")
  writeFileSync(join(outputLoopDir, "spec-decomposed-requirements.md"), sectionText(data, "decomposed_requirements"), "utf-8")
  writeFileSync(join(outputLoopDir, "spec-formal-verification-checklist.md"), sectionText(data, "formal_verification_checklist"), "utf-8")
  writeFileSync(join(outputLoopDir, "spec-edge-cases.md"), sectionText(data, "edge_cases"), "utf-8")
  writeFileSync(join(outputLoopDir, "spec-anti-patterns.md"), sectionText(data, "anti_patterns"), "utf-8")
  if (data.codeLocalization) {
    writeFileSync(join(outputLoopDir, "spec-code-localization.md"), data.codeLocalization.content, "utf-8")
  }
  writeJsonFile(join(outputLoopDir, "state.json"), state)
  writeJsonFile(join(outputLoopDir, "spec-input-manifest.json"), specInputManifest(data, outputLoopDir))

  writeJsonFile(artifactPaths(outputLoopDir, 1).loopManifest, {
    schema: "pact-loop-manifest/v1",
    artifact_version: 2,
    loop_id: loopID,
    project_root: projectRoot,
    plan_file: input.planFile,
    source_plan_path: join(outputLoopDir, "source-plan.md"),
    source_plan_sha256: sha256Text(sourcePlan),
    plan_sha256: sha256Text(plan),
    round0_enabled: true,
    round0_source: "spec-import",
    spec_bundle_dir: bundleDir,
    artifact_generation_strategy: "markdown-sections-v2",
    copied_evidence_dir: join(outputLoopDir, copiedSectionsRelativeDir),
    code_localization_file: data.codeLocalization ? join(outputLoopDir, "spec-code-localization.md") : undefined,
    excluded_files: excludedFiles,
    max_rounds: state.max_rounds,
    next_round: state.next_round,
    current_round_deprecated_alias: state.current_round,
    attempted_worker_rounds: 0,
    completed_worker_rounds: 0,
    reviewed_worker_rounds: 0,
    full_alignment_interval: state.full_alignment_interval,
    session_strategy: state.session_strategy,
    round_boundary: state.round_boundary,
    trajectory_mode: state.trajectory_mode,
    planner_backend: "spec-import",
    planner_model: null,
    reviewer_backend: state.reviewer_backend,
    reviewer_model: state.reviewer_model,
    worker_backend: state.worker_backend,
    worker_model: state.worker_model,
    worker_config_source: state.worker_config_source,
    verification_enabled: Boolean(state.verification_command),
    verification_command: state.verification_command,
    verification_timeout_ms: state.verification_timeout_ms,
    goal_tracker_immutable_sha256: goalTrackerHash,
    base_commit: baseCommit,
    created_at: now.toISOString(),
  })
  writeJsonFile(artifactPaths(outputLoopDir, 0).roundState, {
    schema: "pact-round-state/v1",
    artifact_version: 1,
    loop_id: loopID,
    round: 0,
    phase: "round_finished",
    loop_phase: "implementation",
    started_at: now.toISOString(),
    updated_at: now.toISOString(),
    result_path: artifactPaths(outputLoopDir, 0).roundResult,
    status: "complete",
    notes: "Round 00 deterministically imported an external requirement decomposition bundle.",
  })
  writeJsonFile(join(outputLoopDir, "round-00-git-snapshot.json"), {
    schema: "pact-git-snapshot/v1",
    artifact_version: 1,
    loop_id: loopID,
    round: 0,
    stage: "git",
    created_at: now.toISOString(),
    project_root: projectRoot,
    head: baseCommit ?? null,
  })
  writeJsonFile(artifactPaths(outputLoopDir, 0).roundResult, {
    schema: "pact-round-result/v1",
    artifact_version: 1,
    loop_id: loopID,
    round: 0,
    status: "complete",
    loop_phase: "implementation",
    created_at: now.toISOString(),
    failure_category: null,
    planner_backend: "spec-import",
    planner_model: null,
    reviewer_backend: state.reviewer_backend,
    reviewer_model: state.reviewer_model,
    worker_backend: state.worker_backend,
    worker_model: state.worker_model,
    worker_config_source: state.worker_config_source,
    metrics: {
      round0: true,
      imported_groups: data.groups.length,
      imported_tasks: data.todoSeed.length,
      imported_sections: data.sections.length,
    },
    artifacts: {
      source_plan: join(outputLoopDir, "source-plan.md"),
      canonical_plan: join(outputLoopDir, "plan.md"),
      todo: join(outputLoopDir, "todo.md"),
      goal_tracker: join(outputLoopDir, "goal-tracker.md"),
      spec_input_manifest: join(outputLoopDir, "spec-input-manifest.json"),
      spec_evidence_dir: join(outputLoopDir, copiedSectionsRelativeDir),
      spec_code_localization: data.codeLocalization ? join(outputLoopDir, "spec-code-localization.md") : undefined,
      git_snapshot: join(outputLoopDir, "round-00-git-snapshot.json"),
    },
  })

  commitRoundHistory(outputLoopDir, 0, "round-00 imported requirement decomposition")

  return {
    loopDir: outputLoopDir,
    loopID,
    excludedFiles,
    generatedFiles: [
      "state.json",
      "loop-manifest.json",
      "source-plan.md",
      "plan.md",
      "todo.md",
      "goal-tracker.md",
      "round-00-result.json",
      "round-00-state.json",
      "round-00-git-snapshot.json",
      "spec-input-manifest.json",
      "spec-source/enhanced_requirement_sections",
      "spec-code-localization.md",
    ],
  }
}

function readBundle(input: { bundleDir: string; outputLoopDir: string }): BundleData {
  const sectionsDir = join(input.bundleDir, "enhanced_requirement_sections")
  if (!existsSync(sectionsDir)) throw new Error(`Missing spec import sections directory: ${sectionsDir}`)
  const sections = readSections(sectionsDir, input.outputLoopDir)
  const codeLocalization = findCodeLocalizationSection(sections)
  const steps = parseImplementationSteps(sectionTextFromSections(sections, "decomposed_implementation_steps"))
  const nonDeliverySteps = steps.filter((step) => !isDeliveryOnlyTask(step))
  const parsedGroups = parseRequirementGroups(sectionTextFromSections(sections, "decomposed_requirements")).filter(
    (group) => !isDeliveryOnlyGroup(group),
  )
  const groups = parsedGroups.length ? parsedGroups : groupsFromSteps(nonDeliverySteps)
  return {
    bundleDir: input.bundleDir,
    sectionsDir,
    copiedSectionsDir: join(input.outputLoopDir, copiedSectionsRelativeDir),
    sections,
    originalRequirement:
      stripHeading(sectionTextFromSections(sections, "original_requirement")) ||
      readOptionalText(join(input.bundleDir, "original_requirement.txt")) ||
      stripHeading(sectionTextFromSections(sections, "problem_understanding")) ||
      "Imported LoLBench requirement.",
    groups,
    todoSeed: nonDeliverySteps,
    codeLocalization,
  }
}

function readSections(sectionsDir: string, outputLoopDir: string): SectionFile[] {
  return readdirSync(sectionsDir)
    .filter((fileName) => /^\d+_.+\.md$/.test(fileName))
    .sort((left, right) => numericPrefix(left) - numericPrefix(right) || left.localeCompare(right))
    .map((fileName) => {
      const sourcePath = join(sectionsDir, fileName)
      return {
        number: numericPrefix(fileName),
        slug: fileName.replace(/^\d+_/, "").replace(/\.md$/, ""),
        fileName,
        sourcePath,
        loopPath: join(outputLoopDir, copiedSectionsRelativeDir, fileName),
        content: readText(sourcePath),
      }
    })
}

function findCodeLocalizationSection(sections: SectionFile[]): SectionFile | undefined {
  const explicit = [...sections]
    .reverse()
    .find((section) => /(?:semantic_search_)?code_localization|code_function_localization|implementation_surfaces/.test(section.slug))
  if (explicit) return explicit

  const lastSection = sections.at(-1)
  if (!lastSection) return undefined
  return looksLikeCodeLocalization(lastSection) ? lastSection : undefined
}

function looksLikeCodeLocalization(section: SectionFile): boolean {
  if (/\b(?:code|function|file|anchor|localization|surface|target)\b/i.test(section.slug.replace(/_/g, " "))) return true
  return /semantic search code localization|likely implementation surfaces|should inspect|target (?:functions|files)|function localization|code localization/i.test(
    section.content,
  )
}

function parseRequirementGroups(text: string): RequirementGroup[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^- \*\*(.+?)\*\* \[([^\]]*)\]:\s*(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match, index) => ({
      id: `GRP-${String(index + 1).padStart(3, "0")}`,
      title: match[1]?.trim() ?? `Requirement ${index + 1}`,
      reqs: reqList(match[2] ?? ""),
      criterion: workerSafePatchExportText(match[3]?.trim() ?? ""),
    }))
}

function parseImplementationSteps(text: string): TodoSeed[] {
  const starts = [...text.matchAll(/^- \[ \] `STEP-\d+` .+$/gm)].map((match) => match.index ?? 0)
  return starts
    .map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim())
    .map(parseImplementationStep)
    .filter((task): task is TodoSeed => Boolean(task))
}

function parseImplementationStep(block: string): TodoSeed | undefined {
  const header = /^- \[ \] `(STEP-\d+)` (.+?) \[([^\]]*)\]/m.exec(block)
  if (!header) return undefined
  const groupLine = /^  Group:\s*([^;]+);\s*depends_on:\s*(.+)$/m.exec(block)
  return {
    step_id: header[1] ?? "STEP-000",
    title: header[2]?.trim() ?? "Imported implementation step",
    reqs: reqList(header[3] ?? ""),
    group_id: groupLine?.[1]?.trim() ?? "GRP-001",
    depends_on: splitList(groupLine?.[2] ?? ""),
    action: workerSafePatchExportText(blockField(block, "Action") ?? ""),
    anchors: splitList(blockField(block, "Anchors") ?? ""),
    checks: splitSemicolonList(workerSafePatchExportText(blockField(block, "Checks") ?? "")),
    hard_requirement: /\bhard_requirement=True\b/i.test(block),
  }
}

function groupsFromSteps(steps: TodoSeed[]): RequirementGroup[] {
  return steps.map((step) => ({
    id: step.step_id,
    title: step.title,
    reqs: step.reqs,
    criterion: `${step.title}: ${step.action || "Imported implementation step."}`,
    sourceStepID: step.step_id,
  }))
}

function renderSourcePlan(data: BundleData): string {
  return [
    "# Imported Requirement Decomposition",
    "",
    "The original requirement remains authoritative. The imported Markdown sections, copied evidence directory, and code-localization supplement are execution guidance for PACT worker/reviewer rounds.",
    "",
    "Important exclusion: patch_final.diff and generated final patch artifacts are not part of worker/reviewer input.",
    "",
    "## Original Requirement",
    data.originalRequirement.trim(),
    "",
    "## Primary Decomposed Requirements",
    sectionText(data, "decomposed_requirements").trim(),
    "",
    "## Primary Decomposed Implementation Steps",
    sectionText(data, "decomposed_implementation_steps").trim(),
    "",
    "## Formal Verification Checklist",
    sectionText(data, "formal_verification_checklist").trim(),
    "",
    "## Edge Cases",
    sectionText(data, "edge_cases").trim(),
    "",
    "## Anti-Patterns",
    sectionText(data, "anti_patterns").trim(),
    "",
    "## Spec Evidence",
    `- Copied section directory: ${copiedSectionsRelativeDir}`,
    data.codeLocalization ? "- Code localization supplement: spec-code-localization.md" : "- Code localization supplement: unavailable",
    "",
  ].join("\n")
}

function renderPlan(data: BundleData): string {
  return [
    "# Goal Description",
    `Implement the imported LoLBench requirement: ${firstSentence(data.originalRequirement)} The worker edits workspace source/test files only; PACT/harness owns final patch export.`,
    "",
    "## Acceptance Criteria",
    "| AC | Criterion | Positive Tests | Negative Tests |",
    "| --- | --- | --- | --- |",
    ...data.groups.map((group, index) => {
      const ac = `AC-${index + 1}`
      return `| ${ac} | ${escapeTableCell(groupCriterion(group))} | ${escapeTableCell(groupPositiveTests(group, data))} | ${escapeTableCell(groupNegativeTests(group, data))} |`
    }),
    "",
    "## Path Boundaries",
    "- Edit workspace source/test files only.",
    "- PACT/harness owns final solution.patch/test.patch export and validation-owned patch artifacts.",
    "- Do not inspect, copy, or apply patch_final.diff during worker or reviewer rounds.",
    "- Do not use web/code-host lookup.",
    "",
    "## Spec Evidence",
    `- Spec input manifest: spec-input-manifest.json`,
    `- Copied source sections: ${copiedSectionsRelativeDir}`,
    data.codeLocalization ? "- Code/function localization supplement: spec-code-localization.md" : "- Code/function localization supplement: unavailable",
    "- These evidence files are advisory inspection aids. Use them when helpful, then verify against the repository source before editing.",
    "",
    "## Dependencies",
    ...data.todoSeed.map((task) => {
      const dependencies = activeStepDependencies(data, task)
      return `- ${task.step_id}: ${task.title}${dependencies.length ? ` depends on ${dependencies.join(", ")}` : ""}`
    }),
    "",
    "## Imported Formal Verification Checklist",
    sectionText(data, "formal_verification_checklist").trim(),
    "",
    "## Imported Implementation Anchors",
    sectionText(data, "implementation_anchors").trim(),
    "",
    "## Task Breakdown",
    "| Task ID | Description | Target AC | Tag | Depends On |",
    "| --- | --- | --- | --- | --- |",
    ...taskRows(data),
    "",
    "## Pending Decisions",
    "- Follow the target repository branch's existing architecture and generated-file workflow when exact mechanics differ from imported guidance.",
    "- Keep implementation edits separable from optional test edits; PACT/harness owns patch export.",
    "",
  ].join("\n")
}

function renderTodo(data: BundleData): string {
  return [
    "# Todo",
    "",
    "| Task ID | Description | Target AC | Tag | Depends On | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...taskRows(data).map((row) => `${row.replace(/\s*\|\s*$/, "")} | pending |`),
    "",
  ].join("\n")
}

function renderGoalTracker(data: BundleData): string {
  return [
    "# Goal Tracker",
    "",
    "<!--",
    "This file tracks imported PACT goals and progress.",
    "RULES:",
    "- IMMUTABLE SECTION: do not modify after loop initialization.",
    "- MUTABLE SECTION: updates must preserve evidence and justification.",
    "- Imported checklists, edge cases, anti-patterns, and code-localization files are reviewer audit inputs.",
    "-->",
    "",
    "## IMMUTABLE SECTION",
    "",
    "### Ultimate Goal",
    `Implement the imported LoLBench requirement: ${firstSentence(data.originalRequirement)} The worker edits workspace source/test files only; PACT/harness owns final patch export.`,
    "",
    "### Acceptance Criteria",
    "| AC | Criterion | Positive Tests | Negative Tests | Status |",
    "| --- | --- | --- | --- | --- |",
    ...data.groups.map((group, index) => {
      const ac = `AC-${index + 1}`
      return `| ${ac} | ${escapeTableCell(groupCriterion(group))} | ${escapeTableCell(groupPositiveTests(group, data))} | ${escapeTableCell(groupNegativeTests(group, data))} | pending |`
    }),
    "",
    "### Spec Evidence",
    `- Spec input manifest: spec-input-manifest.json`,
    `- Copied source sections: ${copiedSectionsRelativeDir}`,
    data.codeLocalization ? "- Code/function localization supplement: spec-code-localization.md" : "- Code/function localization supplement: unavailable",
    "",
    "### Imported Formal Verification Checklist",
    sectionText(data, "formal_verification_checklist").trim(),
    "",
    "### Imported Edge Cases",
    sectionText(data, "edge_cases").trim(),
    "",
    "### Imported Anti-Patterns",
    sectionText(data, "anti_patterns").trim(),
    "",
    "## MUTABLE SECTION",
    "",
    "### Plan Version: 1 (Updated: Round 1)",
    "",
    "#### Plan Evolution Log",
    "| Round | Change | Reason | Impact on AC |",
    "| --- | --- | --- | --- |",
    "| 1 | Imported requirement decomposition as canonical Round00 state | Deterministic spec import replaced LLM planner | All ACs |",
    "",
    "#### Active Tasks",
    "| Task | Target AC | Status | Tag | Owner | Notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...data.todoSeed.map((task, index) => {
      const taskID = `task-${index + 1}`
      return `| ${taskID} | ${acForTask(data, task)} | pending | ${taskTag(task, index)} | worker | ${escapeTableCell(taskNote(task))} |`
    }),
    "",
    "### Completed and Verified",
    "| AC | Task | Completed Round | Verified Round | Evidence |",
    "| --- | --- | --- | --- | --- |",
    "",
    "### Explicitly Deferred",
    "| Task | Original AC | Deferred Since | Justification | When to Reconsider |",
    "| --- | --- | --- | --- | --- |",
    "",
    "### Open Issues",
    "| Issue | Discovered Round | Blocking AC | Resolution Path |",
    "| --- | --- | --- | --- |",
    "",
  ].join("\n")
}

function specInputManifest(data: BundleData, outputLoopDir: string): Record<string, unknown> {
  return {
    schema: "pact-spec-input-manifest/v1",
    artifact_generation_strategy: "markdown-sections-v2",
    bundle_dir: data.bundleDir,
    sections_dir: data.sectionsDir,
    copied_evidence_dir: join(outputLoopDir, copiedSectionsRelativeDir),
    code_localization_file: data.codeLocalization ? join(outputLoopDir, "spec-code-localization.md") : undefined,
    core_sections: {
      original_requirement: rolePath(data, "original_requirement"),
      implementation_anchors: rolePath(data, "implementation_anchors"),
      decomposed_implementation_steps: rolePath(data, "decomposed_implementation_steps"),
      decomposed_requirements: rolePath(data, "decomposed_requirements"),
      formal_verification_checklist: rolePath(data, "formal_verification_checklist"),
      edge_cases: rolePath(data, "edge_cases"),
      anti_patterns: rolePath(data, "anti_patterns"),
      code_localization: data.codeLocalization ? join(outputLoopDir, "spec-code-localization.md") : undefined,
    },
    section_files: data.sections.map((section) => ({
      number: section.number,
      slug: section.slug,
      source_path: section.sourcePath,
      loop_path: section.loopPath,
      sha256: sha256Text(section.content),
    })),
    excluded_files: excludedFiles,
  }
}

function taskRows(data: BundleData): string[] {
  const stepToTask = new Map(data.todoSeed.map((task, index) => [task.step_id, `task-${index + 1}`]))
  return data.todoSeed.map((task, index) => {
    const taskID = `task-${index + 1}`
    const dependsOn = activeStepDependencies(data, task)
      .map((step) => stepToTask.get(step) ?? step)
      .join(", ") || "-"
    return `| ${taskID} | ${escapeTableCell(taskDescription(task))} | ${acForTask(data, task)} | ${taskTag(task, index)} | ${escapeTableCell(dependsOn)} |`
  })
}

function activeStepDependencies(data: BundleData, task: TodoSeed): string[] {
  const activeStepIDs = new Set(data.todoSeed.map((candidate) => candidate.step_id))
  return task.depends_on.filter((step) => activeStepIDs.has(step))
}

function groupCriterion(group: RequirementGroup): string {
  return workerSafePatchExportText(`${group.title}: ${group.criterion}`)
}

function groupPositiveTests(group: RequirementGroup, data: BundleData): string {
  const matchingChecks = data.todoSeed
    .filter((task) => task.reqs.some((req) => group.reqs.includes(req)) || task.step_id === group.sourceStepID)
    .flatMap((task) => task.checks)
  return matchingChecks.length ? matchingChecks.join("; ") : "Imported requirement behavior is implemented and verified."
}

function groupNegativeTests(group: RequirementGroup, data: BundleData): string {
  const antiPatterns = stripHeading(sectionText(data, "anti_patterns"))
  if (antiPatterns) return firstSentence(antiPatterns)
  return `Forbidden states and regressions for ${group.title} are rejected.`
}

function taskDescription(task: TodoSeed): string {
  const anchors = task.anchors.length ? ` Anchors: ${task.anchors.join(", ")}.` : ""
  const checks = task.checks.length ? ` Checks: ${task.checks.join("; ")}.` : ""
  const hard = task.hard_requirement ? " Hard requirement." : ""
  return `${task.step_id} ${task.title}: ${task.action}${anchors}${checks}${hard}`
}

function taskNote(task: TodoSeed): string {
  const anchors = task.anchors.length ? ` Anchors: ${task.anchors.join(", ")}.` : ""
  const checks = task.checks.length ? ` Checks: ${task.checks.join("; ")}.` : ""
  return `${task.step_id}: ${task.action}${anchors}${checks}${task.hard_requirement ? " Hard requirement." : ""}`
}

function acForTask(data: BundleData, task: TodoSeed): string {
  const sourceStepIndex = data.groups.findIndex((group) => group.sourceStepID === task.step_id)
  if (sourceStepIndex >= 0) return `AC-${sourceStepIndex + 1}`
  const reqIndex = data.groups.findIndex((group) => task.reqs.some((req) => group.reqs.includes(req)))
  if (reqIndex >= 0) return `AC-${reqIndex + 1}`
  const groupIndex = data.groups.findIndex((group) => group.id === task.group_id)
  return groupIndex >= 0 ? `AC-${groupIndex + 1}` : "AC-1"
}

function taskTag(task: TodoSeed, index: number): "analyze" | "coding" {
  if (index === 0 || /^map\b|^audit\b|^assess\b|^inspect\b|^verify\b/i.test(task.title)) return "analyze"
  return "coding"
}

function sectionText(data: BundleData, slug: string): string {
  return sectionTextFromSections(data.sections, slug)
}

function sectionTextFromSections(sections: SectionFile[], slug: string): string {
  return sections.find((section) => section.slug === slug)?.content ?? ""
}

function rolePath(data: BundleData, slug: string): string | undefined {
  const section = data.sections.find((candidate) => candidate.slug === slug)
  return section?.loopPath
}

function copySectionEvidence(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const fileName of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, fileName)
    if (!statSync(sourcePath).isFile()) continue
    copyFileSync(sourcePath, join(targetDir, fileName))
  }
}

function isDeliveryOnlyGroup(group: RequirementGroup): boolean {
  return isDeliveryOnlyText(`${group.title} ${group.criterion}`)
}

function isDeliveryOnlyTask(task: TodoSeed): boolean {
  return isDeliveryOnlyText(`${task.title} ${task.action} ${task.checks.join(" ")}`)
}

function isDeliveryOnlyText(text: string): boolean {
  const normalized = text.toLowerCase()
  if (/\b(?:solution\.patch|test\.patch|patch artifact|patch output|deliverable|package patches|patch packaging|patch separation)\b/i.test(normalized)) {
    return true
  }
  return /\b(?:emit|generate|produce|prepare|validate|preserve|maintain)\b/i.test(normalized) && /\bpatch\b/i.test(normalized)
}

function workerSafePatchExportText(text: string): string {
  return text
    .replace(/Put implementation changes in `?solution\.patch`?\.\s*/gi, "Keep implementation changes in workspace source files. ")
    .replace(/Implementation work must be delivered through `?solution\.patch`?/gi, "Implementation work must remain in workspace source files")
    .replace(/Implementation changes are delivered in `?solution\.patch`?\./gi, "PACT/harness exports implementation changes from workspace source edits.")
    .replace(/If optional tests are added, put them in `?test\.patch`? only\./gi, "If optional tests are added, keep them as separable workspace test edits; PACT/harness owns test.patch export.")
    .replace(/Tests are optional; if added, they are delivered separately in `?test\.patch`? and not included in `?solution\.patch`?\./gi, "Tests are optional; if added, they remain separable workspace test edits and are not mixed with implementation edits.")
    .replace(/`?solution\.patch`? contains no test-only diffs\./gi, "Implementation edits remain separable from test-only diffs.")
    .replace(/`?test\.patch`? exists only if tests were added and contains no implementation changes\./gi, "Optional test edits remain separable from implementation edits.")
    .replace(/Mixing optional tests into `?solution\.patch`?/gi, "Mixing optional tests into implementation edits")
}

function stripHeading(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
    .join("\n")
    .trim()
}

function firstSentence(text: string): string {
  const stripped = stripHeading(text).replace(/\s+/g, " ").trim()
  const sentence = /^(.{1,280}?[.!?])(?:\s|$)/.exec(stripped)?.[1]
  return (sentence ?? stripped.slice(0, 280)).trim() || "Imported LoLBench requirement."
}

function blockField(block: string, name: string): string | undefined {
  return new RegExp(`^  ${name}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim()
}

function reqList(text: string): string[] {
  return [...text.matchAll(/\bREQ-\d+\b/g)].map((match) => match[0])
}

function splitList(text: string): string[] {
  if (!text || /^none$/i.test(text.trim())) return []
  return text
    .split(/,\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitSemicolonList(text: string): string[] {
  return text
    .split(/;\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function numericPrefix(fileName: string): number {
  return Number(/^(\d+)_/.exec(fileName)?.[1] ?? 0)
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|").trim()
}

function readText(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`Missing spec import file: ${filePath}`)
  return readFileSync(filePath, "utf-8")
}

function readOptionalText(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, "utf-8") : undefined
}

function currentHeadCommit(projectRoot: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf-8" })
  if (result.status !== 0) return undefined
  return result.stdout.trim() || undefined
}

function parseArgs(raw: string[]): SpecImportInput {
  const args = [...raw]
  const parsed: Record<string, string | undefined> = {}
  while (args.length) {
    const key = args.shift()
    if (!key?.startsWith("--")) continue
    parsed[key.slice(2)] = args.shift()
  }
  const bundleDir = parsed["bundle-dir"]
  const outputLoopDir = parsed["output-loop-dir"]
  const projectRoot = parsed["project-root"]
  const planFile = parsed["plan-file"]
  if (!bundleDir) throw new Error("Missing --bundle-dir")
  if (!outputLoopDir) throw new Error("Missing --output-loop-dir")
  if (!projectRoot) throw new Error("Missing --project-root")
  if (!planFile) throw new Error("Missing --plan-file")
  return {
    bundleDir,
    outputLoopDir,
    projectRoot,
    planFile,
    loopID: parsed["loop-id"],
    maxRounds: parsed["max-rounds"] ? Number(parsed["max-rounds"]) : undefined,
    reviewerModel: parsed["reviewer-model"],
    workerModel: parsed.model ?? parsed["worker-model"],
    workerConfigSource: parsed["worker-config-source"],
    sessionStrategy: parsed["session-strategy"] === "same-session" ? "same-session" : "new-per-round",
    fullAlignmentInterval: parsed["full-alignment-interval"] ? Number(parsed["full-alignment-interval"]) : undefined,
    verificationCommand: parsed["verification-command"],
    verificationTimeoutMs: parsed["verification-timeout-ms"] ? Number(parsed["verification-timeout-ms"]) : undefined,
  }
}

if (import.meta.main) {
  const result = importSpecBundle(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify(result, null, 2))
}
