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

type LayoutInputDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export type NodeDimensions = Map<string, { width: number; height: number }>;

/** The context card's authored width (`Context Node.dc.html`). */
export const DEFAULT_NODE_WIDTH = 264;
export const DEFAULT_NODE_HEIGHT = 200;
/** Column pitch inside a band is one card plus this gap (design B1: 294). */
export const LAYOUT_COLUMN_GAP = 30;
/** Vertical gutter between two band mates sharing a column. */
export const LAYOUT_ROW_GAP = 40;

/**
 * Band-aware automatic layout.
 *
 * Lanes are the primary axis: each lane gets a horizontal band, bands stack in
 * dependency-first order, and a band's members flow left to right by dependency
 * depth. Members that share a depth share a column and stack inside the band
 * rather than widening it, so a band's width tracks the length of its
 * dependency chain and never the size of a parallel fan-out.
 *
 * Columns are indexed per band but sized globally, which is what keeps the
 * first member of every band on one vertical line (design B1/E1) instead of
 * letting one wide card in one lane shift the others.
 *
 * The band ordering and membership come from {@link deriveDefinitionLaneBands}
 * — the same model the band layer renders — so the generated geometry and the
 * drawn bands cannot disagree about which lane a context is in.
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

  const nodeWidth = (contextId: string): number =>
    nodeDimensions?.get(contextId)?.width ?? DEFAULT_NODE_WIDTH;
  const nodeHeight = (contextId: string): number =>
    nodeDimensions?.get(contextId)?.height ?? DEFAULT_NODE_HEIGHT;

  // Column index per context: the rank of its depth among the depths present
  // in ITS band, so a band whose chain starts deep still opens at column 0.
  const columnOfContext = new Map<string, number>();
  for (const band of bands) {
    const bandDepths = [
      ...new Set(band.memberContextIds.map((id) => depths.get(id) ?? 0)),
    ].sort((a, b) => a - b);
    for (const contextId of band.memberContextIds) {
      columnOfContext.set(
        contextId,
        bandDepths.indexOf(depths.get(contextId) ?? 0),
      );
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
      const bottom = position.y + nodeHeight(contextId);
      columnCursorY.set(
        column,
        Math.max(nextY(column), bottom + LAYOUT_ROW_GAP),
      );
      contentBottom = Math.max(contentBottom, bottom);
    }

    for (const contextId of generated) {
      const column = columnOfContext.get(contextId) ?? 0;
      const y = nextY(column);
      contextPositions[contextId] = { x: columnX.get(column) ?? 0, y };
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
