import type { LaneBand } from "./lane-bands";

/**
 * Lane band geometry — where the band surfaces sit behind the nodes.
 *
 * Boxes are derived from where the nodes actually are rather than from the
 * layout that generated them, so a hand-dragged node keeps its band wrapped
 * around it and an explicit `nodePositions` override needs no special case.
 * Numbers are the design bundle's band geometry (`Workflow Builder.dc.html` B1,
 * `Workflow Execution.dc.html` E1) in flow coordinates.
 */

/** The fixed header column on the left of every band. */
export const LANE_BAND_HEADER_WIDTH = 180;
/** Gutter between the header column and the first node in the band. */
export const LANE_BAND_HEADER_GAP = 16;
/** How far a band's first node sits from the band's left edge. */
export const LANE_BAND_CONTENT_OFFSET_X =
  LANE_BAND_HEADER_WIDTH + LANE_BAND_HEADER_GAP;
export const LANE_BAND_PADDING_Y = 22;
export const LANE_BAND_PADDING_X = 24;
/** Enough band for the execution header's six lines to breathe. */
export const LANE_BAND_MIN_HEIGHT = 132;
/** Vertical gutter between two stacked bands. */
export const LANE_BAND_GAP = 12;

/**
 * Fit-to-view padding for both canvases.
 *
 * `fitView` frames the NODES, but every band's header column sits
 * {@link LANE_BAND_CONTENT_OFFSET_X} to the LEFT of the leftmost node. A
 * proportional padding is only wide enough to clear it when the graph is wide
 * enough to make the fit width-constrained; a compact graph fits on height
 * instead, leaves less horizontal slack than the header needs, and the lane
 * names are cut off by the viewport edge. Pinning the left side in pixels is
 * what makes the fit frame the band rather than just the cards.
 */
export const CANVAS_FIT_VIEW_PADDING = {
  top: "10%",
  right: "10%",
  bottom: "10%",
  left: `${LANE_BAND_CONTENT_OFFSET_X + LANE_BAND_PADDING_X}px`,
} as const;

export interface LaneBandNodeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneBandBox {
  laneName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a statement ABOUT a lane hangs — the publication pill, the join card.
 *
 * Both describe a merge INTO a lane, and that lane is usually the reserved
 * session lane, which exists to RECEIVE the merge and ordinarily holds no
 * context of its own — so it contributes no node and {@link computeLaneBandBoxes}
 * drops its band. Neither statement may vanish with the band: they are facts
 * about the run, not decoration on a surface. So they fall back to the bottom
 * of the stack, which is where the empty target lane would have sat, and name
 * their own lane in their own text.
 */
export function resolveLaneStatementAnchor(
  boxes: readonly LaneBandBox[],
  targetLaneName: string,
): LaneBandBox | null {
  const target = boxes.find((box) => box.laneName === targetLaneName);
  if (target !== undefined) return target;

  return boxes.reduce<LaneBandBox | null>(
    (lowest, box) =>
      lowest === null || box.y + box.height > lowest.y + lowest.height
        ? box
        : lowest,
    null,
  );
}

/**
 * The band a point in flow coordinates is over, or null between bands.
 *
 * Vertical containment decides it: bands stack as one column and read as
 * full-width stripes, so a node dragged past the widest row is still hovering
 * the lane it looks like it is in. The left edge is honoured because the header
 * column is where the band visibly starts.
 */
export function laneBandAtPoint(
  boxes: readonly LaneBandBox[],
  point: { x: number; y: number },
): LaneBandBox | null {
  return (
    boxes.find(
      (box) =>
        point.x >= box.x && point.y >= box.y && point.y <= box.y + box.height,
    ) ?? null
  );
}

export function computeLaneBandBoxes(
  bands: readonly LaneBand[],
  nodeBoxes: readonly LaneBandNodeBox[],
): LaneBandBox[] {
  const boxById = new Map(nodeBoxes.map((box) => [box.id, box]));

  const membersByBand = bands.map((band) =>
    band.memberContextIds.flatMap((contextId) => {
      const box = boxById.get(contextId);
      return box ? [box] : [];
    }),
  );

  // Only banded nodes decide the shared column: an orphan node — one whose
  // context declares no placement — must not stretch every band to reach it.
  const banded = membersByBand.flat();
  if (banded.length === 0) return [];

  const contentLeft = Math.min(...banded.map((box) => box.x));
  const contentRight = Math.max(...banded.map((box) => box.x + box.width));
  const x = contentLeft - LANE_BAND_CONTENT_OFFSET_X;
  const width = contentRight + LANE_BAND_PADDING_X - x;

  const placed = bands.map((band, index) => {
    const members = membersByBand[index] ?? [];
    // A band declaring members none of which are on the canvas yet is not
    // empty — it is unmeasured, and drawing it would put a band where its
    // members are about to land.
    if (members.length === 0) {
      return band.memberContextIds.length === 0 ? { band, box: null } : null;
    }

    const top = Math.min(...members.map((box) => box.y)) - LANE_BAND_PADDING_Y;
    const bottom =
      Math.max(...members.map((box) => box.y + box.height)) +
      LANE_BAND_PADDING_Y;

    return {
      band,
      box: {
        laneName: band.laneName,
        x,
        y: top,
        width,
        height: Math.max(bottom - top, LANE_BAND_MIN_HEIGHT),
      },
    };
  });

  // A member-less band (README §2.2 — an ephemeral lane) has nothing to wrap,
  // so it takes the shared column and stacks under everything already drawn.
  let stackBottom = Math.max(
    ...placed.flatMap((entry) =>
      entry?.box ? [entry.box.y + entry.box.height] : [],
    ),
  );

  return placed.flatMap((entry) => {
    if (entry === null) return [];
    if (entry.box) return [entry.box];
    const y = stackBottom + LANE_BAND_GAP;
    stackBottom = y + LANE_BAND_MIN_HEIGHT;
    return [
      {
        laneName: entry.band.laneName,
        x,
        y,
        width,
        height: LANE_BAND_MIN_HEIGHT,
      },
    ];
  });
}
