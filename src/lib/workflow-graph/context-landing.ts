import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { isDeepStrictEqual } from "node:util";
import { getExecutionLogger } from "./execution-logger";
import {
  requireCurrentExecution,
  type GraphWorkflowExecutionRepository,
} from "./execution-repository";
import type { ParallelWorktrees } from "./parallel-worktrees";
import type { LaneCommitter } from "./lane-committer";
import type { SoloContextCommitter } from "./solo-context-committer";
import type { JoinRunner } from "./join-runner";
import type { PerSessionMergeMutex } from "./per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/shared/lock-retry";
import type { GraphMergeRunner } from "./graph-merge-runner";
import type {
  RecordPendingHaltReasonInput,
  RecordPendingHaltReasonResult,
} from "./workflow-manager";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  resolveLaneMergeRunValidationMode,
  type ReadLaneMergeRepoConfig,
} from "./lane-merge-validation";
import { resolveContextConversationId } from "./lane-join";
import type { LaneDriftAuditor, LaneDriftVerdict } from "./lane-drift";
/** Matches the halt schema's cap on `unattributedPaths`. */
const MAX_REPORTED_UNATTRIBUTED_PATHS = 50;
import { applyLaneCommitSnapshot } from "./lane-committer";
import { materializeSessionLane } from "./lane-join";
import { SESSION_LANE_ID } from "./lane-identity";
import {
  settleLandingIntent,
  type SettleLandingIntentInput,
} from "./route-runtime";
import { transitionContextMergeStatus } from "./context-transitions";
import type { ExecutionMutationDecision } from "./execution-mutation";
import { changed, unchanged } from "./execution-mutation";
import type {
  GraphWorkflowCanonicalOwnership,
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneCommitSnapshot,
  GraphWorkflowHaltReason,
  GraphWorkflowLandingIntent,
} from "./schemas";
import type { LaneCommitterResult } from "./lane-committer";
import type { SoloContextCommitterResult } from "./solo-context-committer";
import type { JoinRunResult } from "./join-runner";
import type { MergeOutput } from "@/lib/workflows/merge/types";

export interface ContextLandingIdentity {
  executionId: string;
  contextId: string;
  intentToken: string | null;
}

export type ContextLandingDestination =
  | { mode: "lane"; laneId: string }
  | { mode: "solo"; branchName: string; worktreePath: string };

type CommitLanding = ContextLandingIdentity & {
  destination: ContextLandingDestination;
  snapshot: GraphWorkflowExecutionLaneCommitSnapshot;
};

export type LandingOutcome =
  | (CommitLanding & { kind: "committed" })
  | (CommitLanding & { kind: "adopted"; baselineSha: string })
  | (ContextLandingIdentity & {
      kind: "no_changes";
      destination: ContextLandingDestination;
      settledAt: string;
      verification:
        | { mode: "recorded"; intent: GraphWorkflowLandingIntent }
        | {
            mode: "lane";
            result: Extract<LaneCommitterResult, { status: "skipped" }>;
            baselineSha: string | null;
          }
        | {
            mode: "solo";
            result: Extract<SoloContextCommitterResult, { status: "skipped" }>;
            baselineSha: string | null;
            headSha: string | null;
          };
    })
  | (ContextLandingIdentity & {
      kind: "read_only";
      ownership: GraphWorkflowCanonicalOwnership;
    })
  | {
      kind: "joined";
      via: "join";
      executionId: string;
      join: GraphWorkflowExecutionJoinState;
      result: Extract<JoinRunResult, { status: "succeeded" }>;
    }
  | (ContextLandingIdentity & {
      kind: "joined";
      via: "fan_in";
      branchName: string;
      worktreePath: string;
      output: MergeOutput;
    })
  | {
      kind: "failed";
      executionId: string;
      settledAt: string;
      reason: GraphWorkflowHaltReason;
      evidence:
        | {
            mode: "lane";
            identity: ContextLandingIdentity;
            laneId: string;
            result: Extract<LaneCommitterResult, { status: "failed" }>;
          }
        | {
            mode: "solo";
            identity: ContextLandingIdentity;
            result:
              | Extract<SoloContextCommitterResult, { status: "failed" }>
              | { status: "session_missing" };
          }
        | {
            mode: "fan_in";
            identity: ContextLandingIdentity;
            output: MergeOutput | null;
            errorMessage: string | null;
          }
        | {
            mode: "join";
            join: GraphWorkflowExecutionJoinState;
            result: Extract<JoinRunResult, { status: "failed" }>;
          };
    };

