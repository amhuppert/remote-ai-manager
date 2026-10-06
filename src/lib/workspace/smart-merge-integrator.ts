import path from "node:path";
import { createActor, fromPromise, toPromise } from "xstate";
import type { Logger } from "@/lib/logging";
import type {
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
} from "@/lib/workflows/merge/actors";
import type { MergeMachineType } from "@/lib/workflows/merge/machine";
import type { AnalyzeConflictsParams, ResolveConflictsParams } from "@/lib/sessions/conflict-resolution";
import type { MergeInput, MergeOutput } from "@/lib/workflows/merge/types";
import type { LaneGit } from "./lane-git";
import type { LaneIntegrator } from "./lane-integrator";
import { laneJobId } from "./schemas";

export interface SmartMergeIntegratorDeps {
  /**
   * The Smart Merge machine with the actors this deployment runs: Git, the
   * conflict resolver and the check fixer. Production supplies resolvers that
   * run as fresh tasks.
   */
  machine: MergeMachineType;
  lanes: Pick<LaneGit, "abortUnresolvedMerge">;
  log: Pick<Logger, "info" | "warn">;
}

/**
 * The Smart Merge machine as a lane integrator (design §6.4, §6.5). It keeps
 * its algorithm: merge the captured session head into the lane, have the
 * resolver agent settle conflicts, run the lane's publication checks and let
 * the fix agent repair failures, all committed on the lane branch. Its own
 * publication is replaced: the machine is told there is nothing to prepare,
 * so it ends there, and Workspace publishes under target admission.
 */
export function createSmartMergeIntegrator(
  deps: SmartMergeIntegratorDeps,
): LaneIntegrator {
  const machine = deps.machine.provide({
    actors: {
      prepare: fromPromise<PrepareActorOutput, PrepareActorInput>(
        async ({ input }) => ({ status: "up-to-date", expectedTargetSha: input.targetBranch }),
      ),
      publish: fromPromise<PublishActorOutput, PublishActorInput>(async () => ({
        status: "up-to-date",
      })),
    },
  });

  return {
    async integrate({ lane, head, checks, cause, signal }) {
      if (signal.aborted) return { kind: "failed", detail: "Stopped before integrating" };
      const input: MergeInput = {
        jobId: `${laneJobId(cause)}-integrate`,
        projectPath: lane.projectPath,
        projectName: path.basename(lane.projectPath),
        sessionName: lane.sessionName,
        worktreePath: lane.worktreePath,
        branchName: lane.branch,
        message: `Integrate the session head into lane ${lane.laneId}`,
        autoResolve: true,
        autoFixValidation: true,
        agentTurnDispatch: "fresh-run",
        // A commit, not a branch: the lane is checked against exactly the head publication will require.
        targetBranch: head,
        resolutionContext: `This worktree is lane ${lane.laneId} (branch ${lane.branch}). It is being merged with the session branch ${lane.sessionBranch} at commit ${head} before the lane's work is published there. Keep both sides' intent; the lane's changes are the work being delivered.`,
        validationMode:
          checks.length === 0
            ? { mode: "skip" }
            : {
                mode: "run",
                source: "graph_lane_merge",
                selection: { mode: "only", commands: [...checks] },
              },
        finalizeSessionOnPublish: false,
        skipMarkMerged: true,
        maxCasAttempts: 1,
      };
      const actor = createActor(machine, { input });
      const abort = () => actor.send({ type: "ABORT" });
      signal.addEventListener("abort", abort, { once: true });
      let output: MergeOutput;
      try {
        actor.start();
        output = await toPromise(actor);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      deps.log.info("workspace.lane_integrated", {
        laneId: lane.laneId,
        head,
        status: output.status,
      });
      if (output.status === "completed") return { kind: "integrated" };
      // Whatever stopped it, this attempt's merge goes unless someone's resolution is in it.
      const merge = await deps.lanes.abortUnresolvedMerge(lane.worktreePath);
      const left =
        merge === "kept"
          ? ` A resolved merge is left in progress in ${lane.worktreePath}: check and commit it, then ask for a new attempt.`
          : ` Fix it on branch ${lane.branch} in ${lane.worktreePath}, then ask for a new attempt.`;
      if (output.status === "conflicts")
        return {
          kind: "failed",
          detail: `Merging the session head ${head} into the lane conflicts in ${output.conflictFiles.join(", ")}, and the resolver could not settle them${output.error !== null ? `: ${output.error}` : ""}.${merge === "kept" ? left : ` Merge ${head} into branch ${lane.branch} in ${lane.worktreePath} yourself and commit the resolution, then ask for a new attempt.`}`,
        };
      return {
        kind: "failed",
        detail: `Integrating the session head ${head} into the lane failed${output.error !== null ? `: ${output.error}` : ""}.${left}`,
      };
    },
  };
}

/** The conflict resolver the lane actors call; production's is sessions/conflict-resolution. */
export interface LaneConflictResolver {
  resolveConflicts(params: ResolveConflictsParams): Promise<ResolveConflictsOutput>;
  analyzeConflicts(params: AnalyzeConflictsParams): Promise<AnalyzeConflictsOutput>;
}

const productionResolver: LaneConflictResolver = {
  async resolveConflicts(params) {
    return (await import("@/lib/sessions/conflict-resolution")).resolveConflicts(params);
  },
  async analyzeConflicts(params) {
    return (await import("@/lib/sessions/conflict-resolution")).analyzeConflicts(params);
  },
};

/**
 * The conflict resolver and analyzer a lane integration runs: fresh tasks in
 * the lane worktree, since a lane has no conversation of its own to resolve
 * in. The machine's default actors always use a conversation.
 */
export function createLaneConflictActors(resolver: LaneConflictResolver = productionResolver) {
  return {
    resolveConflicts: fromPromise<ResolveConflictsOutput, ResolveConflictsInput>(
      ({ input, signal }) =>
        resolver.resolveConflicts({
          worktreePath: input.worktreePath,
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          agentTurnDispatch: "fresh-run",
          conflictFiles: input.conflictFiles,
          decisions: input.decisions,
          resolutionContext: input.resolutionContext,
          targetBranch: input.targetBranch,
          resolutionTimeoutMs: input.resolutionTimeoutMs,
          signal,
        }),
    ),
    analyzeConflicts: fromPromise<AnalyzeConflictsOutput, AnalyzeConflictsInput>(
      ({ input, signal }) =>
        resolver.analyzeConflicts({
          worktreePath: input.worktreePath,
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          agentTurnDispatch: "fresh-run",
          resolutionContext: input.resolutionContext,
          targetBranch: input.targetBranch,
          resolutionTimeoutMs: input.resolutionTimeoutMs,
          signal,
        }),
    ),
  };
}
