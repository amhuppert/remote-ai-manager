import { mutationValue } from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";

import type { GraphWorkflowExecutionRepository } from "./execution-repository";

import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import path from "node:path";
import { getEligibleContextIds } from "@/lib/workflow-graph/lane-readiness";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import { recordLandingIntent } from "@/lib/workflow-graph/route-runtime";

import {
  assertLoopFence,
  StaleLoopFenceError,
} from "@/lib/workflow-graph/loop-fence";
import { createKeyedMutex, type KeyedMutex } from "@/lib/shared/keyed-mutex";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

import { releaseLoopPassSlotsForContexts } from "@/lib/workflow-graph/loop-budgets";
import {
  classifyContextSchedulability,
  isRouteSourceLanded,
  type ContextSchedulability,
} from "@/lib/workflow-graph/lane-readiness";

import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";

import {
  deriveLaneWorktreePath,
  type ParallelWorktrees,
  type ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";

import {
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
  validateLaneId,
} from "@/lib/workflow-graph/lane-identity";
import {
  canonicalizeOwnership,
  classifyLaneAdmission,
  laneWorktreeExists,
  type CanonicalOwnership,
  type LaneOccupant,
} from "@/lib/workflow-graph/lane-admission";
import type { SessionState } from "@/lib/sessions/schemas";

import {
  buildLifecycleSnapshot,
  transitionContextStatus,
} from "@/lib/workflow-graph/context-transitions";

import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";

import { requireRunningExecution } from "./execution-transitions";

export interface ScheduleEligibleContextsInput {
  projectPath: string;
  sessionName: string;
  /**
   * Upper bound on the number of contexts this pass may schedule. Omit for
   * unbounded. The scheduler also forwards the running budget to the
   * classifier so each eligible context sees its own remaining capacity.
   */
  capacityRemaining?: number;
  /**
   * Contexts whose runners already hold an execution-loop lease. They may
   * still look dependency-eligible in the persisted snapshot while a parked
   * gate is resolving, but this scheduling pass must not reserve them again.
   */
  excludedContextIds?: readonly string[];
  /**
   * Whether the scheduler may place a context on the session worktree.
   * Defaults to `false`. When `false`, classifier results that would otherwise
   * land on the session lane are routed to a freshly forked worktree lane.
   */
  sessionLaneEnabled?: boolean;
}

export type ScheduleEligibleContextsOutcome =
  | { kind: "none" }
  | { kind: "solo"; contextId: string }
  | { kind: "parallel"; batchId: string; contextIds: string[] };

export interface ScheduleEligibleContextsResult {
  execution: GraphWorkflowExecution;
  scheduled: ScheduleEligibleContextsOutcome;
}
export interface ContextSchedulerDeps {
  executionRepository: Pick<
    GraphWorkflowExecutionRepository,
    "getActive" | "mutateActive"
  >;
  parallelWorktrees: ParallelWorktrees;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  now?(): string;
  createBatchId?(): string;
}

export interface ContextScheduler {
  scheduleEligibleContexts(
    input: ScheduleEligibleContextsInput,
  ): Promise<ScheduleEligibleContextsResult>;
}

function getNow(deps: Pick<ContextSchedulerDeps, "now">): string {
  return deps.now?.() ?? new Date().toISOString();
}

const logger = createLogger("graph-workflow-context-scheduler");

/**
 * Serializes a session's lane provisioning across LOOP GENERATIONS: the
 * retired generation and its replacement hold different manager references,
 * and a pause only signals the retired loop, so its scheduler can still be
 * cutting a worktree out of the lock when the replacement schedules the same
 * lane. Hosted on globalThis, like the active-loop registry, because Next.js
 * evaluates route handlers in separate module graphs: a module-level instance
 * would hand the loop the start route launched and the replacement the resume
 * route launches a mutex each, and the two would provision the lane
 * concurrently after all.
 */
const LANE_PROVISIONING_MUTEX_KEY =
  "__cc_graph_workflow_lane_provisioning_mutex" as const;

function laneProvisioningMutex(): KeyedMutex {
  return getGlobalSingleton(LANE_PROVISIONING_MUTEX_KEY, createKeyedMutex);
}

function laneProvisioningKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

function clearLaneStatesFor(
  execution: GraphWorkflowExecution,
  contextIds: readonly string[],
): string[] {
  const cleared: string[] = [];
  for (const contextId of contextIds) {
    if (execution.laneStates[contextId]) {
      cleared.push(contextId);
      delete execution.laneStates[contextId];
    }
  }
  return cleared;
}

/**
 * The envelope assumed for a context whose ownership was never frozen — a run
 * whose deps cannot resolve a session, and therefore cannot provision lanes
 * either. Full access is the fail-closed reading: it collides with every other
 * write-capable member, so such a context can only ever hold a lane alone.
 */
const UNKNOWN_OWNERSHIP: CanonicalOwnership = {
  mode: "full",
  canonicalPrefixes: [],
};

/**
 * Drop every lane reservation this batch owns. Owner-checked, like the
 * per-context stamp: a lane re-reserved by a concurrent batch carries a
 * different `batchId` and its claim must survive.
 */
function releaseLaneReservations(
  execution: GraphWorkflowExecution,
  batchId: string,
): void {
  for (const [laneId, reservation] of Object.entries(
    execution.laneReservations,
  )) {
    if (reservation.batchId !== batchId) continue;
    delete execution.laneReservations[laneId];
  }
}

/**
 * Find the upstream context whose laneId matches `laneId` and which is the
 * direct dependency of any of `contenders`. Used at fan-out to name the parent
 * a non-inheriting sibling forks from.
 */
function findUpstreamCompletedOnLane(
  contenders: readonly string[],
  laneId: string,
  execution: GraphWorkflowExecution,
): string | null {
  // Projection-resolved (decision D1), still walked in definition order: the
  // parent whose lane a contender may inherit is the EFFECTIVE source of an
  // ACTIVE incoming edge. A declined branch never committed anything on that
  // lane, so inheriting from it would continue work that does not exist.
  const contenderSet = new Set(contenders);
  for (const edge of projectExecutionRoutes(execution).edges) {
    if (!contenderSet.has(edge.targetContextId)) continue;
    if (edge.resolution.kind !== "active") continue;
    if (edge.effectiveSourceId === null) continue;
    const upstream = execution.contextStates[edge.effectiveSourceId];
    if (!upstream) continue;
    if (upstream.laneId !== laneId) continue;
    if (upstream.status !== "completed") continue;
    return edge.effectiveSourceId;
  }
  return null;
}

/**
 * Record how a just-dispatched context is going to land (D4 decision D8).
 *
 * The mode is read off the placement the dispatch just made, which is the only
 * point where the destination is known: a lane-bound context commits on its
 * lane, and a session-bound context commits solo.
 *
 * `baselineSha` stays null here: the lane head is resolved out of the write
 * queue, so the runner persists it as soon as it captures it — still before the
 * context's first turn (see `runContextTask`).
 */
function recordDispatchLandingIntent(
  execution: GraphWorkflowExecution,
  contextId: string,
  now: string,
): void {
  const state = execution.contextStates[contextId];
  if (!state) return;
  const placement = execution.workingDefinition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement;
  if (placement?.mode === "readOnly") return;
  if (state.laneId === null && state.isolation === "worktree") {
    throw new Error(`Worktree context "${contextId}" has no assigned lane`);
  }
  const mode = state.laneId !== null ? "lane_commit" : "solo_commit";
  recordLandingIntent(execution, contextId, {
    mode,
    laneId: state.laneId,
    worktreePath: state.worktreePath,
    now,
  });
}

export async function scheduleNextContext(
  deps: Pick<ContextSchedulerDeps, "executionRepository" | "now">,
  projectPath: string,
  sessionName: string,
): Promise<GraphWorkflowExecution> {
  const {
    execution: nextExecution,
    scheduledContextId,
    scheduledEligibleContextIds,
    scheduledClearedLanes,
  } = await deps.executionRepository
    .mutateActive(projectPath, sessionName, (execution) => {
      let scheduledContextId: string | null = null;
      let scheduledEligibleContextIds: string[] = [];
      let scheduledClearedLanes: string[] = [];

      const running = requireRunningExecution(execution);
      const eligibleContextIds = getEligibleContextIds(
        running.workingDefinition,
        running,
      );

      for (const contextId of eligibleContextIds) {
        if (!running.contextStates[contextId]) {
          continue;
        }

        transitionContextStatus(running, contextId, "ready", {
          reason: "manager.schedule_next_context.eligible",
        });
      }

      const nextContextId = eligibleContextIds[0] ?? null;
      running.activeContextIds = nextContextId ? [nextContextId] : [];
      if (nextContextId) {
        transitionContextStatus(running, nextContextId, "running", {
          reason: "manager.schedule_next_context.activate",
        });
        recordDispatchLandingIntent(running, nextContextId, getNow(deps));
        const clearedLanes = Object.keys(running.laneStates);
        running.laneStates = {};

        scheduledContextId = nextContextId;
        scheduledEligibleContextIds = eligibleContextIds;
        scheduledClearedLanes = clearedLanes;
      }

      running.machineSnapshot = buildLifecycleSnapshot(running, {
        lifecycleStatus: "running",
        recoveryMode: "none",
        hasLiveIteration: false,
      });
      return changed(running, {
        scheduledContextId,
        scheduledEligibleContextIds,
        scheduledClearedLanes,
      });
    })
    .then((mutation) => ({
      execution: mutation.execution,
      ...mutationValue(mutation),
    }));

  if (scheduledContextId) {
    logger.info("graph-workflow.context.scheduled", {
      executionId: nextExecution.id,
      nextContextId: scheduledContextId,
      eligibleContextIds: scheduledEligibleContextIds,
      clearedLanes: scheduledClearedLanes,
    });
    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("context.scheduled", {
      contextId: scheduledContextId,
      eligibleContextIds: scheduledEligibleContextIds,
      clearedLanes: scheduledClearedLanes,
    });
  }

  return nextExecution;
}
export function createContextScheduler(
  deps: ContextSchedulerDeps,
): ContextScheduler {
  /**
   * The session's worktree directory and branch — everything scheduling needs
   * from the session record. Resolved once per pass, BEFORE anything is
   * reserved, so a lookup failure aborts with no state to compensate.
   *
   * Returns null when the session itself is gone. Absence is refused when a pass
   * actually needs to provision, not here: this runs on EVERY pass, including
   * passes with nothing eligible, and a session deleted out from under a
   * winding-down execution should leave those passes a quiet no-op rather than
   * a throw.
   */
  async function resolveSessionTargets(
    projectPath: string,
    sessionName: string,
  ): Promise<{
    sessionDir: string;
    sessionBranch: string;
    sessionWorktreePath: string;
  } | null> {
    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return null;
    return {
      sessionDir: path.basename(session.worktreePath),
      sessionBranch: session.branchName,
      sessionWorktreePath: session.worktreePath,
    };
  }

  async function scheduleEligibleContexts(
    input: ScheduleEligibleContextsInput,
  ): Promise<ScheduleEligibleContextsResult> {
    const { projectPath, sessionName } = input;
    const excludedContextIds = new Set(input.excludedContextIds ?? []);
    // Session-lane participation is opt-in per the accepted orchestration
    // design (decision 10). Default off keeps every parallel chain on its
    // own worktree lane and merges into the session branch only at final
    // publish. Callers that have validated the dirty-worktree and
    // concurrent-job preconditions can opt in by passing `true`.
    const sessionLaneEnabled = input.sessionLaneEnabled ?? false;
    const initialCapacity = input.capacityRemaining;

    type LaneCreatedDecision = {
      laneId: string;
      contextId: string;
      branchName: string;
      worktreePath: string;
      kind: "worktree";
    };
    type LaneForkedDecision = {
      newLaneId: string;
      contextId: string;
      parentLaneId: string;
      parentContextId: string;
      parentBranchName: string;
      branchName: string;
      worktreePath: string;
    };
    type LaneReusedDecision = {
      laneId: string;
      contextId: string;
      branchName: string | null;
      worktreePath: string | null;
      kind: "session" | "worktree";
    };
    const laneCreatedDecisions: LaneCreatedDecision[] = [];
    const laneForkedDecisions: LaneForkedDecision[] = [];
    const laneReusedDecisions: LaneReusedDecision[] = [];
    type SchedulableEntry = {
      contextId: string;
      /**
       * The runtime lane id this context is placed on — its AUTHORED lane name,
       * or `SESSION_LANE_ID` for the reserved session lane. Resolved once here,
       * where the definition is in hand, so the out-of-lock provisioning and the
       * finalize mutation address the lane by the same id.
       *
       * Not the context id: a context id accepts any non-empty string while a
       * lane name is spliced into a git branch and a worktree path, and a
       * pre-placement definition's migrated lane (R11.1) is the sanitized
       * encoding of an id that may itself be illegal there.
       */
      laneId: string;
      classification: Extract<ContextSchedulability, { kind: "schedulable" }>;
      /** The envelope this context was admitted under, frozen before reserve. */
      ownership: CanonicalOwnership | null;
      // Set on the entry that MINTS the lane: the lane is provisioned once, from
      // this base, and every other member of the same lane in this batch simply
      // joins the record it produces.
      mint: {
        /** Lane whose committed head the new lane branches from; null = session. */
        sourceLaneId: string | null;
        parentBranchName: string;
        parentContextId: string | null;
        includedContextIds: string[];
      } | null;
    };
    // Routing plan captured by the sync `reserve` mutation below and consumed by
    // the out-of-lock provisioning + the sync `finalize` mutation. `null` means
    // reserve resolved a terminal outcome (none / solo-session) with no worktree
    // work to stage. The reservation returns this plan with its committed state.
    type ProvisionPlan = {
      schedulableEntries: SchedulableEntry[];
      provisionEntries: SchedulableEntry[];
      batchId: string;
    };

    // ── Stage 0: canonicalize OUTSIDE the write queue (decision D4) ──
    //
    // Resolving a placement's owned prefixes to canonical paths is filesystem
    // I/O, and the reservation reducer runs on the synchronous write-queue
    // entry where no I/O is allowed. So the realpath work happens here, against
    // the pre-scheduling snapshot, and hands the reducer an IMMUTABLE canonical
    // set per candidate. The reducer then compares frozen sets — which is what
    // makes the admission decision atomic against co-candidates and against a
    // concurrent scheduler — and the set it admitted on is the set persisted for
    // dispatch, so nothing between here and the turn can widen the envelope.
    //
    // A candidate with no frozen set (deps that cannot resolve a session, which
    // is also a scheduler that cannot provision lanes) is treated as needing the
    // lane to itself, the fail-closed reading.
    const frozenOwnership = new Map<string, CanonicalOwnership>();
    // Freezes taken against a lane worktree that did not exist yet, keyed by
    // context: provisional until the worktree is checked out (decision D4).
    const provisionalFreezes = new Map<
      string,
      { placement: ContextPlacement; laneWorktreePath: string }
    >();
    // Candidates whose canonical envelope could not be resolved at all. Held
    // apart from "no freeze taken" so the reducer can refuse them outright
    // instead of reading them as full access.
    const unresolvableOwnership = new Set<string>();
    const sessionTargets = await resolveSessionTargets(
      projectPath,
      sessionName,
    );
    if (sessionTargets) {
      const snapshot = await deps.executionRepository.getActive(
        projectPath,
        sessionName,
      );
      if (snapshot) {
        for (const contextId of getEligibleContextIds(
          snapshot.workingDefinition,
          snapshot,
        ).filter((contextId) => !excludedContextIds.has(contextId))) {
          const context = snapshot.workingDefinition.executionContexts.find(
            (context) => context.id === contextId,
          );
          const placement = context?.placement;
          if (!placement) continue;
          const laneId =
            placement.lane === SESSION_LANE_NAME
              ? SESSION_LANE_ID
              : placement.lane;
          const laneWorktreePath =
            snapshot.executionLanes[laneId]?.worktreePath ??
            (laneId === SESSION_LANE_ID
              ? sessionTargets.sessionWorktreePath
              : deriveLaneWorktreePath({
                  projectPath,
                  sessionDir: sessionTargets.sessionDir,
                  laneId,
                }));
          try {
            frozenOwnership.set(
              contextId,
              canonicalizeOwnership({
                placement,
                laneWorktreePath,
                stableRead: context?.outputSchema !== undefined,
              }),
            );
          } catch (error) {
            // The envelope could not be resolved — an unreadable ancestor, an
            // unterminating symlink chain, a prefix escaping the worktree. This
            // is NOT the same as "no freeze was taken" (the no-session case
            // below), which reads as full access: a candidate whose canonical
            // set is unknown must not be admitted at all, because there is
            // nothing to prove it disjoint from anyone. Refusing only this
            // candidate leaves lanes whose envelopes did resolve free to
            // proceed, and the next pass re-probes.
            unresolvableOwnership.add(contextId);
            logger.warn("graph-workflow.scheduler.ownership_freeze_failed", {
              executionId: snapshot.id,
              contextId,
              laneId,
              error: getErrorMessage(error),
            });
            continue;
          }
          // A freeze taken before the lane worktree exists resolved nothing;
          // it is re-taken after provisioning, below, and re-judged before
          // anyone starts.
          if (!laneWorktreeExists(laneWorktreePath)) {
            provisionalFreezes.set(contextId, { placement, laneWorktreePath });
          }
        }
      }
    }

    // Staged protocol (Design 3.1): worktree provisioning (`provisionLane`) —
    // the ~20.8s hold — runs OUTSIDE the write queue between a short synchronous
    // `reserve` mutation (classify + record `ready` intent, fenced) and a short
    // synchronous `finalize` mutation (apply the lane state, fence + halt
    // re-checked, else compensate by disposing the worktrees).
    const reservedSchedule = await deps.executionRepository
      .mutateActive(projectPath, sessionName, (execution) => {
        const observations: Array<{
          level: "info" | "warn";
          event: string;
          data: Record<string, unknown>;
        }> = [];

        const outcome: { value: ScheduleEligibleContextsOutcome } = {
          value: { kind: "none" },
        };
        let readySetEligibleContextIds: string[] = [];
        let scheduledClearedLanes: string[] = [];
        const provisionPlan: { value: ProvisionPlan | null } = { value: null };

        const running = requireRunningExecution(execution);

        // Enforce no-new-scheduling-after-pending-halt at the transaction
        // boundary. The outer event-driven loop checks pendingHaltReason
        // against its local snapshot, but an in-flight sibling may record a
        // halt concurrently between the loop's refresh and this scheduling
        // mutation. Reading pendingHaltReason from the latest persisted
        // execution inside the repository transaction is the only way to
        // guarantee the invariant holds under event-driven rescheduling.
        if (running.pendingHaltReason !== null) {
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "none" };
          return changed(running, {
            observations,
            outcome,
            readySetEligibleContextIds,
            scheduledClearedLanes,
            provisionPlan,
          });
        }

        const eligibleContextIds = getEligibleContextIds(
          running.workingDefinition,
          running,
        ).filter((contextId) => !excludedContextIds.has(contextId));
        readySetEligibleContextIds = [...eligibleContextIds];

        if (eligibleContextIds.length === 0) {
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "none" };
          return changed(running, {
            observations,
            outcome,
            readySetEligibleContextIds,
            scheduledClearedLanes,
            provisionPlan,
          });
        }

        for (const contextId of eligibleContextIds) {
          if (running.contextStates[contextId]) {
            transitionContextStatus(running, contextId, "ready", {
              reason: "manager.schedule_eligible_contexts.eligible",
            });
          }
        }

        // Lane-aware routing: classify each eligible context. The classifier
        // separates dependency-ready, lane-safe contexts from those still
        // waiting on a join, busy lane, or capacity. Wait-state contexts stay
        // in status `ready` so the UI surfaces them but are not provisioned.
        //
        // `targetLaneId` on a schedulable result is the existing lane to
        // consume (null = session worktree); `requiresFork` indicates the
        // session lane is unsafe (either disabled by caller or another
        // worktree lane has unpublished work) so the scheduler must mint a
        // fresh worktree lane instead.
        const schedulableEntries: SchedulableEntry[] = [];
        // Reserved-but-not-running contexts count against the query budget: the
        // caller's remaining capacity was computed from what is IN FLIGHT under
        // its own loop, and a sibling batch's reservations are turns that are
        // about to start but have not been dispatched yet (decision D4).
        const foreignReservedCount = Object.values(
          running.laneReservations,
        ).reduce((total, reservation) => total + reservation.members.length, 0);
        let remainingCapacity =
          initialCapacity === undefined
            ? undefined
            : Math.max(0, initialCapacity - foreignReservedCount);
        // The one place a context's authored lane name is read. Every lane this
        // pass validates, provisions, or keys uses this rather than the context
        // id: the two coincide for a context whose id is already a legal lane
        // segment, and diverge exactly where they must — an authored group lane,
        // and a pre-placement context whose migrated lane is the sanitized
        // encoding of an id that is not spliceable into a branch or a path.
        const authoredLaneOf = (contextId: string): string | undefined =>
          running.workingDefinition.executionContexts.find(
            (ctx) => ctx.id === contextId,
          )?.placement.lane;
        type Candidate = {
          contextId: string;
          classification: Extract<
            ContextSchedulability,
            { kind: "schedulable" }
          >;
        };
        const candidates: Candidate[] = [];
        for (const contextId of eligibleContextIds) {
          const classification = classifyContextSchedulability({
            contextId,
            definition: running.workingDefinition,
            execution: running,
            options: {
              sessionLaneEnabled,
            },
          });
          if (classification.kind !== "schedulable") continue;
          candidates.push({ contextId, classification });
        }

        // ── Reservation reducer: the atomic half of admission (decision D4) ──
        //
        // Occupancy per lane, over the three populations that can collide with a
        // candidate: members RUNNING on the lane (their own frozen envelope), a
        // sibling batch's reservations, and candidates admitted earlier in THIS
        // pass. All three are compared as frozen canonical sets, so no ordering
        // of concurrent schedulers can admit two contexts whose write surfaces
        // touch.
        const occupantsByLane = new Map<string, LaneOccupant[]>();
        const occupantsOf = (laneId: string): LaneOccupant[] => {
          const known = occupantsByLane.get(laneId);
          if (known) return known;
          const occupants: LaneOccupant[] = [];
          for (const state of Object.values(running.contextStates)) {
            if (
              (state.laneId ??
                (state.isolation === "session" ? SESSION_LANE_ID : null)) !==
              laneId
            )
              continue;
            if (
              state.status !== "running" &&
              !(
                state.status === "completed" &&
                !isRouteSourceLanded(running, state.contextId)
              )
            )
              continue;
            occupants.push({
              contextId: state.contextId,
              ownership: state.reservedOwnership ?? UNKNOWN_OWNERSHIP,
            });
          }
          for (const member of running.laneReservations[laneId]?.members ??
            []) {
            occupants.push(member);
          }
          occupantsByLane.set(laneId, occupants);
          return occupants;
        };
        // Lanes this pass will MINT, and the entry that mints each one. A lane
        // is one worktree for the whole execution, so the first admitted member
        // provisions it and every later member of the same lane in this pass
        // coalesces onto the record it produces (decision D5).
        const mintedByLane = new Map<string, SchedulableEntry>();
        for (const candidate of candidates) {
          const { contextId, classification } = candidate;
          if (remainingCapacity !== undefined && remainingCapacity <= 0) break;
          // Fail closed rather than falling back to the context id: a context
          // the definition does not carry has no authored lane, and inventing
          // one from its id is the lexical fallback lane-write-policy forbids.
          const laneName = authoredLaneOf(contextId);
          if (laneName === undefined) {
            throw new Error(
              `Context "${contextId}" is not present in the working definition, so it has no authored lane placement`,
            );
          }
          const laneId =
            laneName === SESSION_LANE_NAME ? SESSION_LANE_ID : laneName;

          // No canonical set, no admission. The stage-0 probe could not decide
          // what this candidate would write, and an envelope that cannot be
          // resolved cannot be proven disjoint from anyone.
          if (unresolvableOwnership.has(contextId)) continue;

          const ownership = frozenOwnership.get(contextId) ?? null;
          const verdict = classifyLaneAdmission({
            candidate: ownership ?? UNKNOWN_OWNERSHIP,
            occupants: occupantsOf(laneId),
          });
          if (verdict.kind === "refuse") {
            observations.push({
              level: "info",
              event: "graph-workflow.scheduler.lane_admission_refused",
              data: {
                executionId: running.id,
                contextId,
                laneId,
                reason: verdict.reason,
                blockingContextId: verdict.blockingContextId,
              },
            });
            continue;
          }

          // Minting. `requiresFork` with no existing lane record means the
          // authored lane has to be provisioned; a sibling batch already
          // provisioning it makes this candidate wait for the pass where the
          // lane exists, rather than racing `git worktree add` for one path.
          const mintsLane =
            classification.targetLaneId === null &&
            classification.requiresFork &&
            laneId !== SESSION_LANE_ID;
          let mint: SchedulableEntry["mint"] = null;
          if (mintsLane) {
            if (running.laneReservations[laneId] !== undefined) continue;
            if (!mintedByLane.has(laneId)) {
              // Fail closed at the point provisioning is actually required: no
              // session means no branch to fork from and no path to place the
              // worktree at, and inventing either is how a lane ends up
              // somewhere its execution does not own.
              if (!sessionTargets) {
                throw new Error(
                  `Cannot provision lane "${laneId}": session "${sessionName}" was not found`,
                );
              }
              const sourceLaneId = classification.forkFromLaneId;
              const parentLane =
                sourceLaneId === null
                  ? undefined
                  : running.executionLanes[sourceLaneId];
              mint = {
                sourceLaneId: parentLane ? sourceLaneId : null,
                includedContextIds: [
                  ...(parentLane?.includedContextIds ??
                    running.executionLanes[SESSION_LANE_ID]
                      ?.includedContextIds ??
                    []),
                ],
                parentBranchName:
                  parentLane?.branchName ?? sessionTargets.sessionBranch,
                parentContextId:
                  sourceLaneId !== null && parentLane
                    ? findUpstreamCompletedOnLane(
                        [contextId],
                        sourceLaneId,
                        running,
                      )
                    : null,
              };
            }
          }

          const entry: SchedulableEntry = {
            contextId,
            laneId,
            classification,
            ownership,
            mint,
          };
          schedulableEntries.push(entry);
          if (mintsLane && !mintedByLane.has(laneId)) {
            mintedByLane.set(laneId, entry);
          }
          occupantsOf(laneId).push({
            contextId,
            ownership: ownership ?? UNKNOWN_OWNERSHIP,
          });
          if (remainingCapacity !== undefined) {
            remainingCapacity = Math.max(0, remainingCapacity - 1);
          }
        }

        if (schedulableEntries.length === 0) {
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "none" };
          return changed(running, {
            observations,
            outcome,
            readySetEligibleContextIds,
            scheduledClearedLanes,
            provisionPlan,
          });
        }

        // Whether the context's AUTHORED lane is a group lane — anything but
        // the reserved session lane, which is the session worktree itself.
        //
        // This is where the deleted plan's continuation score used to sit, and
        // the declared answer subsumes it: a context on a group lane needs that
        // lane provisioned, both for its own work and because every later
        // member of the lane inherits the worktree it mints. Without it the
        // first member would land in `laneId: null` and the next member's
        // classifier would see no worktree source lane to reuse.
        const laneIsGroupLane = (contextId: string): boolean => {
          const lane = authoredLaneOf(contextId);
          return lane !== undefined && lane !== SESSION_LANE_NAME;
        };

        const soloEntry =
          schedulableEntries.length === 1 ? schedulableEntries[0]! : null;
        const isSoloSession =
          soloEntry !== null &&
          soloEntry.classification.targetLaneId === null &&
          !soloEntry.classification.requiresFork &&
          !laneIsGroupLane(soloEntry.contextId);

        if (isSoloSession && soloEntry) {
          const soloContextId = soloEntry.contextId;
          const contextState = running.contextStates[soloContextId]!;
          transitionContextStatus(running, soloContextId, "running", {
            reason: "manager.schedule_eligible_contexts.solo_session",
          });
          contextState.isolation = "session";
          contextState.worktreePath = null;
          contextState.branchName = null;
          contextState.batchId = null;
          contextState.laneId = null;
          recordDispatchLandingIntent(running, soloContextId, getNow(deps));

          const activeIdSet = new Set(running.activeContextIds);
          activeIdSet.add(soloContextId);
          running.activeContextIds = [...activeIdSet];

          const clearedLanes = clearLaneStatesFor(running, [soloContextId]);
          scheduledClearedLanes = clearedLanes;

          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "solo", contextId: soloContextId };
          return changed(running, {
            observations,
            outcome,
            readySetEligibleContextIds,
            scheduledClearedLanes,
            provisionPlan,
          });
        }

        // The lane id is what gets spliced into a branch name and a worktree
        // path, so that is what must satisfy the charset. Validating the context
        // id here would refuse a pre-placement context whose migrated lane is
        // legal precisely because the id was not (R11.1). The session lane is
        // exempt: it is never spliced into anything, being the session worktree.
        for (const entry of schedulableEntries) {
          if (entry.laneId !== SESSION_LANE_ID) validateLaneId(entry.laneId);
        }

        // Reserve records the routing intent AND persists two owner-discriminated
        // reservations (Design 3.1, decision D5). Per CONTEXT: the batch id it
        // will provision under — `getEligibleContextIds` excludes a stamped
        // context, so a concurrent same-epoch scheduler cannot re-classify and
        // double-provision it. Per LANE: the batch id plus the frozen ownership
        // of every member this pass admitted — which is how a concurrent
        // scheduler sees a lane that is mid-provision (and must not race
        // `git worktree add` for it) and judges its own candidates against write
        // surfaces that are claimed but not yet running. Both are cleared at the
        // fenced finalize, out of the lock, or by the compensating release.
        const batchId = deps.createBatchId?.() ?? randomUUID();
        const reservedAt = getNow(deps);
        for (const entry of schedulableEntries) {
          const contextState = running.contextStates[entry.contextId];
          if (contextState) {
            contextState.reservedByBatchId = batchId;
            contextState.reservedOwnership = entry.ownership;
          }
          const reservation = (running.laneReservations[entry.laneId] ??= {
            laneId: entry.laneId,
            batchId,
            provisioning: false,
            members: [],
            createdAt: reservedAt,
          });
          reservation.provisioning ||= entry.mint !== null;
          reservation.members.push({
            contextId: entry.contextId,
            ownership: entry.ownership ?? UNKNOWN_OWNERSHIP,
          });
        }
        running.machineSnapshot = buildLifecycleSnapshot(running, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
        provisionPlan.value = {
          schedulableEntries,
          // Exactly the lane-minting entries: one worktree per lane, however
          // many members of that lane this batch admitted (decision D5).
          provisionEntries: schedulableEntries.filter(
            (entry) => entry.mint !== null,
          ),
          batchId,
        };
        return changed(running, {
          observations,
          outcome,
          readySetEligibleContextIds,
          scheduledClearedLanes,
          provisionPlan,
        });
      })
      .then((mutation) => {
        const value = mutationValue(mutation);
        for (const observation of value.observations)
          logger[observation.level](observation.event, observation.data);
        return { execution: mutation.execution, ...mutationValue(mutation) };
      });

    // Terminal outcomes (none / solo-session) are fully applied by reserve; only
    // a routing plan warrants the out-of-lock provisioning + fenced finalize.
    let {
      execution: nextExecution,
      outcome,
      scheduledClearedLanes,
    } = reservedSchedule;
    const { readySetEligibleContextIds, provisionPlan } = reservedSchedule;
    const plan = provisionPlan.value;
    if (plan !== null) {
      const { schedulableEntries, provisionEntries, batchId } = plan;

      // Compensating release of the reserve's owner-discriminated stamps.
      // DEFINED BEFORE any post-reserve work (session lookup, provisioning) can
      // throw so EVERY failure path after the reserve commits releases
      // `reservedByBatchId` — a `getSession` rejection/null (or a missing-dep
      // throw) must not strand the stamps and leave the contexts permanently
      // ineligible for a same-epoch retry (Design 3.1). A short sync mutation;
      // if this generation was already superseded the write is fenced out and
      // the stamps belong to a dead generation anyway, so a stale-fence refusal
      // is swallowed. OWNER-CHECKED: only a stamp this batch still owns is
      // cleared — a concurrent same-epoch batch that re-reserved the context
      // carries a different `batchId` and its reservation must survive.
      const releaseReservations = async (): Promise<void> => {
        try {
          await deps.executionRepository
            .mutateActive(projectPath, sessionName, (execution) => {
              const observations: Array<{
                level: "info" | "warn";
                event: string;
                data: Record<string, unknown>;
              }> = [];

              const running = requireRunningExecution(execution);
              const releasedContextIds: string[] = [];
              for (const entry of schedulableEntries) {
                const contextState = running.contextStates[entry.contextId];
                if (contextState?.reservedByBatchId === batchId) {
                  contextState.reservedByBatchId = null;
                  contextState.reservedOwnership = null;
                  releasedContextIds.push(entry.contextId);
                }
              }
              releaseLaneReservations(running, batchId);
              // A batch that never formed also gives back the shared pass slots
              // of any loop pass it was going to start (decision D7): the
              // reservation is durable, so keeping it would charge the
              // execution's 25-pass backstop for a pass no lane exists for. The
              // retry re-reserves through the same definition-ordered admission
              // walk, and a released slot is reusable meanwhile.
              const releasedSlots = releaseLoopPassSlotsForContexts(
                running,
                releasedContextIds,
              );
              if (releasedSlots.length > 0) {
                observations.push({
                  level: "info",
                  event: "graph-workflow.loop.pass_slot_released",
                  data: {
                    executionId: running.id,
                    slots: releasedSlots,
                  },
                });
              }
              return changed(running, { observations });
            })
            .then((mutation) => {
              const value = mutationValue(mutation);
              for (const observation of value.observations)
                logger[observation.level](observation.event, observation.data);
              return mutation.execution;
            });
        } catch (err) {
          if (!(err instanceof StaleLoopFenceError)) throw err;
        }
      };

      const { parallelWorktrees, sessionDir, sessionBranch } =
        await (async () => {
          const parallelWorktreesDep = deps.parallelWorktrees;
          if (!sessionTargets) {
            throw new Error(
              "Cannot provision lanes without a session worktree",
            );
          }
          return {
            parallelWorktrees: parallelWorktreesDep,
            sessionDir: sessionTargets.sessionDir,
            sessionBranch: sessionTargets.sessionBranch,
          };
        })().catch(async (err: unknown) => {
          await releaseReservations();
          throw err;
        });

      // Worktrees to dispose if the finalize is refused (superseded fence) or a
      // halt lands mid-provision — this caller's worktree-side-effect
      // compensation story.
      const provisioned: Array<{
        entry: SchedulableEntry;
        result: ProvisionResult;
      }> = [];
      // Best-effort disposal: a `disposeLane` rejection on one lane must NOT
      // abort disposal of the remaining lanes nor skip the reservation release
      // that follows. Failures are collected and returned so the caller can
      // report them; this never throws.
      const disposeProvisioned = async (): Promise<
        Array<{ branchName: string; error: unknown }>
      > => {
        const failures: Array<{ branchName: string; error: unknown }> = [];
        for (const { result } of provisioned) {
          try {
            await parallelWorktrees.disposeLane({
              projectPath,
              worktreePath: result.worktreePath,
              branchName: result.branchName,
            });
          } catch (error) {
            failures.push({ branchName: result.branchName, error });
          }
        }
        return failures;
      };

      // Compensate a failed/superseded schedule: dispose every provisioned lane
      // best-effort, then GUARANTEE the owner-checked reservation release (it
      // runs even when a lane disposal failed), then report any disposal
      // failures. Never throws — the callers preserve the original scheduling
      // error with their own `throw`. A genuine (non-fence) release failure is
      // reported rather than masking that original error.
      const compensateSchedule = async (): Promise<void> => {
        const disposalFailures = await disposeProvisioned();
        try {
          await releaseReservations();
        } catch (releaseError) {
          logger.error("graph-workflow.scheduler.reservation_release_failed", {
            error:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        }
        if (disposalFailures.length > 0) {
          logger.warn("graph-workflow.scheduler.lane_dispose_failed", {
            failedLaneBranches: disposalFailures.map((f) => f.branchName),
          });
        }
      };

      // One provisioning critical section per session, shared across loop
      // generations (on globalThis, like the loop registry): a pause only
      // signals the retired loop, so its scheduler can still be inside
      // `git worktree add` when the operator resumes and the replacement
      // generation reserves the same lane. Serializing provision-through-
      // finalize keeps the two apart: the retired batch finishes, its fenced
      // finalize disposes what it cut, and only then does the successor
      // provision. So the successor never adopts a worktree the retired batch
      // is about to dispose and never races it for one path (#80, design 3.8).
      await laneProvisioningMutex().run(
        laneProvisioningKey(projectPath, sessionName),
        async () => {
          // Slow worktree provisioning OUTSIDE the write queue. A failure disposes
          // the lanes already created in this pass, releases the reservations, and
          // aborts scheduling.
          try {
            // Re-judge the generation before touching disk. A pause that landed
            // between this batch's reserve and its turn in the critical section
            // has retired it; provisioning anyway would cut a worktree that only
            // the fenced finalize can dispose, after a successor may have adopted
            // it. The refusal takes the compensation path below: nothing was
            // provisioned, and the release fences out like every other write.
            assertLoopFence(
              projectPath,
              sessionName,
              await deps.executionRepository.getActive(
                projectPath,
                sessionName,
              ),
            );
            for (const entry of provisionEntries) {
              const result = await parallelWorktrees.provisionLane({
                projectPath,
                sessionName,
                sessionDir,
                sessionBranch: entry.mint?.parentBranchName ?? sessionBranch,
                laneId: entry.laneId,
              });
              provisioned.push({ entry, result });
            }
          } catch (err) {
            await compensateSchedule();
            throw err;
          }

          // ── Re-freeze what could only be guessed before the worktree existed ──
          //
          // Stage 0 canonicalized a to-be-minted lane's prefixes against a path
          // `git worktree add` had not created, so they were appended lexically.
          // Checking the source branch out is exactly the step that can turn two
          // lexically disjoint prefixes into one directory — a symlink committed on
          // that branch — so the pre-provision freeze cannot be the set anyone is
          // admitted under. Re-take it here, still OUTSIDE the write queue (this is
          // realpath I/O), and let the finalize reducer re-judge the frozen results
          // atomically. A canonicalization that now throws (a prefix escaping the
          // checked-out worktree) fails the whole batch closed rather than starting
          // a turn under an envelope that could not be resolved.
          const recanonicalized = new Map<string, CanonicalOwnership>();
          if (provisionalFreezes.size > 0) {
            const provisionedPathByLane = new Map<string, string>();
            for (const { entry, result } of provisioned) {
              provisionedPathByLane.set(entry.laneId, result.worktreePath);
            }
            try {
              for (const entry of schedulableEntries) {
                const staged = provisionalFreezes.get(entry.contextId);
                if (!staged) continue;
                recanonicalized.set(
                  entry.contextId,
                  canonicalizeOwnership({
                    placement: staged.placement,
                    stableRead: frozenOwnership.get(entry.contextId)
                      ?.stableRead,
                    laneWorktreePath:
                      provisionedPathByLane.get(entry.laneId) ??
                      staged.laneWorktreePath,
                  }),
                );
              }
            } catch (err) {
              await compensateSchedule();
              throw err;
            }
          }

          // Fenced finalize: a short synchronous mutation that re-checks the loop
          // fence (inside the repository's `mutateActive`) and the pending-halt
          // state before committing the running/lane transition. If this generation
          // was superseded or a halt landed while provisioning was in flight, the
          // provisioned worktrees are disposed as compensation.
          const finalizedSchedule = await deps.executionRepository
            .mutateActive(projectPath, sessionName, (execution) => {
              const observations: Array<{
                level: "info" | "warn";
                event: string;
                data: Record<string, unknown>;
              }> = [];

              const outcome: { value: ScheduleEligibleContextsOutcome } = {
                value: { kind: "none" },
              };
              let compensate = false;
              const laneForkedDecisions: LaneForkedDecision[] = [];
              const laneCreatedDecisions: LaneCreatedDecision[] = [];
              const laneReusedDecisions: LaneReusedDecision[] = [];
              let scheduledClearedLanes: string[] = [];

              const running = requireRunningExecution(execution);

              // A halt recorded during provisioning supersedes this schedule: do
              // not start the contexts; commit only the halt-aware snapshot and
              // dispose the provisioned worktrees below. Clear the reservation stamps
              // so the contexts are re-schedulable once the halt clears — the batch
              // never formed (Design 3.1).
              if (running.pendingHaltReason !== null) {
                for (const entry of schedulableEntries) {
                  const contextState = running.contextStates[entry.contextId];
                  // Owner-checked like every other release: a stamp reassigned to a
                  // replacement batch while this one was provisioning is that
                  // batch's claim, and clearing it here would strand a context this
                  // batch no longer owns.
                  if (contextState?.reservedByBatchId === batchId) {
                    contextState.reservedByBatchId = null;
                    contextState.reservedOwnership = null;
                  }
                }
                releaseLaneReservations(running, batchId);
                running.machineSnapshot = buildLifecycleSnapshot(running, {
                  lifecycleStatus: "running",
                  recoveryMode: "none",
                  hasLiveIteration: false,
                });
                outcome.value = { kind: "none" };
                compensate = true;
                return changed(running, {
                  observations,
                  outcome,
                  compensate,
                  laneForkedDecisions,
                  laneCreatedDecisions,
                  laneReusedDecisions,
                  scheduledClearedLanes,
                });
              }

              // Re-judge the batch on the re-taken freezes, atomically. Only the
              // comparison happens here — the realpath work is already done — so
              // the reducer stays synchronous. A member refused now was admitted on
              // a prefix set the checkout invalidated: it keeps no lane, gives back
              // its stamp, and stays eligible. Its next pass canonicalizes against
              // the worktree that now exists, so the collision is visible up front
              // and the refusal is stable rather than a livelock.
              // Owner fence on the per-context stamp, the twin of the one
              // `releaseLaneReservations` applies to the lane claim (decision D5).
              // A context whose stamp is no longer this batch's was taken over
              // while provisioning was in flight — by reservation recovery or a
              // replacement batch. Starting it here would run it under a plan its
              // current owner did not make, and clearing the stamp would erase that
              // owner's claim, so it is dropped untouched.
              // Both halves of the claim are fenced, because either can be replaced
              // while provisioning is in flight and each alone is insufficient: the
              // context stamp says this batch may still start THIS context, and the
              // lane claim says it may still materialize and occupy THAT lane. The
              // owner-checked delete afterwards is cleanup, not an admission fence —
              // without the lane half, a batch whose claim was replaced would still
              // create the lane record and start its members on it.
              const disownedContextIds = new Set<string>();
              for (const entry of schedulableEntries) {
                const stampLost =
                  running.contextStates[entry.contextId]?.reservedByBatchId !==
                  batchId;
                const laneClaim = running.laneReservations[entry.laneId];
                const laneLost =
                  laneClaim === undefined || laneClaim.batchId !== batchId;
                if (!stampLost && !laneLost) continue;
                disownedContextIds.add(entry.contextId);
                // Give back only what is still ours. A stamp this batch still holds
                // has to be released or the context is stranded ineligible; a stamp
                // already reassigned belongs to its new owner and is left alone.
                if (!stampLost) {
                  const contextState = running.contextStates[entry.contextId];
                  if (contextState) {
                    contextState.reservedByBatchId = null;
                    contextState.reservedOwnership = null;
                  }
                }
                observations.push({
                  level: "warn",
                  event: "graph-workflow.scheduler.reservation_disowned",
                  data: {
                    executionId: running.id,
                    contextId: entry.contextId,
                    laneId: entry.laneId,
                    batchId,
                    stampLost,
                    laneLost,
                  },
                });
              }

              const refusedContextIds = new Set<string>();
              if (recanonicalized.size > 0) {
                const finalizeOccupants = new Map<string, LaneOccupant[]>();
                const finalizeOccupantsOf = (
                  laneId: string,
                ): LaneOccupant[] => {
                  const known = finalizeOccupants.get(laneId);
                  if (known) return known;
                  const occupants: LaneOccupant[] = [];
                  for (const state of Object.values(running.contextStates)) {
                    if (
                      (state.laneId ??
                        (state.isolation === "session"
                          ? SESSION_LANE_ID
                          : null)) !== laneId
                    )
                      continue;
                    if (
                      state.status !== "running" &&
                      !(
                        state.status === "completed" &&
                        !isRouteSourceLanded(running, state.contextId)
                      )
                    )
                      continue;
                    occupants.push({
                      contextId: state.contextId,
                      ownership: state.reservedOwnership ?? UNKNOWN_OWNERSHIP,
                    });
                  }
                  finalizeOccupants.set(laneId, occupants);
                  return occupants;
                };
                for (const entry of schedulableEntries) {
                  if (disownedContextIds.has(entry.contextId)) continue;
                  const ownership =
                    recanonicalized.get(entry.contextId) ??
                    entry.ownership ??
                    UNKNOWN_OWNERSHIP;
                  const occupants = finalizeOccupantsOf(entry.laneId);
                  const verdict = classifyLaneAdmission({
                    candidate: ownership,
                    occupants,
                  });
                  if (verdict.kind === "refuse") {
                    refusedContextIds.add(entry.contextId);
                    const contextState = running.contextStates[entry.contextId];
                    if (contextState) {
                      contextState.reservedByBatchId = null;
                      contextState.reservedOwnership = null;
                    }
                    observations.push({
                      level: "info",
                      event:
                        "graph-workflow.scheduler.lane_admission_refused_post_provision",
                      data: {
                        executionId: running.id,
                        contextId: entry.contextId,
                        laneId: entry.laneId,
                        reason: verdict.reason,
                        blockingContextId: verdict.blockingContextId,
                      },
                    });
                    continue;
                  }
                  occupants.push({ contextId: entry.contextId, ownership });
                }
              }
              const admittedEntries = schedulableEntries.filter(
                (entry) =>
                  !refusedContextIds.has(entry.contextId) &&
                  !disownedContextIds.has(entry.contextId),
              );

              // Nothing survived the re-check, so this batch never formed. Report
              // it as such rather than as an empty parallel batch, and give back
              // only the lane claims still owned here — a replacement owner's claim
              // must outlive this finalize. Any worktree cut for a lane taken over
              // meanwhile is deliberately left in place: disposing it could remove
              // the one its new owner is about to use.
              if (admittedEntries.length === 0) {
                releaseLaneReservations(running, batchId);
                running.machineSnapshot = buildLifecycleSnapshot(running, {
                  lifecycleStatus: "running",
                  recoveryMode: "none",
                  hasLiveIteration: false,
                });
                outcome.value = { kind: "none" };
                return changed(running, {
                  observations,
                  outcome,
                  compensate,
                  laneForkedDecisions,
                  laneCreatedDecisions,
                  laneReusedDecisions,
                  scheduledClearedLanes,
                });
              }

              const provisionTimestamp = getNow(deps);

              // Mint each provisioned lane exactly once, before placing anyone on
              // it: several members of one lane can be admitted in a single pass,
              // and they all join the same record (decision D5).
              for (const { entry, result } of provisioned) {
                // A lane whose claim was replaced mid-provision is not this batch's
                // to materialize: recording it would hand the replacement owner a
                // lane record it never created. The worktree stays on disk
                // unreferenced, which is the safe side of this trade.
                if (disownedContextIds.has(entry.contextId)) continue;
                const mint = entry.mint;
                if (!mint) {
                  throw new Error(
                    `Provisioned lane "${entry.laneId}" has no mint plan; only a minting entry is provisioned`,
                  );
                }
                // Graph-owned branches only advance while provisioning. The
                // reservation's coverage is therefore a conservative snapshot
                // of the branch copied, independent of later parent landings.
                running.executionLanes[entry.laneId] = {
                  laneId: entry.laneId,
                  kind: "worktree",
                  status: "active",
                  worktreePath: result.worktreePath,
                  branchName: result.branchName,
                  includedContextIds: [...mint.includedContextIds],
                  lastCommittingContextId: mint.parentContextId,
                  commitSnapshots: [],
                  createdAt: provisionTimestamp,
                  updatedAt: provisionTimestamp,
                };
                if (
                  mint.sourceLaneId !== null &&
                  mint.parentContextId !== null
                ) {
                  laneForkedDecisions.push({
                    newLaneId: entry.laneId,
                    contextId: entry.contextId,
                    parentLaneId: mint.sourceLaneId,
                    parentContextId: mint.parentContextId,
                    parentBranchName: mint.parentBranchName,
                    branchName: result.branchName,
                    worktreePath: result.worktreePath,
                  });
                } else {
                  laneCreatedDecisions.push({
                    laneId: entry.laneId,
                    contextId: entry.contextId,
                    branchName: result.branchName,
                    worktreePath: result.worktreePath,
                    kind: "worktree",
                  });
                }
              }

              for (const entry of admittedEntries) {
                const { contextId, laneId } = entry;
                const contextState = running.contextStates[contextId]!;
                transitionContextStatus(running, contextId, "running", {
                  reason: "manager.schedule_eligible_contexts.batch",
                });
                contextState.batchId = batchId;
                // Reservation realized: the context is now `running`, so drop the
                // owner-discriminated stamp the reserve set (Design 3.1). The frozen
                // ownership STAYS — it is the envelope dispatch composes the turn's
                // write policy from, and the set later admissions compare against.
                // Where the pre-provision freeze was provisional, the re-taken one
                // supersedes it, so the persisted envelope is the one this context
                // was actually admitted under.
                contextState.reservedByBatchId = null;
                const refrozen = recanonicalized.get(contextId);
                if (refrozen) contextState.reservedOwnership = refrozen;

                const placement =
                  running.workingDefinition.executionContexts.find(
                    (context) => context.id === contextId,
                  )?.placement;
                if (
                  placement?.lane === SESSION_LANE_NAME &&
                  placement.mode === "readOnly"
                ) {
                  contextState.laneId = null;
                  contextState.worktreePath = null;
                  contextState.branchName = null;
                  contextState.isolation = "session";
                  contextState.batchId = null;
                  continue;
                }

                const lane = running.executionLanes[laneId];
                if (!lane) {
                  // The session lane before final publish materializes a record for
                  // it: the context runs in the session worktree with no lane.
                  if (laneId === SESSION_LANE_ID) {
                    contextState.laneId = null;
                    contextState.worktreePath = null;
                    contextState.branchName = null;
                    contextState.isolation = "session";
                    contextState.batchId = null;
                    continue;
                  }
                  throw new Error(
                    `Lane "${laneId}" referenced by context "${contextId}" was not found in executionLanes`,
                  );
                }

                contextState.laneId = laneId;
                if (lane.kind === "session") {
                  contextState.worktreePath = null;
                  contextState.branchName = null;
                  contextState.isolation = "session";
                  laneReusedDecisions.push({
                    laneId,
                    contextId,
                    branchName: null,
                    worktreePath: null,
                    kind: "session",
                  });
                  continue;
                }
                if (lane.worktreePath === null) {
                  throw new Error(
                    `Lane "${laneId}" referenced by context "${contextId}" is worktree-kind but has null worktreePath`,
                  );
                }
                contextState.worktreePath = lane.worktreePath;
                contextState.branchName = lane.branchName;
                contextState.isolation = "worktree";
                if (entry.mint === null) {
                  laneReusedDecisions.push({
                    laneId,
                    contextId,
                    branchName: lane.branchName,
                    worktreePath: lane.worktreePath,
                    kind: "worktree",
                  });
                }
              }

              releaseLaneReservations(running, batchId);

              // Landing intents ride the SAME mutation that assigns the lanes
              // (decision D8): the placement above is what decides how each context
              // will land, so recording the intent anywhere later would leave a
              // window where the only record of it lives in the runner's memory.
              for (const entry of admittedEntries) {
                recordDispatchLandingIntent(
                  running,
                  entry.contextId,
                  provisionTimestamp,
                );
              }

              const activeIdSet = new Set(running.activeContextIds);
              for (const entry of admittedEntries) {
                activeIdSet.add(entry.contextId);
              }
              running.activeContextIds = [...activeIdSet];
              const clearedLanes = clearLaneStatesFor(
                running,
                admittedEntries.map((e) => e.contextId),
              );
              scheduledClearedLanes = clearedLanes;

              running.machineSnapshot = buildLifecycleSnapshot(running, {
                lifecycleStatus: "running",
                recoveryMode: "none",
                hasLiveIteration: false,
              });

              outcome.value = {
                kind: "parallel",
                batchId,
                contextIds: admittedEntries.map((e) => e.contextId),
              };
              return changed(running, {
                observations,
                outcome,
                compensate,
                laneForkedDecisions,
                laneCreatedDecisions,
                laneReusedDecisions,
                scheduledClearedLanes,
              });
            })
            .then((mutation) => {
              const value = mutationValue(mutation);
              for (const observation of value.observations)
                logger[observation.level](observation.event, observation.data);
              return {
                execution: mutation.execution,
                ...mutationValue(mutation),
              };
            })
            .catch(async (err: unknown) => {
              // A finalize refused for a non-fence reason leaves the reserve's
              // stamps set; the owner-checked release inside `compensateSchedule`
              // clears them so the contexts re-schedule. When the refusal IS a
              // stale fence the stamps live on a superseded generation and the
              // release fences out harmlessly. Disposal is best-effort and cannot
              // skip the release.
              await compensateSchedule();
              throw err;
            });
          nextExecution = finalizedSchedule.execution;
          outcome = finalizedSchedule.outcome;
          scheduledClearedLanes = finalizedSchedule.scheduledClearedLanes;
          laneForkedDecisions.push(...finalizedSchedule.laneForkedDecisions);
          laneCreatedDecisions.push(...finalizedSchedule.laneCreatedDecisions);
          laneReusedDecisions.push(...finalizedSchedule.laneReusedDecisions);
          const compensate = finalizedSchedule.compensate;

          if (compensate) {
            // Halt superseded this batch: the fenced finalize already cleared the
            // reservation stamps atomically, so only the provisioned worktrees need
            // best-effort disposal here.
            const disposalFailures = await disposeProvisioned();
            if (disposalFailures.length > 0) {
              logger.warn("graph-workflow.scheduler.lane_dispose_failed", {
                failedLaneBranches: disposalFailures.map((f) => f.branchName),
              });
            }
          }
        },
      );
    }

    const scheduled = outcome.value;
    const execLogger = getExecutionLogger(nextExecution.id);

    if (readySetEligibleContextIds.length > 0) {
      execLogger?.lifecycle("scheduler.ready_set", {
        eligibleContextIds: readySetEligibleContextIds,
      });
      logger.info("graph-workflow.scheduler.ready_set", {
        executionId: nextExecution.id,
        eligibleContextIds: readySetEligibleContextIds,
      });
    }

    for (const decision of laneCreatedDecisions) {
      execLogger?.lifecycle("lane.created", decision);
      logger.info("graph-workflow.lane.created", {
        executionId: nextExecution.id,
        ...decision,
      });
    }

    for (const decision of laneForkedDecisions) {
      execLogger?.lifecycle("lane.forked", decision);
      logger.info("graph-workflow.lane.forked", {
        executionId: nextExecution.id,
        ...decision,
      });
    }

    for (const decision of laneReusedDecisions) {
      execLogger?.lifecycle("lane.reused", decision);
      logger.info("graph-workflow.lane.reused", {
        executionId: nextExecution.id,
        ...decision,
      });
    }

    if (scheduledClearedLanes.length > 0) {
      execLogger?.lifecycle("lane.cleanup", {
        clearedLaneStateContextIds: scheduledClearedLanes,
      });
      logger.info("graph-workflow.lane.cleanup", {
        executionId: nextExecution.id,
        clearedLaneStateContextIds: scheduledClearedLanes,
      });
    }

    if (scheduled.kind === "solo") {
      logger.info("graph-workflow.context.scheduled", {
        executionId: nextExecution.id,
        nextContextId: scheduled.contextId,
        eligibleContextIds: [scheduled.contextId],
        clearedLanes: scheduledClearedLanes,
      });
      execLogger?.lifecycle("context.scheduled", {
        contextId: scheduled.contextId,
        eligibleContextIds: [scheduled.contextId],
        clearedLanes: scheduledClearedLanes,
      });
    } else if (scheduled.kind === "parallel") {
      logger.info("graph-workflow.parallel.batch_scheduled", {
        executionId: nextExecution.id,
        batchId: scheduled.batchId,
        contextIds: scheduled.contextIds,
        clearedLanes: scheduledClearedLanes,
      });
      execLogger?.lifecycle("parallel.batch_scheduled", {
        batchId: scheduled.batchId,
        contextIds: scheduled.contextIds,
        clearedLanes: scheduledClearedLanes,
      });
    }

    return { execution: nextExecution, scheduled };
  }
  return { scheduleEligibleContexts };
}
