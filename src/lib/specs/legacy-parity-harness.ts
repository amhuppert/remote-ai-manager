import { stableStringify } from "@/lib/state-store/serialization";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

import {
  LEGACY_GROUP_ACCEPTANCE_CRITERIA,
  LEGACY_UNMAPPED_CRITERION_NOTICE,
} from "./legacy-plan-render";
import type { SpecRevisionSnapshot } from "./schemas";

/**
 * The shadow parity harness: does the authored-plan path (importer →
 * materializer) reproduce what the legacy spec→graph compiler actually
 * launched?
 *
 * The comparison is semantic, not byte-wise, because the two paths deliberately
 * identify their nodes differently. Contexts are matched by the set of approved
 * task elements inside them — a partition of the same task set — so a context
 * pair lines up regardless of what either side called it. Everything compared
 * is then a difference in CONTENT, and every content difference must map to one
 * of the four approved deltas. One that does not is a regression, and the
 * harness says so rather than widening the list.
 *
 * Three things are deliberately NOT compilation differences and are reported in
 * their own sections instead of the difference list:
 *
 * - fields present on one side and absent on the other. A launched-only field
 *   is an edit a human made to the saved definition before launch; a
 *   materialized-only field is a provenance surface the plan adds. Neither is
 *   the same question `differences` answers.
 * - the post-launch amendments recorded in the capture, which happened to the
 *   running definition after it was launched and could not have come from any
 *   compilation.
 * - the paths listed in `notCompared`, each with the reason it is out of scope.
 *
 * Every other shared field is compared, and a difference in one that no
 * approved delta explains fails the harness.
 */

export const APPROVED_DELTAS = {
  "prerequisite-apology-removal":
    "The compiler apologized in prose where it could not map a criterion to a task or state a context's contract directly; the authored plan says the same thing structurally with a typed context and an authored contract, so those lines are gone.",
  "context-identity-scheme":
    "Compiled graph nodes are identified from the approved handles the plan is authored in (`t7`, `lane-persistence`) rather than from spec element ids (`context-task-output-lookup`, `spec-task-task-output-lookup`), and the origin URIs that embed an identity move with it.",
  "locked-region-declarations":
    "Locked regions are declared by the plan over the plan's own nodes, not by the compiler over the revision's tasks.",
  "charter-rendering":
    "Governance is authored once on the plan and copied, instead of being synthesized at compile time from the revision's intent sections; the validation selection the plan pins travels with it.",
} as const;

export type ApprovedDelta = keyof typeof APPROVED_DELTAS;

export const PARITY_DIMENSIONS = [
  "context-membership",
  "edge-topology",
  "criterion-coverage",
  "instruction-content",
  "governance-envelope",
] as const;
export type ParityDimension = (typeof PARITY_DIMENSIONS)[number];

export interface ParityDifference {
  readonly dimension: ParityDimension;
  /** What the difference is about: a context block, a task, or a field. */
  readonly subject: string;
  readonly finding: string;
  /** Null means unenumerated, which fails the harness. */
  readonly approvedDelta: ApprovedDelta | null;
  readonly launched?: string;
  readonly materialized?: string;
}

export interface ParityFieldPresence {
  readonly node: string;
  readonly field: string;
  readonly value: string;
}

export interface ParityNotCompared {
  readonly path: string;
  readonly reason: string;
}

export interface ParityCaseReport {
  readonly case: string;
  readonly launchedFrom: Readonly<Record<string, unknown>>;
  readonly counts: {
    readonly launchedContexts: number;
    readonly materializedContexts: number;
    readonly launchedTasks: number;
    readonly materializedTasks: number;
    readonly launchedEdges: number;
    readonly materializedEdges: number;
    readonly comparedCriteria: number;
  };
  readonly differences: readonly ParityDifference[];
  readonly unenumerated: readonly ParityDifference[];
  readonly launchedOnlyFields: readonly ParityFieldPresence[];
  readonly materializedOnlyFields: readonly ParityFieldPresence[];
  readonly postLaunchAmendments: readonly Readonly<Record<string, unknown>>[];
  readonly notCompared: readonly ParityNotCompared[];
}

