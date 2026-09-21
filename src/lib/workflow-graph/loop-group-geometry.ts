import type { GraphWorkflowLoopGroup } from "./definition-schemas";
import type { LaneBandNodeBox } from "./lane-band-geometry";
import type { LaneBand } from "./lane-bands";

export const LOOP_GROUP_PADDING = 16;
export const LOOP_GROUP_HEADER_HEIGHT = 52;

export interface LoopGroupBox {
  key: string;
  loop: GraphWorkflowLoopGroup;
  memberContextIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export function expandLoopNodeBox(node: LaneBandNodeBox): LaneBandNodeBox {
  return {
    ...node,
    x: node.x - LOOP_GROUP_PADDING,
    y: node.y - LOOP_GROUP_HEADER_HEIGHT,
    width: node.width + LOOP_GROUP_PADDING * 2,
    height: node.height + LOOP_GROUP_HEADER_HEIGHT + LOOP_GROUP_PADDING,
  };
}

export function expandLoopNodeBoxes(
  nodes: readonly LaneBandNodeBox[],
  groups: readonly GraphWorkflowLoopGroup[],
): LaneBandNodeBox[] {
  const memberIds = new Set(groups.flatMap((group) => group.bodyContextIds));
  return nodes.map((node) =>
    memberIds.has(node.id) ? expandLoopNodeBox(node) : node,
  );
}

function encloseMembers(
  loop: GraphWorkflowLoopGroup,
  laneName: string,
  members: readonly LaneBandNodeBox[],
): LoopGroupBox {
  const expanded = members.map(expandLoopNodeBox);
  const x = Math.min(...expanded.map((node) => node.x));
  const y = Math.min(...expanded.map((node) => node.y));
  const right = Math.max(...expanded.map((node) => node.x + node.width));
  const bottom = Math.max(...expanded.map((node) => node.y + node.height));
  const memberContextIds = members.map((node) => node.id);
  return {
    key: JSON.stringify([loop.id, laneName, memberContextIds]),
    loop,
    memberContextIds,
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function intersects(box: LoopGroupBox, node: LaneBandNodeBox): boolean {
  return (
    box.x < node.x + node.width &&
    box.x + box.width > node.x &&
    box.y < node.y + node.height &&
    box.y + box.height > node.y
  );
}

/**
 * A loop may cross lanes, so each lane gets its own named segment. Dragged
 * cards can interrupt a body: separate enclosures preserve membership without
 * making an unrelated card look like part of the loop.
 */
export function computeLoopGroupBoxes(
  groups: readonly GraphWorkflowLoopGroup[],
  bands: readonly LaneBand[],
  nodes: readonly LaneBandNodeBox[],
): LoopGroupBox[] {
  const nodeById = new Map(
    nodes
      .filter((node) => node.width > 0 && node.height > 0)
      .map((node) => [node.id, node]),
  );
  const nodesByLane = bands.map((band) => ({
    laneName: band.laneName,
    nodes: band.memberContextIds.flatMap((id) => {
      const node = nodeById.get(id);
      return node ? [node] : [];
    }),
  }));

  return groups.flatMap((loop) => {
    const bodyIds = new Set(loop.bodyContextIds);
    return nodesByLane.flatMap(({ laneName, nodes: laneNodes }) => {
      const members = laneNodes.filter((node) => bodyIds.has(node.id));
      if (members.length === 0) return [];

      const box = encloseMembers(loop, laneName, members);
      const includesUnrelatedCard = laneNodes.some(
        (node) => !bodyIds.has(node.id) && intersects(box, node),
      );
      return includesUnrelatedCard
        ? members.map((member) => encloseMembers(loop, laneName, [member]))
        : [box];
    });
  });
}
