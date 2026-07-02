import { createActor, toPromise } from "xstate";
import { createLogger } from "@/lib/logging";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import {
  mergeMachine,
  type MergeMachineType,
} from "@/lib/workflows/merge/machine";
import type { MergeOutput } from "@/lib/workflows/merge/types";

const logger = createLogger("graph-workflow-merge-runner");

export interface GraphMergeRunnerInput {
  jobId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  contextId: string;
  branchName: string;
  featureWorktreePath: string;
  targetBranch: string;
  targetWorktreePath: string;
  message: string;
  /** Operator guidance for conflict resolution, threaded into the machine's
   *  resolver as per-file decisions. */
  decisions?: ConflictDecisionInput[];
}

export interface GraphMergeRunner {
  run(input: GraphMergeRunnerInput): Promise<MergeOutput>;
}

export interface GraphMergeRunnerDeps {
  /**
   * For tests: build a merge machine variant. Production omits this; the
   * runner uses the default machine and signals "do not finalize the
   * session on publish" via `finalizeSessionOnPublish: false` on the
   * machine input — that's the only difference from a user-driven Smart
   * Merge.
   */
  buildMachine?: () => MergeMachineType;
}

export function createGraphWorkflowMergeRunner(
  deps: GraphMergeRunnerDeps = {},
): GraphMergeRunner {
  const buildMachine = deps.buildMachine ?? (() => mergeMachine);

  return {
    async run(input: GraphMergeRunnerInput): Promise<MergeOutput> {
      logger.info("graph_merge_started", {
        jobId: input.jobId,
        contextId: input.contextId,
        branchName: input.branchName,
        targetBranch: input.targetBranch,
        featureWorktreePath: input.featureWorktreePath,
        targetWorktreePath: input.targetWorktreePath,
      });

      const machine = buildMachine();
      const actor = createActor(machine, {
        input: {
          jobId: input.jobId,
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          worktreePath: input.featureWorktreePath,
          branchName: input.branchName,
          message: input.message,
          autoResolve: true,
          decisions: input.decisions,
          targetBranch: input.targetBranch,
          targetWorktreePath: input.targetWorktreePath,
          finalizeSessionOnPublish: false,
        },
      });
      actor.start();
      const output = await toPromise(actor);

      logger.info("graph_merge_finished", {
        jobId: input.jobId,
        contextId: input.contextId,
        status: output.status,
        mergeHash: output.mergeHash,
        conflictFiles: output.conflictFiles.length,
      });

      return output;
    },
  };
}
