/**
 * Evidence for an `output_schema_validation` breaker trip (D2, decision D4).
 *
 * The halt reason itself carries only what every breaker trip carries — the
 * context, the failure count, a summary line. The material an operator needs to
 * act on this particular trip lives elsewhere by design: the refused payload and
 * its path-keyed issues stay in the validation-failure record (a rejected
 * candidate must never reach `contextOutputs`), and the contract that refused it
 * lives on the context. This module is the one place that reassembles the three,
 * so the halt card and the halt-details dialog cannot disagree about what
 * failed.
 *
 * Returns `null` for every other halt, which is what keeps the extra chrome off
 * the surfaces that render ordinary halts.
 */

import { resolveConsecutiveFailureThreshold } from "@/lib/workflow-graph/constants";
import { outputSchemasMatch } from "@/lib/workflow-graph/context-outputs";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";

export type TimestampedValidationResult = GraphWorkflowValidationResultEvent & {
  occurredAt: string;
};

/**
 * Validation results from an execution's event history, newest first.
 *
 * `preReset` entries are excluded: a context that was reset re-ran its work, so
 * a rejection from before the reset describes a payload no longer in play.
 */
export function collectValidationResults(
  events: ReadonlyArray<GraphWorkflowExecutionEvent>,
): TimestampedValidationResult[] {
  const results: TimestampedValidationResult[] = [];
  for (const entry of events) {
    if (
      entry.event.type !== "graph-workflow-validation-result" ||
      entry.preReset === true
    ) {
      continue;
    }
    results.push({ ...entry.event, occurredAt: entry.occurredAt });
  }
  return results.reverse();
}

/** One refused instance path and what was wrong at it. */
export interface OutputSchemaHaltIssue {
  /** JSON-Pointer-style instance path; absent on a pre-`path` record. */
  path?: string;
  title: string;
  description?: string;
}

export interface OutputSchemaHaltEvidence {
  contextId: string;
  /** Empty when the failure record has aged out of the event window. */
  issues: OutputSchemaHaltIssue[];
  /** The refused text verbatim (already bounded at capture time). */
  rejectedOutput: string | null;
  /**
   * The contract that REFUSED this payload — the snapshot taken at rejection
   * time, not whatever the context declares now.
   */
  declaredSchema: Record<string, unknown> | null;
  /**
   * True when the context's contract has changed since the rejection (the Edit
   * schema action on these surfaces does exactly that). The schema above is
   * then history, and the surface says so rather than presenting it as the
   * current declaration.
   */
  schemaEditedSinceRejection: boolean;
  /**
   * True only when the contract that refused is PROVABLY still the one the
   * context declares — a snapshot was recorded and it still matches. Resume
   * restarts the refused turn against the live contract, so this is what a
   * surface offering Resume has to read; `schemaEditedSinceRejection` cannot
   * answer it, because its `false` also covers "no snapshot exists, so nothing
   * can be compared", and blocking on that would strand a run forever.
   */
  contractUnchangedSinceRejection: boolean;
  /** Consecutive capture failures that tripped the breaker. */
  failureCount: number | null;
  breakerThreshold: number | null;
  iteration: number | null;
  maxIterations: number | null;
  /**
   * The structured-output gate's own bounded repair on the refused turn: turns
   * spent, and the budget in force. `null` when no repair turn ran or the
   * record predates the fields — the chip's presence is the signal that the
   * gate re-asked at all.
   *
   * Deliberately NOT D1's `execution.planRepairRounds`: that agent repairs the
   * PLAN after a halt, so a round from it describes neither this rejection nor
   * this turn, and reporting it here would attribute an unrelated later repair
   * to the refusal.
   */
  gateRepairAttempts: number | null;
  gateRepairBudget: number | null;
}

