import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import {
  conversationTotals,
  toConversationDurableSeed,
  type ConversationDurableSeed,
} from "./actor-input-loader";
/**
 * Conversation actor rehydration policy.
 *
 * Decides which persisted machine snapshots are worth restoring into live
 * actors at server startup, and performs the restore: candidates are flattened
 * across session conversations and session-less project conversations, only
 * snapshots waiting on a permission answer resume, and each restored actor is
 * registered into the manager-owned actor registry with abandoned queue
 * deliveries recovered before its first drain.
 */

import { type Snapshot } from "xstate";
import { isActorSettled, type ConversationActorHost } from "./actor-host";
import type { ConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import type { ConversationActorRef } from "./machine";

import { conversationRuntimeKey } from "./runtime-state";
import { drainConversationQueue } from "@/lib/conversations/message-queue-drain";
import { createLogger, type Logger } from "@/lib/logging";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import {
  PROJECT_CONVERSATION_SESSION_SENTINEL,
  isProjectSentinel,
} from "@/lib/conversations/project-conversation-scope";
import type { ConversationSnapshotOwner } from "@/lib/state-store";
// Deep import (not the barrel): the whole-state startup read is deliberately
// NOT a StateStore method, so it is reachable only through the startup-owned
// module. The `no-restricted-imports` startup-reader gate allowlists this file.
import { readAllForStartupFromDb } from "@/lib/state-store/startup-reader";
import { getErrorMessage } from "@/lib/shared/errors";
import { isActiveQueuedMessageStatus } from "@/lib/conversations/message-queue-schemas";

// The `conversation-manager` module key is a stable log-query key: rehydration
// events group with the manager's actor lifecycle events, so one module filter
// covers a conversation actor's full lifecycle across restarts.
const logger = createLogger("conversation-manager");

/**
 * Decide whether a persisted conversation snapshot is worth restoring into a
 * live actor at startup.
 *
 * The only machine state that can meaningfully resume across a process
 * boundary is "waiting for a permission answer" — i.e. `pendingQuestion` is
 * set in context. A user can still answer that question after a restart, and
 * the actor needs to be live to receive the event.
 *
 * Every other snapshot shape (idle, executing.*, acquiringResources, debug.*,
 * externalExecuting, etc.) is non-resumable: the underlying invoked actor
 * (SDK stream, subprocess) is dead, so the in-machine state is stale. A fresh
 * actor created lazily by `ensureConversationActor` is functionally
 * equivalent — `applySyncDerivedFields` will overwrite any stale
 * `ConversationState.status` ("running"/"waiting_for_input") on the next
 * machine event.
 */
export function shouldRehydrateSnapshot(snapshot: Snapshot<unknown>): boolean {
  if (snapshot.status !== "active") return false;
  const context = (snapshot as { context?: { pendingQuestion?: unknown } })
    .context;
  return context?.pendingQuestion != null;
}

interface RehydrateOneActorArgs {
  key: string;
  projectPath: string;
  projectName: string;
  /**
   * The session-keyed runtime/state-store name — the project sentinel for a
   * session-less project conversation (A5). Named for what it is so it cannot be
   * spread into a log line as a public `sessionName`: this stage's structured
   * events carry the discriminated scope instead (R1.3).
   */
  storeSessionName: string;
  worktreePath: string;
  conversation: ConversationDurableSeed & { id: string };
  snapshot?: Snapshot<unknown>;
  /** Structured-log sink. Injected so a test can read what the restore emitted;
   *  log fields are a public identity surface (R1.3). */
  log?: Logger;
}

/**
 * Restore a resumable actor, or start an idle actor for an ordinary queue.
 * Recovery precedes actor startup so orphaned deliveries require review before
 * any automatic drain. A failed recovery prevents startup.
 *
 * Exported so the recovery-before-start ordering is unit-testable with a fake
 * snapshot and injected queue deps, without driving the real state store.
 */
export async function rehydrateOneConversationActor(
  args: RehydrateOneActorArgs,
  deps: {
    host: ConversationActorHost;
    queue: ConversationQueueDeps;
    mutateConversation: import("./effects").ConversationDurableEffects["mutateConversation"];
  },
): Promise<boolean> {
  const { key, projectPath, projectName, storeSessionName, worktreePath } =
    args;
  const { conversation, snapshot } = args;
  const log = args.log ?? logger;
  const scopeRef = scopeRefFromStoreSessionName(storeSessionName);

  try {
    // XState v5 requires `input` even when restoring from snapshot.
    // Row-owned accounting overrides the debounced snapshot; control state
    // and pending questions remain owned by the validated snapshot.
    const restored = snapshot as
      | ReturnType<ConversationActorRef["getSnapshot"]>
      | undefined;
    const overlaidSnapshot = restored
      ? {
          ...restored,
          context: {
            ...restored.context,
            totals: conversationTotals(conversation),
            promptCount: conversation.promptCount,
            lastActivityAt: conversation.lastActivityAt,
          },
        }
      : undefined;
    const actor = deps.host.create(
      {
        projectPath,
        target: targetFromStoreSessionName(
          projectName,
          storeSessionName,
          conversation.id,
        ),

        worktreePath,

        ...conversation,
        persistence: "durable",
      },
      overlaidSnapshot,
    );

    // Recover abandoned `delivering` rows before the actor's first drain so a
    // delivery attempt orphaned by the previous process requires review before
    // this actor can drain later messages.
    try {
      await deps.queue.recoverAbandonedDeliveries({
        projectPath,
        sessionName: storeSessionName,
        conversationId: conversation.id,
      });
    } catch (err) {
      log.error("queue.recover_failed", {
        conversationId: conversation.id,
        ...scopeRef,
        error: getErrorMessage(err),
      });
      throw err;
    }

    if (!snapshot) {
      await deps.mutateConversation(
        projectPath,
        storeSessionName,
        conversation.id,
        "conversation-manager.recoverIdle",
        (record) => {
          record.status = "awaiting";
          record.activeTurnSource = null;
          record.pendingQuestionId = null;
          record.pendingQuestions = null;
        },
      );
      log.info("conversation-manager.interrupted_turn_settled", {
        conversationId: conversation.id,
        ...scopeRef,
      });
    }

    actor.start();

    // A restored actor does not re-enter its state, so entry-action drains
    // never fire for it. Drain explicitly when it woke settled (idle or
    // waitingForInput) so rows enqueued before the restart — e.g. an answer
    // POSTed moments before the crash — deliver without waiting for new input.
    if (isActorSettled(actor)) {
      void drainConversationQueue(actor.getSnapshot().context, deps.queue);
    }

    log.info("conversation-manager.rehydrated", {
      conversationId: conversation.id,
      ...scopeRef,
      projectName,
    });
    return true;
  } catch (err) {
    log.error("conversation-manager.rehydrate_failed", {
      conversationId: conversation.id,
      ...scopeRef,
      error: getErrorMessage(err),
    });
    // Clean up partial registration
    const actor = deps.host.get(key);
    if (actor) {
      actor.stop();
      deps.host.remove(key, actor);
    }
    return false;
  }
}

/**
 * A conversation eligible for snapshot rehydration. Session conversations bind
 * to their owning session's worktree; session-less project conversations key on
 * the sentinel session name and bind to the project's repo-root worktree.
 */
export interface RehydrationCandidate {
  projectPath: string;
  /** Session-keyed store/runtime name; the sentinel at project scope (A5). */
  storeSessionName: string;
  worktreePath: string;
  conversation: ConversationState;
}

/**
 * Flatten session conversations and session-less project conversations into a
 * single rehydration candidate list. Pure — directly unit-testable.
 */
export function collectRehydrationCandidates(
  state: ManagerState,
  projectConversations: ReadonlyArray<{
    projectPath: string;
    conversation: ConversationState;
  }>,
): RehydrationCandidate[] {
  const candidates: RehydrationCandidate[] = [];
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const [sessionName, session] of Object.entries(project.sessions)) {
      for (const conversation of session.conversations) {
        candidates.push({
          projectPath,
          storeSessionName: sessionName,
          worktreePath: session.worktreePath,
          conversation,
        });
      }
    }
  }
  for (const { projectPath, conversation } of projectConversations) {
    candidates.push({
      projectPath,
      storeSessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: projectPath,
      conversation,
    });
  }
  return candidates;
}

