import { z } from "zod";
import { graphWorkflowContextStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import { graphWorkflowStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The three observational-equivalence projections named by R14 / decision D14,
 * plus the normalization that makes two runs comparable.
 *
 * A projection is deliberately COARSE: it keeps the decisions and orderings D4
 * could change (which contexts became eligible and were dispatched, how each
 * context's status moved, which typed events fired in what order) and drops
 * everything a run is free to vary (wall-clock stamps, minted identifiers,
 * prose). That is what makes "identical modulo timestamps and generated
 * identifiers" a mechanical check rather than a judgement call.
 *
 * Test-support only; not imported by production code.
 */

const schedulingEligibilitySchema = z.object({
  decision: z.literal("eligible"),
  /** The eligibility set at this commit, in definition order. */
  contextIds: z.array(z.string()),
});

const schedulingDispatchSchema = z.object({
  decision: z.literal("scheduled"),
  outcome: z.enum(["none", "solo", "parallel"]),
  contextIds: z.array(z.string()),
});

const schedulingIterationSchema = z.object({
  decision: z.literal("dispatched"),
  contextId: z.string(),
  iteration: z.number().int().min(1),
});

const schedulingJoinSchema = z.object({
  decision: z.literal("join"),
  joinKind: z.string(),
  contextId: z.string().nullable(),
  sourceLaneIds: z.array(z.string()),
  targetLaneId: z.string(),
});

export const schedulingDecisionSchema = z.discriminatedUnion("decision", [
  schedulingEligibilitySchema,
  schedulingDispatchSchema,
  schedulingIterationSchema,
  schedulingJoinSchema,
]);
export type SchedulingDecision = z.infer<typeof schedulingDecisionSchema>;

/**
 * One observable context-status move. `from: null` marks a context observed for
 * the first time — the shape a runtime-materialized context (a loop-pass clone
 * or an expansion-added node) takes, so a pre-D4 recording pins that none
 * appears mid-run.
 */
export const contextStatusTransitionSchema = z.object({
  contextId: z.string(),
  from: graphWorkflowContextStatusSchema.nullable(),
  to: graphWorkflowContextStatusSchema,
});
export type ContextStatusTransition = z.infer<
  typeof contextStatusTransitionSchema
>;

export const typedEventRecordSchema = z.object({
  kind: z.string(),
  /** The entity the event is about (context, task, lane, join, batch). */
  subject: z.string().nullable(),
  /** The event's own discriminator — status, verdict, or outcome. */
  detail: z.string().nullable(),
});
export type TypedEventRecord = z.infer<typeof typedEventRecordSchema>;

export const compatibilityRecordingSchema = z.object({
  scenario: z.string(),
  terminalStatus: graphWorkflowStatusSchema,
  haltReason: z.string().nullable(),
  scheduling: z.array(schedulingDecisionSchema),
  statusTransitions: z.array(contextStatusTransitionSchema),
  events: z.array(typedEventRecordSchema),
});
export type CompatibilityRecording = z.infer<
  typeof compatibilityRecordingSchema
>;

/**
 * Context-status moves observable between two COMMITTED execution snapshots.
 * Intra-reducer intermediate states are deliberately invisible: a mutation
 * commits atomically, so no observer of the persisted execution can see them.
 * Contexts are visited in id order so a commit touching several stays stable.
 */
export function diffContextStatuses(
  previous: GraphWorkflowExecution | null,
  next: GraphWorkflowExecution,
): ContextStatusTransition[] {
  const transitions: ContextStatusTransition[] = [];
  for (const contextId of Object.keys(next.contextStates).sort()) {
    const to = next.contextStates[contextId]?.status;
    if (to === undefined) continue;
    const from = previous?.contextStates[contextId]?.status ?? null;
    if (from === to) continue;
    transitions.push({ contextId, from, to });
  }
  return transitions;
}

/**
 * Reduce a typed SSE event to its kind plus the two fields that make the kind
 * legible. The switch is exhaustive over the discriminated union on purpose: a
 * new D4 event kind fails to compile here until it is projected, so a recording
 * can never silently omit one.
 */
export function projectTypedEvent(
  event: GraphWorkflowSSEEvent,
): TypedEventRecord {
  switch (event.type) {
    case "graph-workflow-status":
      return { kind: event.type, subject: null, detail: event.workflowStatus };
    case "graph-workflow-context-status":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.status,
      };
    case "graph-workflow-context-skipped":
      return {
        kind: event.type,
        subject: event.contextId,
        // The verdict set IS the decision; a bare "skipped" would make two runs
        // that skipped the same context for different reasons look identical.
        detail: event.edgeEvaluations
          .map((evaluation) => `${evaluation.edgeId}:${evaluation.verdict}`)
          .join(","),
      };
    case "graph-workflow-route-resolved":
      return {
        kind: event.type,
        subject: event.sourceContextId,
        // The activated set IS the decision, and the control revision is what
        // distinguishes a re-decision of the same capture from a first one.
        detail: `r${event.routeControlRevision}:${event.activatedEdgeIds.join("|")}`,
      };
    case "graph-workflow-task-status":
      return { kind: event.type, subject: event.taskId, detail: event.status };
    case "graph-workflow-validation-result":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.pass ? "pass" : "fail",
      };
    case "graph-workflow-validation-specialist-result":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: `${event.roundSeq}:${event.specialist.assignmentId}:${event.specialist.pass ? "pass" : "fail"}`,
      };
    case "graph-workflow-validation-incident":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: `${event.roundSeq}:${event.incident}`,
      };
    case "graph-workflow-circuit-breaker":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.condition,
      };
    case "graph-workflow-shared-documents-updated":
      return {
        kind: event.type,
        subject: null,
        detail: String(event.documents.length),
      };
    case "graph-workflow-pending-halt-reason":
      return {
        kind: event.type,
        subject: null,
        detail: event.pendingHaltReason?.type ?? null,
      };
    case "graph-workflow-merge-status":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.mergeStatus,
      };
    case "graph-workflow-batch-scheduled":
      return {
        kind: event.type,
        subject: event.batchId,
        detail: event.contextIds.join(","),
      };
    case "graph-workflow-lane-status":
      return { kind: event.type, subject: event.laneId, detail: event.status };
    case "graph-workflow-lane-created":
      return {
        kind: event.type,
        subject: event.laneId,
        detail: `${event.kind}:${event.placementSource}`,
      };
    case "graph-workflow-lane-concurrent-admission":
      return {
        kind: event.type,
        subject: event.laneId,
        detail: `${event.canonicalCheckResult}:${event.memberContextIds.join(",")}`,
      };
    case "graph-workflow-lane-landed":
      return {
        kind: event.type,
        subject: event.laneId,
        detail: `${event.contextId}:${event.commitSha ?? "no-commit"}`,
      };
    case "graph-workflow-lane-drift-halted":
      return {
        kind: event.type,
        subject: event.laneId,
        detail: `${event.contextId}:${event.unattributedPaths.join(",")}`,
      };
    case "graph-workflow-lane-commit":
      return {
        kind: event.type,
        subject: event.laneId,
        detail: event.contextId,
      };
    case "graph-workflow-join-status":
      return {
        kind: event.type,
        subject: event.joinId,
        detail: `${event.kind}:${event.status}`,
      };
    case "graph-workflow-approval-pending":
      return { kind: event.type, subject: event.contextId, detail: null };
    case "graph-workflow-approval-resolved":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.decision,
      };
    case "graph-workflow-user-input-pending":
      return { kind: event.type, subject: event.contextId, detail: null };
    case "graph-workflow-user-input-resolved":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.resolution,
      };
    case "graph-workflow-charter-registered":
      return { kind: event.type, subject: event.definitionId, detail: null };
    case "graph-workflow-charter-updated":
      return { kind: event.type, subject: event.definitionId, detail: null };
    case "graph-workflow-live-edit-applied":
      return { kind: event.type, subject: null, detail: event.source };
    case "graph-workflow-graph-expanded":
      return {
        kind: event.type,
        subject: event.invokerContextId,
        // The verdict IS the decision; a refusal's code distinguishes two
        // refusals of the same request that a bare "refused" would flatten.
        detail: `${event.outcome}${
          event.refusalCode === null ? "" : `:${event.refusalCode}`
        }`,
      };
    case "graph-workflow-plan-repair":
      return {
        kind: event.type,
        subject: event.contextId,
        detail: event.outcome,
      };
    case "graph-workflow-loop-decision":
      return {
        kind: event.type,
        subject: `${event.loopGroupId}#${event.pass}`,
        // The control revision is what distinguishes a re-decision of the same
        // pass from its first decision, exactly as it does for routes.
        detail: `r${event.loopControlRevision}:${event.verdict}:${event.outcome}`,
      };
    default: {
      const unprojected: never = event;
      throw new Error(
        `Unprojected graph-workflow event kind: ${JSON.stringify(unprojected)}`,
      );
    }
  }
}

