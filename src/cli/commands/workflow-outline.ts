import { z } from "zod";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { charterInvariantSchema } from "@/lib/workflows/charter-schemas";
import {
  acceptanceCriteriaSchema,
  criterionRecordsOf,
} from "@/lib/workflow-graph/criteria/criterion-records";
import {
  graphWorkflowAgentValidationOverrideSchema,
  graphWorkflowLaneMergeValidationOverrideSchema,
  graphWorkflowScriptValidatorConfigSchema,
  type GraphWorkflowCommandSelector,
  type GraphWorkflowLaneMergeValidationOverride,
} from "@/lib/workflow-graph/config-schemas";
import {
  formatOutputSchemaShape,
  summarizeOutputSchemaShape,
  type OutputSchemaShape,
} from "./workflow-output-schema";

/**
 * CLI-side projections over the `GET /workflows/[workflowId]` response `item`
 * (docs/design/cc-cli/05 §Read API). The outline is the agent's navigation map:
 * structure + identifiers + prose SIZES (never prose bodies), so addressing an
 * edit costs a few hundred tokens instead of the whole definition. The section
 * selectors return one full slice (prose included) for the piece the agent
 * intends to change. Structural fields parse a deliberately minimal, permissive
 * local mirror of the record, retaining unknown keys (`.loose()`) so per-context
 * config-override blocks survive for the `--context` / `--config` slices. The
 * validation selector blocks are the exception: those parse the foundation
 * schemas from `@/lib/workflow-graph/config-schemas` (charter invariant
 * contracts-from-foundation — selector shapes are never privately redefined).
 */

/** The cascade override blocks, in the order the outline reports them. */
const CONFIG_BLOCK_KEYS = [
  "implementer",
  "contextValidator",
  "scriptValidator",
  "iterationPolicy",
  "circuitBreaker",
  "mutability",
  "planRepair",
  "collaboration",
  "humanApprovalGate",
  "askUserQuestions",
  "agentValidation",
  // Workflow tier only — never present on a context, but the shared key list
  // is harmless there and keeps `--config` slicing uniform.
  "laneMergeValidation",
] as const;

/**
 * The assignment shapes as they appear in a SAVED definition: reference-bearing.
 * Deliberately permissive like the rest of this mirror — a definition authored
 * against a newer server may carry fields this CLI does not render, and that
 * must not cost the outline. What it may NOT carry is a resolved snapshot;
 * `live get` is the surface for those.
 */
const outlineProfileRefSchema = z
  .object({ tier: z.string(), id: z.string() })
  .loose();

const outlineAgentRuntimeSchema = z
  .object({
    backend: z.string(),
    modelSelection: backendModelSelectionSchema,
  })
  .loose();

const outlineAssignmentSchema = z
  .object({
    id: z.string(),
    profile: outlineProfileRefSchema,
    focus: z.string().optional(),
    agent: outlineAgentRuntimeSchema,
  })
  .loose();

const outlineValidatorCohortSchema = z
  .object({
    enabled: z.boolean(),
    assignments: z.array(outlineAssignmentSchema),
  })
  .loose();

const outlineStaffingSchema = z.object({
  implementer: outlineAssignmentSchema.optional(),
  contextValidator: outlineValidatorCohortSchema.optional(),
});

/** `all-except format` / `only test` / `none` / `all` — the outline vocabulary. */
export function formatCommandSelector(
  selector: GraphWorkflowCommandSelector,
): string {
  if (selector.mode === "all") {
    return selector.except.length > 0
      ? `all-except ${selector.except.join("+")}`
      : "all";
  }
  return selector.commands.length > 0
    ? `only ${selector.commands.join("+")}`
    : "none";
}

/**
 * `final-only project` / `every-merge typecheck+test` / `final-only none` —
 * the lane-merge vocabulary shared by the saved and live outline renderers.
 * Accepts the override shape (resolved snapshots are assignable to it); an
 * omitted strategy reads as the schema default.
 */
