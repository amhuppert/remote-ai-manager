/**
 * Actor logic (fromPromise) for the Smart Merge workflow.
 *
 * Each actor wraps an existing function from the codebase and provides
 * typed input/output for the XState machine to invoke.
 */

import { fromPromise } from "xstate";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/jobs/schemas";
import { createLogger } from "@/lib/logging";
import {
  acquireProjectLockWithRetry,
  type AcquireProjectLockOptions,
} from "@/lib/prompt/project-lock-retry";
import type {
  PrepareResult,
  PrepareSquashMergeInput,
  PublishPreparedMergeInput,
  PublishResult,
  TargetCheckoutState,
} from "@/lib/git/worktree";

const logger = createLogger("smart-merge-actors");

// ============================================================
// Helpers
// ============================================================

/**
 * Resolve the conversation that conflict-resolution and validation-fix turns
 * should bind to for a given feature session. Picks the session's
 * most-recently-active conversation; throws when the session has no
 * conversation so the merge fails loudly rather than dispatching against an
 * undefined identifier.
 */
async function resolveSessionConversationId(
  projectPath: string,
  sessionName: string,
): Promise<string> {
  const { getSessionConversations } = await import("@/lib/state-store");
  const conversations = await getSessionConversations(projectPath, sessionName);
  const id = conversations[0]?.id;
  if (!id) {
    throw new Error(
      `No conversation found for session ${projectPath}::${sessionName}; cannot dispatch conflict-resolution / validation-fix turn`,
    );
  }
  return id;
}

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface CheckUncommittedInput {
  worktreePath: string;
}
export interface CheckUncommittedOutput {
  hasChanges: boolean;
}

export interface GetCurrentBranchInput {
  worktreePath: string;
}
export interface GetCurrentBranchOutput {
  branch: string | null;
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
  targetBranch: string;
}
export interface MergeMainOutput {
  status: "clean" | "conflicts";
  conflictFiles: string[];
}

export interface ResolveConflictsInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  decisions?: ConflictDecisionInput[];
  resolutionContext?: string;
  targetBranch?: string;
}
export interface ResolveConflictsOutput {
  status: "resolved" | "failed";
  conflicts: ConflictEntry[];
  partialConflicts?: ConflictEntry[];
}

export interface AnalyzeConflictsInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  resolutionContext?: string;
  targetBranch?: string;
}
export interface AnalyzeConflictsOutput {
  status: "analyzed" | "failed";
  conflicts: ConflictEntry[];
}

export interface RunValidationInput {
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  /**
   * Branch the work merges into, forwarded to the validation script as
   * `TARGET_BRANCH` so it scopes checks to the diff against that base. Omitted
   * by callers that have no distinct target (e.g. Smart Commit), letting the
   * script default to main.
   */
  targetBranch?: string;
  timeoutMs: number;
}
export type RunValidationOutput = void;

export interface FixValidationInput {
  worktreePath: string;
  validationOutput: string;
  projectPath: string;
  sessionName: string;
  branchName: string;
  isRetry: boolean;
}
export interface FixValidationOutput {
  status: "fixed" | "failed";
  error?: string;
}

export interface PrepareActorInput {
  projectPath: string;
  worktreePath: string;
  branchName: string;
  targetBranch: string;
  message: string;
  jobId: string;
  /** Override the auto-detected prepare path (sourced from per-repo config). */
  forcePath?: "plumbing" | "fallback";
}

export type PrepareActorOutput =
  | {
      status: "prepared";
      preparedSha: string;
      expectedTargetSha: string;
      parkedRef: string;
    }
  | {
      status: "conflicts";
      expectedTargetSha: string;
      conflictFiles: string[];
    };

export interface PublishActorInput {
  projectPath: string;
  sessionName: string;
  targetBranch: string;
  preparedSha: string;
  expectedTargetSha: string;
  parkedRef: string;
  /** When true, the actor finalises the session (state, dev-servers, child retargeting) on success. */
  finalizeSession: boolean;
}

export type PublishActorOutput =
  | {
      status: "completed";
      mergeHash: string;
      refreshWarning?: string;
    }
  | {
      status: "ready-to-land";
      parkedRef: string;
      preparedSha: string;
      targetWorktreePath: string;
    }
  | {
      status: "cas-lost";
      actualTargetSha: string;
    }
  | {
      status: "failed";
      error: string;
    };

// ============================================================
// Actor Definitions
// ============================================================