const ISO_TIMESTAMP_PATTERN =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})/g;
const UUID_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * "Modulo timestamps and generated identifiers": timestamps collapse to one
 * token, and each distinct generated id maps to an ordinal token in
 * first-appearance order. Ordinal renaming — not erasure — is what keeps the
 * check sharp: identity relationships and counts survive, so an extra minted
 * lane or batch still breaks the recording while a differing UUID does not.
 */
export function createVolatileValueNormalizer(): (value: string) => string {
  const generatedIds = new Map<string, string>();
  return (value) =>
    value
      .replace(ISO_TIMESTAMP_PATTERN, "<timestamp>")
      .replace(UUID_PATTERN, (match) => {
        const existing = generatedIds.get(match);
        if (existing !== undefined) return existing;
        const token = `<generated-${generatedIds.size + 1}>`;
        generatedIds.set(match, token);
        return token;
      });
}

export function normalizeRecording(
  recording: CompatibilityRecording,
): CompatibilityRecording {
  const normalize = createVolatileValueNormalizer();
  const normalizeNullable = (value: string | null): string | null =>
    value === null ? null : normalize(value);

  return {
    scenario: recording.scenario,
    terminalStatus: recording.terminalStatus,
    haltReason: recording.haltReason,
    scheduling: recording.scheduling.map((decision) => {
      switch (decision.decision) {
        case "eligible":
        case "scheduled":
          return {
            ...decision,
            contextIds: decision.contextIds.map(normalize),
          };
        case "dispatched":
          return { ...decision, contextId: normalize(decision.contextId) };
        case "join":
          return {
            ...decision,
            contextId: normalizeNullable(decision.contextId),
            sourceLaneIds: decision.sourceLaneIds.map(normalize),
            targetLaneId: normalize(decision.targetLaneId),
          };
      }
    }),
    statusTransitions: recording.statusTransitions.map((transition) => ({
      ...transition,
      contextId: normalize(transition.contextId),
    })),
    events: recording.events.map((event) => ({
      kind: event.kind,
      subject: normalizeNullable(event.subject),
      detail: normalizeNullable(event.detail),
    })),
  };
}