export function formatLaneMergeSelection(
  laneMergeValidation: GraphWorkflowLaneMergeValidationOverride,
): string {
  const commands = laneMergeValidation.commands;
  const selection =
    !commands || commands.mode === "project"
      ? "project"
      : commands.commands.length > 0
        ? commands.commands.join("+")
        : "none";
  return `${laneMergeValidation.strategy ?? "final-only"} ${selection}`;
}

export function formatAgentModelSelection(
  backend: string,
  selection: BackendModelSelection,
): string {
  const parameters = Object.entries(selection.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => `${id}=${value}`);
  return [backend, selection.modelId, ...parameters].join(" ");
}

// The selector blocks parse with the FOUNDATION schemas (charter invariant
// contracts-from-foundation): the CLI renders exactly the shapes the server
// validates, so the two can never drift. The wrapper stays `.loose()` so an
// unrelated workflowConfig block never breaks the validation line.
const validationSelectionsSchema = z
  .object({
    scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
    agentValidation: graphWorkflowAgentValidationOverrideSchema.optional(),
    laneMergeValidation:
      graphWorkflowLaneMergeValidationOverrideSchema.optional(),
  })
  .loose();
const outlineContextSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    // The shared tolerant union (legacy prose | ordered records), like the
    // validation selector blocks: criteria are a foundation contract, never a
    // privately redefined mirror shape.
    acceptanceCriteria: acceptanceCriteriaSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .extend(outlineStaffingSchema.shape)
  .loose();

const outlineTaskSchema = z
  .object({
    id: z.string(),
    contextId: z.string(),
    order: z.number(),
    title: z.string(),
    instructions: z.string().optional(),
  })
  .loose();

const outlineEdgeSchema = z
  .object({
    sourceContextId: z.string(),
    targetContextId: z.string(),
  })
  .loose();

const outlineParameterSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    required: z.boolean().optional(),
  })
  .loose();

const outlinePrerequisiteSchema = z
  .object({
    kind: z.string(),
    path: z.string().optional(),
    skill: z.string().optional(),
  })
  .loose();

const outlineCharterSchema = z
  .object({
    mission: z.string().optional(),
    conventions: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    vocabulary: z.array(z.string()).optional(),
    testStrategy: z.string().optional(),
    knownAmbiguities: z.array(z.string()).optional(),
    invariants: z.array(charterInvariantSchema).optional(),
    sourcesOfTruth: z.array(z.unknown()).optional(),
  })
  .loose();

const outlineDefinitionSchema = z
  .object({
    workflowConfig: z
      .record(z.string(), z.unknown())
      .and(outlineStaffingSchema)
      .optional(),
    charter: outlineCharterSchema.optional(),
    parameters: z.array(outlineParameterSchema).optional(),
    prerequisites: z.array(outlinePrerequisiteSchema).optional(),
    executionContexts: z.array(outlineContextSchema).optional(),
    tasks: z.array(outlineTaskSchema).optional(),
    edges: z.array(outlineEdgeSchema).optional(),
  })
  .loose();

const outlineRecordSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    definition: outlineDefinitionSchema,
  })
  .loose();

export type OutlineRecord = z.infer<typeof outlineRecordSchema>;

