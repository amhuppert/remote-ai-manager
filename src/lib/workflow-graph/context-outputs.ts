/**
 * Read side of per-context structured outputs (D2, decision D6).
 *
 * One accessor answers "what did this context produce" and one resolver answers
 * "what does this context receive". Prompt injection, the builder/inspector UI,
 * and — later — D4 conditional edges all read through here rather than reaching
 * into `execution.contextOutputs` and `workingDefinition.edges` themselves, so
 * "an output exists" has exactly one definition.
 *
 * Pure and dependency-free: every input is already on the execution.
 */

import type {
  GraphWorkflowContextOutput,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";

/**
 * Four states, not two. A context that never declared an `outputSchema` has no
 * output *by design*, which is categorically different from one that owes an
 * output and has not produced it yet; collapsing those would make a downstream
 * reader treat a free-form upstream as a run still in flight.
 *
 * `orphaned` is the fourth: a payload is banked but the current definition
 * declares no contract for it, because a live edit cleared the schema after the
 * capture. It is deliberately NOT `captured` — the payload satisfies nothing the
 * definition now says, so a "Captured" chip, a filled node glyph, or an injected
 * upstream input would each be a claim about a contract that no longer exists.
 * It is deliberately not `none` either: the payload is still readable evidence
 * (the CLI outline reports it), and dropping it would lose an operator's record
 * of what the context produced.
 */
export type GraphWorkflowContextOutputLookup =
  | {
      kind: "captured";
      /** The validated payload — the common case a reader wants. */
      value: Record<string, unknown>;
      /** The full record, for capture provenance (when, which iteration, how). */
      output: GraphWorkflowContextOutput;
    }
  | { kind: "pending"; outputSchema: Record<string, unknown> }
  | { kind: "orphaned"; output: GraphWorkflowContextOutput }
  | { kind: "none" };

/** One top-level property of a declared `outputSchema`. */
export interface GraphWorkflowOutputSchemaField {
  name: string;
  /** The declared `type`, or null when the declaration omits one. */
  type: string | null;
  required: boolean;
  description: string | null;
}

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

/** One direct predecessor as seen by the context that depends on it. */
export interface GraphWorkflowUpstreamInput {
  contextId: string;
  title: string;
  /**
   * Whether the predecessor declares an `outputSchema` at all.
   *
   * Carried separately from `schemaFields` because a valid declaration need not
   * have a field list: a bare `{"type": "object"}` and a root `oneOf` both
   * constrain the payload while naming no top-level properties. Reading
   * "declared" off `schemaFields !== null` would report those contexts as
   * free-form, which is the opposite of what they are.
   */
  declared: boolean;
  /** The declared top-level fields; null when the declaration names none. */
  schemaFields: GraphWorkflowOutputSchemaField[] | null;
  /** null when nothing is banked — free-form, or declared but not yet produced. */
  output: Record<string, unknown> | null;
}

function findContext(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowResolvedContext | undefined {
  return execution.workingDefinition.executionContexts.find(
    (context) => context.id === contextId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * What `contextId` produced. An unknown context id reports `none` rather than
 * throwing: callers ask about ids drawn from live-edited definitions and edge
 * lists, and a removed context is legitimately "no output", not a programming
 * error.
 *
 * The CURRENT declaration decides: a banked payload with no declaration behind
 * it is `orphaned`, never `captured`. A live edit can clear or replace a
 * context's `outputSchema` after a payload was banked (`runtime-edits.ts`
 * reconciles the row at that choke point), and this accessor is the one
 * definition of "an output exists", so the distinction is made here rather than
 * in each reader.
 */
export function getContextOutput(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowContextOutputLookup {
  const outputSchema = findContext(execution, contextId)?.outputSchema;
  const output = execution.contextOutputs[contextId];
  if (outputSchema === undefined) {
    return output ? { kind: "orphaned", output } : { kind: "none" };
  }
  if (output) {
    return { kind: "captured", value: output.value, output };
  }
  return { kind: "pending", outputSchema };
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
  return resolveDefinitionUpstreamInputs(
    execution.workingDefinition,
    contextId,
  ).map((row) => {
    const lookup = getContextOutput(execution, row.contextId);
    return lookup.kind === "captured" ? { ...row, output: lookup.value } : row;
  });
}