export interface LegacyParityInput {
  readonly caseKey: string;
  /** The definition the archived execution was launched with. */
  readonly launched: WorkflowSemanticDefinition;
  /** The imported attempt, compiled through the delivery-plan materializer. */
  readonly materialized: WorkflowSemanticDefinition;
  /** The approved revision both sides were built from. */
  readonly snapshot: SpecRevisionSnapshot;
  readonly launchedFrom: Readonly<Record<string, unknown>>;
  readonly postLaunchAmendments: readonly Readonly<Record<string, unknown>>[];
}

const LEGACY_METADATA = {
  taskElementId: "specTaskElementId",
  criterionElementIds: "specCriterionElementIds",
} as const;

const PLAN_METADATA = {
  taskId: "specPlanTaskId",
  sourceMap: "specPlanSourceMap",
} as const;

const NOT_COMPARED: readonly ParityNotCompared[] = [
  {
    path: "/executionContexts/*/description",
    reason:
      "The context pack is the bounded implementer aid the plan materializer assembles from the criteria a context owns, and whose omissions its own pack manifest reports; the compiler's one-line context summary has no counterpart in it, so a byte comparison would report a deliberate replacement rather than a compilation difference. KNOWN GAP, not a claim of irrelevance: this field IS execution-affecting — iteration-prompt.ts and validator-runner.ts both inject it as the agent's `Goal:` line — so prompt content can drift here without failing this harness. Closing it needs a fifth approved delta, which acceptance criterion 3's enumerated four do not admit; that is a human decision, and this entry is where it is recorded until it is made.",
  },
  {
    path: "/executionContexts/*/metadata and /tasks/*/metadata",
    reason:
      "Both sides encode their provenance here in their own vocabulary — the compiler's spec origin map, the plan's source map — so a byte comparison would compare two vocabularies rather than two plans. What the blocks MEAN is compared: task-element identity and criterion ownership are read out of these blocks on both sides and are exactly what the context-membership and criterion-coverage dimensions check.",
  },
];

/** One context on either side, reduced to what the comparison is about. */
interface ContextProjection {
  readonly nodeId: string;
  readonly title: string;
  readonly acceptanceCriteria: string;
  readonly originSourceUri: string;
  readonly taskElementIds: readonly string[];
  readonly criterionElementIds: readonly string[];
  readonly raw: GraphWorkflowExecutionContextDefinition;
}

interface TaskProjection {
  readonly nodeId: string;
  readonly taskElementId: string;
  readonly membershipKey: string;
  readonly order: number;
  readonly title: string;
  readonly instructions: string;
  readonly raw: GraphWorkflowTaskDefinition;
}

interface DefinitionProjection {
  readonly contextsByKey: ReadonlyMap<string, ContextProjection>;
  readonly tasksByElementId: ReadonlyMap<string, TaskProjection>;
  readonly edges: ReadonlyMap<string, { fromKey: string; toKey: string }>;
}

function membershipKey(taskElementIds: readonly string[]): string {
  return [...taskElementIds]
    .sort((left, right) => (left < right ? -1 : 1))
    .join("|");
}

function metadataValue(
  metadata: Readonly<Record<string, string>> | undefined,
  key: string,
  node: string,
): string {
  const value = metadata?.[key];
  if (value === undefined) {
    throw new Error(`Compiled node ${node} carries no ${key} metadata.`);
  }
  return value;
}

function parseIdList(raw: string, node: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error(`Compiled node ${node} carries an unreadable id list.`);
  }
  return parsed as string[];
}

/**
 * The legacy definition read back through its own metadata: which approved task
 * element each compiled task is, and which criteria each context's tasks
 * covered.
 */