export type SliceResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parse the GET response `item` into the outline mirror, or null if unrecognizable. */
export function parseOutlineRecord(item: unknown): OutlineRecord | null {
  const parsed = outlineRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

// ============================================================
// Structured outline (the `--json` payload) + text rendering
// ============================================================

export interface OutlineData {
  id: string;
  name: string;
  revision: number;
  contexts: Array<{
    id: string;
    title: string;
    deps: string[];
    taskCount: number;
    overrides: string[];
    /**
     * The context's acceptance-criterion records, ids + sizes only (#69
     * change 4 stage 1). Legacy prose projects as its one canonical wrapped
     * record, so the outline always shows the ids a verdict would cite.
     */
    criteria: OutlineCriterionRecord[];
    /** `null` when the context declares no output contract (free-form). */
    outputSchema: OutputSchemaShape | null;
  }>;
  tasks: Array<{
    contextId: string;
    order: number;
    id: string;
    title: string;
    instructionChars: number;
  }>;
  charter: {
    missionChars: number;
    conventions: number;
    nonGoals: number;
    vocabulary: number;
    knownAmbiguities: number;
    invariants: OutlineCharterInvariant[];
    sources: number;
  };
  parameters: Array<{ name: string; type: string; required: boolean }>;
  prerequisites: Array<{ kind: string; locator: string }>;
  /**
   * Every assignment the document itself authors, workflow tier first and then
   * per context in graph order. A saved definition resolves nothing, so a row
   * carries the qualified reference and never a revision or resolved hash.
   */
  staffing: OutlineAssignmentRow[];
  configOverrides: {
    workflow: string[];
    contexts: Array<{ id: string; blocks: string[] }>;
  };
}

export interface OutlineCharterInvariant {
  id: string;
  contextIds: string[] | null;
  statementChars: number;
}

export interface OutlineCriterionRecord {
  id: string;
  statementChars: number;
}

export interface OutlineAssignmentRow {
  /** `workflow` for the workflow-tier block, otherwise the context id. */
  scope: string;
  role: "implementer" | "validator";
  assignmentId: string;
  /** The qualified `tier:id` spelling of the profile reference. */
  profile: string;
  focus: string | null;
  runtime: string;
  /** True for an assignment retained by a DISABLED cohort (dormant config). */
  dormant?: true;
}

export function buildOutlineData(record: OutlineRecord): OutlineData {
  const def = record.definition;
  const contexts = def.executionContexts ?? [];
  const tasks = def.tasks ?? [];
  const edges = def.edges ?? [];

  const depsFor = (contextId: string): string[] =>
    edges
      .filter((edge) => edge.targetContextId === contextId)
      .map((edge) => edge.sourceContextId)
      .sort();

  const tasksByContext = (contextId: string) =>
    tasks
      .filter((task) => task.contextId === contextId)
      .sort((a, b) => a.order - b.order);

  const charter = def.charter ?? {};

  return {
    id: record.id,
    name: record.name,
    revision: record.revision,
    contexts: contexts.map((context) => ({
      id: context.id,
      title: context.title,
      deps: depsFor(context.id),
      taskCount: tasksByContext(context.id).length,
      overrides: presentBlockKeys(context),
      criteria:
        context.acceptanceCriteria === undefined
          ? []
          : criterionRecordsOf(context.acceptanceCriteria).map((record) => ({
              id: record.id,
              statementChars: record.statement.length,
            })),
      outputSchema: context.outputSchema
        ? summarizeOutputSchemaShape(context.outputSchema)
        : null,
    })),
    tasks: contexts.flatMap((context) =>
      tasksByContext(context.id).map((task) => ({
        contextId: context.id,
        order: task.order,
        id: task.id,
        title: task.title,
        instructionChars: (task.instructions ?? "").length,
      })),
    ),
    charter: {
      missionChars: (charter.mission ?? "").length,
      conventions: charter.conventions?.length ?? 0,
      nonGoals: charter.nonGoals?.length ?? 0,
      vocabulary: charter.vocabulary?.length ?? 0,
      knownAmbiguities: charter.knownAmbiguities?.length ?? 0,
      invariants: (charter.invariants ?? []).map((invariant) => ({
        id: invariant.id,
        contextIds: invariant.appliesTo?.contextIds ?? null,
        statementChars: invariant.statement.length,
      })),
      sources: charter.sourcesOfTruth?.length ?? 0,
    },
    parameters: (def.parameters ?? []).map((param) => ({
      name: param.name,
      type: param.type,
      required: param.required ?? false,
    })),
    prerequisites: (def.prerequisites ?? []).map((prereq) => ({
      kind: prereq.kind,
      locator: prereq.path ?? prereq.skill ?? "",
    })),
    staffing: [
      ...staffingRows("workflow", def.workflowConfig),
      ...contexts.flatMap((context) => staffingRows(context.id, context)),
    ],
    configOverrides: {
      workflow: presentBlockKeys(def.workflowConfig),
      contexts: contexts
        .map((context) => ({
          id: context.id,
          blocks: presentBlockKeys(context),
        }))
        .filter((entry) => entry.blocks.length > 0),
    },
  };
}

/**
 * Render the outline as the compact text navigation map. Every size line ends
 * with the selector that reads the prose behind it (#80 I-18): a reader who can
 * see that a charter is 646 characters still has to discover `--charter`
 * elsewhere, and the discovery is what costs. These are hint-tier — they name a
 * next read and carry no rationale.
 */
export function renderOutline(record: OutlineRecord): string {
  const data = buildOutlineData(record);
  const lines: string[] = [];
  lines.push(`workflow ${data.id} "${data.name}" rev ${data.revision}`);

  lines.push(`contexts (${data.contexts.length}):`);
  const idWidth = Math.max(0, ...data.contexts.map((c) => c.id.length));
  for (const context of data.contexts) {
    const deps = context.deps.length > 0 ? context.deps.join(",") : "-";
    const outputSchema = context.outputSchema
      ? `  ${formatOutputSchemaShape(context.outputSchema)}`
      : "";
    const overrides =
      context.overrides.length > 0
        ? `  [${context.overrides.join(", ")} override]`
        : "";
    lines.push(
      `  ${context.id.padEnd(idWidth)}  "${context.title}"  deps=${deps}  tasks=${context.taskCount}  criteria=${context.criteria.length}${outputSchema}${overrides}  -> --context ${context.id}`,
    );
  }

  // The citable criterion ids per context (sizes stay in the JSON projection,
  // bodies stay in `--context`), in the invariants line's scope vocabulary.
  const criteriaScopes = data.contexts.filter(
    (context) => context.criteria.length > 0,
  );
  if (criteriaScopes.length > 0) {
    lines.push(
      `criteria: ${criteriaScopes
        .map(
          (context) =>
            `${context.id} ${context.criteria.map((record) => record.id).join(",")}`,
        )
        .join(" · ")}`,
    );
  }

  if (data.tasks.length > 0) {
    lines.push("tasks:");
    const ctxWidth = Math.max(0, ...data.tasks.map((t) => t.contextId.length));
    const taskIdWidth = Math.max(0, ...data.tasks.map((t) => t.id.length));
    let lastContextId: string | null = null;
    for (const task of data.tasks) {
      const label = task.contextId === lastContextId ? "" : task.contextId;
      lastContextId = task.contextId;
      lines.push(
        `  ${label.padEnd(ctxWidth)}  ${task.order} ${task.id.padEnd(taskIdWidth)}  "${task.title}"  (${formatCharCount(task.instructionChars)} chars)  -> --task ${task.id}`,
      );
    }
  }

  const charterParts = [`mission ${data.charter.missionChars} chars`];
  if (data.charter.conventions > 0)
    charterParts.push(`conventions ${data.charter.conventions}`);
  if (data.charter.nonGoals > 0)
    charterParts.push(`nonGoals ${data.charter.nonGoals}`);
  if (data.charter.vocabulary > 0)
    charterParts.push(`vocabulary ${data.charter.vocabulary}`);
  if (data.charter.knownAmbiguities > 0)
    charterParts.push(`knownAmbiguities ${data.charter.knownAmbiguities}`);
  charterParts.push(`sources ${data.charter.sources}`);
  lines.push(`charter: ${charterParts.join(" · ")} -> --charter`);

  if (data.charter.invariants.some((invariant) => invariant.contextIds)) {
    const invariantScopes = data.charter.invariants.map((invariant) =>
      invariant.contextIds
        ? `${invariant.id} contexts=${invariant.contextIds.join(",")}`
        : `${invariant.id} global`,
    );
    lines.push(`invariants: ${invariantScopes.join(" · ")}`);
  }

  lines.push(
    `parameters: ${
      data.parameters.length > 0
        ? data.parameters
            .map(
              (param) =>
                `${param.name} (${param.type}${param.required ? ", required" : ""})`,
            )
            .join(", ")
        : "none"
    }`,
  );

  lines.push(
    `prerequisites: ${
      data.prerequisites.length > 0
        ? data.prerequisites
            .map((prereq) => `${prereq.kind}:${prereq.locator}`)
            .join(", ")
        : "none"
    }`,
  );

  lines.push(...staffingBlock(data.staffing));

  const workflowOverrides =
    data.configOverrides.workflow.length > 0
      ? data.configOverrides.workflow.join(",")
      : "-";
  const contextOverrides =
    data.configOverrides.contexts.length > 0
      ? data.configOverrides.contexts
          .map((entry) => `${entry.id}(${entry.blocks.join(",")})`)
          .join(", ")
      : "-";
  lines.push(
    `config overrides: workflow=${workflowOverrides} · contexts: ${contextOverrides} -> --config`,
  );

  const validationLine = renderValidationSelections(
    record.definition.workflowConfig,
  );
  if (validationLine) lines.push(validationLine);

  return `${lines.join("\n")}\n`;
}

/**
 * The concrete workflow-tier validation selections (validation-concurrency §6):
 * `validation: script typecheck+test · roles implementer all-except format,
 * validator none · laneMerge final-only project`. Omitted entirely when the
 * workflow config declares no selection.
 */
function renderValidationSelections(workflowConfig: unknown): string | null {
  const parsed = validationSelectionsSchema.safeParse(workflowConfig ?? {});
  if (!parsed.success) return null;
  const { scriptValidator, agentValidation, laneMergeValidation } = parsed.data;

  const parts: string[] = [];
  if (scriptValidator) {
    parts.push(
      scriptValidator.commands.length > 0
        ? `script ${scriptValidator.commands.join("+")}`
        : "script none",
    );
  }
  if (agentValidation) {
    const roles: string[] = [];
    if (agentValidation.implementer) {
      roles.push(
        `implementer ${formatCommandSelector(agentValidation.implementer)}`,
      );
    }
    if (agentValidation.contextValidator) {
      roles.push(
        `validator ${formatCommandSelector(agentValidation.contextValidator)}`,
      );
    }
    if (roles.length > 0) parts.push(`roles ${roles.join(", ")}`);
  }
  if (laneMergeValidation) {
    parts.push(`laneMerge ${formatLaneMergeSelection(laneMergeValidation)}`);
  }

  return parts.length > 0 ? `validation: ${parts.join(" · ")}` : null;
}

// ============================================================
// Section selectors (full-prose slices)
// ============================================================

/** `--context <ctx>`: one context (full prose + config) + its tasks (full instructions). */
export function sliceContext(
  record: OutlineRecord,
  contextId: string,
): SliceResult {
  const context = (record.definition.executionContexts ?? []).find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    return { ok: false, error: `no context "${contextId}" in this definition` };
  }
  const tasks = (record.definition.tasks ?? [])
    .filter((task) => task.contextId === contextId)
    .sort((a, b) => a.order - b.order);
  return { ok: true, value: { context, tasks } };
}

