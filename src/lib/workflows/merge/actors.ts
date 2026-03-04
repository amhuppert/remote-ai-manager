/**
 * Actor logic (fromPromise) for the Smart Merge workflow.
 *
 * Each actor wraps an existing function from the codebase and provides
 * typed input/output for the XState machine to invoke.
 */

import { fromPromise } from "xstate";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/schemas";

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface CheckUncommittedInput {
  worktreePath: string;
}
export interface CheckUncommittedOutput {
  hasChanges: boolean;
}

export interface CommitChangesInput {
  worktreePath: string;
  message: string;
  skipHooks?: boolean;
}
export interface CommitChangesOutput {
  hash: string;
}

export interface MergeMainInput {
  worktreePath: string;
}
export interface MergeMainOutput {
  status: "clean" | "conflicts";
  conflictFiles: string[];
}

export interface ResolveConflictsInput {
  worktreePath: string;
  decisions?: ConflictDecisionInput[];
}
export interface ResolveConflictsOutput {
  status: "resolved" | "failed";
  conflicts: ConflictEntry[];
  partialConflicts?: ConflictEntry[];
}

export interface RunValidationInput {
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  timeoutMs: number;
}
export type RunValidationOutput = void;

export interface FixValidationInput {
  worktreePath: string;
  validationOutput: string;
}
export interface FixValidationOutput {
  status: "fixed" | "failed";
  error?: string;
}

export interface SquashMergeInput {
  projectPath: string;
  branchName: string;
  message: string;
  sessionName: string;
}
export interface SquashMergeOutput {
  mergeHash: string;
}

// ============================================================
// Actor Definitions
// ============================================================

/** Check if a worktree has uncommitted changes. */
export const checkUncommitted = fromPromise<
  CheckUncommittedOutput,
  CheckUncommittedInput
>(async ({ input }) => {
  const { hasUncommittedChanges } = await import("@/lib/git-operations");
  const hasChanges = await hasUncommittedChanges(input.worktreePath);
  return { hasChanges };
});

/** Commit changes in a worktree. */
export const commitChangesActor = fromPromise<
  CommitChangesOutput,
  CommitChangesInput
>(async ({ input }) => {
  const { commitChanges } = await import("@/lib/git-operations");
  const { hash } = await commitChanges(input.worktreePath, input.message, {
    skipHooks: input.skipHooks,
  });
  return { hash };
});

/** Merge main branch into the feature branch. */
export const mergeMain = fromPromise<MergeMainOutput, MergeMainInput>(
  async ({ input }) => {
    const { mergeMainIntoFeature } = await import("@/lib/git-operations");
    const result = await mergeMainIntoFeature(input.worktreePath);
    return {
      status: result.status,
      conflictFiles: result.status === "conflicts" ? result.conflictFiles : [],
    };
  },
);

/** Resolve merge conflicts via Claude. */
export const resolveConflictsActor = fromPromise<
  ResolveConflictsOutput,
  ResolveConflictsInput
>(async ({ input }) => {
  const { resolveConflicts } = await import("@/lib/conflict-resolution");
  const result = await resolveConflicts({
    worktreePath: input.worktreePath,
    decisions: input.decisions,
  });
  return {
    status: result.status,
    conflicts: result.status === "resolved" ? result.conflicts : [],
    partialConflicts:
      result.status === "failed" ? result.partialConflicts : undefined,
  };
});

/** Run pre-merge validation (typecheck + tests). */
export const runValidation = fromPromise<
  RunValidationOutput,
  RunValidationInput
>(async ({ input }) => {
  const { runPreMergeValidation } = await import("@/lib/repo-config");
  await runPreMergeValidation({
    projectPath: input.projectPath,
    worktreePath: input.worktreePath,
    sessionName: input.sessionName,
    branchName: input.branchName,
    timeoutMs: input.timeoutMs,
  });
});

/** Fix validation errors via Claude. */
export const fixValidation = fromPromise<
  FixValidationOutput,
  FixValidationInput
>(async ({ input }) => {
  const { fixValidationErrors } = await import("@/lib/validation-fix");
  const result = await fixValidationErrors({
    worktreePath: input.worktreePath,
    validationOutput: input.validationOutput,
  });
  return {
    status: result.status === "fixed" ? "fixed" : "failed",
    error: result.status === "failed" ? result.error : undefined,
  };
});

/** Squash merge into main, with project lock and session cleanup. */
export const squashMergeActor = fromPromise<
  SquashMergeOutput,
  SquashMergeInput
>(async ({ input }) => {
  const { squashMerge } = await import("@/lib/git-operations");
  const { acquireProjectLock } = await import("@/lib/lock");
  const { setSessionFinished } = await import("@/lib/state");
  const { stopAllForSession } = await import("@/lib/dev-server-registry");

  // Acquire project lock with retry
  const MAX_WAIT_MS = 30_000;
  const RETRY_MS = 100;
  let releaseProject: (() => void) | undefined;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      releaseProject = acquireProjectLock(input.projectPath);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }

  if (!releaseProject) {
    throw new Error(
      "Another merge is in progress for this project. Please retry.",
    );
  }

  try {
    const { mergeHash } = await squashMerge(
      input.projectPath,
      input.branchName,
      input.message,
    );

    // Stop dev servers (best-effort)
    try {
      await stopAllForSession({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
    } catch {
      // best-effort
    }

    await setSessionFinished(input.projectPath, input.sessionName);

    return { mergeHash };
  } finally {
    releaseProject();
  }
});
