/**
 * Lane identity for graph workflows: who a lane belongs to, and how that
 * identity is encoded everywhere a lane is addressed.
 *
 * A context is reviewed by an ordered cohort of validator assignments, so lane
 * KIND alone no longer identifies a lane. This module owns the one encoding
 * every addressing surface shares:
 *  - `laneStateKey` — the `execution.laneStates[contextId]` inner key;
 *  - `graphLaneId` / `parseGraphLaneId` — the primitive-layer lane id the
 *    shared `LaneStore`/`LaneService` stack addresses lanes by;
 *  - `assignmentFingerprint` — what a lane must be rebuilt for.
 *
 * The implementer stays keyed by kind alone: one implementer per context is a
 * standing constraint, so an assignment segment there would encode nothing.
 *
 * Deliberately dependency-free (no `node:crypto`): the fingerprint is a
 * canonical join rather than a digest, so browser-project fixtures and the
 * authoring preview can compute it, and a mismatch names the field that moved
 * instead of two opaque hashes.
 */

import type { GraphWorkflowAgentConfig } from "@/lib/workflow-graph/config-schemas";
import {
  graphWorkflowLaneKindSchema,
  type GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";

const LANE_ID_SEPARATOR = "\u0000";
const ASSIGNMENT_SEPARATOR = ":";

/** Lane kinds whose lanes are per-assignment rather than per-context. */
const ASSIGNMENT_SCOPED_LANES: ReadonlySet<GraphWorkflowLaneKind> = new Set([
  "context_validator",
]);

export interface LaneIdentity {
  lane: GraphWorkflowLaneKind;
  /** Null for lane kinds that are not assignment-scoped (the implementer). */
  assignmentId: string | null;
}

function toLaneKind(value: string): GraphWorkflowLaneKind | null {
  const parsed = graphWorkflowLaneKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The `laneStates[contextId]` inner key: `implementer` or
 * `context_validator:<assignmentId>`.
 *
 * An assignment id is lowercase kebab-case (see `agentAssignmentIdSchema`), so
 * it can never contain the `:` separator and the encoding is unambiguous.
 */
export function laneStateKey(
  lane: GraphWorkflowLaneKind,
  assignmentId?: string,
): string {
  return assignmentId !== undefined && ASSIGNMENT_SCOPED_LANES.has(lane)
    ? `${lane}${ASSIGNMENT_SEPARATOR}${assignmentId}`
    : lane;
}

export function parseLaneStateKey(key: string): LaneIdentity | null {
  const separatorIndex = key.indexOf(ASSIGNMENT_SEPARATOR);
  if (separatorIndex === -1) {
    const lane = toLaneKind(key);
    return lane === null ? null : { lane, assignmentId: null };
  }
  const lane = toLaneKind(key.slice(0, separatorIndex));
  const assignmentId = key.slice(separatorIndex + 1);
  if (lane === null || assignmentId.length === 0) return null;
  return { lane, assignmentId };
}

/**
 * Primitive-layer lane id for a graph lane. The NUL separator cannot occur in a
 * lane kind, a context id, or an assignment id, so the encoding is unambiguous.
 * The assignment is a third segment rather than a widened second one, so a
 * context id containing any printable character stays parseable.
 */
export function graphLaneId(
  lane: GraphWorkflowLaneKind,
  contextId: string,
  assignmentId?: string,
): string {
  const scoped =
    assignmentId !== undefined && ASSIGNMENT_SCOPED_LANES.has(lane);
  return [lane, contextId, ...(scoped ? [assignmentId] : [])].join(
    LANE_ID_SEPARATOR,
  );
}

export function parseGraphLaneId(
  laneId: string,
): (LaneIdentity & { contextId: string }) | null {
  const segments = laneId.split(LANE_ID_SEPARATOR);
  if (segments.length < 2 || segments.length > 3) return null;
  const [laneSegment, contextId, assignmentSegment] = segments;
  const lane = toLaneKind(laneSegment ?? "");
  if (lane === null || !contextId) return null;
  if (assignmentSegment === undefined) {
    return { lane, contextId, assignmentId: null };
  }
  if (assignmentSegment.length === 0) return null;
  return { lane, contextId, assignmentId: assignmentSegment };
}

/**
 * Everything about an assignment that a live lane has already baked in.
 *
 * The delivered profile bytes (`resolvedInstructionHash`) are in it because a
 * lane replays its instructions once, at creation; strategy, continuity, and
 * the runtime triple are in it because each decides which handle the lane
 * holds. The use-site `id` is deliberately NOT: two assignments of one profile
 * differ by lane key, not by fingerprint, and folding the id in would force a
 * rotation on every rename while proving nothing about the delivered bytes.
 */
export interface FingerprintableAssignment {
  profileSnapshot: { resolvedInstructionHash: string };
  agent: GraphWorkflowAgentConfig;
  strategy?: string;
  continuity?: { enabled: boolean; contextLimitTokens?: number };
}

export function assignmentFingerprint(
  assignment: FingerprintableAssignment,
): string {
  return [
    assignment.profileSnapshot.resolvedInstructionHash,
    assignment.strategy ?? "",
    assignment.continuity === undefined
      ? ""
      : String(assignment.continuity.enabled),
    assignment.continuity?.contextLimitTokens ?? "",
    assignment.agent.backend,
    assignment.agent.model,
    assignment.agent.reasoningEffort,
  ].join("|");
}
