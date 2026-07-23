import { describe, expect, it } from "vitest";
import {
  contractTaskGroups,
  contractedGroupsHavePath,
} from "./group-contraction";

describe("contractTaskGroups", () => {
  it("partitions tasks, topologically orders group members, and deduplicates group edges", () => {
    const contraction = contractTaskGroups([
      task("task-4", "T4", ["task-2", "task-3"]),
      task("task-3", "T3", [], "build"),
      task("task-1", "T1", [], "build"),
      task("task-2", "T2", ["task-1"], "build"),
    ]);

    expect(
      contraction.groups.map((group) => ({
        laneGroup: group.laneGroup,
        memberTaskIds: group.memberTaskIds,
        orderedTaskIds: group.orderedTaskIds,
      })),
    ).toEqual([
      {
        laneGroup: "build",
        memberTaskIds: ["task-1", "task-2", "task-3"],
        orderedTaskIds: ["task-1", "task-2", "task-3"],
      },
      {
        laneGroup: undefined,
        memberTaskIds: ["task-4"],
        orderedTaskIds: ["task-4"],
      },
    ]);
    expect(contraction.edges).toEqual([
      {
        sourceGroupId: "lane:build",
        targetGroupId: "task:task-4",
        dependencyPairs: [
          { sourceTaskId: "task-2", targetTaskId: "task-4" },
          { sourceTaskId: "task-3", targetTaskId: "task-4" },
        ],
      },
    ]);
    expect(contraction.groupCycle).toBeUndefined();
    expect(
      contractedGroupsHavePath(contraction, "lane:build", "task:task-4"),
    ).toBe(true);
    expect(
      contractedGroupsHavePath(contraction, "task:task-4", "lane:build"),
    ).toBe(false);
  });

  it("detects a cycle introduced only by lane-group contraction", () => {
    const contraction = contractTaskGroups([
      task("task-a1", "T1", [], "a"),
      task("task-b1", "T2", ["task-a1"], "b"),
      task("task-b2", "T3", [], "b"),
      task("task-a2", "T4", ["task-b2"], "a"),
    ]);

    expect(contraction.groupCycle).toEqual(["lane:a", "lane:b", "lane:a"]);
    expect(contraction.intraGroupCycleTaskIds).toBeUndefined();
  });

  it("reports an intra-group task cycle without dropping members", () => {
    const contraction = contractTaskGroups([
      task("task-2", "T2", ["task-1"], "one-lane"),
      task("task-1", "T1", ["task-2"], "one-lane"),
    ]);

    expect(contraction.groups[0]?.orderedTaskIds).toEqual(["task-1", "task-2"]);
    expect(contraction.intraGroupCycleTaskIds).toEqual(["task-1", "task-2"]);
  });

  it("treats lane-group keys as exact opaque strings", () => {
    const contraction = contractTaskGroups([
      task("task-1", "T1", [], "source\u0000lane"),
      task("task-2", "T2", ["task-1"], "target:lane"),
    ]);

    expect(contraction.edges).toEqual([
      {
        sourceGroupId: "lane:source\u0000lane",
        targetGroupId: "lane:target:lane",
        dependencyPairs: [{ sourceTaskId: "task-1", targetTaskId: "task-2" }],
      },
    ]);
  });
});

function task(
  id: string,
  handle: string,
  dependsOnTaskIds: string[],
  laneGroup?: string,
) {
  return { id, handle, dependsOnTaskIds, laneGroup };
}
