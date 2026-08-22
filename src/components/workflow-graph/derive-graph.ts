import type { Node, Edge } from "@xyflow/react";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowExecutionContextDefinition,
  CascadeWorkflowSemanticDefinition,
  GraphWorkflowCascadeContext,
  GraphWorkflowTaskDefinition,
  GraphWorkflowVisualLayout,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  deriveContextWaitState,
  type ContextWaitState,
} from "./derive-wait-state";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { resolveContext } from "@/lib/workflow-graph/resolve-config";
import { createExecutionIndex } from "@/lib/workflow-graph/execution-index";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import {
  resolvedRouteEdge,
  type RouteEdgeResolution,
} from "@/lib/workflow-graph/route-projection";
import { getContextOutput } from "@/lib/workflow-graph/context-outputs";
import {
  resolveLoopPassMembership,
  type LoopPassMembership,
} from "@/lib/workflow-graph/loop-ledger";
import { resolveExpansionProvenance } from "@/lib/workflow-graph/expansion-receipts";
import type { GraphWorkflowContextSkipReason } from "@/lib/workflow-graph/schemas";
import {
  deriveDefinitionLaneBands,
  deriveExecutionLaneBands,
  type LaneBandState,
} from "@/lib/workflow-graph/lane-bands";
import {
  contextNodeAriaLabel,
  contextNodeCrew,
  contextNodeGrade,
  contextNodeStatus,
  ownedPathsText,
} from "./node-presentation";

/**
 * The graph is a read-only projection, so it takes the CASCADE shape: a seeded
 * context is a cascade context plus `profileSnapshot`, and nothing here reads
 * the snapshot — one type therefore serves both the builder preview (which has
 * no snapshots) and a running execution.
 */
type DeriveGraphDefinition =
  | WorkflowSemanticDefinition
  | CascadeWorkflowSemanticDefinition;

/**
 * A skipped context as the read surfaces render it (D4 R13): the COMPLETE
 * recorded verdict set, plus the subset that actually decided the skip.
 *
 * `decidingEdgeIds` is derived rather than persisted because the durable reason
 * records every incoming edge — an operator asking "why was this branch not
 * taken" wants the guards that resolved false, not the ones that merely dropped
 * out of the conjunction.
 */
export type ContextSkipDisplay = {
  at: string;
  edgeEvaluations: GraphWorkflowContextSkipReason["edgeEvaluations"];
  decidingEdgeIds: string[];
};

/** A materialized loop pass instance, with its group's activation and budget. */
export type ContextLoopDisplay = LoopPassMembership;

/** The accepted expansion that authorized a runtime-added node (R8 provenance). */
export type ContextProvenanceDisplay = {
  requestId: string;
  invokerContextId: string;
  rationale: string;
  payloadHash: string;
  acceptedAt: string;
};

export type ExecutionContextNodeData = {
  context:
    | GraphWorkflowExecutionContextDefinition
    | GraphWorkflowCascadeContext;
  tasks: GraphWorkflowTaskDefinition[];
  mode: "builder" | "execution";
  contextState?: GraphWorkflowExecutionContextState;
  taskStates?: Record<string, GraphWorkflowTaskState>;
  waitState?: ContextWaitState;
  /**
   * Present ONLY when the context declares an `outputSchema` — its absence is
   * how the node knows to draw no contract glyph at all. `captured` is false in
   * builder mode by construction: nothing has run, so a declared contract is
   * always still owed.
   */
  outputSchema?: { captured: boolean };
  /** Present only on a `skipped` context (D4 R4) — the recorded route verdicts. */
  skip?: ContextSkipDisplay;
  /** Present only on a materialized loop pass instance (D4 R9). */
  loop?: ContextLoopDisplay;
  /** Present only on a context a runtime expansion created (D4 R8). */
  provenance?: ContextProvenanceDisplay;
  /**
   * The state of the band this context sits in, so the node's lane chip and the
   * band behind it cannot disagree. Derived from the same lane-band model the
   * band layer renders.
   */
  laneState: LaneBandState;
  /** Present only when a runtime expansion created this context's whole lane. */
  laneCreatedAtRuntime?: true;
  /**
   * Blocks this context overrides at its OWN tier, named for display — the
   * set-on-this-context marker's reason. Empty when everything is inherited.
   */
  configOverrides: string[];
};

