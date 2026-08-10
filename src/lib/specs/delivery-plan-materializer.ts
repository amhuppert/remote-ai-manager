import { createHash } from "node:crypto";
import { z } from "zod";

import { stableStringify } from "@/lib/state-store/serialization";
import type {
  GraphWorkflowContextEdge,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";

import {
  deliveryPlanHash,
  type DeliveryPlanContext,
  type DeliveryPlanDocument,
  type DeliveryPlanGovernance,
  type DeliveryPlanWiringEntry,
} from "./delivery-plan";
import { elementHandleInSnapshot } from "./review-state";
import type {
  Refusal,
  SpecRevisionSnapshot,
  ValidationStrategy,
} from "./schemas";

/**
 * Exact materialization (design §5): the authored `DeliveryPlanAttempt` becomes
 * the executed `WorkflowSemanticDefinition` by copying, never by inferring.
 *
 * Nothing here groups contexts, derives an edge, unions criterion text into a
 * contract, or invents a prerequisite context — the plan was authored in the
 * graph vocabulary precisely so that none of those transforms remain. What the
 * module does add is provenance: a per-context source map in `metadata`, and a
 * bounded per-context pack in `description` carrying the criterion text, proof
 * plan, and wiring ownership an implementer needs but a validator is not held
 * to. The acceptance contract itself travels alone.
 */

/** The pinned-revision facts a pack quotes. Read once, copied, never re-derived. */
export interface DeliveryPlanMaterializationCriterion {
  readonly criterionElementId: string;
  readonly handle: string;
  readonly text: string;
  readonly validationStrategy: ValidationStrategy;
}

/**
 * The pinned revision read as materialization input. The handle is derived
 * through the one snapshot derivation the rest of the spec surfaces use, so a
 * context pack quotes an address an implementer can actually resolve — a
 * hand-built handle would render text no `cctl spec element get` accepts. An
 * element the revision never numbered has no handle at all, and is addressed
 * by its element id rather than by an invented one.
 */
export function deliveryPlanMaterializationCriteria(
  snapshot: SpecRevisionSnapshot,
): DeliveryPlanMaterializationCriterion[] {
  return snapshot.elements.flatMap(({ element, version }) =>
    version.payload.kind === "criterion"
      ? [
          {
            criterionElementId: element.id,
            handle: elementHandleInSnapshot(snapshot, element.id) ?? element.id,
            text: version.payload.text,
            validationStrategy: version.payload.validationStrategy,
          },
        ]
      : [],
  );
}

/**
 * The inherited configuration resolved at materialization and pinned into the
 * candidate. Passing it in (rather than reading global config here) is what
 * makes "changing a global default afterwards does not alter the stored
 * candidate" a property of the code: the materializer never has a live default
 * to drift against.
 */
export interface DeliveryPlanMaterializationDefaults {
  readonly approvalRequired: boolean;
  readonly workflowConfig: WorkflowConfigOverride;
}

export interface DeliveryPlanMaterializationInput {
  readonly spec: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly attemptId: string;
  readonly pinnedRevisionId: string;
  readonly draftRevision: number;
  readonly document: DeliveryPlanDocument;
  readonly criteria: readonly DeliveryPlanMaterializationCriterion[];
  readonly registeredValidationCommandNames: readonly string[];
  readonly defaults: DeliveryPlanMaterializationDefaults;
}

/** What one context's pack included, and what the byte bound cost it. */
export interface DeliveryPlanPackManifest {
  readonly contextId: string;
  readonly total: number;
  readonly included: number;
  readonly omitted: number;
}

export interface DeliveryPlanMaterialization {
  readonly definition: WorkflowSemanticDefinition;
  readonly compiledDefinitionHash: string;
  readonly planHash: string;
  readonly packManifests: readonly DeliveryPlanPackManifest[];
}

export type DeliveryPlanMaterializationResult =
  | { readonly ok: true; readonly value: DeliveryPlanMaterialization }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * The one named canonical serialization the exactness contract allows: the
 * authored contract lines become the `acceptanceCriteria` string joined by a
 * newline. It is a pure function of the authored lines and of nothing else, so
 * reordering criteria or re-annotating task contributions cannot move a byte.
 */
export const ACCEPTANCE_CONTRACT_SERIALIZATION = (
  contract: readonly string[],
): string => contract.join("\n");

/** The per-context pack ceiling; the manifest reports what it cost. */
export const CONTEXT_PACK_MAX_BYTES = 32 * 1024;

export interface DeliveryPlanMaterializerFieldMapping {
  readonly source: string;
  readonly target: string;
  readonly transformation: string;
}

const MATERIALIZER_FIELDS = {
  approvalRequired: {
    source: "defaults.approvalRequired",
    target: "approvalRequired",
    transformation: "copy and pin",
    sourceKey: "approvalRequired",
    targetKey: "approvalRequired",
  },
  charterMission: {
    source: "governance.mission",
    target: "charter.mission",
    transformation: "copy",
    sourceKey: "mission",
    targetKey: "mission",
  },
  charterInvariants: {
    source: "governance.charterInvariants[]",
    target: "charter.invariants[]",
    transformation: "copy id and statement; omit the array when empty",
    sourceKey: "charterInvariants",
    targetKey: "invariants",
  },
  sourcesOfTruth: {
    source: "governance.sourcesOfTruth[]",
    target: "charter.sourcesOfTruth[]",
    transformation: "copy; omit appliesTo when null",
    sourceKey: "sourcesOfTruth",
    targetKey: "sourcesOfTruth",
  },
  validationCommandNames: {
    source: "governance.validationCommandNames[]",
    target: "workflowConfig.agentValidation.contextValidator.commands[]",
    transformation: "resolve registered names, copy, and pin",
    sourceKey: "validationCommandNames",
  },
  contextId: {
    source: "contexts[].contextId",
    target: "executionContexts[].id",
    transformation: "copy",
    sourceKey: "contextId",
    targetKey: "id",
  },
  contextTitle: {
    source: "contexts[].title",
    target: "executionContexts[].title",
    transformation: "copy",
    sourceKey: "title",
    targetKey: "title",
  },
  contextPack: {
    source:
      "contexts[].criterionElementIds[] + proofPlan[] + wiring[] + pinned criteria",
    target: "executionContexts[].description",
    transformation: `render bounded context pack (${CONTEXT_PACK_MAX_BYTES} bytes)`,
    targetKey: "description",
  },
  acceptanceContract: {
    source: "contexts[].acceptanceContract[]",
    target: "executionContexts[].acceptanceCriteria",
    transformation: "join authored lines with newline",
    sourceKey: "acceptanceContract",
    targetKey: "acceptanceCriteria",
  },
  taskId: {
    source: "tasks[].taskId",
    target: "tasks[].id",
    transformation: "copy",
    sourceKey: "taskId",
    targetKey: "id",
  },
  taskContextId: {
    source: "tasks[].contextId",
    target: "tasks[].contextId",
    transformation: "copy",
    sourceKey: "contextId",
    targetKey: "contextId",
  },
  taskOrder: {
    source: "tasks[].order",
    target: "tasks[].order",
    transformation: "sort per context, then assign dense 1-based order",
    sourceKey: "order",
    targetKey: "order",
  },
  taskTitle: {
    source: "tasks[].title",
    target: "tasks[].title",
    transformation: "copy",
    sourceKey: "title",
    targetKey: "title",
  },
  taskInstructions: {
    source: "tasks[].instructions",
    target: "tasks[].instructions",
    transformation: "copy",
    sourceKey: "instructions",
    targetKey: "instructions",
  },
  taskContributions: {
    source: "tasks[].contributesToCriterionElementIds[]",
    target: "tasks[].metadata.specPlanContributesToCriterionElementIds",
    transformation: "stable JSON serialization; provenance only",
    sourceKey: "contributesToCriterionElementIds",
  },
  edgeId: {
    source: "edges[].edgeId",
    target: "edges[].id",
    transformation: "copy",
    sourceKey: "edgeId",
    targetKey: "id",
  },
  edgeSource: {
    source: "edges[].fromContextId",
    target: "edges[].sourceContextId",
    transformation: "copy",
    sourceKey: "fromContextId",
    targetKey: "sourceContextId",
  },
  edgeTarget: {
    source: "edges[].toContextId",
    target: "edges[].targetContextId",
    transformation: "copy",
    sourceKey: "toContextId",
    targetKey: "targetContextId",
  },
  compiledDefinitionHash: {
    source: "materialized WorkflowSemanticDefinition",
    target: "compiledDefinitionHash",
    transformation: "sha256 of canonical stable serialization",
  },
} as const;

export const DELIVERY_PLAN_MATERIALIZER_FIELD_MAPPINGS = Object.values(
  MATERIALIZER_FIELDS,
).map(({ source, target, transformation }) => ({
  source,
  target,
  transformation,
})) satisfies readonly DeliveryPlanMaterializerFieldMapping[];

export const DELIVERY_PLAN_METADATA_KEYS = {
  attemptId: "specPlanAttemptId",
  planHash: "specPlanHash",
  pinnedRevisionId: "specPlanPinnedRevisionId",
  contextId: "specPlanContextId",
  contextType: "specPlanContextType",
  taskId: "specPlanTaskId",
  contributesTo: "specPlanContributesToCriterionElementIds",
  sourceMap: "specPlanSourceMap",
  packManifest: "specPlanPackManifest",
} as const;

/**
 * The charter copy. Every authored byte travels unchanged; the only structural
 * move is dropping an absent `appliesTo`, which the workflow charter expresses
 * by omission and the plan document by `null`.
 */
export function deliveryPlanCharter(
  governance: DeliveryPlanGovernance,
): WorkflowCharter {
  return {
    [MATERIALIZER_FIELDS.charterMission.targetKey]:
      governance[MATERIALIZER_FIELDS.charterMission.sourceKey],
    ...(governance[MATERIALIZER_FIELDS.charterInvariants.sourceKey].length === 0
      ? {}
      : {
          [MATERIALIZER_FIELDS.charterInvariants.targetKey]: governance[
            MATERIALIZER_FIELDS.charterInvariants.sourceKey
          ].map((invariant) => ({
            id: invariant.id,
            statement: invariant.statement,
          })),
        }),
    [MATERIALIZER_FIELDS.sourcesOfTruth.targetKey]: governance[
      MATERIALIZER_FIELDS.sourcesOfTruth.sourceKey
    ].map((source) => ({
      rank: source.rank,
      id: source.id,
      label: source.label,
      type: source.type,
      locator: source.locator,
      description: source.description,
      ...(source.appliesTo === null ? {} : { appliesTo: source.appliesTo }),
      accessPolicy: source.accessPolicy,
    })),
  };
}

export function deliveryPlanCompiledHash(
  definition: WorkflowSemanticDefinition,
): string {
  return `sha256:${createHash("sha256").update(stableStringify(definition)).digest("hex")}`;
}

/** The definition's stable identity for a plan attempt, independent of any snapshot row. */
export function deliveryPlanOriginSourceUri(
  specId: string,
  attemptId: string,
  planHash: string,
): string {
  return `spec-plan://${specId}/attempts/${attemptId}?plan=${planHash}`;
}

export function materializeDeliveryPlan(
  input: DeliveryPlanMaterializationInput,
): DeliveryPlanMaterializationResult {
  const document = input.document;
  const planHash = deliveryPlanHash({
    pinnedRevisionId: input.pinnedRevisionId,
    draftRevision: input.draftRevision,
    document,
  });

  const refusal = refuseUnmaterializable(input, planHash);
  if (refusal !== null) return { ok: false, refusal };

  const criteriaById = new Map(
    input.criteria.map((criterion) => [
      criterion.criterionElementId,
      criterion,
    ]),
  );
  const originSourceUri = deliveryPlanOriginSourceUri(
    input.spec.id,
    input.attemptId,
    planHash,
  );
  const tasksByContext = new Map<string, typeof document.tasks>();
  for (const context of document.contexts) {
    tasksByContext.set(
      context.contextId,
      orderedTasks(document, context.contextId),
    );
  }

  const packManifests: DeliveryPlanPackManifest[] = [];
  const executionContexts: GraphWorkflowExecutionContextDefinition[] =
    document.contexts.map((context) => {
      const pack = contextPack(context, document, criteriaById);
      packManifests.push({
        contextId: context.contextId,
        total: pack.total,
        included: pack.included,
        omitted: pack.omitted,
      });
      return {
        [MATERIALIZER_FIELDS.contextId.targetKey]:
          context[MATERIALIZER_FIELDS.contextId.sourceKey],
        [MATERIALIZER_FIELDS.contextTitle.targetKey]:
          context[MATERIALIZER_FIELDS.contextTitle.sourceKey],
        [MATERIALIZER_FIELDS.contextPack.targetKey]: pack.text,
        [MATERIALIZER_FIELDS.acceptanceContract.targetKey]:
          ACCEPTANCE_CONTRACT_SERIALIZATION(
            context[MATERIALIZER_FIELDS.acceptanceContract.sourceKey],
          ),
        origin: {
          sourceUri: `${originSourceUri}#${context.contextId}`,
          label: context.title,
        },
        metadata: {
          [DELIVERY_PLAN_METADATA_KEYS.attemptId]: input.attemptId,
          [DELIVERY_PLAN_METADATA_KEYS.planHash]: planHash,
          [DELIVERY_PLAN_METADATA_KEYS.pinnedRevisionId]:
            input.pinnedRevisionId,
          [DELIVERY_PLAN_METADATA_KEYS.contextId]: context.contextId,
          [DELIVERY_PLAN_METADATA_KEYS.contextType]: context.contextType,
          [DELIVERY_PLAN_METADATA_KEYS.sourceMap]: stableStringify({
            contextId: context.contextId,
            taskIds: (tasksByContext.get(context.contextId) ?? []).map(
              (task) => task.taskId,
            ),
            criterionElementIds: [...context.criterionElementIds],
            incomingEdges: document.edges
              .filter((edge) => edge.toContextId === context.contextId)
              .map((edge) => ({
                edgeId: edge.edgeId,
                fromContextId: edge.fromContextId,
              })),
          }),
          [DELIVERY_PLAN_METADATA_KEYS.packManifest]: stableStringify({
            total: pack.total,
            included: pack.included,
            omitted: pack.omitted,
          }),
        },
      };
    });

  const tasks: GraphWorkflowTaskDefinition[] = document.contexts.flatMap(
    (context) =>
      (tasksByContext.get(context.contextId) ?? []).map((task, index) => ({
        [MATERIALIZER_FIELDS.taskId.targetKey]:
          task[MATERIALIZER_FIELDS.taskId.sourceKey],
        [MATERIALIZER_FIELDS.taskContextId.targetKey]:
          task[MATERIALIZER_FIELDS.taskContextId.sourceKey],
        // Graph order is a 1-based position; the authored `order` is only a
        // sort key, so the compiled positions stay dense however it was numbered.
        [MATERIALIZER_FIELDS.taskOrder.targetKey]: index + 1,
        [MATERIALIZER_FIELDS.taskTitle.targetKey]:
          task[MATERIALIZER_FIELDS.taskTitle.sourceKey],
        [MATERIALIZER_FIELDS.taskInstructions.targetKey]:
          task[MATERIALIZER_FIELDS.taskInstructions.sourceKey],
        source: "user" as const,
        metadata: {
          [DELIVERY_PLAN_METADATA_KEYS.attemptId]: input.attemptId,
          [DELIVERY_PLAN_METADATA_KEYS.planHash]: planHash,
          [DELIVERY_PLAN_METADATA_KEYS.taskId]: task.taskId,
          [DELIVERY_PLAN_METADATA_KEYS.contextId]: task.contextId,
          [DELIVERY_PLAN_METADATA_KEYS.contributesTo]: stableStringify([
            ...task[MATERIALIZER_FIELDS.taskContributions.sourceKey],
          ]),
        },
      })),
  );

  const edges: GraphWorkflowContextEdge[] = document.edges.map((edge) => ({
    [MATERIALIZER_FIELDS.edgeId.targetKey]:
      edge[MATERIALIZER_FIELDS.edgeId.sourceKey],
    [MATERIALIZER_FIELDS.edgeSource.targetKey]:
      edge[MATERIALIZER_FIELDS.edgeSource.sourceKey],
    [MATERIALIZER_FIELDS.edgeTarget.targetKey]:
      edge[MATERIALIZER_FIELDS.edgeTarget.sourceKey],
  }));

  const definition: WorkflowSemanticDefinition = {
    schemaVersion: 1,
    [MATERIALIZER_FIELDS.approvalRequired.targetKey]:
      input.defaults[MATERIALIZER_FIELDS.approvalRequired.sourceKey],
    origin: {
      sourceUri: originSourceUri,
      label: `${input.spec.name} delivery plan ${planHash}`,
    },
    lockedRegions: lockedRegions(document, originSourceUri, input.spec.slug),
    workflowConfig: pinnedWorkflowConfig(input),
    charter: deliveryPlanCharter(document.governance),
    parameters: [],
    prerequisites: [],
    executionContexts,
    tasks,
    edges,
  };

  return {
    ok: true,
    value: {
      definition,
      compiledDefinitionHash: deliveryPlanCompiledHash(definition),
      planHash,
      packManifests,
    },
  };
}

/**
 * The resolved configuration the candidate pins. The plan's authored policy
 * overrides ride beside it as declared intent rather than silently rewriting a
 * config key: an override names a key in the author's words, and only the
 * enumerated selections below are machine-resolved.
 */
function pinnedWorkflowConfig(
  input: DeliveryPlanMaterializationInput,
): WorkflowConfigOverride {
  const selected = [
    ...input.document.governance[
      MATERIALIZER_FIELDS.validationCommandNames.sourceKey
    ],
  ];
  return {
    ...input.defaults.workflowConfig,
    agentValidation: {
      ...input.defaults.workflowConfig.agentValidation,
      contextValidator: { mode: "only", commands: selected },
    },
  };
}

function orderedTasks(
  document: DeliveryPlanDocument,
  contextId: string,
): DeliveryPlanDocument["tasks"] {
  return document.tasks
    .filter((task) => task.contextId === contextId)
    .sort(
      (left, right) =>
        left.order - right.order || compareText(left.taskId, right.taskId),
    );
}

interface ContextPack {
  readonly text: string;
  readonly total: number;
  readonly included: number;
  readonly omitted: number;
}

/**
 * The implementer-facing pack: the criterion text, proof plan, and wiring
 * ownership the context owns. It is bounded by bytes rather than by entry
 * count because the bound exists to protect one persisted column, and the
 * manifest states what the bound cost so a truncated pack never reads as a
 * complete one.
 */
function contextPack(
  context: DeliveryPlanContext,
  document: DeliveryPlanDocument,
  criteriaById: ReadonlyMap<string, DeliveryPlanMaterializationCriterion>,
): ContextPack {
  const wiring = document.wiring.filter((entry) =>
    wiringBelongsToContext(entry, context.contextId),
  );
  const proofByCriterion = new Map(
    context.proofPlan.map((step) => [step.criterionElementId, step]),
  );
  const entries = context.criterionElementIds.map((criterionElementId) => {
    const criterion = criteriaById.get(criterionElementId);
    const proof = proofByCriterion.get(criterionElementId);
    const handle = criterion?.handle ?? criterionElementId;
    return [
      `- ${handle}: ${criterion?.text ?? "(criterion text unavailable in the pinned revision)"}`,
      `  Required evidence: ${(criterion?.validationStrategy.kinds ?? []).join(", ")}`,
      ...(criterion?.validationStrategy.note === undefined
        ? []
        : [`  Approved strategy note: ${criterion.validationStrategy.note}`]),
      ...(proof === undefined
        ? []
        : [`  Proof plan: ${proof.evidenceKinds.join(", ")} — ${proof.note}`]),
    ].join("\n");
  });

  const suffix = (included: number, omitted: number): string[] => [
    "",
    "Production wiring owned here",
    ...(wiring.length === 0
      ? ["- None."]
      : wiring.map((entry) => `- ${wiringLine(entry)}`)),
    "",
    `Pack manifest: ${entries.length} owned criteria, ${included} included, ${omitted} omitted for the ${CONTEXT_PACK_MAX_BYTES}-byte context pack bound.`,
  ];
  const head = [
    `Context ${context.contextId} (${context.contextType}).`,
    "",
    "Owned acceptance criteria",
  ];
  const render = (included: number): string =>
    [
      ...head,
      ...(included === 0
        ? ["- None owned by this context."]
        : entries.slice(0, included)),
      ...suffix(included, entries.length - included),
    ].join("\n");

  let included = entries.length;
  let text = render(included);
  while (
    included > 0 &&
    Buffer.byteLength(text, "utf8") > CONTEXT_PACK_MAX_BYTES
  ) {
    included -= 1;
    text = render(included);
  }
  return {
    text,
    total: entries.length,
    included,
    omitted: entries.length - included,
  };
}

function wiringBelongsToContext(
  entry: DeliveryPlanWiringEntry,
  contextId: string,
): boolean {
  return entry.owner.contextId === contextId;
}

function wiringLine(entry: DeliveryPlanWiringEntry): string {
  const scope =
    entry.criterionElementIds.length === 0
      ? "no criterion"
      : entry.criterionElementIds.join(", ");
  return entry.owner.kind === "call_site"
    ? `${entry.capabilityId} (${scope}): call site ${entry.owner.locator}`
    : `${entry.capabilityId} (${scope}): owned downstream by ${entry.owner.contextId}`;
}

/**
 * The plan-owned regions of a compiled definition. Declaring them is this
 * module's job; refusing an edit that lands inside one is owned downstream by
 * the context lock-reopen path, which also owns the escape that makes locking
 * safe (design §11).
 */
function lockedRegions(
  document: DeliveryPlanDocument,
  originSourceUri: string,
  specSlug: string,
): WorkflowSemanticDefinition["lockedRegions"] {
  const reason = "the delivery plan owns it";
  // Both escapes, stated in the refusal itself: the plan has one before launch
  // and two after it, and which one applies is decided by whether a run exists
  // — something the reader knows and the region does not (`refusals-name-remedy`).
  const instruction = `Before launch, reopen the plan with \`cctl spec plan reopen ${specSlug} --reason <why>\` and re-propose. After launch, replan with \`cctl spec capture ${specSlug} --file <task.json> --blocking-reason <why>\`, or add to the running definition with \`cctl workflow live amend --reason <why> --file <live-ops.json>\` (additive only).`;
  return [
    {
      paths: ["/charter", "/approvalRequired", "/origin"],
      sourceUri: originSourceUri,
      reason,
      instruction,
    },
    ...document.contexts.map((context) => ({
      paths: [
        `/executionContexts/${context.contextId}/id`,
        `/executionContexts/${context.contextId}/title`,
        `/executionContexts/${context.contextId}/description`,
        `/executionContexts/${context.contextId}/acceptanceCriteria`,
        `/executionContexts/${context.contextId}/metadata`,
      ],
      sourceUri: `${originSourceUri}#${context.contextId}`,
      reason,
      instruction,
    })),
    ...document.tasks.map((task) => ({
      paths: [
        `/tasks/${task.taskId}/id`,
        `/tasks/${task.taskId}/contextId`,
        `/tasks/${task.taskId}/title`,
        `/tasks/${task.taskId}/instructions`,
        `/tasks/${task.taskId}/order`,
        `/tasks/${task.taskId}/metadata`,
      ],
      sourceUri: `${originSourceUri}#${task.taskId}`,
      reason,
      instruction,
    })),
    ...document.edges.map((edge) => ({
      paths: [
        `/edges/${edge.edgeId}/id`,
        `/edges/${edge.edgeId}/sourceContextId`,
        `/edges/${edge.edgeId}/targetContextId`,
      ],
      sourceUri: `${originSourceUri}#${edge.edgeId}`,
      reason,
      instruction,
    })),
    {
      paths: [
        "/executionContexts/*",
        "/tasks/*",
        "/edges/*",
        "/workflowConfig",
        "/laneMergeValidation",
      ],
      sourceUri: originSourceUri,
      reason,
      instruction,
    },
  ];
}

/** One context's provenance, read back out of a compiled definition. */
export interface DeliveryPlanContextSourceMapEntry {
  readonly contextId: string;
  readonly taskIds: readonly string[];
  readonly criterionElementIds: readonly string[];
}

export interface DeliveryPlanTaskSourceMapEntry {
  readonly taskId: string;
  readonly contextId: string;
  readonly contributesToCriterionElementIds: readonly string[];
}

export interface DeliveryPlanEdgeSourceMapEntry {
  readonly edgeId: string;
  readonly fromContextId: string;
  readonly toContextId: string;
}

export interface DeliveryPlanSourceMap {
  readonly attemptId: string;
  readonly planHash: string;
  readonly pinnedRevisionId: string;
  readonly contexts: readonly DeliveryPlanContextSourceMapEntry[];
  readonly tasks: readonly DeliveryPlanTaskSourceMapEntry[];
  readonly edges: readonly DeliveryPlanEdgeSourceMapEntry[];
}

const contextSourceMapSchema = z
  .object({
    contextId: z.string().min(1),
    taskIds: z.array(z.string().min(1)),
    criterionElementIds: z.array(z.string().min(1)),
    incomingEdges: z.array(
      z
        .object({
          edgeId: z.string().min(1),
          fromContextId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * The inverse of materialization: from a compiled definition back to the plan
 * elements that produced it. Every edge is read from the context it targets,
 * which is what makes the coverage total — an edge has exactly one target, so
 * an edge with no entry is an edge whose target context vanished.
 *
 * It throws rather than returning partial provenance: a caller resolving spec
 * criteria from a run would otherwise silently attribute evidence to nothing.
 */
export function readDeliveryPlanSourceMap(
  definition: WorkflowSemanticDefinition,
): DeliveryPlanSourceMap {
  const contexts: DeliveryPlanContextSourceMapEntry[] = [];
  const edges: DeliveryPlanEdgeSourceMapEntry[] = [];
  let identity: {
    attemptId: string;
    planHash: string;
    pinnedRevisionId: string;
  } | null = null;

  for (const context of definition.executionContexts) {
    const metadata = context.metadata;
    const raw = metadata?.[DELIVERY_PLAN_METADATA_KEYS.sourceMap];
    if (metadata === undefined || raw === undefined) {
      throw new Error(
        `Execution context ${context.id} carries no delivery-plan source map.`,
      );
    }
    const parsed = contextSourceMapSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(
        `Execution context ${context.id} carries an unreadable delivery-plan source map: ${parsed.error.message}`,
      );
    }
    identity ??= {
      attemptId: requiredMetadata(
        metadata,
        DELIVERY_PLAN_METADATA_KEYS.attemptId,
        context.id,
      ),
      planHash: requiredMetadata(
        metadata,
        DELIVERY_PLAN_METADATA_KEYS.planHash,
        context.id,
      ),
      pinnedRevisionId: requiredMetadata(
        metadata,
        DELIVERY_PLAN_METADATA_KEYS.pinnedRevisionId,
        context.id,
      ),
    };
    contexts.push({
      contextId: parsed.data.contextId,
      taskIds: parsed.data.taskIds,
      criterionElementIds: parsed.data.criterionElementIds,
    });
    for (const edge of parsed.data.incomingEdges) {
      edges.push({
        edgeId: edge.edgeId,
        fromContextId: edge.fromContextId,
        toContextId: parsed.data.contextId,
      });
    }
  }

  if (identity === null) {
    throw new Error("The definition carries no execution context to map.");
  }

  const tasks = definition.tasks.map((task) => {
    const metadata = task.metadata;
    if (metadata === undefined) {
      throw new Error(`Task ${task.id} carries no delivery-plan source map.`);
    }
    return {
      taskId: requiredMetadata(
        metadata,
        DELIVERY_PLAN_METADATA_KEYS.taskId,
        task.id,
      ),
      contextId: requiredMetadata(
        metadata,
        DELIVERY_PLAN_METADATA_KEYS.contextId,
        task.id,
      ),
      contributesToCriterionElementIds: z
        .array(z.string().min(1))
        .parse(
          JSON.parse(
            requiredMetadata(
              metadata,
              DELIVERY_PLAN_METADATA_KEYS.contributesTo,
              task.id,
            ),
          ),
        ),
    };
  });

  return { ...identity, contexts, tasks, edges };
}

function requiredMetadata(
  metadata: Readonly<Record<string, string>>,
  key: string,
  nodeId: string,
): string {
  const value = metadata[key];
  if (value === undefined) {
    throw new Error(
      `Delivery-plan metadata ${key} is missing from compiled node ${nodeId}.`,
    );
  }
  return value;
}

function refuseUnmaterializable(
  input: DeliveryPlanMaterializationInput,
  planHash: string,
): Refusal | null {
  const document = input.document;
  const reopen = `Nothing was compiled and no candidate was stored. Edit the attempt with \`cctl spec plan edit ${input.spec.slug} --file <plan.json>\` and re-run \`cctl spec plan propose ${input.spec.slug}\`.`;

  const duplicates = [
    ...duplicateIds(
      document.contexts.map((context) => context.contextId),
      "context",
    ),
    ...duplicateIds(
      document.tasks.map((task) => task.taskId),
      "task",
    ),
    ...duplicateIds(
      document.edges.map((edge) => edge.edgeId),
      "edge",
    ),
  ];
  if (duplicates.length > 0) {
    return {
      code: "dangling_reference",
      unmetConditions: duplicates,
      instruction: `${reopen} Give each context, task, and edge its own id.`,
      details: { attemptId: input.attemptId, planHash },
    };
  }

  const dangling = danglingReferences(input);
  if (dangling.length > 0) {
    return {
      code: "dangling_reference",
      unmetConditions: dangling,
      instruction: `${reopen} Every reference must name an element the plan or its pinned revision ${input.pinnedRevisionId} carries.`,
      details: { attemptId: input.attemptId, planHash },
    };
  }

  const registered = [...input.registeredValidationCommandNames];
  const unknownCommands = document.governance.validationCommandNames.filter(
    (name) => !registered.includes(name),
  );
  if (unknownCommands.length > 0) {
    return {
      code: "dangling_reference",
      unmetConditions: unknownCommands.map(
        (name) =>
          `Validation command '${name}' is not registered for this project.`,
      ),
      instruction: `${reopen} Registered commands are: ${registered.join(", ")}. Run \`cctl validate list\` to confirm, or register the command under validation.commands in CommandCenter.json first.`,
      details: {
        attemptId: input.attemptId,
        unknownCommands,
        registeredCommands: registered,
      },
    };
  }

  if (document.contexts.length === 0) {
    return {
      code: "invalid_scope",
      unmetConditions: ["The delivery plan has no execution context."],
      instruction: reopen,
      details: { attemptId: input.attemptId, planHash },
    };
  }

  const emptyContract = document.contexts.find(
    (context) => context.acceptanceContract.length === 0,
  );
  if (emptyContract !== undefined) {
    return {
      code: "invalid_scope",
      unmetConditions: [
        `Context ${emptyContract.contextId} has no acceptance contract, so it would compile to a context no validator can judge.`,
      ],
      instruction: `${reopen} Give ${emptyContract.contextId} at least one acceptanceContract line.`,
      details: {
        attemptId: input.attemptId,
        contextId: emptyContract.contextId,
      },
    };
  }

  if (
    document.governance.mission.trim().length === 0 ||
    document.governance.sourcesOfTruth.length === 0
  ) {
    return {
      code: "invalid_scope",
      unmetConditions: [
        "The delivery plan's governance has no mission or no ranked source of truth, so it cannot compile a charter.",
      ],
      instruction: `${reopen} Author governance.mission and at least one governance.sourcesOfTruth entry.`,
      details: { attemptId: input.attemptId },
    };
  }

  return null;
}

function duplicateIds(ids: readonly string[], kind: string): string[] {
  const seen = new Set<string>();
  const reported = new Set<string>();
  const findings: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      continue;
    }
    if (reported.has(id)) continue;
    reported.add(id);
    findings.push(`Two ${kind} entries share the id '${id}'.`);
  }
  return findings;
}

/**
 * Every reference the compiled graph would carry, checked against what the plan
 * and its pinned revision actually contain. The check runs before anything is
 * built so a refusal can state the whole set at once rather than stopping at
 * the first one and making the author re-propose per defect.
 */
function danglingReferences(input: DeliveryPlanMaterializationInput): string[] {
  const document = input.document;
  const contextIds = new Set(
    document.contexts.map((context) => context.contextId),
  );
  const criterionIds = new Set(
    input.criteria.map((criterion) => criterion.criterionElementId),
  );
  const findings: string[] = [];

  const requireCriterion = (id: string, where: string): void => {
    if (criterionIds.has(id)) return;
    findings.push(
      `${where} names criterion '${id}', which revision ${input.pinnedRevisionId} does not carry.`,
    );
  };
  const requireContext = (id: string, where: string): void => {
    if (contextIds.has(id)) return;
    findings.push(
      `${where} names context '${id}', which the plan does not carry.`,
    );
  };

  for (const disposition of document.dispositions) {
    requireCriterion(
      disposition.criterionElementId,
      `Disposition '${disposition.criterionElementId}'`,
    );
  }
  for (const context of document.contexts) {
    for (const criterionElementId of context.criterionElementIds) {
      requireCriterion(criterionElementId, `Context '${context.contextId}'`);
    }
    for (const step of context.proofPlan) {
      requireCriterion(
        step.criterionElementId,
        `Proof plan of context '${context.contextId}'`,
      );
    }
  }
  for (const task of document.tasks) {
    requireContext(task.contextId, `Task '${task.taskId}'`);
    for (const criterionElementId of task.contributesToCriterionElementIds) {
      requireCriterion(criterionElementId, `Task '${task.taskId}'`);
    }
  }
  for (const edge of document.edges) {
    requireContext(edge.fromContextId, `Edge '${edge.edgeId}'`);
    requireContext(edge.toContextId, `Edge '${edge.edgeId}'`);
  }
  for (const entry of document.wiring) {
    requireContext(entry.owner.contextId, `Wiring '${entry.capabilityId}'`);
    for (const criterionElementId of entry.criterionElementIds) {
      requireCriterion(criterionElementId, `Wiring '${entry.capabilityId}'`);
    }
  }
  return findings;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