export function settleContextLanding(
  execution: GraphWorkflowExecution,
  outcome: LandingOutcome,
): ExecutionMutationDecision {
  if (execution.id !== outcome.executionId) return unchanged();
  if (outcome.kind === "read_only") return unchanged();
  if (outcome.kind === "joined" && outcome.via === "join") return unchanged();
  if (outcome.kind === "failed" && outcome.evidence.mode === "join")
    return unchanged();

  const identity =
    outcome.kind === "failed"
      ? outcome.evidence.mode === "join"
        ? null
        : outcome.evidence.identity
      : outcome;
  if (!identity) return unchanged();
  const current = execution.contextStates[identity.contextId];
  if (
    !current ||
    (current.landingIntent?.token ?? null) !== identity.intentToken
  )
    return unchanged();

  let next = structuredClone(execution);
  const context = next.contextStates[identity.contextId];
  if (!context) return unchanged();
  let didChange = false;
  const setMergeStatus = (
    status: typeof context.mergeStatus,
    error: string | null,
  ) => {
    if (context.mergeStatus !== status || context.lastMergeError !== error)
      didChange = true;
    transitionContextMergeStatus(next, identity.contextId, status, {
      reason: "context_landing.settled",
    });
    context.lastMergeError = error;
  };
  // The intent and its snapshot settle in one mutation. Agent-authored commits
  // carry baseline-to-head evidence because the agent did not add our trailer.
  const settleIntent = (input: SettleLandingIntentInput) => {
    const intent = context.landingIntent;
    if (!intent) return;
    if (
      intent.state === input.state &&
      intent.evidence === (input.evidence ?? intent.evidence) &&
      intent.headSha === (input.headSha ?? intent.headSha)
    )
      return;
    settleLandingIntent(next, identity.contextId, input);
    didChange = true;
  };

  if (outcome.kind === "failed") {
    // Failed landing evidence blocks dependents on resume; it never skips them.
    if (outcome.evidence.mode === "lane") {
      setMergeStatus("merged-failed", outcome.evidence.result.errorMessage);
      settleIntent({
        state: "failed",
        evidence: "commit",
        now: outcome.settledAt,
      });
    } else if (outcome.evidence.mode === "solo") {
      if (outcome.evidence.result.status !== "session_missing") {
        settleIntent({
          state: "failed",
          evidence: "commit",
          now: outcome.settledAt,
        });
      }
    } else if (outcome.evidence.mode === "fan_in") {
      setMergeStatus(
        outcome.evidence.output?.status === "conflicts"
          ? "conflicts"
          : "merged-failed",
        outcome.evidence.errorMessage,
      );
    }
    return didChange ? changed(next) : unchanged();
  }

  if (outcome.kind === "joined") {
    setMergeStatus("merged-success", null);
    return didChange ? changed(next) : unchanged();
  }

  const destination = outcome.destination;
  let laneId: string | null =
    destination.mode === "lane" ? destination.laneId : null;
  if (destination.mode === "solo") {
    const assignedLane =
      context.laneId === null ? undefined : next.executionLanes[context.laneId];
    laneId = assignedLane?.kind === "session" ? assignedLane.laneId : null;
    if (outcome.kind !== "no_changes" && laneId === null) {
      laneId = SESSION_LANE_ID;
      if (!next.executionLanes[laneId]) {
        next = materializeSessionLane(next, {
          sessionLaneId: laneId,
          branchName: destination.branchName,
          worktreePath: destination.worktreePath,
          now: () => outcome.snapshot.committedAt,
        });
        didChange = true;
      }
    }
  }

  if (destination.mode === "lane") setMergeStatus("merged-success", null);
  if (laneId !== null) {
    const lane = next.executionLanes[laneId];
    if (!lane)
      throw new Error(
        `Landing lane "${laneId}" is missing from execution "${execution.id}"`,
      );
    if (
      outcome.kind !== "no_changes" &&
      !lane.commitSnapshots.some(
        (snapshot) =>
          snapshot.contextId === identity.contextId &&
          snapshot.sha === outcome.snapshot.sha,
      )
    ) {
      next = applyLaneCommitSnapshot(next, laneId, outcome.snapshot);
      didChange = true;
    } else if (!lane.includedContextIds.includes(identity.contextId)) {
      lane.includedContextIds = [
        ...lane.includedContextIds,
        identity.contextId,
      ];
      didChange = true;
    }
  }
  settleIntent(
    outcome.kind === "no_changes"
      ? { state: "landed", evidence: "no-changes", now: outcome.settledAt }
      : {
          state: "landed",
          evidence: outcome.kind === "adopted" ? "adopted-head" : "commit",
          headSha: outcome.snapshot.sha,
          now: outcome.snapshot.committedAt,
        },
  );
  return didChange ? changed(next) : unchanged();
}