export type DeriveNodesOptions = {
  /**
   * The pre-cascade draft, when the caller has one. A resolved context cannot
   * distinguish a context-tier block from an inherited one for most settings —
   * only the authored document can — so a caller holding the draft passes it
   * and gets exact override provenance instead of the partial record a resolved
   * context carries.
   */
  authoredDefinition?: WorkflowSemanticDefinition;
  /**
   * The global tier, for a caller whose `definition` is ITSELF the authored
   * document (the launch preview). An inherited implementer or cohort is simply
   * absent from an authored context, so without this the card would show no
   * crew at all for a workflow that configures its agents once at the workflow
   * tier. Present → every context is put through `resolveContext`, the owner of
   * the global → workflow → context cascade, so the preview names the crew that
   * would actually run. A caller that already resolved its definition omits it.
   */
  workflowDefaults?: WorkflowDefaults;
};

export type ContextEdgeData = {
  sourceStatus?: GraphWorkflowContextStatus;
  targetStatus?: GraphWorkflowContextStatus;
  /**
   * Present ONLY on a guarded edge (D4 R1) — its absence is how the edge knows
   * to draw a plain solid line with no chip, which is every pre-D4 edge.
   * `resolution` is the projection's verdict, so the chip reports what the
   * engine actually decided rather than re-evaluating the guard.
   */
  guard?: { kind: "schema" | "else"; resolution: RouteEdgeResolution["kind"] };
  /**
   * The instance whose landed work satisfies this edge, when it differs from
   * the authored source — a concluded loop's external edge (D1). Topology still
   * renders the logical source; this is the provenance beside it.
   */
  effectiveSourceId?: string;
};

export type ContextDisplayPhase =
  | GraphWorkflowContextStatus
  | "validating"
  | "advisory-response"
  | "merging";

export type DisplayValidators = {
  script: boolean;
  agent: "claude" | "codex" | null;
};

export function getDisplayValidators(
  context: ExecutionContextNodeData["context"],
): DisplayValidators {
  return {
    script: getDisplayScriptGate(context.scriptValidator),
    agent: getDisplayAgentValidator(context.contextValidator),
  };
}

function getDisplayScriptGate(
  scriptValidator: ExecutionContextNodeData["context"]["scriptValidator"],
): boolean {
  if (!scriptValidator) return false;
  return scriptValidator.commands.length > 0;
}

// The node shows ONE agent-validator pill, so a cohort collapses to the backend
// its assignments run on — or `null` when they disagree, since a single pill
// claiming one backend for a mixed cohort would be worse than none.
function getDisplayAgentValidator(
  cohort: ExecutionContextNodeData["context"]["contextValidator"],
): "claude" | "codex" | null {
  if (!cohort?.enabled) return null;
  const backends = new Set(
    cohort.assignments.map((assignment) => assignment.agent.backend),
  );
  if (backends.size !== 1) return null;
  return [...backends][0] ?? null;
}

export function getDisplayApprovalGate(
  context: ExecutionContextNodeData["context"],
): boolean {
  return context.humanApprovalGate?.enabled === true;
}

export function getContextDisplayPhase(
  contextState: GraphWorkflowExecutionContextState | undefined,
): ContextDisplayPhase | undefined {
  if (!contextState) return undefined;
  if (contextState.mergeStatus === "in-progress") {
    return "merging";
  }
  if (contextState.status === "running") {
    // Ahead of the task-count check for the same reason as the wait state: a
    // context owing an advisory-response turn has already been certified, and
    // reading it as `validating` would colour the node for a review that is
    // over. `recertifying` falls through — a blocking round IS what runs next.
    if (contextState.advisoryResponse?.phase === "awaiting_response") {
      return "advisory-response";
    }
    if (
      contextState.totalTaskCount > 0 &&
      contextState.completedTaskCount >= contextState.totalTaskCount
    ) {
      return "validating";
    }
  }
  return contextState.status;
}