export interface WorkflowResultRecoveryScope {
  projectPath: string;
  sessionName: string;
}

/** Every persisted session, including sessions whose conversation list is empty. */
export function collectWorkflowResultRecoveryScopes(
  state: ManagerState,
): WorkflowResultRecoveryScope[] {
  const scopes: WorkflowResultRecoveryScope[] = [];
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const sessionName of Object.keys(project.sessions)) {
      scopes.push({ projectPath, sessionName });
    }
  }
  return scopes;
}

export interface RehydrateConversationActorsDeps {
  host: ConversationActorHost;
  queue: ConversationQueueDeps;
  mutateConversation: import("./effects").ConversationDurableEffects["mutateConversation"];
  /**
   * The startup-only whole-state read. Assembles the project/session/
   * conversation tree without touching the snapshot sidecar — resume tokens are
   * fetched per candidate via `getConversationMachineSnapshot` below.
   */
  readAllForStartup(): ManagerState;
  listAllProjectConversations(): Promise<
    { projectPath: string; conversation: ConversationState }[]
  >;
  getProjectDisplayName(projectPath: string): string;
  /**
   * Point read of one conversation's persisted resume-token snapshot from the
   * owner-discriminated sidecar. The snapshot no longer rides the conversation
   * row, so rehydration fetches it per candidate on demand.
   */
  getConversationMachineSnapshot(
    owner: ConversationSnapshotOwner,
    conversationId: string,
  ): unknown | null;
  validateRestoredSnapshot(
    raw: unknown,
    conversationId: string,
    expectedSchemaVersion: number,
  ): Snapshot<unknown> | null;
  recoverWorkflowResultClaims?(
    projectPath: string,
    sessionName: string,
  ): Promise<number>;
  reconcileWorkflowResultEffects?(
    projectPath: string,
    sessionName: string,
  ): Promise<number>;
}

