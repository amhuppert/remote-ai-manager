import { computeContextDepths } from "./graph-depth";
import { deriveExecutionLaneActivities } from "./lane-activity";
import { SESSION_LANE_ID, SESSION_LANE_NAME } from "./lane-identity";

/**
 * Lane bands — the horizontal swimlane the canvas groups nodes into.
 *
 * A lane has NO grade (README §4). A band therefore carries membership, a
 * per-member GRADE SUMMARY, and its runtime facts; the grade itself renders
 * only on the context that declares it. There is deliberately no `grade` or
 * `mode` field on this shape: the type is the enforcement.
 */
export type LaneBandState = "active" | "merged" | "pending" | "session";

export type LaneBandGrade = "full" | "owned" | "readOnly";

export interface LaneBandRuntime {
  /**
   * The engine's lane status, verbatim. Kept beside {@link LaneBand.state}
   * because the two answer different questions: `state` colours the band
   * (is this lane the live one?), `status` is what the header pill says.
   */
  status: string;
  branchLabel: string | null;
  worktreeLabel: string | null;
  /** e.g. `joined → delivery` — the context-merge this lane feeds. */
  joinLabel: string | null;
  /** e.g. `publishes → session`, or `publication target` on the session lane. */
  publicationLabel: string | null;
}

export interface LaneBand {
  laneName: string;
  state: LaneBandState;
  /** The reserved `session` lane: the session worktree, read-only members only. */
  reserved: boolean;
  /** Members in dependency order — the order the band lays them out. */
  memberContextIds: string[];
  memberCount: number;
  /** `3 members` / `1 member`. */
  membershipLabel: string;
  /** `2 owning · 1 full` — empty when no member declares a placement. */
  gradeSummary: string;
  /** Null in builder mode: a draft lane has no runtime. */
  runtime: LaneBandRuntime | null;
}

export interface LaneBandContext {
  id: string;
  placement?: { lane: string; mode: LaneBandGrade };
}

export interface LaneBandDefinition {
  executionContexts: readonly LaneBandContext[];
  edges: readonly { sourceContextId: string; targetContextId: string }[];
}

export interface LaneBandJoin {
  kind: "context_merge" | "final_publish";
  targetLaneId: string;
  sourceLaneIds: readonly string[];
  status: string;
  /** Per-source progress, for a publish reporting how far through it is. */
  mergedSourceLaneIds?: readonly string[];
  conflicts?: { files: readonly string[] } | null;
}

export interface LaneBandExecutionLane {
  laneId: string;
  kind: "session" | "worktree";
  status: string;
  branchName: string;
  worktreePath?: string | null;
  includedContextIds?: readonly string[];
}

export interface LaneBandExecution {
  activeContextIds?: readonly string[];
  workingDefinition: LaneBandDefinition;
  contextStates: Record<
    string,
    | { status: string; batchId?: string | null; laneId?: string | null }
    | undefined
  >;
  executionLanes?: Record<string, LaneBandExecutionLane | undefined>;
  joins?: Record<string, LaneBandJoin | undefined>;
}

const GRADE_LABEL: Record<LaneBandGrade, string> = {
  owned: "owning",
  full: "full",
  readOnly: "read-only",
};

// Owning first, then full, then read-only — the order the design states the
// summary in ("2 owning · 1 full", "2 owning · 1 read-only").
const GRADE_ORDER: readonly LaneBandGrade[] = ["owned", "full", "readOnly"];

/**
 * What a lane is CALLED on screen. The session lane is the only lane whose id
 * is not its name, and every surface that names a lane — band header, mobile
 * list, join card, gate row — has to agree, or the same lane reads as two.
 */
export function laneDisplayName(laneId: string): string {
  return laneId === SESSION_LANE_ID ? SESSION_LANE_NAME : laneId;
}

function isSessionLane(laneName: string): boolean {
  return laneName === SESSION_LANE_NAME || laneName === SESSION_LANE_ID;
}

function membershipLabel(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}

function gradeSummary(grades: readonly LaneBandGrade[]): string {
  return GRADE_ORDER.flatMap((grade) => {
    const count = grades.filter((candidate) => candidate === grade).length;
    return count > 0 ? [`${count} ${GRADE_LABEL[grade]}`] : [];
  }).join(" · ");
}

interface OrderedMembership {
  laneNames: string[];
  membersByLane: Map<string, string[]>;
}

/**
 * Lane order and member order in one pass: bands stack by the shallowest
 * member's dependency depth, members flow left-to-right by their own depth.
 * Ties keep authored order, so a re-derive never reshuffles a stable graph.
 */
