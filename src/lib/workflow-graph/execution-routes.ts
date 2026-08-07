/**
 * The adapter that hands a running execution to the pure route projection
 * (D4 R2, decision D1).
 *
 * Deliberately tiny and dependency-free beyond the projection itself: lane
 * readiness, the scheduler, joins, upstream-input resolution and the read
 * surfaces all need projection-resolved edges, and they sit on both sides of
 * the landing/transition modules. Keeping the adapter here is what lets every
 * one of them derive routes from `route-projection.ts` without importing the
 * settlement machinery — or each other.
 *
 * Route semantics are not decided here. This module only marshals.
 */

import {
  incomingRoutes,
  projectRoutes,
  type RouteProjection,
  type RouteProjectionLoop,
} from "@/lib/workflow-graph/route-projection";
import { loopInstanceId } from "@/lib/workflow-graph/loop-resolver";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  CascadeWorkflowSemanticDefinition,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

/** The activation edge is retargeted onto pass 1's entry and never cloned. */
const FIRST_LOOP_PASS = 1;

export type RouteRuntimeDefinition =
  | WorkflowSemanticDefinition
  | CascadeWorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

/**
 * The declared loop groups as the projection reads them (D4 R9): the logical
 * exit whose external edges the loop holds, the body it repeats, its activation,
 * and — once concluded — the pass instance that actually satisfies those edges.
 *
 * Activation comes from `loopStates`, which the settlement transaction owns.
 * A group with no ledger entry yet reads `unstarted`, which is exactly right:
 * seed resolution materializes pass 1 but nothing has decided whether the
 * activation path was taken, so downstream must wait either way.
 *
 * Only RESOLVED groups carry a body template, and only a resolved definition
 * ever reaches a running execution; an authored group has no pass instances to
 * hold edges for.
 */
export function projectExecutionLoops(
  execution: GraphWorkflowExecution,
  definition: RouteRuntimeDefinition = execution.workingDefinition,
): RouteProjectionLoop[] {
  const loopGroups = definition.loopGroups ?? [];
  const loops: RouteProjectionLoop[] = [];
  for (const group of loopGroups) {
    if (!("template" in group)) continue;
    const state = execution.loopStates[group.id];
    loops.push({
      id: group.id,
      exitContextId: group.exitContextId,
      bodyContextIds: group.template.contexts.map((context) => context.id),
      activationContextId: loopInstanceId(
        group.id,
        FIRST_LOOP_PASS,
        group.entryContextId,
      ),
      activation: state?.activation ?? "unstarted",
      concludingExitContextId: state?.concludingExitContextId ?? null,
    });
  }
  return loops;
}

/**
 * Project the routes of a running execution.
 *
 * `definition` defaults to the working definition; callers that already hold a
 * definition pass it explicitly so the two cannot disagree mid-mutation.
 */
export function projectExecutionRoutes(
  execution: GraphWorkflowExecution,
  definition: RouteRuntimeDefinition = execution.workingDefinition,
): RouteProjection {
  return projectRoutes({
    executionContexts: definition.executionContexts.map((context) => ({
      id: context.id,
      outputSchema: context.outputSchema,
      routing: context.routing,
    })),
    edges: definition.edges,
    contextStates: execution.contextStates,
    contextOutputs: execution.contextOutputs,
    loops: projectExecutionLoops(execution, definition),
  });
}

/**
 * The contexts a target still depends on: the EFFECTIVE sources of every
 * incoming edge that has not been OMITTED, deduplicated in definition order.
 *
 * Every consumer that used to read `edge.sourceContextId` for landing, lane
 * visibility or injected data goes through here. Reading the raw authored
 * source would make a downstream wait on a branch the routing already declined
 * — and, once loops land, on a declared exit context that never runs.
 *
 * "Not omitted" rather than "active" on purpose. An omitted edge (its source
 * skipped) genuinely drops out of the conjunction and must not be waited on.
 * An UNRESOLVED edge has not been decided yet, so it keeps its logical source
 * and keeps blocking — which is exactly the pre-D4 behaviour, and is what stops
 * this from silently calling an undecided fan-in ready. For a context the
 * projection has already ruled `eligible`, every remaining edge is active, so
 * this set is the active set there.
 */
export function routeUpstreamContextIds(
  execution: GraphWorkflowExecution,
  contextId: string,
  definition: RouteRuntimeDefinition = execution.workingDefinition,
): string[] {
  const projection = projectExecutionRoutes(execution, definition);
  const sourceIds: string[] = [];
  for (const edge of incomingRoutes(projection, contextId)) {
    if (edge.resolution.kind === "omitted") continue;
    const sourceId = edge.effectiveSourceId ?? edge.logicalSourceId;
    if (!sourceIds.includes(sourceId)) sourceIds.push(sourceId);
  }
  return sourceIds;
}
