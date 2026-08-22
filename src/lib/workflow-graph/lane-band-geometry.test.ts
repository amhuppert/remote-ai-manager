import { describe, expect, it } from "vitest";
import {
  computeLaneBandBoxes,
  laneBandAtPoint,
  LANE_BAND_CONTENT_OFFSET_X,
  LANE_BAND_GAP,
  LANE_BAND_MIN_HEIGHT,
  LANE_BAND_PADDING_X,
  LANE_BAND_PADDING_Y,
  type LaneBandBox,
  type LaneBandNodeBox,
  resolveLaneStatementAnchor,
} from "./lane-band-geometry";
import type { LaneBand } from "./lane-bands";

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

function nodeBox(
  id: string,
  x: number,
  y: number,
  width = 264,
  height = 180,
): LaneBandNodeBox {
  return { id, x, y, width, height };
}

describe("computeLaneBandBoxes", () => {
  it("wraps a band's members and reserves the header column to their left", () => {
    const boxes = computeLaneBandBoxes(
      [band("delivery", ["ctx_a", "ctx_b"])],
      [nodeBox("ctx_a", 200, 500), nodeBox("ctx_b", 500, 500, 264, 220)],
    );

    expect(boxes).toEqual([
      {
        laneName: "delivery",
        x: 200 - LANE_BAND_CONTENT_OFFSET_X,
        y: 500 - LANE_BAND_PADDING_Y,
        width:
          LANE_BAND_CONTENT_OFFSET_X + (500 + 264 - 200) + LANE_BAND_PADDING_X,
        // The tallest member (220) decides the bottom edge.
        height: 220 + LANE_BAND_PADDING_Y * 2,
      },
    ]);
  });

  it("gives every band the same left edge and width so the bands stack as one column", () => {
    const boxes = computeLaneBandBoxes(
      [band("plan", ["ctx_plan"]), band("delivery", ["ctx_a", "ctx_b"])],
      [
        nodeBox("ctx_plan", 200, 40),
        nodeBox("ctx_a", 200, 500),
        nodeBox("ctx_b", 500, 500),
      ],
    );

    expect(boxes.map((box) => box.x)).toEqual([
      200 - LANE_BAND_CONTENT_OFFSET_X,
      200 - LANE_BAND_CONTENT_OFFSET_X,
    ]);
    // The widest row, not the band's own members, sets the shared width.
    const sharedWidth =
      LANE_BAND_CONTENT_OFFSET_X + (500 + 264 - 200) + LANE_BAND_PADDING_X;
    expect(boxes.map((box) => box.width)).toEqual([sharedWidth, sharedWidth]);
  });

  it("keeps a short band tall enough for its header", () => {
    const boxes = computeLaneBandBoxes(
      [band("session", ["ctx_notes"])],
      [nodeBox("ctx_notes", 200, 800, 264, 60)],
    );

    expect(boxes.map((box) => box.height)).toEqual([LANE_BAND_MIN_HEIGHT]);
  });

  it("omits a band whose members have no measured box yet", () => {
    const boxes = computeLaneBandBoxes(
      [band("plan", ["ctx_plan"]), band("delivery", ["ctx_unmeasured"])],
      [nodeBox("ctx_plan", 200, 40)],
    );

    expect(boxes.map((box) => box.laneName)).toEqual(["plan"]);
  });

  it("returns nothing before any node has been placed", () => {
    expect(computeLaneBandBoxes([band("plan", ["ctx_plan"])], [])).toEqual([]);
  });

  // An ephemeral lane (README §2.2) is a band with no members. It has no
  // members to wrap, so it takes the shared column and stacks below the bands
  // that do — it is a drop target before it is anything else.
  it("stacks a member-less band below the populated ones", () => {
    const boxes = computeLaneBandBoxes(
      [band("plan", ["ctx_plan"]), band("rollback", [])],
      [nodeBox("ctx_plan", 200, 40)],
    );

    const plan = boxes[0]!;
    expect(boxes[1]).toEqual({
      laneName: "rollback",
      x: plan.x,
      y: plan.y + plan.height + LANE_BAND_GAP,
      width: plan.width,
      height: LANE_BAND_MIN_HEIGHT,
    });
  });

  it("stacks two member-less bands one after the other", () => {
    const boxes = computeLaneBandBoxes(
      [band("plan", ["ctx_plan"]), band("rollback", []), band("spike", [])],
      [nodeBox("ctx_plan", 200, 40)],
    );

    expect(boxes.map((box) => box.laneName)).toEqual([
      "plan",
      "rollback",
      "spike",
    ]);
    expect(boxes[2]!.y).toBe(
      boxes[1]!.y + LANE_BAND_MIN_HEIGHT + LANE_BAND_GAP,
    );
  });

  // Without a placed node there is no shared column to hang a band off, so an
  // empty canvas stays empty rather than guessing one.
  it("draws no member-less band before any node has been placed", () => {
    expect(computeLaneBandBoxes([band("rollback", [])], [])).toEqual([]);
  });

  it("ignores boxes that belong to no band", () => {
    const boxes = computeLaneBandBoxes(
      [band("plan", ["ctx_plan"])],
      [nodeBox("ctx_plan", 200, 40), nodeBox("ctx_orphan", 4000, 40)],
    );

    expect(boxes.map((box) => box.width)).toEqual([
      LANE_BAND_CONTENT_OFFSET_X + 264 + LANE_BAND_PADDING_X,
    ]);
  });
});

