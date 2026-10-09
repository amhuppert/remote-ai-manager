import type { RunContext, RunLane, RunLoop } from "./model";

/**
 * Where the read-only diagram draws each context: a column per dependency
 * depth, a band per placement (the session worktree, then each lane), rows
 * within a band in definition order, and a frame around each loop's body.
 * Pure, so the drawing never decides structure.
 */

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 68;
const GAP_X = 52;
// Room for a loop's frame and label between stacked contexts.
const GAP_Y = 40;
const BAND_HEADER = 36;
const BAND_PAD_X = 20;
const BAND_PAD_BOTTOM = 18;
const BAND_GAP = 12;
const LOOP_PAD = 8;
const LOOP_LABEL = 20;

export interface PlacedNode {
  key: string;
  x: number;
  y: number;
}

export interface PlacedBand {
  id: string;
  label: string;
  lane: RunLane | null;
  y: number;
  height: number;
}

export interface PlacedLoop {
  loop: RunLoop;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramLayout {
  nodes: PlacedNode[];
  bands: PlacedBand[];
  loops: PlacedLoop[];
  width: number;
  height: number;
}

function depths(contexts: readonly RunContext[]): Map<string, number> {
  const byKey = new Map(contexts.map((context) => [context.key, context]));
  const memo = new Map<string, number>();
  const visit = (key: string, seen: ReadonlySet<string>): number => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const context = byKey.get(key);
    // A cycle or an unknown key is the compiler's to refuse; the diagram draws what it can.
    if (context === undefined || seen.has(key)) return 0;
    const next = new Set(seen).add(key);
    const parents = context.dependsOn.filter((parent) => byKey.has(parent));
    const depth =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((parent) => visit(parent, next)));
    memo.set(key, depth);
    return depth;
  };
  for (const context of contexts) visit(context.key, new Set());
  return memo;
}

export function layoutDiagram(input: {
  contexts: readonly RunContext[];
  lanes: readonly RunLane[];
  loops: readonly RunLoop[];
}): DiagramLayout {
  const depth = depths(input.contexts);
  const columns =
    Math.max(
      0,
      ...input.contexts.map((context) => depth.get(context.key) ?? 0),
    ) + 1;
  const bandsSpec = [
    {
      id: "session",
      label: "Session worktree",
      lane: null as RunLane | null,
      match: (c: RunContext) => c.placement.kind === "session",
    },
    ...input.lanes.map((lane) => ({
      id: `lane:${lane.key}`,
      label: `Lane ${lane.key}`,
      lane,
      match: (c: RunContext) =>
        c.placement.kind === "lane" && c.placement.lane === lane.key,
    })),
  ];
  const width = BAND_PAD_X * 2 + columns * NODE_WIDTH + (columns - 1) * GAP_X;
  const nodes: PlacedNode[] = [];
  const bands: PlacedBand[] = [];
  let top = 0;
  for (const spec of bandsSpec) {
    const members = input.contexts.filter(spec.match);
    if (members.length === 0) continue;
    const rowsUsed = new Map<number, number>();
    let rows = 0;
    for (const member of members) {
      const column = depth.get(member.key) ?? 0;
      const row = rowsUsed.get(column) ?? 0;
      rowsUsed.set(column, row + 1);
      rows = Math.max(rows, row + 1);
      nodes.push({
        key: member.key,
        x: BAND_PAD_X + column * (NODE_WIDTH + GAP_X),
        y: top + BAND_HEADER + row * (NODE_HEIGHT + GAP_Y),
      });
    }
    const height =
      BAND_HEADER + rows * NODE_HEIGHT + (rows - 1) * GAP_Y + BAND_PAD_BOTTOM;
    bands.push({
      id: spec.id,
      label: spec.label,
      lane: spec.lane,
      y: top,
      height,
    });
    top += height + BAND_GAP;
  }
  const placed = new Map(nodes.map((node) => [node.key, node]));
  const loops = input.loops.flatMap((loop): PlacedLoop[] => {
    const body = loop.body
      .map((key) => placed.get(key))
      .filter((node): node is PlacedNode => node !== undefined);
    if (body.length === 0) return [];
    const left = Math.min(...body.map((node) => node.x)) - LOOP_PAD;
    const right =
      Math.max(...body.map((node) => node.x + NODE_WIDTH)) + LOOP_PAD;
    const upper =
      Math.min(...body.map((node) => node.y)) - LOOP_PAD - LOOP_LABEL;
    const lower =
      Math.max(...body.map((node) => node.y + NODE_HEIGHT)) + LOOP_PAD;
    return [
      { loop, x: left, y: upper, width: right - left, height: lower - upper },
    ];
  });
  return { nodes, bands, loops, width, height: Math.max(0, top - BAND_GAP) };
}