/** One incoming route as the inspector reports it (D4 R13 legibility). */
export type ContextRouteRow = {
  edgeId: string;
  logicalSourceId: string;
  effectiveSourceId: string | null;
  guard: "none" | "schema" | "else";
  resolution: RouteEdgeResolution["kind"];
};

/**
 * A context's incoming routes with the projection's verdict on each.
 *
 * The WHOLE conjunction is reported, not just the guarded edges: "why did this
 * context run / not run" is a statement about every incoming route, and an
 * omitted sibling is part of that answer.
 */
export function deriveContextRouteRows(
  execution: GraphWorkflowExecution,
  contextId: string,
  definition: DeriveGraphDefinition = execution.workingDefinition,
): ContextRouteRow[] {
  const projection = projectExecutionRoutes(execution, definition);
  return projection.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => ({
      edgeId: edge.edgeId,
      logicalSourceId: edge.logicalSourceId,
      effectiveSourceId: edge.effectiveSourceId,
      guard: edge.guard,
      resolution: edge.resolution.kind,
    }));
}

/**
 * The recorded skip verdicts of a skipped context, or null for every other
 * status. Read off the durable `skipReason` rather than re-projected: the
 * reason describes the moment the branch was decided, and a later projection
 * over a moved graph would answer a different question.
 */
