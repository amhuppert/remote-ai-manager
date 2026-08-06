import path from "node:path";
import { stat } from "node:fs/promises";
import { createLogger } from "@/lib/logging";
import { getActiveGraphWorkflowExecution, getSession } from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  createExecutionTargetResolver,
  type ExecutionTarget,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { DevServerTargetRef } from "./schemas";

const logger = createLogger("dev-server-target-resolver");

export type DevServerTargetErrorCode =
  | "INVALID_DEV_SERVER_TARGET"
  | "SESSION_NOT_FOUND"
  | "WORKFLOW_EXECUTION_NOT_ACTIVE"
  | "WORKFLOW_CONTEXT_NOT_FOUND"
  | "WORKFLOW_WORKTREE_UNAVAILABLE";

export class DevServerTargetError extends Error {
  constructor(
    readonly code: DevServerTargetErrorCode,
    message: string,
    readonly status: number,
    readonly instruction?: string,
  ) {
    super(message);
    this.name = "DevServerTargetError";
  }
}

export interface ResolvedDevServerTarget {
  kind: DevServerTargetRef["kind"];
  worktreePath: string;
  branchName: string;
  isolation: "session" | "worktree";
  executionId: string | null;
  contextId: string | null;
  laneId: string | null;
}

export interface DevServerTargetResolverInput {
  projectName: string;
  projectPath: string;
  sessionName: string;
  target: DevServerTargetRef;
}

export interface DevServerTargetResolver {
  resolve(
    input: DevServerTargetResolverInput,
  ): Promise<ResolvedDevServerTarget>;
}

export interface DevServerTargetResolverDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  directoryExists(candidate: string): Promise<boolean>;
}

const defaultDeps: DevServerTargetResolverDeps = {
  getSession,
  getActiveGraphWorkflowExecution,
  async directoryExists(candidate) {
    try {
      return (await stat(candidate)).isDirectory();
    } catch {
      return false;
    }
  },
};

const executionTargetResolver = createExecutionTargetResolver();

function executionNotActive(): DevServerTargetError {
  return new DevServerTargetError(
    "WORKFLOW_EXECUTION_NOT_ACTIVE",
    "The claimed workflow execution is not active for this session.",
    409,
    "Run `cctl workflow status` to read the live execution; if this execution was superseded, stop dev-server work and surface the mismatch to the orchestrator or user.",
  );
}

function workflowWorktreeUnavailable(detail: string): DevServerTargetError {
  return new DevServerTargetError(
    "WORKFLOW_WORKTREE_UNAVAILABLE",
    `The workflow context worktree is unavailable: ${detail}`,
    409,
    "The lane worktree is not provisioned, is being removed, or is gone; dev-server work must not continue there.",
  );
}

function hasUnavailableCleanup(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const state = execution.contextStates[contextId];
  if (!state) return false;
  if (state.cleanupStatus === "pending" || state.cleanupStatus === "removed") {
    return true;
  }
  if (state.laneId === null) return false;
  return Object.values(execution.contextStates).some(
    (candidate) =>
      candidate.laneId === state.laneId &&
      (candidate.cleanupStatus === "pending" ||
        candidate.cleanupStatus === "removed"),
  );
}

function resolveWorkflowExecutionTarget(
  execution: GraphWorkflowExecution,
  contextId: string,
  session: SessionState,
): ExecutionTarget {
  const state = execution.contextStates[contextId];
  const definitionHasContext =
    execution.workingDefinition.executionContexts.some(
      (candidate) => candidate.id === contextId,
    );
  if (!state || !definitionHasContext) {
    throw new DevServerTargetError(
      "WORKFLOW_CONTEXT_NOT_FOUND",
      `Workflow context "${contextId}" was not found in the active execution.`,
      404,
    );
  }
  if (hasUnavailableCleanup(execution, contextId)) {
    throw workflowWorktreeUnavailable("cleanup has started");
  }

  const hasProvisionedContextWorktree =
    state.worktreePath !== null && state.branchName !== null;
  if (
    state.laneId === null &&
    !hasProvisionedContextWorktree &&
    (state.status === "pending" || state.status === "ready")
  ) {
    throw workflowWorktreeUnavailable("the context has not been provisioned");
  }
  if (state.laneId !== null) {
    const lane = execution.executionLanes[state.laneId];
    if (!lane) {
      throw workflowWorktreeUnavailable(
        "the assigned execution lane is missing",
      );
    }
    if (lane.kind === "worktree" && lane.worktreePath === null) {
      throw workflowWorktreeUnavailable("the assigned lane has no worktree");
    }
  }

  try {
    return executionTargetResolver.resolve({ execution, contextId, session });
  } catch (error) {
    throw workflowWorktreeUnavailable(getErrorMessage(error));
  }
}

