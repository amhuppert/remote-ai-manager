import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import {
  laneBandAtPoint,
  type LaneBandBox,
} from "@/lib/workflow-graph/lane-band-geometry";
import {
  evaluateLaneDrop,
  type LaneDropEvaluation,
} from "@/lib/workflow-graph/lane-drop";

export interface LaneDragOrigin {
  readonly contextId: string;
  /** The lane the context declared before the drag started. */
  readonly lane: string;
  /** Where the node sat when the drag started, in flow coordinates. */
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

export interface LaneDragInput {
  readonly definition: WorkflowSemanticDefinition;
  /**
   * The bands as they stood when the drag STARTED — the dragged node pinned at
   * its origin — so the band under the pointer cannot chase the node that is
   * being dragged out of it.
   */
  readonly boxes: readonly LaneBandBox[];
  readonly origin: LaneDragOrigin;
  /** The dragged node's live position, in flow coordinates. */
  readonly position: { readonly x: number; readonly y: number };
}

export interface LaneDragHover {
  /** The band being crossed into, or null while the drag stays home. */
  readonly targetLane: string | null;
  /** The verdict on that crossing; null when there is no crossing. */
  readonly evaluation: LaneDropEvaluation | null;
}

export type LaneDragDrop =
  /** Today's behaviour: visual layout only, no semantic edit. */
  | { readonly kind: "layout" }
  | {
      readonly kind: "replace";
      readonly targetLane: string;
      readonly definition: WorkflowSemanticDefinition;
      readonly notice: string | null;
    }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly remedy: string;
    };

/**
 * The band crossing a drag is making, if any (README §2.1).
 *
 * The node's CENTRE decides which band it is over: a card is taller than the
 * gutter between two bands, so its top edge alone would report a crossing the
 * moment the card grazed a neighbour.
 */
function targetLaneOf(input: LaneDragInput): string | null {
  const centre = {
    x: input.position.x + input.origin.size.width / 2,
    y: input.position.y + input.origin.size.height / 2,
  };
  const band = laneBandAtPoint(input.boxes, centre);
  if (band === null || band.laneName === input.origin.lane) return null;
  return band.laneName;
}

export function resolveLaneDragHover(input: LaneDragInput): LaneDragHover {
  const targetLane = targetLaneOf(input);
  if (targetLane === null) return { targetLane: null, evaluation: null };
  return {
    targetLane,
    evaluation: evaluateLaneDrop({
      definition: input.definition,
      contextId: input.origin.contextId,
      targetLane,
    }),
  };
}

/**
 * What the drop does. The check is re-run here rather than trusting the hover
 * verdict: the draft can change under a drag (a sibling edit, a live re-derive),
 * and the write must be gated by the definition it is actually applied to.
 */
/** The card a finished drop leaves behind, matching `LaneDropCallout`'s props. */
export interface LaneDropCalloutContent {
  readonly tone: "red" | "amber";
  readonly title: string;
  readonly message: string;
  readonly footnote: string;
}

const REFUSED_FOOTNOTE =
  "Nothing was written. The definition is still at the same dirty state it had before the drag.";

const ACCEPTED_FOOTNOTE =
  "The placement was written. Only placement.lane changed — the grade and its owned paths carried across.";

/**
 * What the canvas says once the pointer is released, or null when the gesture
 * has nothing to report (README §4).
 *
 * An accepted drop is usually silent — the band moved, which is the feedback —
 * but a placement that is legal and still COSTS something says so at the moment
 * it is made, which is the only moment the author is thinking about it. A
 * refusal always speaks: a pointer gesture that quietly did nothing is the
 * failure this card exists to prevent.
 */
export function laneDropCalloutFor(
  drop: LaneDragDrop,
): LaneDropCalloutContent | null {
  switch (drop.kind) {
    case "layout":
      return null;
    case "replace":
      return drop.notice === null
        ? null
        : {
            tone: "amber",
            title: "Placement accepted",
            message: drop.notice,
            footnote: ACCEPTED_FOOTNOTE,
          };
    case "refused":
      return {
        tone: "red",
        title: "Placement check failed",
        message: `${drop.reason} ${drop.remedy}`,
        footnote: REFUSED_FOOTNOTE,
      };
  }
}

/**
 * The same drop, chosen by lane NAME rather than by where a pointer let go —
 * the touch re-placement path (README §12: "the same validation, the same
 * refusal copy"). A phone has no drag, so the lane picker names its target
 * directly; everything after that naming is this module's one drop model, so
 * the two gestures cannot drift apart on what they accept or what they say.
 */
export function resolveLaneChoiceDrop(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  targetLane: string,
): LaneDragDrop {
  const evaluation = evaluateLaneDrop({ definition, contextId, targetLane });

  switch (evaluation.outcome) {
    case "accepted":
      return {
        kind: "replace",
        targetLane,
        definition: evaluation.definition,
        notice: evaluation.notice,
      };
    case "refused":
      return {
        kind: "refused",
        reason: evaluation.reason,
        remedy: evaluation.remedy,
      };
    case "unchanged":
      return { kind: "layout" };
  }
}

export function resolveLaneDragDrop(input: LaneDragInput): LaneDragDrop {
  const targetLane = targetLaneOf(input);
  if (targetLane === null) return { kind: "layout" };
  return resolveLaneChoiceDrop(
    input.definition,
    input.origin.contextId,
    targetLane,
  );
}
