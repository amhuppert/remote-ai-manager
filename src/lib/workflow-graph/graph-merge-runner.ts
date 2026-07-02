import { createActor, toPromise } from "xstate";
import { createLogger } from "@/lib/logging";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import { recordMergeIntent as defaultRecordMergeIntent } from "@/lib/merge-intents/repo";
import type { RecordMergeIntentInput } from "@/lib/merge-intents/repo";
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
  /** Lane-derived intent notes for the conflict resolver (what each side of
   *  the merge was building and why), assembled at join time. */
  resolutionContext?: string;
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
  /** Persists the intent brief against the landed squash commit. */
  recordMergeIntent?(input: RecordMergeIntentInput): void;
}

export function createGraphWorkflowMergeRunner(
  deps: GraphMergeRunnerDeps = {},
): GraphMergeRunner {
  const buildMachine = deps.buildMachine ?? (() => mergeMachine);
  const recordMergeIntent = deps.recordMergeIntent ?? defaultRecordMergeIntent;

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
          resolutionContext: input.resolutionContext,
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

      // Attach the lane-derived intent brief to the landed squash commit so
      // later merges that pull this commit in can explain it to their
      // conflict resolvers. Non-throwing.
      if (
        output.status === "completed" &&
        output.mergeHash &&
        input.resolutionContext
      ) {
        try {
          recordMergeIntent({
            projectPath: input.projectPath,
            commitSha: output.mergeHash,
            intent: input.resolutionContext,
            source: "graph-join",
          });
        } catch (err) {
          logger.error("graph_merge_record_intent_failed", {
            jobId: input.jobId,
            mergeHash: output.mergeHash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return output;
    },
  };
}
