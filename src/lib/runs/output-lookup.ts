/**
 * The RAW four-state read of "what did this context produce" (D2, decision D6),
 * with no imports at all.
 *
 * It was extracted out of `context-outputs.ts` for D4: the route projection
 * evaluates edge guards against this read, and the projection has to stay
 * browser-safe and free of the execution shape so the graph page and the CLI
 * outline can derive the same routing verdicts the scheduler does. Layered
 * accessors build on it — `context-outputs.ts` binds it to a running execution
 * and is where later states that depend on engine lifecycle (a skipped source)
 * are added; nothing layered belongs here.
 *
 * Generic in the output record so this module needs no schema import: any record
 * carrying the validated `value` satisfies it, and callers get their own precise
 * type back.
 */

/** The parts of a context this read looks at: does it declare a contract? */
export interface OutputDeclaringContext {
  readonly id: string;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

/**
 * Read structurally rather than as an execution: the authored definition, a
 * running execution's `workingDefinition`, and a loop pass's cloned subgraph are
 * all the same shape here.
 */
export interface RawOutputLookupSource<TOutput> {
  readonly executionContexts: readonly OutputDeclaringContext[];
  readonly contextOutputs: Readonly<Record<string, TOutput | undefined>>;
}

/**
 * Four states, not two. A context that never declared an `outputSchema` has no
 * output *by design*, which is categorically different from one that owes an
 * output and has not produced it yet; collapsing those would make a downstream
 * reader treat a free-form upstream as a run still in flight.
 *
 * `orphaned` is the fourth: a payload is banked but the current definition
 * declares no contract for it, because a live edit cleared the schema after the
 * capture. It is deliberately NOT `captured` — the payload satisfies nothing the
 * definition now says, so a "Captured" chip, a filled node glyph, an injected
 * upstream input, or an activated guard would each be a claim about a contract
 * that no longer exists. It is deliberately not `none` either: the payload is
 * still readable evidence (the CLI outline reports it), and dropping it would
 * lose an operator's record of what the context produced.
 */
export type RawContextOutputLookup<TOutput> =
  | {
      kind: "captured";
      /** The validated payload — the common case a reader wants. */
      value: Record<string, unknown>;
      /** The full record, for capture provenance (when, which iteration, how). */
      output: TOutput;
    }
  | { kind: "pending"; outputSchema: Record<string, unknown> }
  | { kind: "orphaned"; output: TOutput }
  | { kind: "none" };

function ownOutput<TOutput>(
  outputs: Readonly<Record<string, TOutput | undefined>>,
  contextId: string,
): TOutput | undefined {
  // OWN property, not plain indexing: context ids reach this read from edge
  // lists and live-edited definitions, so `constructor` or `toString` would
  // otherwise resolve to an `Object.prototype` member and be reported as a
  // banked payload. A guard evaluating against that is a routing decision made
  // on a payload no context ever produced.
  return Object.prototype.hasOwnProperty.call(outputs, contextId)
    ? outputs[contextId]
    : undefined;
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
 * reconciles the row at that choke point), and this is the one definition of
 * "an output exists", so the distinction is made here rather than in each
 * reader.
 */
export function lookupRawContextOutput<
  TOutput extends { value: Record<string, unknown> },
>(
  source: RawOutputLookupSource<TOutput>,
  contextId: string,
): RawContextOutputLookup<TOutput> {
  const outputSchema = source.executionContexts.find(
    (context) => context.id === contextId,
  )?.outputSchema;
  const output = ownOutput(source.contextOutputs, contextId);

  if (outputSchema === undefined) {
    return output ? { kind: "orphaned", output } : { kind: "none" };
  }
  if (output) {
    return { kind: "captured", value: output.value, output };
  }
  return { kind: "pending", outputSchema };
}