function projectLaunched(
  definition: WorkflowSemanticDefinition,
): DefinitionProjection {
  const elementIdByNodeId = new Map(
    definition.tasks.map((task) => [
      task.id,
      metadataValue(task.metadata, LEGACY_METADATA.taskElementId, task.id),
    ]),
  );
  const contextsByKey = new Map<string, ContextProjection>();
  const keyByContextId = new Map<string, string>();
  for (const context of definition.executionContexts) {
    const members = definition.tasks
      .filter((task) => task.contextId === context.id)
      .sort((left, right) => left.order - right.order);
    const taskElementIds = members.map(
      (task) => elementIdByNodeId.get(task.id) ?? task.id,
    );
    const criterionElementIds: string[] = [];
    const seen = new Set<string>();
    for (const task of members) {
      for (const criterionId of parseIdList(
        metadataValue(
          task.metadata,
          LEGACY_METADATA.criterionElementIds,
          task.id,
        ),
        task.id,
      )) {
        if (seen.has(criterionId)) continue;
        seen.add(criterionId);
        criterionElementIds.push(criterionId);
      }
    }
    const key = membershipKey(taskElementIds);
    keyByContextId.set(context.id, key);
    contextsByKey.set(key, {
      nodeId: context.id,
      title: context.title,
      acceptanceCriteria: context.acceptanceCriteria,
      originSourceUri: context.origin?.sourceUri ?? "",
      taskElementIds,
      criterionElementIds,
      raw: context,
    });
  }

  const tasksByElementId = new Map<string, TaskProjection>();
  for (const task of definition.tasks) {
    const taskElementId = elementIdByNodeId.get(task.id) ?? task.id;
    tasksByElementId.set(taskElementId, {
      nodeId: task.id,
      taskElementId,
      membershipKey: keyByContextId.get(task.contextId) ?? task.contextId,
      order: task.order,
      title: task.title,
      instructions: task.instructions,
      raw: task,
    });
  }

  return {
    contextsByKey,
    tasksByElementId,
    edges: projectEdges(definition, keyByContextId),
  };
}

/**
 * The plan's definition read back through the source map the materializer
 * writes. Plan task ids are the approved bare handles, so the approved revision
 * — not the other definition — is what resolves them to element ids.
 */
function projectMaterialized(
  definition: WorkflowSemanticDefinition,
  snapshot: SpecRevisionSnapshot,
): DefinitionProjection {
  const elementIdByPlanTaskId = new Map<string, string>(
    snapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "task" && element.number !== null
        ? [[`t${element.number}`, element.id] as [string, string]]
        : [],
    ),
  );
  const resolve = (planTaskId: string): string =>
    elementIdByPlanTaskId.get(planTaskId) ?? planTaskId;

  const contextsByKey = new Map<string, ContextProjection>();
  const keyByContextId = new Map<string, string>();
  for (const context of definition.executionContexts) {
    const rawSourceMap: unknown = JSON.parse(
      metadataValue(context.metadata, PLAN_METADATA.sourceMap, context.id),
    );
    const sourceMap = rawSourceMap as {
      taskIds: string[];
      criterionElementIds: string[];
    };
    const taskElementIds = sourceMap.taskIds.map(resolve);
    const key = membershipKey(taskElementIds);
    keyByContextId.set(context.id, key);
    contextsByKey.set(key, {
      nodeId: context.id,
      title: context.title,
      acceptanceCriteria: context.acceptanceCriteria,
      originSourceUri: context.origin?.sourceUri ?? "",
      taskElementIds,
      criterionElementIds: sourceMap.criterionElementIds,
      raw: context,
    });
  }

  const tasksByElementId = new Map<string, TaskProjection>();
  for (const task of definition.tasks) {
    const taskElementId = resolve(
      metadataValue(task.metadata, PLAN_METADATA.taskId, task.id),
    );
    tasksByElementId.set(taskElementId, {
      nodeId: task.id,
      taskElementId,
      membershipKey: keyByContextId.get(task.contextId) ?? task.contextId,
      order: task.order,
      title: task.title,
      instructions: task.instructions,
      raw: task,
    });
  }

  return {
    contextsByKey,
    tasksByElementId,
    edges: projectEdges(definition, keyByContextId),
  };
}

function projectEdges(
  definition: WorkflowSemanticDefinition,
  keyByContextId: ReadonlyMap<string, string>,
): Map<string, { fromKey: string; toKey: string }> {
  const edges = new Map<string, { fromKey: string; toKey: string }>();
  for (const edge of definition.edges) {
    const fromKey =
      keyByContextId.get(edge.sourceContextId) ?? edge.sourceContextId;
    const toKey =
      keyByContextId.get(edge.targetContextId) ?? edge.targetContextId;
    edges.set(`${fromKey} => ${toKey}`, { fromKey, toKey });
  }
  return edges;
}

/** A short, stable label for a context block, for a human reading the report. */
function blockLabel(context: ContextProjection): string {
  return context.taskElementIds.join(", ");
}