export async function loadRehydrationInfrastructure(): Promise<
  Omit<RehydrateConversationActorsDeps, "host" | "queue">
> {
  const stateMod = await import("@/lib/state-store");
  const { getProjectDisplayName } = await import("@/lib/projects/resolver");
  const { validateRestoredSnapshot } = await import("./persistence");
  const { getGraphWorkflowResultDeliveryService } =
    await import("@/lib/workflow-graph/result-delivery-service");
  return {
    mutateConversation: stateMod.mutateConversation,
    readAllForStartup: readAllForStartupFromDb,
    listAllProjectConversations: stateMod.listAllProjectConversations,
    getProjectDisplayName,
    getConversationMachineSnapshot: stateMod.getConversationMachineSnapshot,
    validateRestoredSnapshot,
    recoverWorkflowResultClaims: stateMod.recoverGraphWorkflowResultDeliveries,
    reconcileWorkflowResultEffects: (projectPath, sessionName) =>
      getGraphWorkflowResultDeliveryService().reconcilePendingResults(
        projectPath,
        sessionName,
      ),
  };
}

/**
 * Rehydrate conversation actors from persisted snapshots on startup — across
 * both session conversations and session-less project conversations.
 * Returns the number of actors rehydrated.
 */
export async function rehydrateConversationActors(
  deps?: RehydrateConversationActorsDeps,
): Promise<number> {
  if (!deps) {
    const { restorePersistedConversations } = await import("./manager");
    return restorePersistedConversations();
  }
  const resolved = deps;
  const projectConversations = await resolved.listAllProjectConversations();
  const state = resolved.readAllForStartup();
  const candidates = collectRehydrationCandidates(state, projectConversations);
  const workflowResultScopes = collectWorkflowResultRecoveryScopes(state);

  if (resolved.reconcileWorkflowResultEffects) {
    for (const { projectPath, sessionName } of workflowResultScopes) {
      try {
        await resolved.reconcileWorkflowResultEffects(projectPath, sessionName);
      } catch (err) {
        logger.error(
          "conversation-manager.workflow_result_effect_reconciliation_failed",
          {
            scope: "session",
            projectPath,
            sessionName,
            error: getErrorMessage(err),
          },
        );
      }
    }
  }

  if (resolved.recoverWorkflowResultClaims) {
    for (const { projectPath, sessionName } of workflowResultScopes) {
      try {
        const recovered = await resolved.recoverWorkflowResultClaims(
          projectPath,
          sessionName,
        );
        if (recovered > 0) {
          logger.info("conversation-manager.workflow_result_claims_recovered", {
            scope: "session",
            projectPath,
            sessionName,
            recovered,
          });
        }
      } catch (err) {
        logger.error("conversation-manager.workflow_result_recovery_failed", {
          scope: "session",
          projectPath,
          sessionName,
          error: getErrorMessage(err),
        });
      }
    }
  }

  let count = 0;
  let skippedNonResumable = 0;

  for (const {
    projectPath,
    storeSessionName,
    worktreePath,
    conversation,
  } of candidates) {
    const owner: ConversationSnapshotOwner = isProjectSentinel(storeSessionName)
      ? "project"
      : "session";
    const persistedSnapshot = resolved.getConversationMachineSnapshot(
      owner,
      conversation.id,
    );
    const snapshot =
      persistedSnapshot == null
        ? null
        : resolved.validateRestoredSnapshot(
            persistedSnapshot,
            conversation.id,
            1, // expected schema version
          );

    const resumeSnapshot =
      snapshot && shouldRehydrateSnapshot(snapshot) ? snapshot : undefined;
    const hasOrdinaryQueue =
      conversation.role === null &&
      !conversation.archived &&
      conversation.pendingQueue.some((row) =>
        isActiveQueuedMessageStatus(row.status),
      );
    if (!resumeSnapshot && !hasOrdinaryQueue) {
      skippedNonResumable++;
      continue;
    }

    const key = conversationRuntimeKey(
      projectPath,
      storeSessionName,
      conversation.id,
    );

    // Skip if already running
    if (resolved.host.has(key)) continue;

    const started = await rehydrateOneConversationActor(
      {
        key,
        projectPath,
        projectName: resolved.getProjectDisplayName(projectPath),
        storeSessionName,
        worktreePath,
        conversation: {
          id: conversation.id,
          ...toConversationDurableSeed(conversation),
        },
        snapshot: resumeSnapshot,
      },
      resolved,
    );

    if (started) count++;
  }

  if (count > 0 || skippedNonResumable > 0) {
    logger.info("conversation-manager.rehydration_complete", {
      count,
      skippedNonResumable,
    });
  }

  return count;
}
