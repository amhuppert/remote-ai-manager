import type {
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { computeContextDepths } from "./graph-depth";
import {
  LANE_BAND_CONTENT_OFFSET_X,
  LANE_BAND_GAP,
  LANE_BAND_MIN_HEIGHT,
  LANE_BAND_PADDING_Y,
} from "./lane-band-geometry";
import { deriveDefinitionLaneBands } from "./lane-bands";
import {
  LOOP_GROUP_HEADER_HEIGHT,
  LOOP_GROUP_PADDING,
} from "./loop-group-geometry";

type LayoutInputDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export type NodeDimensions = Map<string, { width: number; height: number }>;

/** The context card's authored width (`Context Node.dc.html`). */
export const DEFAULT_NODE_WIDTH = 264;
export const DEFAULT_NODE_HEIGHT = 200;
/**
 * Column pitch is one card plus this gap. Wider than the design bundle's 30
 * (B1: 294 pitch) because a cross-band edge spends the gap on its horizontal
 * run: at 30 an edge dropping a band reads as a vertical line.
 */
export const LAYOUT_COLUMN_GAP = 100;
/** Vertical gutter between two band mates sharing a column. */
export const LAYOUT_ROW_GAP = 40;

/**
 * Band-aware automatic layout.
 *
 * Lanes are the primary axis: each lane gets a horizontal band, bands stack in
 * dependency-first order, and members flow left to right by dependency depth.
 * Members that share a depth share a column and stack inside the band rather
 * than widening it, so a band's width tracks the length of its dependency
 * chain and never the size of a parallel fan-out.
 *
 * Columns are indexed by GLOBAL depth and sized globally, so a context always
 * sits strictly right of every context it depends on — wherever their bands
 * stack. That is the axis the canvas promises: x is dependency order, y is
 * lane membership, and an edge can only ever point rightward. A band whose
 * chain starts deep therefore opens deep, and the empty run before its first
 * member is the wait it depicts.
 *
 * The band ordering and membership come from {@link deriveDefinitionLaneBands},
 * which reads each context's authored placement. The band layer reads the same
 * placement — directly in the builder, and through the execution lane model on
 * a live run — so the generated geometry and the drawn bands cannot disagree
 * about which lane a context is in.
 */
export function generateWorkflowLayout(
  definition: LayoutInputDefinition,
  existingLayout?: GraphWorkflowVisualLayout | null,
  nodeDimensions?: NodeDimensions,
): GraphWorkflowVisualLayout {
  const contextPositions: GraphWorkflowVisualLayout["contextPositions"] = {};
  const existingPositions = existingLayout?.contextPositions ?? {};
  const depths = computeContextDepths(definition);
  const bands = deriveDefinitionLaneBands(definition);
  const loopMembers = new Set(
    definition.loopGroups?.flatMap((loop) =>
      "bodyContextIds" in loop ? loop.bodyContextIds : [],
    ),
  );
  const insetX = (id: string) => (loopMembers.has(id) ? LOOP_GROUP_PADDING : 0);
  const insetY = (id: string) =>
    loopMembers.has(id) ? LOOP_GROUP_HEADER_HEIGHT : 0;

  const nodeWidth = (contextId: string): number =>
    (nodeDimensions?.get(contextId)?.width ?? DEFAULT_NODE_WIDTH) +
    insetX(contextId) * 2;
  const nodeHeight = (contextId: string): number =>
    (nodeDimensions?.get(contextId)?.height ?? DEFAULT_NODE_HEIGHT) +
    insetY(contextId) +
    insetX(contextId);

  // Column index per context: its global dependency depth. Depth is the
  // longest path from a root, so an edge's target is always at least one
  // column right of its source — the invariant that keeps every edge pointing
  // rightward across bands.
  const columnOfContext = new Map<string, number>();
  for (const band of bands) {
    for (const contextId of band.memberContextIds) {
      columnOfContext.set(contextId, depths.get(contextId) ?? 0);
    }
  }

  const columnWidths = new Map<number, number>();
  for (const [contextId, column] of columnOfContext) {
    columnWidths.set(
      column,
      Math.max(columnWidths.get(column) ?? 0, nodeWidth(contextId)),
    );
  }

  const columnX = new Map<number, number>();
  let cursorX = LANE_BAND_CONTENT_OFFSET_X;
  for (const column of [...columnWidths.keys()].sort((a, b) => a - b)) {
    columnX.set(column, cursorX);
    cursorX +=
      (columnWidths.get(column) ?? DEFAULT_NODE_WIDTH) + LAYOUT_COLUMN_GAP;
  }

  let bandContentTop = LANE_BAND_PADDING_Y;

  for (const band of bands) {
    const columnCursorY = new Map<number, number>();
    const nextY = (column: number): number =>
      columnCursorY.get(column) ?? bandContentTop;
    const occupied: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    let contentBottom = bandContentTop;

    const preserved = band.memberContextIds.filter(
      (contextId) => existingPositions[contextId] !== undefined,
    );
    const generated = band.memberContextIds.filter(
      (contextId) => existingPositions[contextId] === undefined,
    );

    // Preserved positions are applied first so a generated band mate always
    // lands clear of them, whatever order the contexts were authored in.
    for (const contextId of preserved) {
      const position = existingPositions[contextId];
      if (!position) continue;
      contextPositions[contextId] = position;
      const column = columnOfContext.get(contextId) ?? 0;
      const x = position.x - insetX(contextId);
      const y = position.y - insetY(contextId);
      const bottom = y + nodeHeight(contextId);
      occupied.push({
        x,
        y,
        width: nodeWidth(contextId),
        height: nodeHeight(contextId),
      });
      columnCursorY.set(
        column,
        Math.max(nextY(column), bottom + LAYOUT_ROW_GAP),
      );
      contentBottom = Math.max(contentBottom, bottom);
    }

    for (const contextId of generated) {
      const column = columnOfContext.get(contextId) ?? 0;
      const x = columnX.get(column) ?? 0;
      const width = nodeWidth(contextId);
      const height = nodeHeight(contextId);
      let y = nextY(column);

      // A persisted position can occupy a different canonical column after a
      // topology edit changes its dependency depth. Check physical rectangles
      // as well as depth cursors so a generated card cannot land beneath it.
      while (true) {
        const collision = occupied.find(
          (box) =>
            x < box.x + box.width &&
            x + width > box.x &&
            y < box.y + box.height &&
            y + height > box.y,
        );
        if (!collision) break;
        y = collision.y + collision.height + LAYOUT_ROW_GAP;
      }

      contextPositions[contextId] = {
        x: x + insetX(contextId),
        y: y + insetY(contextId),
      };
      occupied.push({ x, y, width, height });
      const bottom = y + nodeHeight(contextId);
      columnCursorY.set(column, bottom + LAYOUT_ROW_GAP);
      contentBottom = Math.max(contentBottom, bottom);
    }

    const bandTop = bandContentTop - LANE_BAND_PADDING_Y;
    const bandHeight = Math.max(
      contentBottom + LANE_BAND_PADDING_Y - bandTop,
      LANE_BAND_MIN_HEIGHT,
    );
    bandContentTop = bandTop + bandHeight + LANE_BAND_GAP + LANE_BAND_PADDING_Y;
  }

  return {
    workflowId: existingLayout?.workflowId ?? "generated",
    contextPositions,
    viewport: existingLayout?.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}
