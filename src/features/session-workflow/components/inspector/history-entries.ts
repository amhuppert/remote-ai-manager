import type {
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationIncidentEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";

/**
 * The validation-shaped slices of the event log the inspector reads, for the
 * whole run or for one context.
 *
 * Shared by the Overview and by a context's History tab so both read the same
 * definition of "the current attempt": every entry a context reset retired is
 * left out, because the visible history is the attempt running now and nothing
 * in the record tells one attempt's rounds from another's.
 */

/**
 * One logged event lifted out of the stream, carrying where it sat in it.
 *
 * The position travels with the event because the timestamp cannot order the
 * log on its own: consecutive mutations are stamped in the same millisecond
 * often enough that a reader asking "what was in force when this was written"
 * by time alone answers with something written after it.
 */
export type Timestamped<T> = T & { occurredAt: string; logIndex: number };

export interface InspectorHistoryEntries {
  validationEvents: Timestamped<GraphWorkflowValidationResultEvent>[];
  circuitBreakerEvents: Timestamped<GraphWorkflowCircuitBreakerEvent>[];
  incidentEvents: Timestamped<GraphWorkflowValidationIncidentEvent>[];
}

export function getHistoryEntries(
  events: readonly GraphWorkflowExecutionEvent[],
  contextId?: string,
): InspectorHistoryEntries {
  const ofThisContext = (event: { contextId?: string }): boolean =>
    contextId == null || event.contextId === contextId;

  const validationEvents = events
    .flatMap(
      (entry, logIndex): Timestamped<GraphWorkflowValidationResultEvent>[] => {
        const event = entry.event;
        if (event.type !== "graph-workflow-validation-result") return [];
        if (entry.preReset === true) return [];
        if (!ofThisContext(event)) return [];
        return [{ ...event, occurredAt: entry.occurredAt, logIndex }];
      },
    )
    .reverse();
  const circuitBreakerEvents = events
    .flatMap(
      (entry, logIndex): Timestamped<GraphWorkflowCircuitBreakerEvent>[] => {
        const event = entry.event;
        if (event.type !== "graph-workflow-circuit-breaker") return [];
        if (entry.preReset === true) return [];
        if (!ofThisContext(event)) return [];
        return [{ ...event, occurredAt: entry.occurredAt, logIndex }];
      },
    )
    .reverse();
  // Oldest-first, unlike the two above: incidents are read against ONE round,
  // where the order they happened in is the diagnosis.
  const incidentEvents = events.flatMap(
    (entry, logIndex): Timestamped<GraphWorkflowValidationIncidentEvent>[] => {
      const event = entry.event;
      if (event.type !== "graph-workflow-validation-incident") return [];
      if (entry.preReset === true) return [];
      if (!ofThisContext(event)) return [];
      return [{ ...event, occurredAt: entry.occurredAt, logIndex }];
    },
  );

  return { validationEvents, circuitBreakerEvents, incidentEvents };
}