export function compareLegacyParity(
  input: LegacyParityInput,
): ParityCaseReport {
  const launched = projectLaunched(input.launched);
  const materialized = projectMaterialized(input.materialized, input.snapshot);
  const differences: ParityDifference[] = [];
  const launchedOnlyFields: ParityFieldPresence[] = [];
  const materializedOnlyFields: ParityFieldPresence[] = [];

  compareContexts(launched, materialized, differences);
  compareEdges(launched, materialized, differences);
  compareTasks(launched, materialized, differences);
  compareEnvelope(input.launched, input.materialized, differences);
  collectFieldPresence(
    launched,
    materialized,
    launchedOnlyFields,
    materializedOnlyFields,
  );

  const comparedCriteria = new Set(
    [...launched.contextsByKey.values()].flatMap(
      (context) => context.criterionElementIds,
    ),
  ).size;

  return {
    case: input.caseKey,
    launchedFrom: input.launchedFrom,
    counts: {
      launchedContexts: input.launched.executionContexts.length,
      materializedContexts: input.materialized.executionContexts.length,
      launchedTasks: input.launched.tasks.length,
      materializedTasks: input.materialized.tasks.length,
      launchedEdges: input.launched.edges.length,
      materializedEdges: input.materialized.edges.length,
      comparedCriteria,
    },
    differences,
    unenumerated: differences.filter(
      (difference) => difference.approvedDelta === null,
    ),
    launchedOnlyFields,
    materializedOnlyFields,
    postLaunchAmendments: input.postLaunchAmendments,
    notCompared: NOT_COMPARED,
  };
}

function compareContexts(
  launched: DefinitionProjection,
  materialized: DefinitionProjection,
  differences: ParityDifference[],
): void {
  for (const [key, launchedContext] of launched.contextsByKey) {
    const materializedContext = materialized.contextsByKey.get(key);
    if (materializedContext === undefined) {
      differences.push({
        dimension: "context-membership",
        subject: blockLabel(launchedContext),
        finding:
          "The launched definition groups these task elements into one context; the materialized plan has no context with that exact membership.",
        approvedDelta: null,
        launched: launchedContext.nodeId,
      });
      continue;
    }
    if (launchedContext.nodeId !== materializedContext.nodeId) {
      differences.push({
        dimension: "context-membership",
        subject: blockLabel(launchedContext),
        finding: "The two paths give this context different ids.",
        approvedDelta: "context-identity-scheme",
        launched: launchedContext.nodeId,
        materialized: materializedContext.nodeId,
      });
    }
    if (
      launchedContext.originSourceUri !== materializedContext.originSourceUri
    ) {
      differences.push({
        dimension: "context-membership",
        subject: blockLabel(launchedContext),
        finding: "The context origin URI names a different source identity.",
        approvedDelta: "context-identity-scheme",
        launched: launchedContext.originSourceUri,
        materialized: materializedContext.originSourceUri,
      });
    }
    if (launchedContext.title !== materializedContext.title) {
      differences.push({
        dimension: "context-membership",
        subject: blockLabel(launchedContext),
        finding: "The context titles differ.",
        approvedDelta: null,
        launched: launchedContext.title,
        materialized: materializedContext.title,
      });
    }
    if (
      launchedContext.taskElementIds.join("|") !==
      materializedContext.taskElementIds.join("|")
    ) {
      differences.push({
        dimension: "context-membership",
        subject: blockLabel(launchedContext),
        finding: "The context runs its tasks in a different order.",
        approvedDelta: null,
        launched: launchedContext.taskElementIds.join(", "),
        materialized: materializedContext.taskElementIds.join(", "),
      });
    }
    compareCoverage(launchedContext, materializedContext, differences);
  }

  for (const [key, materializedContext] of materialized.contextsByKey) {
    if (launched.contextsByKey.has(key)) continue;
    differences.push({
      dimension: "context-membership",
      subject: blockLabel(materializedContext),
      finding:
        "The materialized plan groups these task elements into one context; the launched definition has no context with that exact membership.",
      approvedDelta: null,
      materialized: materializedContext.nodeId,
    });
  }
}

