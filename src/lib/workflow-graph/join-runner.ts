import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import type { GraphMergeRunner } from "./graph-merge-runner";
import type { PerSessionMergeMutex } from "./per-session-merge-mutex";
import type { SessionGitLock } from "./session-git-lock";
import { applyJoinProgress, remainingSourceLanes } from "./lane-join";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
} from "@/lib/workflows/schemas";
const logger = createLogger("graph-workflow-join-runner");

export type JoinRunnerMutateActive = (
  mutator: (
    execution: GraphWorkflowExecution,
  ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
) => Promise<GraphWorkflowExecution>;

interface JoinRunnerRunInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  joinId: string;
  mutateActive: JoinRunnerMutateActive;
}

type JoinRunResult =
  | { status: "succeeded" }
  | {
      status: "failed";
      message: string;
      conflictFiles: string[];
      failedSourceLaneId: string;
    };

export interface JoinRunner {
  run(input: JoinRunnerRunInput): Promise<JoinRunResult>;
}

export interface JoinRunnerDeps {
  mergeRunner: GraphMergeRunner;
  sessionGitLock: SessionGitLock;
  mergeMutex: PerSessionMergeMutex;
  createJobId?(): string;
  now?(): string;
}

export function createJoinRunner(deps: JoinRunnerDeps): JoinRunner {
  const createJobId = deps.createJobId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async run(input): Promise<JoinRunResult> {
      const { projectPath, projectName, sessionName, joinId, mutateActive } =
        input;

      let execution = await mutateActive((e) =>
        applyJoinProgress(e, joinId, now(), { status: "running" }),
      );

      let join = execution.joins[joinId];
      if (!join) {
        const message = `Join ${joinId} not found`;
        logger.error("graph-workflow.join.missing", {
          joinId,
          executionId: execution.id,
        });
        return {
          status: "failed",
          message,
          conflictFiles: [],
          failedSourceLaneId: "",
        };
      }

      const targetLane = execution.executionLanes[join.targetLaneId];
      if (!targetLane || targetLane.worktreePath === null) {
        const message = `Target lane ${join.targetLaneId} is missing or has no worktree path`;
        execution = await mutateActive((e) =>
          applyJoinProgress(e, joinId, now(), {
            status: "failed",
            errorMessage: message,
          }),
        );
        logger.error("graph-workflow.join.target_invalid", {
          joinId,
          targetLaneId: join.targetLaneId,
          executionId: execution.id,
        });
        return {
          status: "failed",
          message,
          conflictFiles: [],
          failedSourceLaneId: "",
        };
      }

      const targetBranch = targetLane.branchName;
      const targetWorktreePath = targetLane.worktreePath;

      while (true) {
        const currentJoin: GraphWorkflowExecutionJoinState = join;
        const remaining = remainingSourceLanes(currentJoin);
        if (remaining.length === 0) {
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), { status: "succeeded" }),
          );
          logger.info("graph-workflow.join.completed", {
            joinId,
            kind: currentJoin.kind,
            targetLaneId: currentJoin.targetLaneId,
            executionId: execution.id,
          });
          return { status: "succeeded" };
        }

        const sourceLaneId = remaining[0]!;
        const sourceLane = execution.executionLanes[sourceLaneId];
        if (!sourceLane || sourceLane.worktreePath === null) {
          const message = `Source lane ${sourceLaneId} is missing or has no worktree path`;
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), {
              status: "failed",
              errorMessage: message,
            }),
          );
          logger.error("graph-workflow.join.source_invalid", {
            joinId,
            sourceLaneId,
            executionId: execution.id,
          });
          return {
            status: "failed",
            message,
            conflictFiles: [],
            failedSourceLaneId: sourceLaneId,
          };
        }

        let mergeStatus: "completed" | "failed" | "conflicts";
        let mergeError: string | null = null;
        let mergeConflictFiles: string[] = [];

        try {
          const output = await deps.mergeMutex.withMergeMutex(
            { projectPath, sessionName },
            () =>
              deps.sessionGitLock.withSessionGitLock(
                { projectPath, sessionName },
                () =>
                  deps.mergeRunner.run({
                    jobId: createJobId(),
                    projectPath,
                    projectName,
                    sessionName,
                    contextId: currentJoin.contextId ?? currentJoin.joinId,
                    branchName: sourceLane.branchName,
                    featureWorktreePath: sourceLane.worktreePath!,
                    targetBranch,
                    targetWorktreePath,
                    message: `Graph workflow join ${currentJoin.kind} ${currentJoin.joinId}: ${sourceLaneId} -> ${currentJoin.targetLaneId}`,
                  }),
              ),
          );
          mergeStatus = output.status;
          mergeError = output.error;
          mergeConflictFiles = output.conflictFiles;
        } catch (err) {
          mergeStatus = "failed";
          mergeError = getErrorMessage(err);
          mergeConflictFiles = [];
        }

        if (mergeStatus === "completed") {
          execution = await mutateActive((e) =>
            applyJoinProgress(e, joinId, now(), {
              status: "running",
              addMergedSourceLaneId: sourceLaneId,
            }),
          );
          const refreshed = execution.joins[joinId];
          if (!refreshed) {
            const message = `Join ${joinId} disappeared after persisting progress`;
            logger.error("graph-workflow.join.disappeared", { joinId });
            return {
              status: "failed",
              message,
              conflictFiles: [],
              failedSourceLaneId: sourceLaneId,
            };
          }
          join = refreshed;
          logger.info("graph-workflow.join.source_merged", {
            joinId,
            sourceLaneId,
            targetLaneId: join.targetLaneId,
            executionId: execution.id,
          });
          continue;
        }

        const failureStatus =
          mergeStatus === "conflicts" ? "conflicts" : "failed";
        const message = mergeError ?? "Join merge failed";
        execution = await mutateActive((e) =>
          applyJoinProgress(e, joinId, now(), {
            status: failureStatus,
            errorMessage: message,
            conflicts:
              mergeConflictFiles.length > 0
                ? { files: mergeConflictFiles, message }
                : null,
          }),
        );
        logger.error("graph-workflow.join.source_merge_failed", {
          joinId,
          sourceLaneId,
          mergeStatus: failureStatus,
          conflictFiles: mergeConflictFiles.length,
          executionId: execution.id,
        });
        return {
          status: "failed",
          message,
          conflictFiles: mergeConflictFiles,
          failedSourceLaneId: sourceLaneId,
        };
      }
    },
  };
}
