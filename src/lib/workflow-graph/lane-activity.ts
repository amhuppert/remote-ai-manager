import { SESSION_LANE_ID, SESSION_LANE_NAME } from "./lane-identity";

export interface ExecutionLaneActivityMember {
  contextId: string;
  status: string;
  activity: "active" | "inactive";
  batchId: string | null;
}

export interface ExecutionLaneActivity {
  laneId: string;
  runtimeLaneId: string;
  kind: "session" | "worktree" | null;
  status: string;
  members: ExecutionLaneActivityMember[];
}

interface LaneActivityExecution {
  activeContextIds?: readonly string[];
  workingDefinition: {
    executionContexts: readonly {
      id: string;
      placement?: { lane: string };
    }[];
  };
  contextStates: Record<
    string,
    | {
        status: string;
        batchId?: string | null;
        laneId?: string | null;
      }
    | undefined
  >;
  executionLanes?: Record<
    string,
    | {
        laneId: string;
        kind: "session" | "worktree";
        status: string;
        includedContextIds?: readonly string[];
      }
    | undefined
  >;
}

interface MutableLaneActivity {
  laneId: string;
  runtimeLaneId: string;
  kind: "session" | "worktree" | null;
  runtimeStatus: string;
  memberContextIds: Set<string>;
}

function runtimeLaneId(authoredLaneId: string): string {
  return authoredLaneId === SESSION_LANE_NAME
    ? SESSION_LANE_ID
    : authoredLaneId;
}

function displayLaneId(runtimeId: string): string {
  return runtimeId === SESSION_LANE_ID ? SESSION_LANE_NAME : runtimeId;
}

export function deriveExecutionLaneActivities(
  execution: LaneActivityExecution,
): ExecutionLaneActivity[] {
  const lanes = new Map<string, MutableLaneActivity>();
  const ensureLane = (
    laneId: string,
    resolvedRuntimeLaneId = runtimeLaneId(laneId),
  ): MutableLaneActivity => {
    const existing = lanes.get(laneId);
    if (existing) return existing;
    const created: MutableLaneActivity = {
      laneId,
      runtimeLaneId: resolvedRuntimeLaneId,
      kind: null,
      runtimeStatus: "pending",
      memberContextIds: new Set(),
    };
    lanes.set(laneId, created);
    return created;
  };

  for (const context of execution.workingDefinition.executionContexts) {
    if (!context.placement) continue;
    ensureLane(context.placement.lane).memberContextIds.add(context.id);
  }

  for (const [key, runtimeLane] of Object.entries(
    execution.executionLanes ?? {},
  )) {
    if (!runtimeLane) continue;
    const resolvedRuntimeLaneId = runtimeLane.laneId || key;
    const lane = ensureLane(
      displayLaneId(resolvedRuntimeLaneId),
      resolvedRuntimeLaneId,
    );
    lane.kind = runtimeLane.kind;
    lane.runtimeStatus = runtimeLane.status;
    for (const contextId of runtimeLane.includedContextIds ?? []) {
      lane.memberContextIds.add(contextId);
    }
  }

  for (const [contextId, state] of Object.entries(execution.contextStates)) {
    if (!state?.laneId) continue;
    ensureLane(displayLaneId(state.laneId), state.laneId).memberContextIds.add(
      contextId,
    );
  }

  const activeContextIds = new Set(execution.activeContextIds ?? []);
  return [...lanes.values()].map((lane) => {
    const members = [...lane.memberContextIds].map((contextId) => {
      const state = execution.contextStates[contextId];
      return {
        contextId,
        status: state?.status ?? "-",
        activity: activeContextIds.has(contextId)
          ? ("active" as const)
          : ("inactive" as const),
        batchId: state?.batchId ?? null,
      };
    });
    return {
      laneId: lane.laneId,
      runtimeLaneId: lane.runtimeLaneId,
      kind: lane.kind,
      status:
        lane.runtimeStatus === "pending" &&
        members.some((member) => member.activity === "active")
          ? "active"
          : lane.runtimeStatus,
      members,
    };
  });
}