/** Check if a worktree has uncommitted changes. */
export const checkUncommitted = fromPromise<
  CheckUncommittedOutput,
  CheckUncommittedInput
>(async ({ input }) => {
  const { hasUncommittedChanges } = await import("@/lib/git/commits");
  const hasChanges = await hasUncommittedChanges(input.worktreePath);
  return { hasChanges };
});

/** Read the worktree's currently checked-out branch (null = detached HEAD). */
export const getCurrentBranchActor = fromPromise<
  GetCurrentBranchOutput,
  GetCurrentBranchInput
>(async ({ input }) => {
  const { getCurrentBranch } = await import("@/lib/git/commits");
  const branch = await getCurrentBranch(input.worktreePath);
  return { branch };
});

/** Commit changes in a worktree. */
export const commitChangesActor = fromPromise<
  CommitChangesOutput,
  CommitChangesInput
>(async ({ input }) => {
  const { commitChanges } = await import("@/lib/git/commits");
  const { hash } = await commitChanges(input.worktreePath, input.message, {
    skipHooks: input.skipHooks,
  });
  return { hash };
});

/** Merge target branch into the feature branch. */
export const mergeMain = fromPromise<MergeMainOutput, MergeMainInput>(
  async ({ input }) => {
    const { mergeTargetIntoFeature } = await import("@/lib/git/worktree");
    const result = await mergeTargetIntoFeature(
      input.worktreePath,
      input.targetBranch,
    );
    return {
      status: result.status,
      conflictFiles: result.status === "conflicts" ? result.conflictFiles : [],
    };
  },
);

/** Resolve merge conflicts via the conversation actor. */
export const resolveConflictsActor = fromPromise<
  ResolveConflictsOutput,
  ResolveConflictsInput
>(async ({ input }) => {
  const { resolveConflicts } =
    await import("@/lib/sessions/conflict-resolution");
  const conversationId = await resolveSessionConversationId(
    input.projectPath,
    input.sessionName,
  );
  const result = await resolveConflicts({
    worktreePath: input.worktreePath,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    decisions: input.decisions,
    resolutionContext: input.resolutionContext,
    targetBranch: input.targetBranch,
  });
  return {
    status: result.status,
    conflicts: result.status === "resolved" ? result.conflicts : [],
    partialConflicts:
      result.status === "failed" ? result.partialConflicts : undefined,
  };
});

/** Analyze merge conflicts without resolving them. */
export const analyzeConflictsActor = fromPromise<
  AnalyzeConflictsOutput,
  AnalyzeConflictsInput
>(async ({ input }) => {
  const { analyzeConflicts } =
    await import("@/lib/sessions/conflict-resolution");
  const conversationId = await resolveSessionConversationId(
    input.projectPath,
    input.sessionName,
  );
  const result = await analyzeConflicts({
    worktreePath: input.worktreePath,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    resolutionContext: input.resolutionContext,
    targetBranch: input.targetBranch,
  });
  return {
    status: result.status,
    conflicts: result.status === "analyzed" ? result.conflicts : [],
  };
});

/** Run pre-merge validation (typecheck + tests). */
export const runValidation = fromPromise<
  RunValidationOutput,
  RunValidationInput
>(async ({ input }) => {
  const { runPreMergeValidation, readRepoConfig } =
    await import("@/lib/projects/repo-config");

  // Per-repo timeout takes precedence over the machine's default
  let timeoutMs = input.timeoutMs;
  try {
    const repoConfig = await readRepoConfig(input.projectPath);
    if (repoConfig?.preMergeTimeoutMs) {
      timeoutMs = repoConfig.preMergeTimeoutMs;
    }
  } catch {
    // Best-effort: use the machine's default timeout
  }

  await runPreMergeValidation({
    projectPath: input.projectPath,
    worktreePath: input.worktreePath,
    sessionName: input.sessionName,
    branchName: input.branchName,
    targetBranch: input.targetBranch,
    timeoutMs,
  });
});

/** Fix validation errors via the conversation actor. */
export const fixValidation = fromPromise<
  FixValidationOutput,
  FixValidationInput
