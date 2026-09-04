/**
 * Planning-phase telemetry for graph-plan writes (#80 design 3.10).
 *
 * The retrospective that motivated this design could count planning cost only
 * by tallying tool calls in a transcript. These builders turn each refusal and
 * each server-owned merge into a catalogued structured event, so the next
 * retrospective reads `refusals by code per conversation` out of the log.
 *
 * Every builder is pure: it takes what the route already knows and returns the
 * `{ event, fields }` pair the caller hands to its own logger. Nothing here
 * opens a server, a database, or a logger, so the field contract is unit
 * testable, and no builder is given plan prose, prompt content or a token —
 * ids, codes and counts only. The one non-builder, `callerConversationId`,
 * reads a request header and the ambient trace, and is testable the same way.
 */

import { getTraceContext } from "@/lib/logging";

/** One structured log line: the event name and the fields it carries. */
export interface PlanningTelemetryEvent {
  readonly event: string;
  readonly fields: Readonly<
    Record<string, string | number | readonly string[] | null>
  >;
}

/** The header a `cctl` shell running inside a conversation stamps on a write. */
export const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

/**
 * The conversation a plan write came from.
 *
 * The graph-workflow write routes take no `conversationId` path segment, so
 * the ambient trace context — which derives one from route params — has none
 * to offer them: an agent's identity reaches these routes only on the header
 * its CLI sends. The trace is still consulted second, so a conversation-scoped
 * route needs no separate reader, and `null` is returned for a caller that has
 * no conversation at all (the browser).
 */
export function callerConversationId(request: Request): string | null {
  const header = request.headers.get(CALLER_CONVERSATION_HEADER)?.trim();
  if (header) return header;
  return getTraceContext()?.conversationId ?? null;
}

export const WORKFLOW_VALIDATE_REFUSED_EVENT = "workflow.validate.refused";
export const WORKFLOW_REPLACE_SERVER_FIELDS_MERGED_EVENT =
  "workflow.replace.server_fields_merged";

/** A refused plan issue, reduced to the two ids telemetry may carry. */
export interface RefusedPlanIssue {
  readonly code: string;
  readonly recordId?: string | undefined;
}

export interface WorkflowValidateRefusedInput {
  readonly issues: readonly RefusedPlanIssue[];
  readonly definitionId?: string | null | undefined;
  /**
   * Required, and emitted even when null. The retrospective this event exists
   * for groups friction by the conversation that met it, so a shape allowed to
   * omit the key would silently drop the callers being counted.
   */
  readonly conversationId: string | null;
}

/**
 * One event per distinct issue code in a refusal. Counted per code rather than
 * per issue because the question the telemetry answers is "which rules cost
 * the planner time", and a rule that refuses ten records is one rule the
 * planner had to learn. The record kept is the first the code named, so a
 * counted code still points at somewhere in the plan to look.
 */
export function workflowValidateRefusedEvents(
  input: WorkflowValidateRefusedInput,
): PlanningTelemetryEvent[] {
  const byCode = new Map<string, string | undefined>();
  for (const issue of input.issues) {
    const seen = byCode.get(issue.code);
    if (byCode.has(issue.code) && seen !== undefined) continue;
    byCode.set(issue.code, seen ?? issue.recordId);
  }
  return [...byCode].map(([code, recordId]) => ({
    event: WORKFLOW_VALIDATE_REFUSED_EVENT,
    fields: {
      code,
      ...(recordId === undefined ? {} : { recordId }),
      ...(input.definitionId ? { definitionId: input.definitionId } : {}),
      conversationId: input.conversationId,
    },
  }));
}

export interface WorkflowReplaceServerFieldsMergedInput {
  readonly definitionId: string;
  readonly fields: readonly string[];
  /** Required and always emitted, for the reason stated on the refusal input. */
  readonly conversationId: string | null;
}

/**
 * Null when the merge filled nothing: a plan that already carried the
 * server-owned fields cost the planner nothing, and an event for it would
 * inflate the very count the retrospective reads.
 */
export function workflowReplaceServerFieldsMergedEvent(
  input: WorkflowReplaceServerFieldsMergedInput,
): PlanningTelemetryEvent | null {
  if (input.fields.length === 0) return null;
  return {
    event: WORKFLOW_REPLACE_SERVER_FIELDS_MERGED_EVENT,
    fields: {
      definitionId: input.definitionId,
      fields: [...input.fields],
      conversationId: input.conversationId,
    },
  };
}