export interface ContextLandingDeps {
  executionRepository: Pick<
    GraphWorkflowExecutionRepository,
    "getActive" | "mutateActive"
  >;
  recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult>;
  parallelWorktrees: ParallelWorktrees;
  mergeMutex: PerSessionMergeMutex;
  sessionGitLock: SessionGitLock;
  mergeRunner: GraphMergeRunner;
  laneCommitter: LaneCommitter;
  soloContextCommitter: SoloContextCommitter;
  joinRunner: JoinRunner;
  /**
   * Judges the lane worktree against its members' collective ownership after an
   * enveloped landing (R8).
   */
  laneDriftAuditor: LaneDriftAuditor;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readRepoConfig: ReadLaneMergeRepoConfig;
  createJobId(): string;
}

export interface ContextLandingInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  preTurnHeadSha: string | null;
  target:
    | { isolation: "session" }
    | {
        isolation: "worktree";
        worktreePath: string;
        branchName: string;
        laneId: string | null;
      };
}

export interface ContextLandingResult {
  execution: GraphWorkflowExecution;
  outcome: LandingOutcome;
}

const logger = createLogger("graph-workflow-context-landing");

export function createContextLanding(deps: ContextLandingDeps) {
  async function persistLandingOutcome(
    input: { projectPath: string; sessionName: string; executionId: string },
    result: LandingOutcome,
  ): Promise<GraphWorkflowExecution> {
    if (result.kind === "failed") {
      const current = await requireCurrentExecution(
        deps.executionRepository,
        input.projectPath,
        input.sessionName,
      );
      const decision = settleContextLanding(current, result);
      const alreadyRecorded =
        isDeepStrictEqual(current.pendingHaltReason, result.reason) ||
        current.secondaryHaltReasons.some((reason) =>
          isDeepStrictEqual(reason, result.reason),
        );
      if (decision.kind === "unchanged" && alreadyRecorded) return current;
      const halted = await deps.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: input.executionId,
        reason: result.reason,
        applyAdditionalMutation(draft) {
          const settlement = settleContextLanding(draft, result);
          if (settlement.kind === "changed")
            Object.assign(draft, settlement.execution);
        },
      });
      return halted.execution;
    }
    const settled = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (current) => settleContextLanding(current, result),
    );
    return settled.execution;
  }

  async function land(
    input: ContextLandingInput,
  ): Promise<ContextLandingResult> {
    let execution = await requireCurrentExecution(
      deps.executionRepository,
      input.projectPath,
      input.sessionName,
    );
    const execLogger = getExecutionLogger(execution.id);
    if (execution.id !== input.executionId)
      throw new Error(
        `Landing belongs to execution "${input.executionId}", but "${execution.id}" is active`,
      );
    const landingIdentity: ContextLandingIdentity = {
      executionId: input.executionId,
      contextId: input.contextId,
      intentToken:
        execution.contextStates[input.contextId]?.landingIntent?.token ?? null,
    };
    const identity = () => landingIdentity;
    let outcome: LandingOutcome | null = null;

    async function restoreRecordedLanding(
      destination: ContextLandingDestination,
    ): Promise<boolean> {
      execution = await requireCurrentExecution(
        deps.executionRepository,
        input.projectPath,
        input.sessionName,
      );
      const context = execution.contextStates[input.contextId];
      if (
        execution.id !== landingIdentity.executionId ||
        (context?.landingIntent?.token ?? null) !== landingIdentity.intentToken
      ) {
        throw new Error("Landing authority changed before Git work");
      }
      const intent = context?.landingIntent;
      if (
        context?.status !== "completed" ||
        !intent ||
        intent.state !== "landed"
      )
        return false;
      if (intent.evidence === "no-changes" && intent.settledAt !== null) {
        outcome = {
          ...landingIdentity,
          kind: "no_changes",
          destination,
          settledAt: intent.settledAt,
          verification: { mode: "recorded", intent },
        };
      } else {
        const assigned =
          context.laneId === null
            ? undefined
            : execution.executionLanes[context.laneId];
        const laneId =
          destination.mode === "lane"
            ? destination.laneId
            : assigned?.kind === "session"
              ? assigned.laneId
              : SESSION_LANE_ID;
        const snapshot = execution.executionLanes[laneId]?.commitSnapshots.find(
          (entry) =>
            entry.contextId === input.contextId && entry.sha === intent.headSha,
        );
        if (!snapshot) return false;
        if (intent.evidence === "commit")
          outcome = {
            ...landingIdentity,
            kind: "committed",
            destination,
            snapshot,
          };
        else if (
          intent.evidence === "adopted-head" &&
          intent.baselineSha !== null
        )
          outcome = {
            ...landingIdentity,
            kind: "adopted",
            destination,
            snapshot,
            baselineSha: intent.baselineSha,
          };
        else return false;
      }
      logger.info("graph-workflow.context_landing.replayed", {
        executionId: execution.id,
        contextId: input.contextId,
        evidence: intent.evidence,
        headSha: intent.headSha,
      });
      return true;
    }

    async function persistOutcome(result: LandingOutcome): Promise<void> {
      outcome = result;
      execution = await persistLandingOutcome(input, result);
    }

    async function runFanInMerge(
      contextId: string,
      featureWorktreePath: string,
      featureBranchName: string,
    ): Promise<void> {
      execLogger?.iteration(contextId, "merge.queued", {
        branchName: featureBranchName,
        worktreePath: featureWorktreePath,
      });
      logger.info("graph-workflow.merge.queued", {
        executionId: execution.id,
        contextId,
        branchName: featureBranchName,
      });

      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          await deps.executionRepository
            .mutateActive(input.projectPath, input.sessionName, (e) => {
              const next = structuredClone(e);
              if (next.contextStates[contextId]) {
                transitionContextMergeStatus(next, contextId, "in-progress", {
                  reason: "merge.started",
                });
              }
              return changed(next);
            })
            .then((mutation) => mutation.execution);

          execLogger?.iteration(contextId, "merge.started", {
            branchName: featureBranchName,
          });
          logger.info("graph-workflow.merge.started", {
            executionId: execution.id,
            contextId,
            branchName: featureBranchName,
          });

          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: `Session "${input.sessionName}" not found during fan-in merge`,
              conflictFiles: [],
            };
            await persistOutcome({
              kind: "failed",
              executionId: execution.id,
              settledAt: new Date().toISOString(),
              reason,
              evidence: {
                mode: "fan_in",
                identity: identity(),
                output: null,
                errorMessage: reason.message,
              },
            });
            logger.error("graph-workflow.merge.failed", {
              executionId: execution.id,
              contextId,
              reason: reason.message,
            });
            return;
          }

          let mergeOutput: MergeOutput | null = null;
          let mergeStatus:
            | "completed"
            | "failed"
            | "conflicts"
            | "ready-to-land"
            | "discarded";
          let mergeError: string | null = null;
          let mergeConflictFiles: string[] = [];
          try {
            const output = await deps.sessionGitLock.withSessionGitLock(
              {
                projectPath: input.projectPath,
                sessionName: input.sessionName,
              },
              async () => {
                const validationMode = await resolveLaneMergeRunValidationMode({
                  projectPath: input.projectPath,
                  config: execution.workingDefinition.laneMergeValidation,
                  readRepoConfig: deps.readRepoConfig,
                });
                // The context's own implementer conversation: without it the
                // merge's agent sub-turns fall back to the session's
                // most-recently-active conversation, which in a parallel
                // workflow can belong to a context still running in a
                // different worktree.
                const conversationId = resolveContextConversationId(
                  execution,
                  contextId,
                );
                return deps.mergeRunner.run({
                  jobId: deps.createJobId(),
                  projectPath: input.projectPath,
                  projectName: input.projectName,
                  sessionName: input.sessionName,
                  contextId,
                  branchName: featureBranchName,
                  featureWorktreePath,
                  targetBranch: session.branchName,
                  targetWorktreePath: session.worktreePath,
                  message: `Graph workflow context ${contextId}`,
                  workflowExecutionId: execution.id,
                  ...(conversationId !== null ? { conversationId } : {}),
                  validationMode,
                });
              },
            );
            mergeOutput = output;
            mergeStatus = output.status;
            mergeError = output.error;
            mergeConflictFiles = output.conflictFiles;
          } catch (error) {
            mergeStatus = "failed";
            mergeError = getErrorMessage(error);
            mergeConflictFiles = [];
          }

          if (mergeStatus === "completed") {
            if (!mergeOutput)
              throw new Error("Completed fan-in has no merge evidence");
            await persistOutcome({
              ...identity(),
              kind: "joined",
              via: "fan_in",
              branchName: session.branchName,
              worktreePath: session.worktreePath,
              output: mergeOutput,
            });

            execLogger?.iteration(contextId, "merge.completed", {
              branchName: featureBranchName,
            });
            logger.info("graph-workflow.merge.completed", {
              executionId: execution.id,
              contextId,
              branchName: featureBranchName,
            });

            const dispose = await deps.parallelWorktrees.dispose({
              projectPath: input.projectPath,
              worktreePath: featureWorktreePath,
              branchName: featureBranchName,
            });
            await deps.executionRepository
              .mutateActive(input.projectPath, input.sessionName, (e) => {
                const next = structuredClone(e);
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.cleanupStatus =
                    dispose.status === "removed" ? "removed" : "failed";
                }
                return changed(next);
              })
              .then((mutation) => mutation.execution);
            execLogger?.lifecycle("parallel.cleanup_attempted", {
              contextId,
              status: dispose.status,
              reason: dispose.status === "failed" ? dispose.reason : undefined,
            });
            return;
          }

          const finalMergeStatus =
            mergeStatus === "conflicts" ? "conflicts" : "merged-failed";
          const haltReason: GraphWorkflowHaltReason = {
            type: "merge_failure",
            contextId,
            message: mergeError ?? "Fan-in merge failed",
            conflictFiles: mergeConflictFiles,
          };
          await persistOutcome({
            kind: "failed",
            executionId: execution.id,
            settledAt: new Date().toISOString(),
            reason: haltReason,
            evidence: {
              mode: "fan_in",
              identity: identity(),
              output: mergeOutput,
              errorMessage: mergeError,
            },
          });
          logger.error("graph-workflow.merge.failed", {
            executionId: execution.id,
            contextId,
            mergeStatus: finalMergeStatus,
            error: mergeError,
            conflictFiles: mergeConflictFiles.length,
          });
        },
      );
    }

    /**
     * Judge the lane worktree against every current member's declared surface
     * after an enveloped landing (R8, decision D8).
     *
     * Only enveloped landings audit: a full-access member owns the whole tree,
     * so there is nothing it could have failed to declare. Runs inside the
     * merge mutex the landing held, so no sibling landing can move the worktree
     * between the commit and the reading of it.
     *
     * Read failures do not halt. The audit is a backstop for writes the sandbox
     * could not stop, and turning a status read that failed into a halt would
     * make it a new way for correct runs to stop.
     */
    async function auditLaneDrift(
      contextId: string,
      laneId: string,
      laneWorktreePath: string,
    ): Promise<void> {
      // A lane the execution no longer tracks has no member set to judge
      // against, and the halt this can raise names it.
      if (!execution.executionLanes[laneId]) return;

      const memberOwnerships: GraphWorkflowCanonicalOwnership[] = [];
      for (const state of Object.values(execution.contextStates)) {
        if (state.laneId !== laneId) continue;
        // A member that never reached admission wrote nothing, and its
        // authored placement is not the frozen surface anyone was scoped
        // against — including it would widen the union on a guess.
        if (!state.reservedOwnership) continue;
        memberOwnerships.push(state.reservedOwnership);
      }

      let verdict: LaneDriftVerdict;
      try {
        verdict = await deps.laneDriftAuditor.audit({
          laneWorktreePath,
          memberOwnerships,
        });
      } catch (error) {
        logger.warn("graph-workflow.lane_drift.audit_failed", {
          executionId: execution.id,
          contextId,
          laneId,
          laneWorktreePath,
          error: getErrorMessage(error),
        });
        return;
      }

      if (verdict.unattributedPaths.length === 0) return;

      // Capped to what the halt schema persists; the count in the message keeps
      // the total honest when the list is truncated.
      const unattributedPaths = verdict.unattributedPaths.slice(
        0,
        MAX_REPORTED_UNATTRIBUTED_PATHS,
      );
      const reason: GraphWorkflowHaltReason = {
        type: "ownership_violation",
        laneId,
        contextId,
        unattributedPaths: [...unattributedPaths],
        message: `Lane "${laneId}" has ${verdict.unattributedPaths.length} change(s) that no current member's ownership, scratch, or payload directory accounts for, found while "${contextId}" landed`,
        // Plan repair fills this in if it speaks; the raise never claims a
        // verdict it has not heard.
        summary: null,
      };
      const haltResult = await deps.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason,
      });
      execution = haltResult.execution;
      execLogger?.iteration(contextId, "lane_drift.unattributed", {
        laneId,
        unattributedCount: verdict.unattributedPaths.length,
      });
      logger.error("graph-workflow.lane_drift.unattributed", {
        executionId: execution.id,
        contextId,
        laneId,
        laneWorktreePath,
        unattributedCount: verdict.unattributedPaths.length,
        unattributedPaths,
      });
    }

    async function runLaneCommit(
      contextId: string,
      laneId: string,
      laneWorktreePath: string,
      laneBranchName: string,
      preTurnHeadSha: string | null,
    ): Promise<void> {
      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          if (await restoreRecordedLanding({ mode: "lane", laneId })) return;
          execLogger?.iteration(contextId, "lane_commit.started", {
            laneId,
            laneWorktreePath,
            laneBranchName,
          });
          logger.info("graph-workflow.lane_commit.started", {
            executionId: execution.id,
            contextId,
            laneId,
            laneBranchName,
          });

          // An enveloped landing is the only one that audits: a full-access
          // member owns the whole tree, so no path in the worktree is one it
          // could have failed to declare (R8).
          const auditsDrift =
            execution.contextStates[contextId]?.reservedOwnership?.mode ===
            "owned";
          const result = await deps.sessionGitLock.withSessionGitLock(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            },
            async () =>
              deps.laneCommitter.commit({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                contextId,
                laneId,
                laneWorktreePath,
                preTurnHeadSha,
                landingToken:
                  execution.contextStates[contextId]?.landingIntent?.token ??
                  null,
                // The envelope this context was ADMITTED under, not a fresh read
                // of the definition: what the landing may commit has to be the
                // same set the turn was allowed to write, or a live edit between
                // dispatch and landing would widen the commit past the surface
                // the sibling members were scoped against.
                ownership:
                  execution.contextStates[contextId]?.reservedOwnership ?? null,
              }),
          );

          if (result.status === "failed") {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: result.errorMessage,
              conflictFiles: [],
            };
            await persistOutcome({
              kind: "failed",
              executionId: execution.id,
              settledAt: new Date().toISOString(),
              reason,
              evidence: { mode: "lane", identity: identity(), laneId, result },
            });
            logger.error("graph-workflow.lane_commit.failed", {
              executionId: execution.id,
              contextId,
              laneId,
              error: result.errorMessage,
            });
            return;
          }

          // An adopted result (implementer self-committed; the committer
          // adopted the moved lane HEAD) records a snapshot exactly like a
          // committed one — the snapshot diff is what derives the
          // graph-workflow-lane-commit event feeding commit evidence.
          if (result.status === "committed" || result.status === "adopted") {
            const adopted = result.status === "adopted";
            if (adopted && preTurnHeadSha === null)
              throw new Error("Adopted lane commit has no verified baseline");
            const snapshot = result.snapshot;
            await persistOutcome(
              adopted && preTurnHeadSha !== null
                ? {
                    ...identity(),
                    kind: "adopted",
                    destination: { mode: "lane", laneId },
                    snapshot,
                    baselineSha: preTurnHeadSha,
                  }
                : {
                    ...identity(),
                    kind: "committed",
                    destination: { mode: "lane", laneId },
                    snapshot,
                  },
            );
            execLogger?.iteration(
              contextId,
              adopted ? "lane_commit.adopted" : "lane_commit.completed",
              {
                laneId,
                sha: snapshot.sha,
                committedAt: snapshot.committedAt,
              },
            );
            logger.info(
              adopted
                ? "graph-workflow.lane_commit.adopted"
                : "graph-workflow.lane_commit.completed",
              {
                executionId: execution.id,
                contextId,
                laneId,
                sha: snapshot.sha,
              },
            );
            if (auditsDrift) {
              await auditLaneDrift(contextId, laneId, laneWorktreePath);
            }
            return;
          }

          // status === "skipped" — no uncommitted changes on the lane. Still
          // mark the context as available in the lane so downstream contexts
          // (and any future join) see the work as ready, but do not append a
          // snapshot since no commit was made.
          await persistOutcome({
            ...identity(),
            kind: "no_changes",
            destination: { mode: "lane", laneId },
            settledAt: new Date().toISOString(),
            verification: { mode: "lane", result, baselineSha: preTurnHeadSha },
          });
          execLogger?.iteration(contextId, "lane_commit.skipped", {
            laneId,
            laneWorktreePath,
          });
          logger.info("graph-workflow.lane_commit.skipped", {
            executionId: execution.id,
            contextId,
            laneId,
          });
          if (auditsDrift) {
            await auditLaneDrift(contextId, laneId, laneWorktreePath);
          }
        },
      );
    }

    async function runSoloCommit(
      contextId: string,
      preTurnHeadSha: string | null,
    ): Promise<void> {
      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: `Session "${input.sessionName}" not found during solo-context commit`,
              conflictFiles: [],
            };
            await persistOutcome({
              kind: "failed",
              executionId: execution.id,
              settledAt: new Date().toISOString(),
              reason,
              evidence: {
                mode: "solo",
                identity: identity(),
                result: { status: "session_missing" },
              },
            });
            logger.error("graph-workflow.solo_commit.session_missing", {
              executionId: execution.id,
              contextId,
            });
            return;
          }

          if (
            await restoreRecordedLanding({
              mode: "solo",
              branchName: session.branchName,
              worktreePath: session.worktreePath,
            })
          )
            return;
          const result = await deps.sessionGitLock.withSessionGitLock(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            },
            async () =>
              deps.soloContextCommitter.commit({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                contextId,
                sessionWorktreePath: session.worktreePath,
                landingToken:
                  execution.contextStates[contextId]?.landingIntent?.token ??
                  null,
                ownership:
                  execution.contextStates[contextId]?.reservedOwnership ?? null,
              }),
          );

          if (result.status === "failed") {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: result.errorMessage,
              conflictFiles: [],
            };
            await persistOutcome({
              kind: "failed",
              executionId: execution.id,
              settledAt: new Date().toISOString(),
              reason,
              evidence: { mode: "solo", identity: identity(), result },
            });
            logger.error("graph-workflow.solo_commit.failed", {
              executionId: execution.id,
              contextId,
              error: result.errorMessage,
            });
            return;
          }

          execLogger?.iteration(contextId, "solo_commit.completed", {
            status: result.status,
          });
          logger.info("graph-workflow.solo_commit.recorded", {
            executionId: execution.id,
            contextId,
            status: result.status,
          });

          // Record the context's commit on the session lane so the snapshot →
          // lane-commit event → evidence-ingest chain carries changedCode for
          // solo runs too. A skipped commit with a moved HEAD means the
          // implementer committed its own work — adopt that HEAD, mirroring
          // the lane-worktree adoption path.
          let snapshotSha: string | null = null;
          let adopted = false;
          let currentHead: string | null = null;
          if (result.status === "committed") {
            snapshotSha = result.hash;
          } else {
            try {
              currentHead = await deps.laneCommitter.resolveHead(
                session.worktreePath,
              );
            } catch {
              currentHead = null;
            }
            if (
              currentHead !== null &&
              preTurnHeadSha !== null &&
              currentHead !== preTurnHeadSha
            ) {
              snapshotSha = currentHead;
              adopted = true;
            }
          }
          if (snapshotSha !== null) {
            const snapshot = {
              contextId,
              sha: snapshotSha,
              committedAt: new Date().toISOString(),
            };
            const destination: ContextLandingDestination = {
              mode: "solo",
              branchName: session.branchName,
              worktreePath: session.worktreePath,
            };
            await persistOutcome(
              adopted && preTurnHeadSha !== null
                ? {
                    ...identity(),
                    kind: "adopted",
                    destination,
                    snapshot,
                    baselineSha: preTurnHeadSha,
                  }
                : { ...identity(), kind: "committed", destination, snapshot },
            );
            if (adopted) {
              execLogger?.iteration(contextId, "solo_commit.adopted_head", {
                sha: snapshotSha,
              });
              logger.info("graph-workflow.solo_commit.adopted_head", {
                executionId: execution.id,
                contextId,
                sha: snapshotSha,
              });
            }
          } else {
            // Nothing to commit and an unmoved HEAD: the context produced no
            // changes, which is still a LANDING — its dependents have
            // everything it was ever going to give them, and leaving the intent
            // unsettled would block them on a commit that will not come.
            if (result.status !== "skipped")
              throw new Error("Committed solo landing has no commit SHA");
            await persistOutcome({
              ...identity(),
              kind: "no_changes",
              destination: {
                mode: "solo",
                branchName: session.branchName,
                worktreePath: session.worktreePath,
              },
              settledAt: new Date().toISOString(),
              verification: {
                mode: "solo",
                result,
                baselineSha: preTurnHeadSha,
                headSha: currentHead,
              },
            });
          }
        },
      );
    }
    const contextDefinition =
      execution.workingDefinition.executionContexts.find(
        (context) => context.id === input.contextId,
      );
    const ownership =
      execution.contextStates[input.contextId]?.reservedOwnership;
    if (contextDefinition?.placement.mode === "readOnly") {
      outcome = {
        ...identity(),
        kind: "read_only",
        ownership: ownership ?? { mode: "readOnly", canonicalPrefixes: [] },
      };
      const laneId =
        input.target.isolation === "worktree" ? input.target.laneId : null;
      execLogger?.iteration(
        input.contextId,
        "read_only.completed_without_commit",
        { laneId, isolation: input.target.isolation },
      );
      logger.info("graph-workflow.read_only.completed_without_commit", {
        executionId: execution.id,
        contextId: input.contextId,
        laneId,
        isolation: input.target.isolation,
      });
      return { execution, outcome };
    }
    if (input.target.isolation === "session") {
      await runSoloCommit(input.contextId, input.preTurnHeadSha);
    } else if (input.target.laneId !== null) {
      await runLaneCommit(
        input.contextId,
        input.target.laneId,
        input.target.worktreePath,
        input.target.branchName,
        input.preTurnHeadSha,
      );
    } else {
      await runFanInMerge(
        input.contextId,
        input.target.worktreePath,
        input.target.branchName,
      );
    }
    if (outcome === null)
      throw new Error("Context landing finished without an outcome");
    execution = await requireCurrentExecution(
      deps.executionRepository,
      input.projectPath,
      input.sessionName,
    );
    return { execution, outcome };
  }
  async function runJoin(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    executionId: string;
    joinId: string;
  }): Promise<ContextLandingResult> {
    const initial = await requireCurrentExecution(
      deps.executionRepository,
      input.projectPath,
      input.sessionName,
    );
    const execLogger = getExecutionLogger(initial.id);
    const result = await deps.joinRunner.run({
      ...input,
      mutateActive: (mutator) =>
        deps.executionRepository.mutateActive(
          input.projectPath,
          input.sessionName,
          mutator,
        ),
      lifecycle: (event, fields) => execLogger?.lifecycle(event, fields),
    });
    const execution = await requireCurrentExecution(
      deps.executionRepository,
      input.projectPath,
      input.sessionName,
    );
    const join = execution.joins[input.joinId];
    if (!join) throw new Error("Join result has no durable join record");
    if (result.status === "succeeded") {
      if (join.status !== "succeeded")
        throw new Error("Successful join result has no durable success record");
      const outcome: LandingOutcome = {
        kind: "joined",
        via: "join",
        executionId: input.executionId,
        join,
        result,
      };
      const settled = await persistLandingOutcome(input, outcome);
      execLogger?.lifecycle("join.completed", {
        joinId: join.joinId,
        kind: join.kind,
      });
      return { execution: settled, outcome };
    }
    const outcome: LandingOutcome = {
      kind: "failed",
      executionId: input.executionId,
      settledAt: new Date().toISOString(),
      reason: result.haltReason ?? {
        type: "join_failure",
        joinId: join.joinId,
        joinKind: join.kind,
        contextId: join.contextId,
        sourceLaneIds: join.sourceLaneIds,
        targetLaneId: join.targetLaneId,
        message: result.message,
        conflictFiles: result.conflictFiles,
        resolutionFailure: result.resolutionFailure ?? undefined,
      },
      evidence: { mode: "join", join, result },
    };
    const settled = await persistLandingOutcome(input, outcome);
    execLogger?.lifecycle("join.failed", {
      joinId: join.joinId,
      kind: join.kind,
      failedSourceLaneId: result.failedSourceLaneId,
      conflictFiles: result.conflictFiles,
      haltReasonType: result.haltReason?.type ?? null,
    });
    logger.error("graph-workflow.join.failed", {
      executionId: execution.id,
      joinId: join.joinId,
      kind: join.kind,
      message: result.message,
      conflictFiles: result.conflictFiles.length,
      haltReasonType: result.haltReason?.type ?? null,
    });
    return { execution: settled, outcome };
  }
  return { land, runJoin };
}

export type ContextLanding = ReturnType<typeof createContextLanding>;