>(async ({ input }) => {
  const { fixValidationErrors } =
    await import("@/lib/workflows/validation-fix");
  const { readRepoConfig } = await import("@/lib/projects/repo-config");
  const path = await import("node:path");

  // Resolve the validation command so the agent can verify its own fixes
  let validationCommand: string | undefined;
  try {
    const repoConfig = await readRepoConfig(input.projectPath);
    if (repoConfig?.preMergeCommand) {
      const scriptPath = path.default.isAbsolute(repoConfig.preMergeCommand)
        ? repoConfig.preMergeCommand
        : path.default.join(input.projectPath, repoConfig.preMergeCommand);
      validationCommand = scriptPath;
    }
  } catch {
    // Best-effort: if we can't read the config, the agent just won't verify
  }

  const conversationId = await resolveSessionConversationId(
    input.projectPath,
    input.sessionName,
  );

  const result = await fixValidationErrors({
    worktreePath: input.worktreePath,
    validationOutput: input.validationOutput,
    validationCommand,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    branchName: input.branchName,
    isRetry: input.isRetry,
  });
  return {
    status: result.status === "fixed" ? "fixed" : "failed",
    error: result.status === "failed" ? result.error : undefined,
  };
});

// ============================================================
// prepareActor / publishActor — split squash-merge pipeline
// ============================================================

export interface PrepareActorDeps {
  prepareSquashMerge(input: PrepareSquashMergeInput): Promise<PrepareResult>;
  revParse(cwd: string, ref: string): Promise<string>;
}

/** Pure inner runner — call directly in tests and from the actor factory. */
export async function runPrepare(
  deps: PrepareActorDeps,
  input: PrepareActorInput,
): Promise<PrepareActorOutput> {
  const expectedTargetSha = (
    await deps.revParse(input.projectPath, `refs/heads/${input.targetBranch}`)
  ).trim();
  const featureSha = (await deps.revParse(input.worktreePath, "HEAD")).trim();

  const result = await deps.prepareSquashMerge({
    projectPath: input.projectPath,
    featureBranch: input.branchName,
    featureSha,
    targetBranch: input.targetBranch,
    targetSha: expectedTargetSha,
    message: input.message,
    jobId: input.jobId,
    forcePath: input.forcePath,
  });

  if (result.kind === "prepared") {
    return {
      status: "prepared",
      preparedSha: result.preparedSha,
      expectedTargetSha: result.expectedTargetSha,
      parkedRef: result.parkedRef,
    };
  }

  return {
    status: "conflicts",
    expectedTargetSha: result.expectedTargetSha,
    conflictFiles: result.conflictFiles,
  };
}

export function createPrepareActor(deps: PrepareActorDeps) {
  return fromPromise<PrepareActorOutput, PrepareActorInput>(async ({ input }) =>
    runPrepare(deps, input),
  );
}

