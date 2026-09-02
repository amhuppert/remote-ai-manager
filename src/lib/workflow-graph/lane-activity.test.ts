import { describe, expect, it } from "vitest";
import {
  deriveExecutionLaneActivities,
  type ExecutionLaneActivity,
} from "./lane-activity";

function membersOf(
  activities: readonly ExecutionLaneActivity[],
  laneId: string,
): string[] {
  const lane = activities.find((activity) => activity.laneId === laneId);
  if (!lane) throw new Error(`no activity for lane "${laneId}"`);
  return lane.members.map((member) => member.contextId);
}

describe("deriveExecutionLaneActivities", () => {
  // A lane forked from another lane's branch is seeded with every context
  // whose landed output that branch already carries, so downstream visibility
  // checks recognise the copied history. That seed records what the BRANCH
  // contains, not who runs on the lane: the upstream context stays a member of
  // the lane it is placed on and must not be reported in the fork as well.
  it("does not count a fork-inherited upstream context as a member of the fork lane", () => {
    const activities = deriveExecutionLaneActivities({
      workingDefinition: {
        executionContexts: [
          { id: "recovery-strings", placement: { lane: "cli-contract" } },
          {
            id: "gate-single-evaluation",
            placement: { lane: "workflow-gate" },
          },
        ],
      },
      contextStates: {
        "recovery-strings": { status: "completed", laneId: "cli-contract" },
        "gate-single-evaluation": {
          status: "completed",
          laneId: "workflow-gate",
        },
      },
      executionLanes: {
        "cli-contract": {
          laneId: "cli-contract",
          kind: "worktree",
          status: "active",
          includedContextIds: ["recovery-strings"],
        },
        "workflow-gate": {
          laneId: "workflow-gate",
          kind: "worktree",
          status: "active",
          includedContextIds: ["recovery-strings", "gate-single-evaluation"],
        },
      },
    });

    expect(membersOf(activities, "cli-contract")).toEqual(["recovery-strings"]);
    expect(membersOf(activities, "workflow-gate")).toEqual([
      "gate-single-evaluation",
    ]);
  });

  it("reports every context in exactly one lane", () => {
    const activities = deriveExecutionLaneActivities({
      workingDefinition: {
        executionContexts: [
          { id: "ctx_a", placement: { lane: "alpha" } },
          { id: "ctx_b", placement: { lane: "beta" } },
        ],
      },
      contextStates: {
        ctx_a: { status: "completed", laneId: "alpha" },
        ctx_b: { status: "running", laneId: "beta" },
      },
      executionLanes: {
        alpha: {
          laneId: "alpha",
          kind: "worktree",
          status: "active",
          includedContextIds: ["ctx_a"],
        },
        beta: {
          laneId: "beta",
          kind: "worktree",
          status: "active",
          includedContextIds: ["ctx_a", "ctx_b"],
        },
      },
    });

    const claims = activities.flatMap((activity) =>
      activity.members.map((member) => member.contextId),
    );
    expect([...claims].sort()).toEqual(["ctx_a", "ctx_b"]);
  });

  // A context with no authored placement — a legacy run, or a context a
  // runtime expansion admitted to a lane it created — belongs to the lane the
  // engine admitted it to. That membership must survive: it is the only record
  // there is.
  it("keeps a context with no authored placement in the lane it was admitted to", () => {
    const activities = deriveExecutionLaneActivities({
      workingDefinition: {
        executionContexts: [{ id: "ctx_generated" }],
      },
      contextStates: {
        ctx_generated: { status: "running", laneId: "delivery.spawn" },
      },
      executionLanes: {
        "delivery.spawn": {
          laneId: "delivery.spawn",
          kind: "worktree",
          status: "active",
          includedContextIds: ["ctx_generated"],
        },
      },
    });

    expect(membersOf(activities, "delivery.spawn")).toEqual(["ctx_generated"]);
  });

  it("still carries the runtime record of a lane whose members have not started", () => {
    const activities = deriveExecutionLaneActivities({
      workingDefinition: {
        executionContexts: [{ id: "ctx_later", placement: { lane: "later" } }],
      },
      contextStates: {
        ctx_later: { status: "pending" },
      },
      executionLanes: {
        later: {
          laneId: "later",
          kind: "worktree",
          status: "active",
          includedContextIds: [],
        },
      },
    });

    expect(
      activities.find((activity) => activity.laneId === "later"),
    ).toMatchObject({
      kind: "worktree",
      status: "active",
      members: [{ contextId: "ctx_later", status: "pending" }],
    });
  });
});