export function parseDevServerTarget(request: Request): DevServerTargetRef {
  const searchParams = new URL(request.url).searchParams;
  const executionIds = searchParams.getAll("executionId");
  const contextIds = searchParams.getAll("contextId");
  if (executionIds.length === 0 && contextIds.length === 0) {
    return { kind: "session" };
  }
  const executionId = executionIds[0];
  const contextId = contextIds[0];
  if (
    executionIds.length !== 1 ||
    contextIds.length !== 1 ||
    executionId === undefined ||
    contextId === undefined ||
    executionId.trim() === "" ||
    contextId.trim() === ""
  ) {
    throw new DevServerTargetError(
      "INVALID_DEV_SERVER_TARGET",
      "executionId and contextId must be supplied together and must be non-empty.",
      400,
    );
  }
  return { kind: "workflow-context", executionId, contextId };
}

export function createDevServerTargetResolver(
  deps: DevServerTargetResolverDeps = defaultDeps,
): DevServerTargetResolver {
  return {
    async resolve(input) {
      const { projectName, projectPath, sessionName, target } = input;
      try {
        const session = await deps.getSession(projectPath, sessionName);
        if (!session) {
          throw new DevServerTargetError(
            "SESSION_NOT_FOUND",
            `Session "${sessionName}" was not found.`,
            404,
          );
        }

        let resolved: ResolvedDevServerTarget;
        if (target.kind === "session") {
          resolved = {
            kind: "session",
            worktreePath: path.resolve(session.worktreePath),
            branchName: session.branchName,
            isolation: "session",
            executionId: null,
            contextId: null,
            laneId: null,
          };
        } else {
          const execution = await deps.getActiveGraphWorkflowExecution(
            projectPath,
            sessionName,
          );
          if (!execution || execution.id !== target.executionId) {
            throw executionNotActive();
          }
          const executionTarget = resolveWorkflowExecutionTarget(
            execution,
            target.contextId,
            session,
          );
          const worktreePath = path.resolve(executionTarget.worktreePath);
          if (!(await deps.directoryExists(worktreePath))) {
            throw workflowWorktreeUnavailable(
              "the resolved directory does not exist",
            );
          }
          resolved = {
            kind: "workflow-context",
            worktreePath,
            branchName: executionTarget.branchName,
            isolation: executionTarget.isolation,
            executionId: execution.id,
            contextId: target.contextId,
            laneId: executionTarget.laneId,
          };
        }

        logger.debug("dev-server.target.resolved", {
          projectName,
          sessionName,
          targetKind: resolved.kind,
          executionId: resolved.executionId,
          contextId: resolved.contextId,
          laneId: resolved.laneId,
          isolation: resolved.isolation,
          worktreePath: resolved.worktreePath,
        });
        return resolved;
      } catch (error) {
        if (error instanceof DevServerTargetError) {
          logger.warn("dev-server.target.rejected", {
            projectName,
            sessionName,
            targetKind: target.kind,
            executionId:
              target.kind === "workflow-context" ? target.executionId : null,
            contextId:
              target.kind === "workflow-context" ? target.contextId : null,
            code: error.code,
          });
        }
        throw error;
      }
    },
  };
}

export const devServerTargetResolver = createDevServerTargetResolver();