describe("resolveLaneStatementAnchor", () => {
  const laneBox = (laneName: string, y: number, height = 200): LaneBandBox => ({
    laneName,
    x: 0,
    y,
    width: 600,
    height,
  });

  it("hangs the pill under the target lane when that lane has a band", () => {
    const anchor = resolveLaneStatementAnchor(
      [laneBox("plan", 0), laneBox("session", 400), laneBox("implement", 200)],
      "session",
    );

    expect(anchor?.laneName).toBe("session");
  });

  it("falls back to the bottom of the stack when the target lane is empty", () => {
    // The ordinary final_publish shape: the session lane receives the publish
    // and holds no context, so it has no band to hang under.
    const anchor = resolveLaneStatementAnchor(
      [laneBox("plan", 0), laneBox("implement", 200)],
      "session",
    );

    expect(anchor?.laneName).toBe("implement");
  });

  it("measures the bottom by the band's lower edge, not its top", () => {
    // A short band starting lower can still end higher than a tall one.
    const anchor = resolveLaneStatementAnchor(
      [laneBox("plan", 0, 900), laneBox("implement", 200, 100)],
      "session",
    );

    expect(anchor?.laneName).toBe("plan");
  });

  it("has nowhere to hang the pill before any band is measured", () => {
    expect(resolveLaneStatementAnchor([], "session")).toBeNull();
  });
});

describe("laneBandAtPoint", () => {
  const boxes: LaneBandBox[] = [
    { laneName: "plan", x: 0, y: 0, width: 800, height: 200 },
    { laneName: "delivery", x: 0, y: 220, width: 800, height: 200 },
  ];

  it("names the band the point falls inside", () => {
    expect(laneBandAtPoint(boxes, { x: 300, y: 300 })?.laneName).toBe(
      "delivery",
    );
  });

  it("is null in the gutter between two bands", () => {
    expect(laneBandAtPoint(boxes, { x: 300, y: 210 })).toBeNull();
  });

  it("is null past the last band", () => {
    expect(laneBandAtPoint(boxes, { x: 300, y: 900 })).toBeNull();
  });

  it("accepts a point dragged out past the band's right edge", () => {
    // Bands read as full-width stripes, and a node dragged beyond the widest
    // row is still visibly inside the lane it hovers.
    expect(laneBandAtPoint(boxes, { x: 5000, y: 100 })?.laneName).toBe("plan");
  });

  it("is null to the left of the header column", () => {
    expect(laneBandAtPoint(boxes, { x: -400, y: 100 })).toBeNull();
  });
});
