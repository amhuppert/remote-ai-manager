/**
 * Geometry types shared by the workflow visualization primitives.
 * Coordinates are in canvas-local pixel space; the MachineCanvas wraps
 * everything in a fixed-pixel container with overflow scroll for mobile.
 */

import type { StateNodeKind, StateStatus } from "../machine-spec-types";

export interface Point {
  x: number;
  y: number;
}

export interface NodeBox {
  /** Top-left x (pixels in canvas space). */
  x: number;
  /** Top-left y. */
  y: number;
  width: number;
  height: number;
}

/** Visual edge between two states. */
export interface EdgeSpec {
  /** Stable id for React keying (e.g. "idle->acquiringResources"). */
  id: string;
  /** Source anchor point. */
  from: Point;
  /** Target anchor point (where the arrowhead lands). */
  to: Point;
  /**
   * Optional second control point for curves. If omitted, a default control
   * point is derived from `from`/`to` and `direction`.
   */
  control?: Point;
  /** Routing style. Defaults to "curve". */
  routing?: "curve" | "straight" | "step" | "loop";
  /**
   * For "curve" / "step" routing: which axis the curve bows along.
   * "h" = bow horizontally (good for vertical-flowing edges),
   * "v" = bow vertically (good for horizontal-flowing edges).
   * Defaults to "h" for vertical edges, "v" for horizontal edges.
   */
  bow?: "h" | "v";
  /** For "loop" routing: bend direction. "right" bends to +x. */
  loopSide?: "left" | "right" | "top" | "bottom";
  /** Event label to display at the midpoint. */
  label?: string;
  /** Guard expression to display under the label, e.g. "[hasRetries]". */
  guard?: string;
  /** Source/target ids for selection highlighting. */
  fromStateId?: string;
  toStateId?: string;
  /** "always" / "onDone" / "onError" → render dashed instead of solid. */
  dashed?: boolean;
  /** Manual override for label position; defaults to path midpoint. */
  labelOffset?: Point;
}

export interface NodeProps {
  id: string;
  label: string;
  kind: StateNodeKind;
  status?: StateStatus;
  /** Top-left in canvas space. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Names shown in the actor pill below the label. */
  invokes?: string[];
  selected?: boolean;
  /** Becomes true when an edge connected to this node is selected. */
  related?: boolean;
  onClick?: (id: string) => void;
}
