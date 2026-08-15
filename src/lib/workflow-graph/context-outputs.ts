/**
 * Read side of per-context structured outputs (D2, decision D6).
 *
 * One accessor answers "what did this context produce" and one resolver answers
 * "what does this context receive". Prompt injection and the builder/inspector
 * UI read through here rather than reaching into `execution.contextOutputs` and
 * `workingDefinition.edges` themselves, so "an output exists" has exactly one
 * definition.
 *
 * The four-state read itself lives in the import-free `output-lookup.ts`, which
 * D4's route projection also evaluates edge guards through; this module is its
 * execution-bound layer.
 *
 * Pure and dependency-free: every input is already on the execution.
 */

import type {
  GraphWorkflowContextOutput,
  GraphWorkflowExecution,
  GraphWorkflowOutputSchemaField,
  GraphWorkflowUpstreamInput,
} from "@/lib/workflow-graph/schemas";
import {
  lookupRawContextOutput,
  type RawContextOutputLookup,
} from "@/lib/workflow-graph/output-lookup";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import {
  findLoopBodyMembership,
  loopInstanceId,
} from "@/lib/workflow-graph/loop-resolver";
import { incomingRoutes } from "@/lib/workflow-graph/route-projection";
import { buildGraphWorkflowExecutionDeepLink } from "@/lib/workflow-graph/execution-deep-link";
import {
  GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES,
  type GraphWorkflowResultOutputProjection,
  type GraphWorkflowResultOutputReference,
} from "@/lib/workflow-graph/result-output-contract";

export { GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES } from "@/lib/workflow-graph/result-output-contract";

/**
 * The four raw states plus the one that only an execution can report: a
 * `skipped` context (D4 R4). It is layered here rather than in the raw read
 * because skipping is LIFECYCLE, not evidence — guards still ask the raw read
 * "was a payload captured", and a skipped source must not answer that question
 * with a lifecycle state.
 *
 * `skipped` outranks the raw verdict: a skipped context that declared a
 * contract owes nothing, so reporting `pending` would claim an output debt the
 * engine's completion invariant no longer holds it to.
 */
export type GraphWorkflowContextOutputLookup =
  | RawContextOutputLookup<GraphWorkflowContextOutput>
  | { kind: "skipped" };

/**
 * One top-level property of a declared `outputSchema`. Re-exported from the
 * persistence schemas because a loop's boundary-input snapshot is durable, and
 * a hand-written twin of a persisted shape is a drift waiting to happen.
 */
export type { GraphWorkflowOutputSchemaField } from "@/lib/workflow-graph/schemas";

/**
 * The SHAPE of a declared `outputSchema` — enough to say a contract exists and
 * how wide it is, with none of the declaration. Read surfaces that size a schema
 * rather than print it (the saved and live CLI outlines, R7.2) share this so a
 * "4 fields" on one surface counts the same properties as on the other.
 */
export interface GraphWorkflowOutputSchemaShape {
  /** The declared root `type`; null when the root is a `oneOf` or implies one. */
  type: string | null;
  /** Top-level property count; null when the root declares no `properties`. */
  fieldCount: number | null;
}

/**
 * The parts of a workflow graph the upstream walk reads.
 *
 * Structural rather than one of the two definition types, because the walk is
 * identical on an authored definition (the builder, which has no execution) and
 * on a resolved one (a running execution's `workingDefinition`). Both satisfy
 * it, so the Q2 scope answer is written once.
 */
export interface GraphWorkflowUpstreamGraph {
  executionContexts: ReadonlyArray<{
    id: string;
    title: string;
    outputSchema?: Record<string, unknown>;
  }>;
  edges: ReadonlyArray<{ sourceContextId: string; targetContextId: string }>;
}

/**
 * One direct predecessor as seen by the context that depends on it. Owned by
 * the persistence schemas: a loop pins these rows as a durable activation-time
 * snapshot, so the row shape is a persisted contract (R9).
 */
export type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/schemas";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Project only captured outputs whose contexts still declare an output
 * contract. Each top-level value is bounded independently, leaving the full
 * payload untouched in `execution.contextOutputs` for addressed retrieval.
 */