function compareCoverage(
  launchedContext: ContextProjection,
  materializedContext: ContextProjection,
  differences: ParityDifference[],
): void {
  const launchedCriteria = [...launchedContext.criterionElementIds].sort();
  const materializedCriteria = [
    ...materializedContext.criterionElementIds,
  ].sort();
  if (launchedCriteria.join("|") !== materializedCriteria.join("|")) {
    differences.push({
      dimension: "criterion-coverage",
      subject: blockLabel(launchedContext),
      finding: "The two paths give this context different criterion ownership.",
      approvedDelta: null,
      launched: launchedCriteria.join(", "),
      materialized: materializedCriteria.join(", "),
    });
  }

  if (
    launchedContext.acceptanceCriteria ===
    materializedContext.acceptanceCriteria
  ) {
    return;
  }
  // The compiler prefixed every context contract with a warning that the
  // contract was a union assembled from whichever tasks were grouped in. An
  // authored contract has no union to warn about.
  const withPreamble =
    materializedContext.acceptanceCriteria.length === 0
      ? LEGACY_GROUP_ACCEPTANCE_CRITERIA
      : [
          LEGACY_GROUP_ACCEPTANCE_CRITERIA,
          "",
          materializedContext.acceptanceCriteria,
        ].join("\n");
  differences.push({
    dimension: "criterion-coverage",
    subject: blockLabel(launchedContext),
    finding:
      launchedContext.acceptanceCriteria === withPreamble
        ? "The acceptance contract is the launched one without the compiler's regrouping preamble."
        : "The acceptance contract differs by more than the compiler's regrouping preamble.",
    approvedDelta:
      launchedContext.acceptanceCriteria === withPreamble
        ? "prerequisite-apology-removal"
        : null,
    ...(launchedContext.acceptanceCriteria === withPreamble
      ? {}
      : {
          launched: launchedContext.acceptanceCriteria,
          materialized: materializedContext.acceptanceCriteria,
        }),
  });
}

function compareEdges(
  launched: DefinitionProjection,
  materialized: DefinitionProjection,
  differences: ParityDifference[],
): void {
  for (const [key] of launched.edges) {
    if (materialized.edges.has(key)) continue;
    differences.push({
      dimension: "edge-topology",
      subject: key,
      finding:
        "The launched definition carries this context edge; the materialized plan does not.",
      approvedDelta: null,
    });
  }
  for (const [key] of materialized.edges) {
    if (launched.edges.has(key)) continue;
    differences.push({
      dimension: "edge-topology",
      subject: key,
      finding:
        "The materialized plan carries this context edge; the launched definition does not.",
      approvedDelta: null,
    });
  }
}

function compareTasks(
  launched: DefinitionProjection,
  materialized: DefinitionProjection,
  differences: ParityDifference[],
): void {
  for (const [taskElementId, launchedTask] of launched.tasksByElementId) {
    const materializedTask = materialized.tasksByElementId.get(taskElementId);
    if (materializedTask === undefined) {
      differences.push({
        dimension: "instruction-content",
        subject: taskElementId,
        finding:
          "The materialized plan carries no task for this approved task element.",
        approvedDelta: null,
        launched: launchedTask.nodeId,
      });
      continue;
    }
    if (launchedTask.nodeId !== materializedTask.nodeId) {
      differences.push({
        dimension: "instruction-content",
        subject: taskElementId,
        finding: "The two paths give this task different ids.",
        approvedDelta: "context-identity-scheme",
        launched: launchedTask.nodeId,
        materialized: materializedTask.nodeId,
      });
    }
    if (launchedTask.title !== materializedTask.title) {
      differences.push({
        dimension: "instruction-content",
        subject: taskElementId,
        finding: "The task titles differ.",
        approvedDelta: null,
        launched: launchedTask.title,
        materialized: materializedTask.title,
      });
    }
    if (launchedTask.order !== materializedTask.order) {
      differences.push({
        dimension: "instruction-content",
        subject: taskElementId,
        finding: "The task runs at a different position in its context.",
        approvedDelta: null,
        launched: String(launchedTask.order),
        materialized: String(materializedTask.order),
      });
    }
    if (launchedTask.raw.source !== materializedTask.raw.source) {
      differences.push({
        dimension: "instruction-content",
        subject: taskElementId,
        finding: "The task sources differ.",
        approvedDelta: null,
        launched: launchedTask.raw.source,
        materialized: materializedTask.raw.source,
      });
    }
    if (launchedTask.instructions === materializedTask.instructions) continue;
    const apologyRemoved =
      launchedTask.instructions ===
      `${materializedTask.instructions}\n${LEGACY_UNMAPPED_CRITERION_NOTICE}`;
    differences.push({
      dimension: "instruction-content",
      subject: taskElementId,
      finding: apologyRemoved
        ? "The instructions are the launched ones without the compiler's unmapped-criterion apology."
        : "The instructions differ by more than the compiler's unmapped-criterion apology.",
      approvedDelta: apologyRemoved ? "prerequisite-apology-removal" : null,
      ...(apologyRemoved
        ? {}
        : {
            launched: launchedTask.instructions,
            materialized: materializedTask.instructions,
          }),
    });
  }

  for (const [
    taskElementId,
    materializedTask,
  ] of materialized.tasksByElementId) {
    if (launched.tasksByElementId.has(taskElementId)) continue;
    differences.push({
      dimension: "instruction-content",
      subject: taskElementId,
      finding:
        "The launched definition carries no task for this approved task element.",
      approvedDelta: null,
      materialized: materializedTask.nodeId,
    });
  }
}