function orderMembership(
  definition: LaneBandDefinition,
  laneOfContext: Map<string, string>,
): OrderedMembership {
  const depths = computeContextDepths({
    executionContexts: [...laneOfContext.keys()].map((id) => ({ id })),
    edges: definition.edges,
  });
  const authoredOrder = new Map<string, number>(
    [...laneOfContext.keys()].map((id, index) => [id, index]),
  );

  const membersByLane = new Map<string, string[]>();
  for (const [contextId, laneName] of laneOfContext) {
    const members = membersByLane.get(laneName);
    if (members) {
      members.push(contextId);
    } else {
      membersByLane.set(laneName, [contextId]);
    }
  }

  const rank = (contextId: string): number => depths.get(contextId) ?? 0;
  for (const members of membersByLane.values()) {
    members.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (authoredOrder.get(a) ?? 0) - (authoredOrder.get(b) ?? 0),
    );
  }

  const laneNames = [...membersByLane.keys()].sort((a, b) => {
    const aMembers = membersByLane.get(a) ?? [];
    const bMembers = membersByLane.get(b) ?? [];
    const aDepth = Math.min(...aMembers.map(rank));
    const bDepth = Math.min(...bMembers.map(rank));
    if (aDepth !== bDepth) return aDepth - bDepth;
    return (
      (authoredOrder.get(aMembers[0] ?? "") ?? 0) -
      (authoredOrder.get(bMembers[0] ?? "") ?? 0)
    );
  });

  return { laneNames, membersByLane };
}

function gradesOf(
  definition: LaneBandDefinition,
  memberContextIds: readonly string[],
): LaneBandGrade[] {
  const modeByContext = new Map<string, LaneBandGrade>();
  for (const context of definition.executionContexts) {
    if (context.placement)
      modeByContext.set(context.id, context.placement.mode);
  }
  return memberContextIds.flatMap((contextId) => {
    const mode = modeByContext.get(contextId);
    return mode ? [mode] : [];
  });
}

export function deriveDefinitionLaneBands(
  definition: LaneBandDefinition,
): LaneBand[] {
  const laneOfContext = new Map<string, string>();
  for (const context of definition.executionContexts) {
    if (!context.placement) continue;
    laneOfContext.set(context.id, laneDisplayName(context.placement.lane));
  }

  const { laneNames, membersByLane } = orderMembership(
    definition,
    laneOfContext,
  );

  return laneNames.map((laneName) => {
    const memberContextIds = membersByLane.get(laneName) ?? [];
    const reserved = isSessionLane(laneName);
    return {
      laneName,
      state: reserved ? "session" : "pending",
      reserved,
      memberContextIds,
      memberCount: memberContextIds.length,
      membershipLabel: membershipLabel(memberContextIds.length),
      gradeSummary: gradeSummary(gradesOf(definition, memberContextIds)),
      runtime: null,
    };
  });
}

/**
 * The band's colour, which is a question about occupancy rather than health: a
 * halted lane is still the lane holding the work, so it stays `active` and the
 * verbatim `halted` status rides {@link LaneBandRuntime.status} for the pill.
 */
function bandState(reserved: boolean, laneStatus: string): LaneBandState {
  if (reserved) return "session";
  if (laneStatus === "merged") return "merged";
  if (laneStatus === "pending") return "pending";
  return "active";
}

function joinLabels(
  joins: Record<string, LaneBandJoin | undefined>,
  runtimeLaneId: string,
  reserved: boolean,
): Pick<LaneBandRuntime, "joinLabel" | "publicationLabel"> {
  let joinLabel: string | null = null;
  let publicationLabel: string | null = reserved ? "publication target" : null;

  for (const join of Object.values(joins)) {
    if (!join || !join.sourceLaneIds.includes(runtimeLaneId)) continue;
    const target = laneDisplayName(join.targetLaneId);
    if (join.kind === "final_publish") {
      publicationLabel = `publishes → ${target}`;
      continue;
    }
    joinLabel =
      join.status === "succeeded" ? `joined → ${target}` : `joins → ${target}`;
  }

  return { joinLabel, publicationLabel };
}

/**
 * The canvas's publication pill (design E1): one statement, for the whole run,
 * of which lanes publish into which lane and what the publish waits on.
 *
 * Separate from {@link LaneBandRuntime.publicationLabel}, which is the per-band
 * header line. A band can only say its own half of the relation ("publishes →
 * session", "publication target"); the pill states the relation itself, and
 * there is exactly one of it because a run has exactly one final publish.
 */
