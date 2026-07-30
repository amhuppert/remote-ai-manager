import { z } from "zod";

/**
 * CLI-side projections over the `GET /workflows/[workflowId]` response `item`
 * (docs/design/cc-cli/05 §Read API). The outline is the agent's navigation map:
 * structure + identifiers + prose SIZES (never prose bodies), so addressing an
 * edit costs a few hundred tokens instead of the whole definition. The section
 * selectors return one full slice (prose included) for the piece the agent
 * intends to change. These parse a deliberately minimal, permissive local mirror
 * of the record — the CLI never imports the server schema graph — retaining
 * unknown keys (`.loose()`) so per-context config-override blocks survive for the
 * `--context` / `--config` slices.
 */

/** The ten cascade override blocks, in the order the outline reports them. */
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
] as const;

const outlineContextSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    acceptanceCriteria: z.string().optional(),
  })
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
    sourcesOfTruth: z.array(z.unknown()).optional(),
  })
  .loose();

const outlineDefinitionSchema = z
  .object({
    workflowConfig: z.record(z.string(), z.unknown()).optional(),
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
    sources: number;
  };
  parameters: Array<{ name: string; type: string; required: boolean }>;
  prerequisites: Array<{ kind: string; locator: string }>;
  configOverrides: {
    workflow: string[];
    contexts: Array<{ id: string; blocks: string[] }>;
  };
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

/** Render the outline as the compact text navigation map. */
export function renderOutline(record: OutlineRecord): string {
  const data = buildOutlineData(record);
  const lines: string[] = [];
  lines.push(`workflow ${data.id} "${data.name}" rev ${data.revision}`);

  lines.push(`contexts (${data.contexts.length}):`);
  const idWidth = Math.max(0, ...data.contexts.map((c) => c.id.length));
  for (const context of data.contexts) {
    const deps = context.deps.length > 0 ? context.deps.join(",") : "-";
    const overrides =
      context.overrides.length > 0
        ? `  [${context.overrides.join(", ")} override]`
        : "";
    lines.push(
      `  ${context.id.padEnd(idWidth)}  "${context.title}"  deps=${deps}  tasks=${context.taskCount}${overrides}`,
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
        `  ${label.padEnd(ctxWidth)}  ${task.order} ${task.id.padEnd(taskIdWidth)}  "${task.title}"  (${formatCharCount(task.instructionChars)} chars)`,
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
  lines.push(`charter: ${charterParts.join(" · ")}`);

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
    `config overrides: workflow=${workflowOverrides} · contexts: ${contextOverrides}`,
  );

  return `${lines.join("\n")}\n`;
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