export function deriveOutputSchemaHaltEvidence(input: {
  execution: GraphWorkflowExecution;
  haltReason: GraphWorkflowHaltReason | null | undefined;
  /** Validation results, newest first; filtered here to the halted context. */
  validationEvents: ReadonlyArray<TimestampedValidationResult>;
}): OutputSchemaHaltEvidence | null {
  const { execution, haltReason, validationEvents } = input;
  if (
    haltReason == null ||
    haltReason.type !== "circuit_breaker" ||
    haltReason.condition !== "output_schema_validation"
  ) {
    return null;
  }

  const contextId = haltReason.contextId;
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  const rejection = validationEvents.find(
    (event) =>
      event.kind === "output_schema" &&
      !event.pass &&
      event.contextId === contextId,
  );
  const contextState = execution.contextStates[contextId];
  const gateRepairAttempts = rejection?.gateRepairAttempts ?? null;
  const rejectedAgainstSchema = rejection?.rejectedAgainstSchema ?? null;

  return {
    contextId,
    issues: (rejection?.issues ?? []).map((issue) => ({
      ...(issue.path !== undefined ? { path: issue.path } : {}),
      title: issue.title,
      ...(issue.description !== undefined
        ? { description: issue.description }
        : {}),
    })),
    rejectedOutput: rejection?.rejectedOutput ?? null,
    // The contract that REFUSED, not the one the context declares now: the
    // Edit-schema action on these very surfaces can replace it while the halt
    // is open. Older records carry no snapshot, so those fall back to the
    // context's contract — which is what refused them.
    declaredSchema: rejectedAgainstSchema ?? context?.outputSchema ?? null,
    // A record with no snapshot cannot have been measured against anything but
    // the context's own contract, so it is never reported as edited.
    schemaEditedSinceRejection:
      rejectedAgainstSchema !== null &&
      !outputSchemasMatch(rejectedAgainstSchema, context?.outputSchema),
    contractUnchangedSinceRejection:
      rejectedAgainstSchema !== null &&
      outputSchemasMatch(rejectedAgainstSchema, context?.outputSchema),
    failureCount: haltReason.failureCount ?? null,
    breakerThreshold:
      context === undefined
        ? null
        : resolveConsecutiveFailureThreshold(context.circuitBreaker),
    iteration: contextState?.iterationCount ?? null,
    maxIterations: context?.iterationPolicy.maxIterations ?? null,
    // A gate that refused the first answer outright reports 0 attempts, which
    // is "no repair ran" — the chip would be noise, so it is not offered.
    gateRepairAttempts:
      gateRepairAttempts !== null && gateRepairAttempts > 0
        ? gateRepairAttempts
        : null,
    gateRepairBudget: rejection?.gateRepairBudget ?? null,
  };
}

/** Evidence keyed by the context whose contract refused, for a set of reasons. */
export type OutputSchemaHaltEvidenceByContext = Record<
  string,
  OutputSchemaHaltEvidence
>;

/**
 * The evidence a single halt reason should render with, or undefined when that
 * reason is not an output-schema trip.
 *
 * Hosts hold one record for the whole halt and every rendering site — primary,
 * each secondary, each action — resolves through here, so "is this the schema
 * variant" is decided once instead of at each site.
 */
export function outputSchemaEvidenceForReason(
  byContext: OutputSchemaHaltEvidenceByContext | null | undefined,
  reason: GraphWorkflowHaltReason,
): OutputSchemaHaltEvidence | undefined {
  if (
    byContext == null ||
    reason.type !== "circuit_breaker" ||
    reason.condition !== "output_schema_validation"
  ) {
    return undefined;
  }
  return byContext[reason.contextId];
}

/**
 * The same evidence for EVERY output-schema trip among a set of halt reasons,
 * keyed by context.
 *
 * A halted execution surfaces one primary reason and any number of secondary
 * ones, and an output-schema trip can land in either slot — a second context
 * failing its contract concurrently is stored as secondary. Hosts render the
 * whole set, so they resolve evidence per reason from this record rather than
 * holding evidence for the primary alone (which would silently degrade a
 * secondary trip to a paths-less summary).
 */
export function deriveOutputSchemaHaltEvidenceByContext(input: {
  execution: GraphWorkflowExecution;
  haltReasons: ReadonlyArray<GraphWorkflowHaltReason | null | undefined>;
  /** All contexts' validation results, newest first; each derivation filters. */
  validationEvents: ReadonlyArray<TimestampedValidationResult>;
}): OutputSchemaHaltEvidenceByContext {
  const byContext: OutputSchemaHaltEvidenceByContext = {};
  for (const haltReason of input.haltReasons) {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: input.execution,
      haltReason,
      validationEvents: input.validationEvents,
    });
    if (evidence !== null) {
      byContext[evidence.contextId] = evidence;
    }
  }
  return byContext;
}