/**
 * Which of the four things the publish is doing. The view maps this to a tone;
 * keeping it a domain word rather than a colour is what lets the pill and the
 * band headers stay in one vocabulary.
 */
export type LaneBandPublicationState =
  | "pending"
  | "running"
  | "published"
  | "failed";

export interface LaneBandPublication {
  readonly sourceLaneNames: string[];
  readonly targetLaneName: string;
  readonly state: LaneBandPublicationState;
  /** What the publish is waiting on, how far it has got, or what happened. */
  readonly condition: string;
  /** The pill's single line — phrased once here, never re-assembled by a view. */
  readonly label: string;
}

function laneNameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function publicationState(status: string): LaneBandPublicationState {
  if (status === "succeeded") return "published";
  if (status === "running") return "running";
  if (status === "failed" || status === "conflicts") return "failed";
  return "pending";
}

/**
 * What the pill says after the arrow.
 *
 * `pending` is the only state that may name the precondition. Saying "after
 * every member completes" once the publish is running describes a condition
 * that has already been met, which reads as work that has not started — the
 * defect this vocabulary exists to fix.
 */
function publicationCondition(
  state: LaneBandPublicationState,
  publish: LaneBandJoin,
): string {
  switch (state) {
    case "published":
      return "published";
    case "running": {
      const merged = publish.mergedSourceLaneIds?.length ?? 0;
      return `${merged} of ${publish.sourceLaneIds.length} lanes merged`;
    }
    case "failed": {
      const files = publish.conflicts?.files.length ?? 0;
      return files > 0
        ? `${files} conflicted file${files === 1 ? "" : "s"}`
        : "merge failed";
    }
    case "pending":
      return "after every member completes";
  }
}

const PUBLICATION_PREFIX: Record<LaneBandPublicationState, string> = {
  pending: "publication",
  running: "publishing",
  published: "publication",
  failed: "publish failed",
};

export function deriveExecutionPublication(
  execution: LaneBandExecution,
): LaneBandPublication | null {
  let publish: LaneBandJoin | null = null;
  for (const join of Object.values(execution.joins ?? {})) {
    if (join && join.kind === "final_publish") publish = join;
  }
  if (publish === null) return null;

  const sourceLaneNames = publish.sourceLaneIds.map(laneDisplayName);
  const targetLaneName = laneDisplayName(publish.targetLaneId);
  const state = publicationState(publish.status);
  const condition = publicationCondition(state, publish);

  return {
    sourceLaneNames,
    targetLaneName,
    state,
    condition,
    label: `${PUBLICATION_PREFIX[state]}: ${laneNameList(sourceLaneNames)} → ${targetLaneName}, ${condition}`,
  };
}

export function deriveExecutionLaneBands(
  execution: LaneBandExecution,
): LaneBand[] {
  // Membership and runtime status come from the one owner of lane activity, so
  // the band cannot disagree with the lane rail about who is in a lane.
  const activities = deriveExecutionLaneActivities(execution);
  const activityByLane = new Map(
    activities.map((activity) => [activity.laneId, activity]),
  );

  const laneOfContext = new Map<string, string>();
  for (const activity of activities) {
    for (const member of activity.members) {
      laneOfContext.set(member.contextId, activity.laneId);
    }
  }

  const { laneNames, membersByLane } = orderMembership(
    execution.workingDefinition,
    laneOfContext,
  );
  const lanes = execution.executionLanes ?? {};
  const joins = execution.joins ?? {};

  return laneNames.map((laneName) => {
    const memberContextIds = membersByLane.get(laneName) ?? [];
    const activity = activityByLane.get(laneName);
    const runtimeLaneId = activity?.runtimeLaneId ?? laneName;
    const laneRecord = lanes[runtimeLaneId] ?? lanes[laneName];
    const reserved = isSessionLane(laneName) || activity?.kind === "session";
    const status = activity?.status ?? "pending";

    return {
      laneName,
      state: bandState(reserved, status),
      reserved,
      memberContextIds,
      memberCount: memberContextIds.length,
      membershipLabel: membershipLabel(memberContextIds.length),
      gradeSummary: gradeSummary(
        gradesOf(execution.workingDefinition, memberContextIds),
      ),
      runtime: {
        status,
        branchLabel: laneRecord?.branchName ?? null,
        // The session lane has no worktree of its own — it IS the session
        // worktree, and the header says so rather than showing an empty row.
        worktreeLabel: reserved
          ? "the session worktree"
          : (laneRecord?.worktreePath ?? null),
        ...joinLabels(joins, runtimeLaneId, reserved),
      },
    };
  });
}