export function projectGraphWorkflowResultOutputs(input: {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}): GraphWorkflowResultOutputProjection {
  const byContext: Record<string, Record<string, unknown>> = {};
  const contexts = [...input.execution.workingDefinition.executionContexts]
    .filter((context) => context.outputSchema !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const deepLink = buildGraphWorkflowExecutionDeepLink({
    projectName: input.projectName,
    sessionName: input.sessionName,
    executionId: input.execution.id,
  });

  for (const context of contexts) {
    const captured = input.execution.contextOutputs[context.id];
    if (captured === undefined) continue;
    const values: Record<string, unknown> = {};
    for (const outputName of Object.keys(captured.value).sort()) {
      const value = captured.value[outputName];
      if (jsonByteLength(value) <= GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES) {
        values[outputName] = value;
        continue;
      }
      const reference: GraphWorkflowResultOutputReference = {
        kind: "output_reference",
        executionId: input.execution.id,
        contextId: context.id,
        outputName,
        deepLink,
        command: `cctl workflow result --execution ${shellQuote(input.execution.id)} --context ${shellQuote(context.id)} --output ${shellQuote(outputName)}`,
      };
      values[outputName] = reference;
    }
    byContext[context.id] = values;
  }

  if (Object.keys(byContext).length === 0) {
    return { kind: "no_declared_structured_result" };
  }
  return { kind: "declared_outputs", byContext };
}

/**
 * Are these two `outputSchema` declarations the SAME contract?
 *
 * Identity by value, not by reference or serialized text: the executions
 * repository canonicalizes key order on write, so the same contract read back
 * after a restart stringifies differently. Callers use this to decide whether
 * evidence gathered under one contract (a banked payload, a recorded rejection)
 * still describes the contract a context declares now — a live edit can replace
 * it at any point. Absent on both sides counts as the same "no contract".
 *
 * Isomorphic on purpose (no `node:util` deep-equal): the inspector runs this in
 * the browser.
 */
export function outputSchemasMatch(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  return deepEquals(a ?? null, b ?? null);
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((entry, index) => deepEquals(entry, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEquals(a[key], b[key]),
  );
}

/**
 * The declared top-level properties of an `outputSchema`, in the schema
 * object's own key order. That is NOT necessarily authoring order: the
 * executions repository canonicalizes key order when it serializes the
 * definition, so a schema read back after a restart lists its fields
 * alphabetically. The order is stable across reloads either way, and no caller
 * may treat it as semantic.
 *
 * Returns null for a schema whose root declares no `properties` — the supported
 * subset always describes an object, but a bare `{"type": "object"}` carries no
 * field list to show.
 */
export function describeOutputSchemaFields(
  outputSchema: Record<string, unknown>,
): GraphWorkflowOutputSchemaField[] | null {
  const properties = outputSchema["properties"];
  if (!isRecord(properties)) {
    return null;
  }
  const requiredNames = new Set(
    Array.isArray(outputSchema["required"])
      ? outputSchema["required"].filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );

  return Object.entries(properties).map(([name, declaration]) => {
    const declared = isRecord(declaration) ? declaration : {};
    const type = declared["type"];
    const description = declared["description"];
    return {
      name,
      type: typeof type === "string" ? type : null,
      required: requiredNames.has(name),
      description: typeof description === "string" ? description : null,
    };
  });
}

/** The outline-tier {@link GraphWorkflowOutputSchemaShape} of a declaration. */
export function summarizeOutputSchemaShape(
  outputSchema: Record<string, unknown>,
): GraphWorkflowOutputSchemaShape {
  const type = outputSchema["type"];
  const fields = describeOutputSchemaFields(outputSchema);
  return {
    type: typeof type === "string" ? type : null,
    fieldCount: fields === null ? null : fields.length,
  };
}

/**
 * {@link lookupRawContextOutput} against a running execution's working
 * definition, with the execution-only `skipped` state layered on top.
 */
export function getContextOutput(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowContextOutputLookup {
  if (execution.contextStates[contextId]?.status === "skipped") {
    return { kind: "skipped" };
  }
  return lookupRawContextOutput(
    {
      executionContexts: execution.workingDefinition.executionContexts,
      contextOutputs: execution.contextOutputs,
    },
    contextId,
  );
}

/**
 * Does this context still owe a validated output?
 *
 * The engine's completion invariant (R2): a context that declares an
 * `outputSchema` is NOT finished when its tasks and validators are — it is
 * finished when the declared payload exists. Every place that could otherwise
 * mark such a context `completed`, or treat a passing validator as the end of a
 * failure run, asks this first.
 */
export function contextOwesOutput(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  return getContextOutput(execution, contextId).kind === "pending";
}

/**
 * What `contextId` receives: its DIRECT predecessors only. A transitive
 * ancestor's output reaches a context through the intermediate context that
 * consumed it, so injecting the whole ancestry would both bloat the prompt and
 * blur which contract a context is actually answering.
 *
 * Ordered by the context list (graph order) rather than edge-declaration order,
 * so the sequence a reader sees matches the graph they authored and does not
 * shift when an edge is removed and re-added.
 */
export function resolveDefinitionUpstreamInputs(
  definition: GraphWorkflowUpstreamGraph,
  contextId: string,
): GraphWorkflowUpstreamInput[] {
  const upstreamIds = new Set(
    definition.edges
      .filter((edge) => edge.targetContextId === contextId)
      .map((edge) => edge.sourceContextId),
  );
  if (upstreamIds.size === 0) {
    return [];
  }

  return definition.executionContexts
    .filter((context) => upstreamIds.has(context.id))
    .map((context) => ({
      contextId: context.id,
      title: context.title,
      declared: context.outputSchema !== undefined,
      schemaFields: context.outputSchema
        ? describeOutputSchemaFields(context.outputSchema)
        : null,
      output: null,
      skipped: false,
    }));
}

/**
 * The running-execution view of {@link resolveDefinitionUpstreamInputs}: the
 * same rows in the same order, with each predecessor's banked payload attached.
 *
 * Delegating rather than re-walking is what keeps the Q2 answer single-sourced
 * — prompt injection, the builder inspector and the execution inspector all
 * inherit a scope change from one place.
 */
export function resolveUpstreamInputs(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowUpstreamInput[] {
  // Rows follow the EFFECTIVE source (decision D1). A loop's external edge is
  // satisfied by the CONCLUDING pass's exit instance, and the declared exit is
  // not in `executionContexts` at all once the body has been unrolled — so a
  // walk over the raw authored source would drop the row entirely rather than
  // merely read the wrong payload. Order still comes from the context list, so
  // the sequence a reader sees is the graph order either way.
  const projection = projectExecutionRoutes(execution);
  const sourceIds = new Set<string>();
  for (const edge of incomingRoutes(projection, contextId)) {
    sourceIds.add(edge.effectiveSourceId ?? edge.logicalSourceId);
  }

  const rows = resolveDefinitionUpstreamInputs(
    {
      executionContexts: execution.workingDefinition.executionContexts,
      // A synthetic edge per resolved source: the walk's job here is row
      // identity and order, and the projection has already decided which
      // instance each edge reads.
      edges: Array.from(sourceIds, (sourceContextId) => ({
        sourceContextId,
        targetContextId: contextId,
      })),
    },
    contextId,
  ).map((row) => {
    const lookup = getContextOutput(execution, row.contextId);
    if (lookup.kind === "captured") {
      return { ...row, output: lookup.value };
    }
    return lookup.kind === "skipped" ? { ...row, skipped: true } : row;
  });

  return [...loopBoundaryInputs(execution, contextId), ...rows];
}

/**
 * The loop-boundary snapshot a pass entry receives on top of its ordinary
 * upstream inputs (R9).
 *
 * The incoming boundary edge is retargeted onto pass 1's entry at seed time and
 * NEVER cloned — it is the loop's activation, consumed once — so from pass 2 on
 * the entry's only edge is the prior-exit wiring edge. The activation-time
 * snapshot is what carries the loop's external inputs forward, pinned so every
 * pass reads the same boundary payloads even if the outside world moved on.
 *
 * Pass 1 is deliberately excluded: its boundary edge is still in the graph, so
 * the ordinary walk already produced these rows and prepending them would
 * duplicate every one.
 */
function loopBoundaryInputs(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowUpstreamInput[] {
  const groups = execution.workingDefinition.loopGroups ?? [];
  for (const group of groups) {
    if (!("template" in group)) continue;
    const state = execution.loopStates[group.id];
    if (!state?.boundaryInputs) continue;
    const membership = findLoopBodyMembership(contextId, [group]);
    if (membership === null || membership.pass === null) continue;
    if (membership.pass < 2) continue;
    if (
      contextId !==
      loopInstanceId(group.id, membership.pass, group.entryContextId)
    ) {
      continue;
    }
    return state.boundaryInputs.map((row) => ({ ...row }));
  }
  return [];
}
