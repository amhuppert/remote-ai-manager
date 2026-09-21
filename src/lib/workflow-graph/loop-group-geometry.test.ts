import { describe, expect, it } from "vitest";
import type { GraphWorkflowLoopGroup } from "./definition-schemas";
import type { LaneBandNodeBox } from "./lane-band-geometry";
import type { LaneBand } from "./lane-bands";
import {
  computeLoopGroupBoxes,
  expandLoopNodeBox,
  expandLoopNodeBoxes,
} from "./loop-group-geometry";

function loop(id: string, bodyContextIds: string[]): GraphWorkflowLoopGroup {
  return {
    id,
    title: `Loop ${id}`,
    bodyContextIds,
    entryContextId: bodyContextIds[0] ?? "entry",
    exitContextId: bodyContextIds.at(-1) ?? "exit",
    until: { schema: {} },
    maxPasses: 3,
  };
}

function band(laneName: string, memberContextIds: string[]): LaneBand {
  return {
    laneName,
    state: "pending",
    reserved: false,
    memberContextIds,
    memberCount: memberContextIds.length,
    membershipLabel: `${memberContextIds.length} members`,
    gradeSummary: "",
    runtime: null,
  };
}

function node(
  id: string,
  x: number,
  y: number,
  width = 264,
  height = 420,
): LaneBandNodeBox {
  return { id, x, y, width, height };
}

describe("computeLoopGroupBoxes", () => {
  it("encloses a loop's measured body with room for its title and border", () => {
    const group = loop("delivery", ["implement", "review"]);
    const boxes = computeLoopGroupBoxes(
      [group],
      [band("delivery", ["implement", "review"])],
      [node("implement", 100, 200), node("review", 500, 220, 264, 500)],
    );

    expect(boxes).toEqual([
      {
        key: expect.any(String),
        loop: group,
        memberContextIds: ["implement", "review"],
        x: 84,
        y: 148,
        width: 696,
        height: 588,
      },
    ]);
  });

  it("keeps a cross-lane body in separate enclosures with the same loop identity", () => {
    const group = loop("delivery", ["implement", "review"]);
    const boxes = computeLoopGroupBoxes(
      [group],
      [band("build", ["implement"]), band("review", ["review"])],
      [node("implement", 100, 200), node("review", 500, 900)],
    );

    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => box.loop)).toEqual([group, group]);
    expect(boxes.map((box) => box.memberContextIds)).toEqual([
      ["implement"],
      ["review"],
    ]);
    expect(
      boxes.map(({ x, y, width, height }) => ({ x, y, width, height })),
    ).toEqual([
      { x: 84, y: 148, width: 296, height: 488 },
      { x: 484, y: 848, width: 296, height: 488 },
    ]);
    expect(new Set(boxes.map((box) => box.key)).size).toBe(2);
  });

  it("keeps separate loop bodies distinct even when they share a lane", () => {
    const groups = [loop("first", ["a"]), loop("second", ["b"])];
    const bands = [band("delivery", ["a", "b", "outside"])];
    const nodes = [node("a", 100, 200), node("b", 500, 200)];
    const boxes = computeLoopGroupBoxes(groups, bands, nodes);

    expect(boxes.map((box) => box.loop.id)).toEqual(["first", "second"]);
    expect(boxes.map((box) => box.memberContextIds)).toEqual([["a"], ["b"]]);
    expect(new Set(boxes.map((box) => box.key)).size).toBe(2);
    expect(
      computeLoopGroupBoxes(groups, bands, nodes).map((box) => box.key),
    ).toEqual(boxes.map((box) => box.key));
  });

  it("omits absent or unmeasured members without inventing their positions", () => {
    const boxes = computeLoopGroupBoxes(
      [loop("delivery", ["placed", "missing", "unmeasured", "unbanded"])],
      [band("delivery", ["placed", "missing", "unmeasured"])],
      [
        node("placed", 100, 200),
        node("unmeasured", 0, 0, 0, 0),
        node("unbanded", -1000, -1000),
      ],
    );

    expect(boxes.map((box) => box.memberContextIds)).toEqual([["placed"]]);
    expect(boxes[0]).toMatchObject({ x: 84, y: 148, width: 296, height: 488 });
    expect(
      computeLoopGroupBoxes(
        [loop("missing", ["none"])],
        [band("empty", [])],
        [],
      ),
    ).toEqual([]);
    expect(
      computeLoopGroupBoxes([], [band("delivery", ["placed"])], []),
    ).toEqual([]);
  });

  it("splits the enclosure when an unrelated card sits between body members", () => {
    const group = loop("delivery", ["implement", "review"]);
    const outsider = node("outside", 300, 200, 100, 150);
    const boxes = computeLoopGroupBoxes(
      [group],
      [band("delivery", ["implement", "outside", "review"])],
      [
        node("implement", 100, 200, 100, 150),
        outsider,
        node("review", 500, 200, 100, 150),
      ],
    );

    expect(boxes.map((box) => box.memberContextIds)).toEqual([
      ["implement"],
      ["review"],
    ]);
    expect(boxes.map((box) => box.loop)).toEqual([group, group]);
    for (const box of boxes) {
      const overlaps =
        box.x < outsider.x + outsider.width &&
        box.x + box.width > outsider.x &&
        box.y < outsider.y + outsider.height &&
        box.y + box.height > outsider.y;
      expect(overlaps).toBe(false);
    }
  });
});

describe("expandLoopNodeBox", () => {
  it("includes the enclosure's header and padding in lane extents", () => {
    const original = node("implement", 100, 200);

    expect(expandLoopNodeBox(original)).toEqual({
      id: "implement",
      x: 84,
      y: 148,
      width: 296,
      height: 488,
    });
    expect(original).toEqual(node("implement", 100, 200));
  });
});

describe("expandLoopNodeBoxes", () => {
  it("expands only declared loop members for matching visible and drop-target extents", () => {
    const before = node("before", 100, 200);
    const implement = node("implement", 500, 200);
    const review = node("review", 900, 200);
    const independent = node("independent", 100, 900);
    const nodes = [before, implement, review, independent];

    expect(
      expandLoopNodeBoxes(nodes, [
        loop("delivery", ["implement", "review", "missing"]),
        loop("separate", ["independent"]),
      ]),
    ).toEqual([
      before,
      { id: "implement", x: 484, y: 148, width: 296, height: 488 },
      { id: "review", x: 884, y: 148, width: 296, height: 488 },
      { id: "independent", x: 84, y: 848, width: 296, height: 488 },
    ]);
    expect(nodes).toEqual([
      node("before", 100, 200),
      node("implement", 500, 200),
      node("review", 900, 200),
      node("independent", 100, 900),
    ]);
    expect(expandLoopNodeBoxes(nodes, [])).toEqual(nodes);
  });
});