export interface PublishActorDeps {
  discoverTargetCheckout(
    projectPath: string,
    targetBranch: string,
  ): Promise<TargetCheckoutState>;
  publishPreparedMerge(
    input: PublishPreparedMergeInput,
  ): Promise<PublishResult>;
  acquireProjectLock: AcquireProjectLockOptions["acquireProjectLock"];
  setSessionFinished(projectPath: string, sessionName: string): Promise<void>;
  retargetOrphanedChildren(
    projectPath: string,
    sessionName: string,
  ): Promise<void>;
  stopAllForSession(args: {
    projectPath: string;
    sessionName: string;
  }): Promise<void>;
  maxLockWaitMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function finalizeSessionSideEffects(
  deps: PublishActorDeps,
  projectPath: string,
  sessionName: string,
): Promise<void> {
  try {
    await deps.stopAllForSession({ projectPath, sessionName });
  } catch (err) {
    logger.warn("publishActor.stop_dev_servers_failed", {
      projectPath,
      sessionName,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  await deps.setSessionFinished(projectPath, sessionName);
  await deps.retargetOrphanedChildren(projectPath, sessionName);
}

export async function runPublish(
  deps: PublishActorDeps,
  input: PublishActorInput,
): Promise<PublishActorOutput> {
  const discovery = await deps.discoverTargetCheckout(
    input.projectPath,
    input.targetBranch,
  );

  if (discovery.kind === "dirty") {
    return {
      status: "ready-to-land",
      parkedRef: input.parkedRef,
      preparedSha: input.preparedSha,
      targetWorktreePath: discovery.worktreePath,
    };
  }

  const cleanTargetWorktreePath =
    discovery.kind === "clean" ? discovery.worktreePath : null;

  const release = await acquireProjectLockWithRetry({
    acquireProjectLock: deps.acquireProjectLock,
    projectPath: input.projectPath,
    maxWaitMs: deps.maxLockWaitMs,
    retryMs: deps.retryMs,
    sleep: deps.sleep,
    callerLabel: "publish",
  });

  try {
    const result = await deps.publishPreparedMerge({
      projectPath: input.projectPath,
      targetBranch: input.targetBranch,
      preparedSha: input.preparedSha,
      expectedTargetSha: input.expectedTargetSha,
      parkedRef: input.parkedRef,
      cleanTargetWorktreePath,
    });

    if (result.kind === "cas-lost") {
      return {
        status: "cas-lost",
        actualTargetSha: result.actualTargetSha,
      };
    }

    if (input.finalizeSession) {
      await finalizeSessionSideEffects(
        deps,
        input.projectPath,
        input.sessionName,
      );
    }

    return result.refreshWarning === undefined
      ? { status: "completed", mergeHash: result.mergeHash }
      : {
          status: "completed",
          mergeHash: result.mergeHash,
          refreshWarning: result.refreshWarning,
        };
  } finally {
    release();
  }
}

export function createPublishActor(deps: PublishActorDeps) {
  return fromPromise<PublishActorOutput, PublishActorInput>(async ({ input }) =>
    runPublish(deps, input),
  );
}

// ============================================================
// discardParkedRefActor — used by the discard entry path
// ============================================================

export interface DiscardParkedRefInput {
  projectPath: string;
  parkedRef: string;
  preparedSha: string;
}
export type DiscardParkedRefOutput = void;

export interface DiscardParkedRefDeps {
  deleteParkedRef(
    projectPath: string,
    parkedRef: string,
    preparedSha: string,
  ): Promise<void>;
}

export async function runDiscardParkedRef(
  deps: DiscardParkedRefDeps,
  input: DiscardParkedRefInput,
): Promise<DiscardParkedRefOutput> {
  await deps.deleteParkedRef(
    input.projectPath,
    input.parkedRef,
    input.preparedSha,
  );
}

export function createDiscardParkedRefActor(deps: DiscardParkedRefDeps) {
  return fromPromise<DiscardParkedRefOutput, DiscardParkedRefInput>(
    async ({ input }) => runDiscardParkedRef(deps, input),
  );
}

export const discardParkedRefActor = fromPromise<
  DiscardParkedRefOutput,
  DiscardParkedRefInput
>(async ({ input }) => {
  const { defaultGitClient } = await import("@/lib/git/client");
  return runDiscardParkedRef(
    {
      async deleteParkedRef(projectPath, parkedRef, preparedSha) {
        await defaultGitClient.git(
          ["update-ref", "-d", parkedRef, preparedSha],
          projectPath,
        );
      },
    },
    input,
  );
});

/** Default singleton wired to real implementations via lazy dynamic imports. */
export const prepareActor = fromPromise<PrepareActorOutput, PrepareActorInput>(
  async ({ input }) => {
    const { prepareSquashMerge } = await import("@/lib/git/worktree");
    const { defaultGitClient } = await import("@/lib/git/client");
    const { readRepoConfig } = await import("@/lib/projects/repo-config");

    let forcePath = input.forcePath;
    if (!forcePath) {
      try {
        const repoConfig = await readRepoConfig(input.projectPath);
        forcePath = repoConfig?.preMergePreparePath;
      } catch {
        // Best-effort: fall through to git --version auto-detect
      }
    }

    return runPrepare(
      {
        prepareSquashMerge,
        async revParse(cwd, ref) {
          const { stdout } = await defaultGitClient.git(
            ["rev-parse", ref],
            cwd,
          );
          return stdout;
        },
      },
      { ...input, forcePath },
    );
  },
);

export const publishActor = fromPromise<PublishActorOutput, PublishActorInput>(
  async ({ input }) => {
    const { discoverTargetCheckout, publishPreparedMerge } =
      await import("@/lib/git/worktree");
    const { acquireProjectLock } = await import("@/lib/prompt/single-flight");
    const { setSessionFinished } = await import("@/lib/state-store");
    const { stopAllForSession } = await import("@/lib/dev-server/registry");
    const { retargetOrphanedChildren } = await import("@/lib/sessions/service");

    return runPublish(
      {
        discoverTargetCheckout,
        publishPreparedMerge,
        acquireProjectLock,
        setSessionFinished,
        retargetOrphanedChildren,
        stopAllForSession,
      },
      input,
    );
  },
);
