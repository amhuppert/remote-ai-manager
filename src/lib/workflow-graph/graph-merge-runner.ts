import { createActor, toPromise } from "xstate";
import { createLogger } from "@/lib/logging";
import {
  mergeMachine,
  type MergeMachineType,
} from "@/lib/workflows/merge/machine";
import { graphContextSquashMergeActor } from "@/lib/workflow-graph/graph-context-squash-merge-actor";
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
}

export interface GraphMergeRunner {
  run(input: GraphMergeRunnerInput): Promise<MergeOutput>;
}

export interface GraphMergeRunnerDeps {
  /**
   * For tests: build a merge machine variant. Production omits this and the
   * runner constructs `mergeMachine.provide({ actors: { squashMerge:
   * graphContextSquashMergeActor } })` so fan-in does not run the
   * session-finalizing default squash actor.
   */
  buildMachine?: () => MergeMachineType;
}

export function createGraphWorkflowMergeRunner(
  deps: GraphMergeRunnerDeps = {},
): GraphMergeRunner {
  const buildMachine =
    deps.buildMachine ??
    (() =>
      mergeMachine.provide({
        actors: {
          squashMerge: graphContextSquashMergeActor,
        },
      }));

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
          targetBranch: input.targetBranch,
          targetWorktreePath: input.targetWorktreePath,
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