function compareEnvelope(
  launched: WorkflowSemanticDefinition,
  materialized: WorkflowSemanticDefinition,
  differences: ParityDifference[],
): void {
  const record = (
    field: string,
    approvedDelta: ApprovedDelta | null,
    finding: string,
  ): void => {
    const launchedValue = stableStringify(
      (launched as unknown as Record<string, unknown>)[field] ?? null,
    );
    const materializedValue = stableStringify(
      (materialized as unknown as Record<string, unknown>)[field] ?? null,
    );
    if (launchedValue === materializedValue) return;
    differences.push({
      dimension: "governance-envelope",
      subject: `/${field}`,
      finding,
      approvedDelta,
      ...(approvedDelta === null
        ? { launched: launchedValue, materialized: materializedValue }
        : {}),
    });
  };

  record(
    "charter",
    "charter-rendering",
    "The charter is authored on the plan instead of synthesized from the revision's intent sections at compile time.",
  );
  record(
    "workflowConfig",
    "charter-rendering",
    "The plan pins its own validation selection into the compiled definition; the compiler left it to the workflow defaults.",
  );
  record(
    "lockedRegions",
    "locked-region-declarations",
    "Locked regions are declared by the plan over its own nodes rather than by the compiler over the revision's tasks.",
  );
  record(
    "origin",
    "context-identity-scheme",
    "The definition origin names the plan attempt rather than the revision and scope hash.",
  );
  record("schemaVersion", null, "The definition schema versions differ.");
  record("approvalRequired", null, "The approval policies differ.");
  record("parameters", null, "The declared parameters differ.");
  record("prerequisites", null, "The declared prerequisites differ.");
}

/**
 * Keys one side carries and the other does not, per node. A shared key with a
 * differing value is never reported here — it is compared above — so this
 * cannot become a place for a real difference to hide.
 */
function collectFieldPresence(
  launched: DefinitionProjection,
  materialized: DefinitionProjection,
  launchedOnly: ParityFieldPresence[],
  materializedOnly: ParityFieldPresence[],
): void {
  const compare = (
    node: string,
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
  ): void => {
    for (const key of Object.keys(left).sort()) {
      if (key in right) continue;
      launchedOnly.push({
        node,
        field: key,
        value: stableStringify(left[key] ?? null),
      });
    }
    for (const key of Object.keys(right).sort()) {
      if (key in left) continue;
      materializedOnly.push({
        node,
        field: key,
        value: stableStringify(right[key] ?? null),
      });
    }
  };

  for (const [key, launchedContext] of launched.contextsByKey) {
    const materializedContext = materialized.contextsByKey.get(key);
    if (materializedContext === undefined) continue;
    compare(
      `context ${blockLabel(launchedContext)}`,
      launchedContext.raw as unknown as Record<string, unknown>,
      materializedContext.raw as unknown as Record<string, unknown>,
    );
  }
  for (const [taskElementId, launchedTask] of launched.tasksByElementId) {
    const materializedTask = materialized.tasksByElementId.get(taskElementId);
    if (materializedTask === undefined) continue;
    compare(
      `task ${taskElementId}`,
      launchedTask.raw as unknown as Record<string, unknown>,
      materializedTask.raw as unknown as Record<string, unknown>,
    );
  }
}
