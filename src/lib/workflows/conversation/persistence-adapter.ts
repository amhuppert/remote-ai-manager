/**
 * Conversation persistence facet.
 *
 * Persistence is a construction-time facet of the conversation runtime, chosen
 * once where the conversation is created rather than re-decided (or forgotten)
 * inside every machine action:
 *
 *   - `durable` — today's behavior. Owns every durable side effect of the
 *     conversation lifecycle: derived-field sync, resume-token snapshot
 *     persistence, automatic naming, the mark-read / mark-unread transitions, the
 *     project-conversation status notification, and the gating of the invoked
 *     child actors' own durable write seams (`gateActorDurableWrites`).
 *   - `ephemeral` — inert. Every method is a no-op, so a runtime with no backing
 *     `ConversationState` record (compaction lanes, workflow-graph validator
 *     lanes) performs zero state-store writes for its entire life. Before this
 *     facet existed those runtimes ran the durable actions and failed 1,314
 *     times (`Conversation not found in session`), each paying the full
 *     write-queue + focused-read pipeline before failing.
 *
 * The machine's `.provide()` block delegates its durable actions to the injected
 * adapter, so the block no longer imports `mutateConversation` or the state
 * store directly — the seam owns every durable write, and the ephemeral variant
 * makes "wrote durably behind an ephemeral label" unrepresentable.
 */

import type { Snapshot } from "xstate";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  conversationEventScopeFields,
  isProjectSentinel,
} from "@/lib/conversations/project-conversation-scope";
import type { GenerateConversationNameInput } from "@/lib/conversations/name-generation";
import type {
  ConversationContext,
  ActiveTurn,
  ConversationPersistenceMode,
} from "./types";
import type {
  ConversationState,
  ActiveTurnSource,
  ConversationUnreadEvent,
} from "@/lib/conversations/schemas";
import { persistSnapshotAfterTransition } from "./persistence";
import type { ActorDurableWriteSeams } from "./actor-implementations";

// Shares the `conversation-manager` log-module key so an adapter warning groups
// with the actor's lifecycle events under one module filter.
const logger = createLogger("conversation-manager");
const conversationNamingLogger = createLogger("conversation-naming");

// ============================================================
// Derived-field mapping (pure)
// ============================================================

/**
 * Classify the active turn as user- or workflow-driven, or null when no turn
 * is active. `task_run` turns are only dispatched by workflow callers, and
 * conversation_turn turns flagged `autonomous` come from graph-workflow's
 * implementer-runner — both should suppress UI affordances meant for the
 * conversation-panel user (e.g. the Stop button).
 */
export function deriveActiveTurnSource(
  activeTurn: ActiveTurn | null,
): ActiveTurnSource {
  if (!activeTurn) return null;
  if (activeTurn.kind === "task_run") return "workflow";
  return activeTurn.autonomous ? "workflow" : "user";
}

/**
 * Apply machine context fields to a mutable ConversationState.
 * Extracted as a pure function for testability.
 */
export function applySyncDerivedFields(
  context: ConversationContext,
  c: ConversationState,
): void {
  c.status = context.status;
  c.activeTurnSource = deriveActiveTurnSource(context.activeTurn);
  c.pendingQuestionId = context.pendingQuestion?.questionId ?? null;
  c.pendingQuestions = context.pendingQuestion?.questions ?? null;
  c.agentBackend = context.agentBackend;
  c.backendRef = context.backendRef;
  c.transcriptPath = context.transcriptPath;
  c.totalCostUsd = context.totals.totalCostUsd;
  c.totalDurationMs = context.totals.totalDurationMs;
  c.totalTurns = context.totals.totalTurns;
  c.contextTokens = context.totals.contextTokens;
  c.contextWindowMax = context.totals.contextWindowMax;
  c.promptCount = context.promptCount;
  if (context.debugMode) {
    c.debugMode = {
      active: context.debugMode.active,
      recording: context.debugMode.recording,
      logFilePath: context.debugMode.logFilePath,
      enteredAt: context.debugMode.enteredAt,
      hypotheses: context.debugMode.hypotheses,
      reproductionSteps: context.debugMode.reproductionSteps,
      fixSummary: context.debugMode.fixSummary,
      verificationSteps: context.debugMode.verificationSteps,
      instructionsDelivered: context.debugMode.instructionsDelivered,
      phase: context.debugMode.phase,
      lastTurnFailed: context.debugMode.lastTurnFailed,
      debugSessionId: context.debugMode.debugSessionId,
      cleanupVerificationAttempt: context.debugMode.cleanupVerificationAttempt,
    };
  } else {
    c.debugMode = null;
  }
}

