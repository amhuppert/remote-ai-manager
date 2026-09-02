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
        /**
         * Part of the lane record, so accepted — but never read here. It names
         * whose landed output the lane's BRANCH carries, which a lane forked
         * from another lane inherits wholesale; it is not who runs on the lane.
         */
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

/**
 * The one owner of "which contexts are in which lane" for every read surface —
 * the canvas bands, the mobile lane list, the status bar, the config panel and
 * the CLI status table all derive from this.
 *
 * Every context is a member of exactly ONE lane. The authored placement is the
 * answer wherever there is one; the lane the engine admitted the context to
 * covers the rest — a run seeded before placement existed, or a context an
 * expansion admitted to a lane it created. A lane record's
 * `includedContextIds` is deliberately not read: it records whose landed output
 * the lane's branch carries, and a lane forked from another lane is seeded with
 * that lane's landed contexts so upstream-visibility checks recognise the copied
 * history. Reading it as membership reports an upstream context inside every
 * lane forked from its own, and the band, its header count and the layout —
 * which positions by placement — then disagree about where the context is.
 */
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

  const placedContextIds = new Set<string>();
  for (const context of execution.workingDefinition.executionContexts) {
    if (!context.placement) continue;
    ensureLane(context.placement.lane).memberContextIds.add(context.id);
    placedContextIds.add(context.id);
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
  }

  for (const [contextId, state] of Object.entries(execution.contextStates)) {
    if (!state?.laneId || placedContextIds.has(contextId)) continue;
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