/** `--task <task>`: one task, full instructions + metadata. */
export function sliceTask(record: OutlineRecord, taskId: string): SliceResult {
  const task = (record.definition.tasks ?? []).find(
    (entry) => entry.id === taskId,
  );
  if (!task) {
    return { ok: false, error: `no task "${taskId}" in this definition` };
  }
  return { ok: true, value: task };
}

/** `--charter`: charter only. */
export function sliceCharter(record: OutlineRecord): SliceResult {
  return { ok: true, value: record.definition.charter ?? {} };
}

/** `--config`: workflowConfig + per-context override blocks only. */
export function sliceConfig(record: OutlineRecord): SliceResult {
  const contexts: Record<string, Record<string, unknown>> = {};
  for (const context of record.definition.executionContexts ?? []) {
    const blocks = pickBlocks(context);
    if (Object.keys(blocks).length > 0) contexts[context.id] = blocks;
  }
  return {
    ok: true,
    value: { workflow: record.definition.workflowConfig ?? {}, contexts },
  };
}

/** `--params`: parameters + prerequisites. */
export function sliceParams(record: OutlineRecord): SliceResult {
  return {
    ok: true,
    value: {
      parameters: record.definition.parameters ?? [],
      prerequisites: record.definition.prerequisites ?? [],
    },
  };
}