// ============================================================
// Adapter interface
// ============================================================

/** Actor handle needed to sample the resume-token snapshot after a macrostep
 *  settles. Narrowed to the one method `persistSnapshotAfterTransition` reads. */
export interface ConversationSnapshotSource {
  getPersistedSnapshot(): Snapshot<unknown>;
}

/**
 * Owns every durable side effect of the conversation lifecycle. `durable`
 * persists; `ephemeral` guarantees zero state-store writes for the runtime's
 * entire life. Method syntax so the production adapter objects satisfy it.
 *
 * "Every durable side effect" is literal: not just the derived-field/snapshot/
 * read-state machine actions, but the project-conversation notification path
 * (which inserts a `notifications` row for sentinel-session conversations) too.
 * A facet that intercepted only the top-level actions would let an ephemeral
 * project compaction persist a notification behind an "ephemeral" label — the
 * exact `__project__`-sentinel gap this method closes.
 */
export interface ConversationPersistenceAdapter {
  /** Sync the machine's derived context fields onto the ConversationState row. */
  syncDerivedFields(context: ConversationContext): void;
  /** Persist the resume-token machine snapshot (debounced, off the hot row). */
  persistSnapshot(
    context: ConversationContext,
    actor: ConversationSnapshotSource,
  ): void;
  /** Clear the unread flag when the user starts a turn. */
  markReadOnUserTurnStart(context: ConversationContext): void;
  /** Queue background naming when the active turn is the first user turn. */
  triggerAutoNaming(context: ConversationContext): void;
  /** Set the unread flag when an agent returns control to the user. */
  markUnreadOnFinish(context: ConversationContext): void;
  /**
   * Fire the project-conversation status notification for a sentinel-session
   * conversation (durable: inserts a `notifications` row + publishes/pushes).
   * Ephemeral no-ops — a synthetic project-compaction lane never notifies.
   */
  notifyProjectStatus(context: ConversationContext): void;
  /**
   * Gate the invoked/child actors' durable state-store WRITE seams on this
   * runtime's persistence choice — the invoked-actor half of "every durable
   * side effect". `durable` returns the actor deps untouched; `ephemeral`
   * replaces every durable write seam with an inert no-op so an invoked actor
   * cannot write durably behind an ephemeral label. The gated set is not just
   * the direct `mutateConversation` / `createReferenceDocument` /
   * `markQueued*` delivery-state writes but the apply services too —
   * `applyMcpAtTurnStart` persists through `stateManager.mutateConversation`
   * and `applyCapabilityAtTurnStart` / `applyCapabilityWhenIdle` persist
   * through `writeRuntimeState`, so a facet that left them live would let an
   * ephemeral `ExecutePrompt` turn still hit the store. Reads and transcript /
   * image file writes (the transcript is the system of record) pass through.
   * Generic so the actor hands in its full deps and gets its full deps back
   * with only the durable write seams gated.
   */
  gateActorDurableWrites<T extends ActorDurableWriteSeams>(deps: T): T;
}

// ============================================================
// Durable adapter — state-store dependency injection
// ============================================================

/**
 * The durable adapter's state-store touchpoints. Injected in tests (real
 * persistence fixture) and lazily resolved to the production seams otherwise —
 * the dynamic import keeps the state-store/events graph out of this module's
 * import-time cost, matching the prior in-action `await import` pattern.
 */