export function deriveContextSkipDisplay(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextSkipDisplay | null {
  const state = execution.contextStates[contextId];
  if (!state || state.status !== "skipped" || !state.skipReason) return null;
  return {
    at: state.skipReason.at,
    edgeEvaluations: state.skipReason.edgeEvaluations,
    decidingEdgeIds: state.skipReason.edgeEvaluations
      .filter((evaluation) => evaluation.verdict === "inactive")
      .map((evaluation) => evaluation.edgeId),
  };
}

/**
 * A context's loop membership, or null when it is not a pass instance. Goes
 * through the shared `resolveLoopPassMembership` projection the inspector and
 * the CLI outline also read, so one instance cannot be badged three ways.
 */
export function deriveContextLoopDisplay(
  definition: DeriveGraphDefinition,
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextLoopDisplay | null {
  return resolveLoopPassMembership({
    contextId,
    loopGroups: definition.loopGroups ?? [],
    loopStates: execution.loopStates,
  });
}

/**
 * The accepted expansion that created this context, or null for one the planner
 * authored. Goes through `resolveExpansionProvenance` rather than re-deriving
 * from `addedContextIds`, so the badge and the audit ledger name one receipt.
 */
export function deriveContextProvenanceDisplay(
  execution: GraphWorkflowExecution,
  contextId: string,
): ContextProvenanceDisplay | null {
  const provenance = resolveExpansionProvenance(
    execution.expansionReceipts,
    contextId,
  );
  if (!provenance || provenance.nodeKind !== "context") return null;
  const { receipt } = provenance;
  return {
    requestId: receipt.requestId,
    invokerContextId: receipt.invokerContextId,
    rationale: receipt.rationale,
    payloadHash: receipt.payloadHash,
    acceptedAt: receipt.acceptedAt,
  };
}

/**
 * The blocks an AUTHORED context declares at its own tier, in a stable display
 * order. Presence is the whole signal: the cascade takes the nearest tier that
 * declares a block, so a declared block IS an override.
 */
const AUTHORED_OVERRIDE_LABELS: readonly [
  keyof GraphWorkflowExecutionContextDefinition,
  string,
][] = [
  ["implementer", "implementer"],
  ["contextValidator", "validator cohort"],
  ["scriptValidator", "script validator"],
  ["humanApprovalGate", "human approval gate"],
  ["askUserQuestions", "ask user questions"],
  ["iterationPolicy", "iteration policy"],
  ["circuitBreaker", "circuit breaker"],
  ["mutability", "mutability"],
  ["planRepair", "plan repair"],
  ["collaboration", "collaboration"],
  ["agentValidation", "agent validation"],
];

/**
 * Blocks whose resolved value is shape-identical to the tier it cascaded from,
 * so the two can be compared directly. `collaboration` and `agentValidation`
 * are deliberately absent: the resolver rewrites them into per-field
 * `{value, source}` records, which no longer compare against a tier — and it
 * records their provenance outright, so the pass below already answers them.
 */
const TIER_COMPARABLE_BLOCKS = [
  "implementer",
  "contextValidator",
  "scriptValidator",
  "humanApprovalGate",
  "askUserQuestions",
  "iterationPolicy",
  "circuitBreaker",
  "mutability",
  "planRepair",
] as const satisfies readonly (keyof WorkflowConfigOverride &
  keyof GraphWorkflowExecutionContextDefinition)[];

type TierComparableBlock = (typeof TIER_COMPARABLE_BLOCKS)[number];

function isTierComparable(
  field: keyof GraphWorkflowExecutionContextDefinition,
): field is TierComparableBlock {
  return (TIER_COMPARABLE_BLOCKS as readonly string[]).includes(field);
}

/**
 * A block's identity for tier comparison, with the bytes SEEDING adds removed.
 * Both the seed boundary and the live-edit boundary attach `profileSnapshot` by
 * spreading the assignment they were given, so an untouched inherited block
 * differs from its tier by exactly that key — which is delivered instructions,
 * not a configuration choice, and must not read as an override. Keys are sorted
 * and undefined-valued keys dropped so the comparison cannot turn on authoring
 * order.
 */
function blockIdentity(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.entries(input)
          .filter(
            ([key, entry]) => key !== "profileSnapshot" && entry !== undefined,
          )
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

/**
 * What this context sets on ITSELF, named for the set-on-this-context marker.
 *
 * Three independent signals, unioned — the marker must appear whenever ANY of
 * them shows an override, and the criterion is that it appear ONLY then:
 *
 *  1. The authored context declares the block. A declared block IS an override,
 *     because the cascade takes the nearest tier that declares one.
 *  2. The resolved context's value no longer matches the tier it was launched
 *     inheriting from. This is what catches a LIVE EDIT: the working definition
 *     is rewritten in place while `authored` — the launch snapshot — is
 *     immutable and keeps reporting the block as inherited forever.
 *  3. The provenance the resolver recorded per field and per role, which is the
 *     only signal for the blocks it rewrites into `{value, source}` records.
 *
 * A block inherited from the GLOBAL tier and then live-edited is not detectable
 * here: signal 2 needs the tier's value, and a launch document carries the
 * workflow tier but not the global one. Reporting it would take provenance the
 * resolved context does not carry, so it is left undetected rather than guessed
 * — a marker that lies about what is set on a context is worse than one that is
 * occasionally absent.
 */
export function deriveContextConfigOverrides(
  context: ExecutionContextNodeData["context"],
  authored?: GraphWorkflowExecutionContextDefinition,
  workflowConfig?: WorkflowConfigOverride,
): string[] {
  const overrides: string[] = [];

  if (authored) {
    for (const [field, label] of AUTHORED_OVERRIDE_LABELS) {
      if (authored[field] !== undefined) {
        overrides.push(label);
        continue;
      }
      if (!isTierComparable(field) || !(field in context)) continue;
      const tierValue = workflowConfig?.[field];
      if (tierValue === undefined) continue;
      const resolvedValue = (context as Record<string, unknown>)[field];
      if (blockIdentity(resolvedValue) !== blockIdentity(tierValue)) {
        overrides.push(label);
      }
    }
  }

  if (
    "scriptValidatorSource" in context &&
    context.scriptValidatorSource === "per-node"
  ) {
    overrides.push("script validator");
  }
  if (
    context.collaboration !== undefined &&
    Object.values(context.collaboration).some(isPerNode)
  ) {
    overrides.push("collaboration");
  }
  const agentValidation = context.agentValidation;
  if (isPerNode(agentValidation?.implementer)) {
    overrides.push("agent validation (implementer)");
  }
  if (isPerNode(agentValidation?.contextValidator)) {
    overrides.push("agent validation (context validator)");
  }
  // Deduped, not concatenated: "script validator" is reachable from both the
  // authored/tier pass and the provenance pass, and the marker names each
  // overridden block once.
  return [...new Set(overrides)];
}

/**
 * Whether a resolved, provenanced value was set at the context tier. The `in`
 * guard is load-bearing: on the AUTHORED shape the same field is a bare value
 * with no provenance at all, which is correctly "not per-node here" — the
 * authored branch above answers that case exactly.
 */
function isPerNode(field: unknown): boolean {
  return (
    typeof field === "object" &&
    field !== null &&
    "source" in field &&
    field.source === "per-node"
  );
}

/**
 * Lanes whose EVERY member arrived through an accepted runtime expansion — the
 * "runtime" marker on the node's lane chip. Derived rather than recorded: the
 * engine keeps receipts per context, not per lane, and a lane holding even one
 * authored member is an authored lane a generated context happened to join.
 */
function runtimeCreatedLaneNames(
  definition: DeriveGraphDefinition,
  execution: GraphWorkflowExecution,
): Set<string> {
  const membersByLane = new Map<string, string[]>();
  for (const context of definition.executionContexts) {
    const lane = context.placement?.lane;
    if (!lane) continue;
    const members = membersByLane.get(lane);
    if (members) members.push(context.id);
    else membersByLane.set(lane, [context.id]);
  }

  const runtimeLanes = new Set<string>();
  for (const [lane, members] of membersByLane) {
    const allGenerated = members.every(
      (contextId) =>
        resolveExpansionProvenance(execution.expansionReceipts, contextId)
          ?.nodeKind === "context",
    );
    if (allGenerated) runtimeLanes.add(lane);
  }
  return runtimeLanes;
}

export function deriveNodes(
  definition: DeriveGraphDefinition,
  layout: GraphWorkflowVisualLayout,
  execution?: GraphWorkflowExecution | null,
  options?: DeriveNodesOptions,
): Node<ExecutionContextNodeData>[] {
  const index = createExecutionIndex(definition, execution);
  const bands = execution
    ? deriveExecutionLaneBands(execution)
    : deriveDefinitionLaneBands(definition);
  const bandStateByContext = new Map<string, LaneBandState>(
    bands.flatMap((band) =>
      band.memberContextIds.map(
        (contextId) => [contextId, band.state] as const,
      ),
    ),
  );
  const runtimeLanes = execution
    ? runtimeCreatedLaneNames(definition, execution)
    : new Set<string>();
  const authoredById = new Map(
    (options?.authoredDefinition?.executionContexts ?? []).map((context) => [
      context.id,
      context,
    ]),
  );

  const workflowConfig = options?.authoredDefinition?.workflowConfig ?? {};
  const workflowDefaults = options?.workflowDefaults;

  return definition.executionContexts.map((context) => {
    const authored = authoredById.get(context.id);
    // The card reads the EFFECTIVE context: an authored preview resolves
    // through the cascade's owner, everyone else already passed a resolved
    // definition and the context is effective as it stands.
    const displayContext =
      workflowDefaults && authored
        ? resolveContext(workflowDefaults, workflowConfig, authored)
        : context;

    const data: ExecutionContextNodeData = {
      context: displayContext,
      tasks: index.tasksByContext.get(context.id) ?? [],
      mode: execution ? "execution" : "builder",
      laneState: bandStateByContext.get(context.id) ?? "pending",
      configOverrides: deriveContextConfigOverrides(
        displayContext,
        authored,
        workflowConfig,
      ),
    };

    if (runtimeLanes.has(displayContext.placement.lane)) {
      data.laneCreatedAtRuntime = true;
    }

    if (displayContext.outputSchema !== undefined) {
      // Read through the D6 accessor rather than `execution.contextOutputs`, so
      // "captured" means the same thing on the node as it does in the inspector
      // and in the downstream prompt injection.
      data.outputSchema = {
        captured:
          execution != null &&
          getContextOutput(execution, context.id).kind === "captured",
      };
    }

    if (execution) {
      const ctxState = execution.contextStates[context.id];
      if (ctxState) {
        data.contextState = ctxState;
      }

      const waitState = deriveContextWaitState({
        contextId: context.id,
        definition,
        execution,
      });
      if (waitState) {
        data.waitState = waitState;
      }

      const taskStates = index.taskStatesByContext.get(context.id);
      if (taskStates && Object.keys(taskStates).length > 0) {
        data.taskStates = taskStates;
      }

      const skip = deriveContextSkipDisplay(execution, context.id);
      if (skip) {
        data.skip = skip;
      }

      const loop = deriveContextLoopDisplay(definition, execution, context.id);
      if (loop) {
        data.loop = loop;
      }

      const provenance = deriveContextProvenanceDisplay(execution, context.id);
      if (provenance) {
        data.provenance = provenance;
      }
    }

    return {
      id: context.id,
      type: "executionContext" as const,
      position: layout.contextPositions[context.id] ?? { x: 0, y: 0 },
      // React Flow names its own focusable node wrapper from this; the card
      // repeats it on its inner group so the same sentence reaches a reader
      // whichever element they land on.
      ariaLabel: contextNodeAccessibleName(data),
      data,
    };
  });
}

/**
 * The node's accessible name, from node data alone — so the canvas wrapper and
 * the rendered card cannot describe the same context two different ways.
 */
export function contextNodeAccessibleName(
  data: ExecutionContextNodeData,
): string {
  return contextNodeAriaLabel({
    title: data.context.title,
    status: contextNodeStatus(data.mode, data.waitState),
    laneName: data.context.placement.lane,
    grade: contextNodeGrade(data.context.placement),
    ownedPaths: ownedPathsText(data.context.placement),
    completedTaskCount: data.contextState?.completedTaskCount ?? 0,
    totalTaskCount: data.contextState?.totalTaskCount ?? data.tasks.length,
    crew: contextNodeCrew(data.context),
    configOverrides: data.configOverrides,
  });
}

export function deriveEdges(
  definition: DeriveGraphDefinition,
  execution?: GraphWorkflowExecution | null,
): Edge<ContextEdgeData>[] {
  // Topology renders the LOGICAL source (decision D1) — the authored edge is
  // what the author drew and what the layout positions — while the STATUS the
  // edge paints follows the EFFECTIVE source, i.e. the instance whose landed
  // work actually satisfies it.
  const projection = execution
    ? projectExecutionRoutes(execution, definition)
    : null;

  return definition.edges.map((edge) => {
    const data: ContextEdgeData = {};

    if (execution) {
      const resolved = projection
        ? resolvedRouteEdge(projection, edge.id)
        : undefined;
      const sourceId = resolved?.effectiveSourceId ?? edge.sourceContextId;
      data.sourceStatus = execution.contextStates[sourceId]?.status;
      data.targetStatus = execution.contextStates[edge.targetContextId]?.status;
      if (resolved && resolved.guard !== "none") {
        data.guard = {
          kind: resolved.guard,
          resolution: resolved.resolution.kind,
        };
      }
      if (
        resolved?.effectiveSourceId != null &&
        resolved.effectiveSourceId !== resolved.logicalSourceId
      ) {
        data.effectiveSourceId = resolved.effectiveSourceId;
      }
    }

    return {
      id: edge.id,
      source: edge.sourceContextId,
      target: edge.targetContextId,
      type: "contextEdge" as const,
      data,
    };
  });
}