// ============================================================
// Helpers
// ============================================================

function formatCharCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`;
}

/**
 * The staffing block: who a saved definition NAMES, never who it resolved.
 *
 * The header says "references" so the distinction from `live get`'s
 * "snapshots" block is visible without reading a row, and no row can carry a
 * revision or resolved hash — a saved document has neither until execution
 * start seeds one.
 */
function staffingBlock(rows: OutlineAssignmentRow[]): string[] {
  if (rows.length === 0) {
    return [
      "staffing (references): none authored — every context inherits the cascade default",
    ];
  }
  const scopeWidth = Math.max(...rows.map((row) => row.scope.length));
  const roleWidth = Math.max(...rows.map((row) => row.role.length));
  const idWidth = Math.max(...rows.map((row) => row.assignmentId.length));
  const profileWidth = Math.max(...rows.map((row) => row.profile.length));
  return [
    "staffing (references):",
    ...rows.map((row) => {
      const detail = row.runtime;
      const focus = row.focus !== null ? `  focus "${row.focus}"` : "";
      const dormant = row.dormant ? "  (cohort disabled)" : "";
      return `  ${row.scope.padEnd(scopeWidth)}  ${row.role.padEnd(
        roleWidth,
      )}  ${row.assignmentId.padEnd(idWidth)}  ${row.profile.padEnd(
        profileWidth,
      )}  ${detail}${focus}${dormant}`;
    }),
  ];
}

/**
 * The assignments one cascade tier authors, as outline rows.
 *
 * A DISABLED cohort's assignments are reported too, flagged dormant: they are
 * persisted configuration a later edit can re-enable without consulting the
 * library, so an author reading the outline before an edit has to see them.
 * Hiding them would make "turn validation back on" a blind operation.
 */
function staffingRows(
  scope: string,
  tier: z.infer<typeof outlineStaffingSchema> | undefined,
): OutlineAssignmentRow[] {
  if (!tier) return [];
  const rows: OutlineAssignmentRow[] = [];
  if (tier.implementer) {
    rows.push(assignmentRow(scope, "implementer", tier.implementer));
  }
  const cohort = tier.contextValidator;
  for (const assignment of cohort?.assignments ?? []) {
    rows.push({
      ...assignmentRow(scope, "validator", assignment),
      ...(cohort?.enabled === false ? { dormant: true as const } : {}),
    });
  }
  return rows;
}

function assignmentRow(
  scope: string,
  role: OutlineAssignmentRow["role"],
  assignment: z.infer<typeof outlineAssignmentSchema>,
): OutlineAssignmentRow {
  return {
    scope,
    role,
    assignmentId: assignment.id,
    profile: `${assignment.profile.tier}:${assignment.profile.id}`,
    focus: assignment.focus ?? null,
    runtime: formatAgentModelSelection(
      assignment.agent.backend,
      assignment.agent.modelSelection,
    ),
  };
}

function presentBlockKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  const record = obj as Record<string, unknown>;
  return CONFIG_BLOCK_KEYS.filter((key) => record[key] !== undefined);
}

function pickBlocks(obj: unknown): Record<string, unknown> {
  const record =
    obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const picked: Record<string, unknown> = {};
  for (const key of CONFIG_BLOCK_KEYS) {
    if (record[key] !== undefined) picked[key] = record[key];
  }
  return picked;
}
