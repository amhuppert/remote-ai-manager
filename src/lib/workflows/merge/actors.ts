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
} from "@/lib/shared/lock-retry";
import type {
  PrepareResult,
  PrepareSquashMergeInput,
  PublishPreparedMergeInput,
  PublishResult,
  TargetCheckoutState,
} from "@/lib/git/worktree";
import type {
  DeliveryGateEvaluateInput,
  DeliveryGateEvaluation,
  DeliveryGateEvaluator,
} from "./types";
import { resolveSessionConversationId } from "../validation-fix/actors";
import { getErrorMessage } from "@/lib/shared/errors";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { evaluateGraphWorkflowSessionDelivery } from "@/lib/workflow-graph/lifecycle-classifier";

const logger = createLogger("smart-merge-actors");

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface GetCurrentBranchInput {
  worktreePath: string;
}
export interface GetCurrentBranchOutput {
  branch: string | null;
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
  /** Explicit conversation for the resolver turn (graph joins pass the source
   *  lane's implementer conversation). Falls back to the session's
   *  most-recently-active conversation when omitted. */
  conversationId?: string;
  /** Files the merge reported as conflicted; the resolver verifies these are
   *  marker-free after the agent claims resolution. */
  conflictFiles?: string[];
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
  /** See {@link ResolveConflictsInput.conversationId}. */
  conversationId?: string;
  resolutionContext?: string;
  targetBranch?: string;
}
export interface AnalyzeConflictsOutput {
  status: "analyzed" | "failed";
  conflicts: ConflictEntry[];
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

export type DeliveryGateActorInput = Omit<
  DeliveryGateEvaluateInput,
  "workflowExecutionId"
> & {
  workflowExecutionId?: string;
};

export type DeliveryGateActorOutput = DeliveryGateEvaluation;

// ============================================================
// Actor Definitions
// ============================================================

export function createDeliveryGateActor(evaluator: DeliveryGateEvaluator) {
  return fromPromise<DeliveryGateActorOutput, DeliveryGateActorInput>(
    async ({ input }) => {
      if (!input.workflowExecutionId) {
        logger.debug("delivery_gate.skipped", {
          preparedSha: input.preparedSha,
          projectPath: input.projectPath,
        });
        return { status: "pass", satisfied: [], deferred: [] };
      }

      logger.info("delivery_gate.evaluate_started", {
        workflowExecutionId: input.workflowExecutionId,
        preparedSha: input.preparedSha,
        expectedTargetSha: input.expectedTargetSha,
        projectPath: input.projectPath,
      });
      const result = await evaluator.evaluate({
        workflowExecutionId: input.workflowExecutionId,
        preparedSha: input.preparedSha,
        expectedTargetSha: input.expectedTargetSha,
        projectPath: input.projectPath,
        ...(input.candidateValidation && {
          candidateValidation: input.candidateValidation,
        }),
      });

      if (result.status === "refused") {
        logger.warn("delivery_gate.refused", {
          workflowExecutionId: input.workflowExecutionId,
          preparedSha: input.preparedSha,
          unmetCount: result.unmet.length,
        });
        return result;
      }

      logger.info("delivery_gate.passed", {
        workflowExecutionId: input.workflowExecutionId,
        preparedSha: input.preparedSha,
        satisfiedCount: result.satisfied.length,
        deferredCount: result.deferred.length,
      });
      return result;
    },
  );
}

export const deliveryGateActor = createDeliveryGateActor({
  async evaluate() {
    throw new Error(
      "Delivery gate evaluator is required for a linked workflow execution",
    );
  },
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
  const conversationId =
    input.conversationId ??
    (await resolveSessionConversationId(input.projectPath, input.sessionName));
  const result = await resolveConflicts({
    worktreePath: input.worktreePath,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    conflictFiles: input.conflictFiles,
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
  const conversationId =
    input.conversationId ??
    (await resolveSessionConversationId(input.projectPath, input.sessionName));
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
  runSessionLifecycleOperation<T>(
    projectPath: string,
    sessionName: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  setSessionFinished(projectPath: string, sessionName: string): Promise<void>;
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<Pick<GraphWorkflowExecution, "id" | "status"> | null>;
  reconcileTicketSessionLifecycle(input: {
    projectPath: string;
    sessionName: string;
    endReason: "finished";
  }): Promise<void>;
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
      err: getErrorMessage(err),
    });
  }

  await deps.runSessionLifecycleOperation(
    projectPath,
    sessionName,
    async () => {
      await deps.setSessionFinished(projectPath, sessionName);
      try {
        await deps.reconcileTicketSessionLifecycle({
          projectPath,
          sessionName,
          endReason: "finished",
        });
      } catch (err) {
        logger.warn("publishActor.ticket_lifecycle_reconcile_failed", {
          projectPath,
          sessionName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
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
    if (input.finalizeSession) {
      const deliveryDecision = evaluateGraphWorkflowSessionDelivery(
        await deps.getActiveGraphWorkflowExecution(
          input.projectPath,
          input.sessionName,
        ),
      );
      if (!deliveryDecision.allowed) {
        logger.warn("publishActor.active_graph_workflow_refused", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: deliveryDecision.executionId,
          workflowStatus: deliveryDecision.status,
        });
        return { status: "failed", error: deliveryDecision.message };
      }
    }

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
    const { getSessionLifecycleGate } =
      await import("@/lib/sessions/lifecycle-gate");
    const { getActiveGraphWorkflowExecution, setSessionFinished } =
      await import("@/lib/state-store");
    const { stopAllForSession } = await import("@/lib/dev-server/registry");
    const { retargetOrphanedChildren } = await import("@/lib/sessions/service");
    const { reconcileTicketSessionLifecycle } =
      await import("@/lib/tickets/lifecycle");

    return runPublish(
      {
        discoverTargetCheckout,
        publishPreparedMerge,
        acquireProjectLock,
        runSessionLifecycleOperation: (projectPath, sessionName, operation) =>
          getSessionLifecycleGate().runExclusive(
            projectPath,
            sessionName,
            operation,
          ),
        setSessionFinished,
        getActiveGraphWorkflowExecution,
        reconcileTicketSessionLifecycle,
        retargetOrphanedChildren,
        stopAllForSession,
      },
      input,
    );
  },
);
