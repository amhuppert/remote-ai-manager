import { getErrorMessage } from "@/lib/shared/errors";
import type { GraphWorkflowHaltReason } from "@/lib/workflows/schemas";
export type DirtyPath = {
  path: string;
  statusCode: string;
  tracked: boolean;
};

type AgentTurnFailedInit = {
  contextId: string;
  engine: "claude" | "codex";
  cause: "sdk_error" | "abort" | "unknown";
  originalMessage: string;
};

export class AgentTurnFailedError extends Error {
  readonly contextId: string;
  readonly engine: "claude" | "codex";
  readonly cause: "sdk_error" | "abort" | "unknown";
  readonly originalMessage: string;

  constructor(message: string, init: AgentTurnFailedInit) {
    super(message);
    this.name = "AgentTurnFailedError";
    this.contextId = init.contextId;
    this.engine = init.engine;
    this.cause = init.cause;
    this.originalMessage = init.originalMessage;
  }
}

type WorktreeCreationDirtyInit = {
  worktreePath: string;
  branchName: string;
  dirtyPaths: DirtyPath[];
};

export class WorktreeCreationDirty extends Error {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly dirtyPaths: DirtyPath[];

  constructor(message: string, init: WorktreeCreationDirtyInit) {
    super(message);
    this.name = "WorktreeCreationDirty";
    this.worktreePath = init.worktreePath;
    this.branchName = init.branchName;
    this.dirtyPaths = init.dirtyPaths;
  }
}

export function isTypedWorkflowError(
  err: unknown,
): err is AgentTurnFailedError | WorktreeCreationDirty {
  return (
    err instanceof AgentTurnFailedError || err instanceof WorktreeCreationDirty
  );
}

const MAX_DIRTY_PATHS_IN_HALT = 5;

type HaltReasonFallback = {
  contextId?: string;
  cause: "sdk_error" | "validation" | "io" | "unknown";
};

export function toHaltReason(
  err: unknown,
  fallback: HaltReasonFallback,
): GraphWorkflowHaltReason {
  if (err instanceof AgentTurnFailedError) {
    return {
      type: "agent_turn_failed",
      contextId: err.contextId,
      engine: err.engine,
      cause: err.cause,
      message: err.originalMessage,
    };
  }
  if (err instanceof WorktreeCreationDirty) {
    return {
      type: "worktree_creation_dirty",
      contextId: fallback.contextId ?? null,
      worktreePath: err.worktreePath,
      branchName: err.branchName,
      dirtyPaths: err.dirtyPaths.slice(0, MAX_DIRTY_PATHS_IN_HALT),
      totalDirtyCount: err.dirtyPaths.length,
    };
  }
  return {
    type: "execution_loop_failed",
    contextId: fallback.contextId ?? null,
    message: getErrorMessage(err),
    cause: fallback.cause,
  };
}