export interface ConversationPersistenceAdapterDeps {
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void | Promise<void>,
  ): Promise<void>;
  publishSessionStatus(event: ConversationUnreadEvent): { delivered: boolean };
  queueAutoName(input: Omit<GenerateConversationNameInput, "trigger">): void;
}

let _deps: ConversationPersistenceAdapterDeps | null = null;

const productionQueueAutoName: ConversationPersistenceAdapterDeps["queueAutoName"] =
  (input) => {
    void import("@/lib/conversations/name-generation")
      .then(({ generateAndApplyConversationName }) =>
        generateAndApplyConversationName({ ...input, trigger: "auto" }),
      )
      .catch((error: unknown) => {
        conversationNamingLogger.warn("conversation_naming.generation_failed", {
          ...conversationEventScopeFields(
            input.projectName,
            input.sessionName,
            input.conversationId,
          ),
          trigger: "auto",
          stage: "background",
          failureKind: "unhandled",
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });
  };

async function resolveDeps(): Promise<ConversationPersistenceAdapterDeps> {
  if (_deps) return _deps;
  const { mutateConversation } = await import("@/lib/state-store");
  const { publishEvent } = await import("@/lib/events/publication");
  return {
    mutateConversation,
    publishSessionStatus: publishEvent,
    queueAutoName: productionQueueAutoName,
  };
}

export function setConversationPersistenceAdapterDeps(
  deps: ConversationPersistenceAdapterDeps,
): void {
  _deps = deps;
}

export function _resetConversationPersistenceAdapterDepsForTesting(): void {
  _deps = null;
}

// ============================================================
// Durable adapter
// ============================================================

export const durableConversationPersistence: ConversationPersistenceAdapter = {
  syncDerivedFields(context) {
    void (async () => {
      try {
        const { mutateConversation } = await resolveDeps();
        await mutateConversation(
          context.projectPath,
          context.sessionName,
          context.conversationId,
          "conversation-manager.syncDerived",
          (c) => applySyncDerivedFields(context, c),
        );
      } catch (err) {
        logger.warn("conversation-manager.sync_derived_failed", {
          conversationId: context.conversationId,
          error: getErrorMessage(err),
        });
      }
    })();
  },

  persistSnapshot(context, actor) {
    persistSnapshotAfterTransition(context, actor);
  },

  markReadOnUserTurnStart(context) {
    void (async () => {
      try {
        const deps = await resolveDeps();
        const { markReadOnUserTurnStart } =
          await import("@/lib/conversations/mark-unread");
        await markReadOnUserTurnStart(
          {
            projectPath: context.projectPath,
            projectName: context.projectName,
            sessionName: context.sessionName,
            conversationId: context.conversationId,
            role: context.role,
          },
          {
            mutateConversation: deps.mutateConversation,
            publishSessionStatus: deps.publishSessionStatus,
          },
        );
      } catch (err) {
        logger.warn("conversation-manager.mark_read_failed", {
          conversationId: context.conversationId,
          error: getErrorMessage(err),
        });
      }
    })();
  },

  triggerAutoNaming(context) {
    const activeTurn = context.activeTurn;
    if (activeTurn?.kind !== "conversation_turn") return;
    if (activeTurn.autonomous === true) return;
    if (context.role !== null) return;
    if (context.promptCount !== 0) return;
    if (context.forkedFrom !== null) return;
    if (activeTurn.promptText.trim().length === 0) return;

    const queueAutoName = _deps?.queueAutoName ?? productionQueueAutoName;
    queueAutoName({
      projectPath: context.projectPath,
      projectName: context.projectName,
      sessionName: context.sessionName,
      conversationId: context.conversationId,
      content: activeTurn.promptText.slice(0, 4_000),
    });
  },

  markUnreadOnFinish(context) {
    void (async () => {
      try {
        const deps = await resolveDeps();
        const { markUnreadOnFinish } =
          await import("@/lib/conversations/mark-unread");
        await markUnreadOnFinish(
          {
            projectPath: context.projectPath,
            projectName: context.projectName,
            sessionName: context.sessionName,
            conversationId: context.conversationId,
            role: context.role,
          },
          {
            mutateConversation: deps.mutateConversation,
            publishSessionStatus: deps.publishSessionStatus,
          },
        );
      } catch (err) {
        logger.warn("conversation-manager.mark_unread_failed", {
          conversationId: context.conversationId,
          error: getErrorMessage(err),
        });
      }
    })();
  },

  notifyProjectStatus(context) {
    // Only sentinel-session (project-scope) conversations notify; the callee
    // re-checks, but gating here keeps the durable write off the hot path for
    // every ordinary session conversation. Fire-and-forget with the same log
    // event the machine emitted before this moved behind the adapter.
    if (!isProjectSentinel(context.sessionName)) return;
    void (async () => {
      const { notifyProjectConversationStatusFromContext } =
        await import("@/lib/project-conversations/status-notifications");
      await notifyProjectConversationStatusFromContext(context);
    })().catch((err) => {
      logger.warn("conversation-manager.project_notification_failed", {
        projectPath: context.projectPath,
        conversationId: context.conversationId,
        status: context.status,
        error: getErrorMessage(err),
      });
    });
  },

  gateActorDurableWrites<T extends ActorDurableWriteSeams>(deps: T): T {
    return deps;
  },
};

// ============================================================
// Ephemeral adapter — inert
// ============================================================

/**
 * The inert replacements for the invoked actors' durable write seams. Each
 * returns the shape its caller expects while touching nothing: the MCP apply
 * reports `no_active_runtime` (an ephemeral lane has no persisted runtime to
 * apply, and the actor only fails a turn on `rejected`), the capability applies
 * return `undefined` (their results are discarded), delivery-state operations
 * return empty outcomes, and the direct writes are void no-ops. Annotated so
 * each method is checked against the real seam signature and drift is a compile
 * error.
 */
const inertActorWriteSeams: ActorDurableWriteSeams = {
  mutateConversation: async () => {},
  createReferenceDocument: async () => ({}),
  markQueuedDelivered: async () => {},
  markQueuedPending: async () => {},
  markQueuedFailed: async () => {},
  recordNotepadDeliveries: async () => {},
  settleNotepadChangeNotice: async () => {},
  claimWorkflowResults: async () => [],
  settleWorkflowResults: async () => 0,
  releaseWorkflowResults: async () => 0,
  applyMcpAtTurnStart: async (input) => ({
    conversationId: input.conversationId,
    backend: input.backend,
    disposition: "no_active_runtime",
    effectiveConfigHash: "",
  }),
  applyCapabilityAtTurnStart: async () => undefined,
  applyCapabilityWhenIdle: async () => undefined,
};

/**
 * No-op adapter for runtimes with no persisted ConversationState record. Every
 * durable side effect is skipped, so the runtime's entire life produces zero
 * state-store writes.
 */
export const ephemeralConversationPersistence: ConversationPersistenceAdapter =
  {
    syncDerivedFields() {},
    persistSnapshot() {},
    markReadOnUserTurnStart() {},
    triggerAutoNaming() {},
    markUnreadOnFinish() {},
    notifyProjectStatus() {},
    gateActorDurableWrites<T extends ActorDurableWriteSeams>(deps: T): T {
      // Overlay the inert write seams onto a copy of the actor's deps; reads,
      // transcript/file I/O, backend call, and lock/slot seams pass through.
      return Object.assign({}, deps, inertActorWriteSeams);
    },
  };

/** Resolve the construction-time persistence choice to its adapter. */
export function resolveConversationPersistenceAdapter(
  mode: ConversationPersistenceMode,
): ConversationPersistenceAdapter {
  return mode === "ephemeral"
    ? ephemeralConversationPersistence
    : durableConversationPersistence;
}
