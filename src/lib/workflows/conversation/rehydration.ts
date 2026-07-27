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

import { createActor, type Snapshot } from "xstate";
import { getActorRegistry, getMachineFactory, isActorSettled } from "./manager";
import { durableConversationPersistence } from "./persistence-adapter";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  getConversationRuntime,
  cleanupConversationRuntime,
} from "./runtime-state";
import {
  drainConversationQueue,
  getConversationQueueDeps,
} from "@/lib/conversations/message-queue-drain";
import { createLogger, type Logger } from "@/lib/logging";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { AgentSessionRef, AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationState,
  ForkedFrom,
  ConversationRole,
} from "@/lib/conversations/schemas";
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
  conversation: {
    id: string;
    createdAt: string;
    forkedFrom: ForkedFrom;
    role: ConversationRole;
    transcriptPath: string | null;
    agentBackend: AgentBackendId;
    backendRef: AgentSessionRef | null;
    promptCount: number;
  };
  snapshot: Snapshot<unknown>;
  /** Structured-log sink. Injected so a test can read what the restore emitted;
   *  log fields are a public identity surface (R1.3). */
  log?: Logger;
}

/**
 * Restore one conversation actor from a validated, resumable persisted
 * snapshot. Abandoned-delivery recovery runs BEFORE `actor.start()` so a
 * `delivering` row orphaned by the previous process is reset to `pending` and
 * reclaimed by this actor's first drain. Recovery failure must not abort the
 * restore. Returns true when the actor started, false when restore failed.
 *
 * Exported so the recovery-before-start ordering is unit-testable with a fake
 * snapshot and injected queue deps, without driving the real state store.
 */
export async function rehydrateOneConversationActor(
  args: RehydrateOneActorArgs,
): Promise<boolean> {
  const { key, projectPath, projectName, storeSessionName, worktreePath } =
    args;
  const { conversation, snapshot } = args;
  const log = args.log ?? logger;
  const scopeRef = scopeRefFromStoreSessionName(storeSessionName);

  try {
    // Register runtime state
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    // A persisted resume-token snapshot means a real ConversationState record
    // exists, so rehydration always restores onto the durable persistence path.
    const machine = getMachineFactory()(durableConversationPersistence);
    // XState v5 requires `input` even when restoring from snapshot.
    // The snapshot already contains the full context, so input is
    // only used for type satisfaction — it won't override the snapshot.
    const actor = createActor(machine, {
      input: {
        projectPath,
        projectName,
        sessionName: storeSessionName,
        worktreePath,
        conversationId: conversation.id,
        createdAt: conversation.createdAt,
        forkedFrom: conversation.forkedFrom,
        role: conversation.role,
        transcriptPath: conversation.transcriptPath,
        agentBackend: conversation.agentBackend,
        backendRef: conversation.backendRef,
        promptCount: conversation.promptCount,
        persistence: "durable",
      },
      snapshot: snapshot as ReturnType<(typeof machine)["resolveState"]>,
    });

    getActorRegistry().set(key, actor);

    // Wire sendToMachine
    const runtime = getConversationRuntime(key);
    if (runtime) {
      runtime.sendToMachine = (event) => {
        actor.send(event);
      };
    }

    // Recover abandoned `delivering` rows before the actor's first drain so a
    // delivery attempt orphaned by the previous process is reset to `pending`
    // and reclaimed by this actor. Recovery failure must not abort rehydrate.
    try {
      await getConversationQueueDeps().recoverAbandonedDeliveries({
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
    }

    actor.start();

    // A restored actor does not re-enter its state, so entry-action drains
    // never fire for it. Drain explicitly when it woke settled (idle or
    // waitingForInput) so rows enqueued before the restart — e.g. an answer
    // POSTed moments before the crash — deliver without waiting for new input.
    if (isActorSettled(actor)) {
      void drainConversationQueue(
        actor,
        actor.getSnapshot().context,
        getConversationQueueDeps(),
      );
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
    cleanupConversationRuntime(key);
    getActorRegistry().delete(key);
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

export interface RehydrateConversationActorsDeps {
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
}

async function defaultRehydrateDeps(): Promise<RehydrateConversationActorsDeps> {
  const stateMod = await import("@/lib/state-store");
  const { getProjectDisplayName } = await import("@/lib/projects/resolver");
  const { validateRestoredSnapshot } = await import("./persistence");
  return {
    readAllForStartup: readAllForStartupFromDb,
    listAllProjectConversations: stateMod.listAllProjectConversations,
    getProjectDisplayName,
    getConversationMachineSnapshot: stateMod.getConversationMachineSnapshot,
    validateRestoredSnapshot,
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
  const resolved = deps ?? (await defaultRehydrateDeps());
  const projectConversations = await resolved.listAllProjectConversations();
  const state = resolved.readAllForStartup();

  let count = 0;
  let skippedNonResumable = 0;

  for (const {
    projectPath,
    storeSessionName,
    worktreePath,
    conversation,
  } of collectRehydrationCandidates(state, projectConversations)) {
    const owner: ConversationSnapshotOwner = isProjectSentinel(storeSessionName)
      ? "project"
      : "session";
    const persistedSnapshot = resolved.getConversationMachineSnapshot(
      owner,
      conversation.id,
    );
    if (persistedSnapshot == null) continue;

    const snapshot = resolved.validateRestoredSnapshot(
      persistedSnapshot,
      conversation.id,
      1, // expected schema version
    );

    if (!snapshot) continue;

    if (!shouldRehydrateSnapshot(snapshot)) {
      skippedNonResumable++;
      continue;
    }

    const key = conversationRuntimeKey(
      projectPath,
      storeSessionName,
      conversation.id,
    );

    // Skip if already running
    if (getActorRegistry().has(key)) continue;

    const started = await rehydrateOneConversationActor({
      key,
      projectPath,
      projectName: resolved.getProjectDisplayName(projectPath),
      storeSessionName,
      worktreePath,
      conversation: {
        id: conversation.id,
        createdAt: conversation.createdAt,
        forkedFrom: conversation.forkedFrom ?? null,
        role: conversation.role ?? null,
        transcriptPath: conversation.transcriptPath ?? null,
        agentBackend: conversation.agentBackend ?? "claude",
        backendRef: conversation.backendRef ?? null,
        promptCount: conversation.promptCount ?? 0,
      },
      snapshot,
    });

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
