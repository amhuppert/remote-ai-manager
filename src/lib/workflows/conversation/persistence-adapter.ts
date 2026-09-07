import { conversationStoreIdentity } from "@/lib/conversations/conversation-target";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { conversationTotals } from "./actor-input-loader";
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
 *     project-conversation status notification. Actor-owned writes use the
 *     separately injected ConversationDurableEffects.
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
import {
  persistSnapshotAfterTransition,
  flushConversationSnapshot,
  reconcileConversationSnapshot,
  forgetConversationSnapshot,
} from "./persistence";

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
  Object.assign(c, conversationTotals(context.totals));
  c.promptCount = context.promptCount;
  c.lastActivityAt = context.lastActivityAt;
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
  whenDurable(context: ConversationContext): Promise<void>;
  reconcile(context: ConversationContext): Promise<void>;
  afterCommit(
    context: ConversationContext,
    publish: () => void | Promise<void>,
  ): Promise<void>;
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
  conversationWrites.clear();
}

// ============================================================
// Durable adapter
// ============================================================

interface WriteReceipt {
  key: string;
  run(): Promise<void>;
  promise: Promise<void>;
  failed: boolean;
  error?: unknown;
}
interface ConversationWrites {
  receipts: WriteReceipt[];
  latest: Map<string, () => Promise<void>>;
}
const conversationWrites = new Map<string, ConversationWrites>();
export function forgetConversationPersistence(
  identity: Parameters<typeof forgetConversationSnapshot>[0],
): void {
  const key = `${identity.projectPath}::${identity.sessionName}::${identity.conversationId}`;
  if (conversationWrites.get(key)?.receipts.length)
    throw new Error("Cannot discard unsettled conversation writes");
  forgetConversationSnapshot(identity);
  conversationWrites.delete(key);
}
function writesFor(context: ConversationContext): ConversationWrites {
  const key = `${context.projectPath}::${conversationTargetStoreSessionName(context.target)}::${context.target.conversationId}`;
  let writes = conversationWrites.get(key);
  if (!writes) {
    writes = { receipts: [], latest: new Map() };
    conversationWrites.set(key, writes);
  }
  return writes;
}

export class ConversationDurabilityError extends Error {
  readonly code = "conversation_durability_failed";
  constructor(
    readonly conversationId: string,
    readonly failures: unknown[],
  ) {
    super(`Conversation finalization failed: ${getErrorMessage(failures[0])}`);
    this.name = "ConversationDurabilityError";
  }
}

/** Enrol before lazy dependency loading so a same-tick barrier owns the write. */
function enrolWrite(
  context: ConversationContext,
  key: string,
  run: () => Promise<void>,
): void {
  const writes = writesFor(context);
  const receipt: WriteReceipt = {
    key,
    run,
    promise: Promise.resolve(),
    failed: false,
  };
  writes.receipts.push(receipt);
  writes.latest.set(key, run);
  receipt.promise = Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      receipt.failed = true;
      receipt.error = error;
      logger.error("conversation.persistence_failed", {
        conversationId: context.target.conversationId,
        operation: key,
        error: getErrorMessage(error),
      });
      throw error;
    });
  void receipt.promise.catch(() => {});
}

async function awaitReceipts(
  context: ConversationContext,
  receipts: WriteReceipt[],
): Promise<void> {
  await Promise.allSettled(receipts.map((receipt) => receipt.promise));
  const failures = receipts
    .filter((receipt) => receipt.failed)
    .map((receipt) => receipt.error);
  if (failures.length)
    throw new ConversationDurabilityError(
      context.target.conversationId,
      failures,
    );
}

export const durableConversationPersistence: ConversationPersistenceAdapter = {
  async whenDurable(context) {
    const writes = writesFor(context);
    const receipts = [...writes.receipts];
    const results = await Promise.allSettled([
      awaitReceipts(context, receipts),
      flushConversationSnapshot(conversationStoreIdentity(context)),
    ]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new ConversationDurabilityError(
        context.target.conversationId,
        failures,
      );
    const committed = new Set(receipts);
    writes.receipts = writes.receipts.filter(
      (receipt) => !committed.has(receipt),
    );
    if (!writes.receipts.length) writes.latest.clear();
  },
  async reconcile(context) {
    const writes = writesFor(context);
    await Promise.allSettled(writes.receipts.map((receipt) => receipt.promise));
    const failedKeys = new Set(
      writes.receipts
        .filter((receipt) => receipt.failed)
        .map((receipt) => receipt.key),
    );
    for (const key of failedKeys) {
      // A newer projection supersedes an earlier failed projection of the same fields.
      const run = writes.latest.get(key)!;
      await run();
      for (const receipt of writes.receipts)
        if (receipt.key === key) {
          receipt.failed = false;
          receipt.error = undefined;
          receipt.promise = Promise.resolve();
        }
    }
    await reconcileConversationSnapshot(conversationStoreIdentity(context));
    await this.whenDurable(context);
  },
  afterCommit(context, publish) {
    const receipts = [...writesFor(context).receipts];
    return awaitReceipts(context, receipts)
      .then(publish)
      .catch((error: unknown) => {
        logger.warn("conversation.publication_skipped", {
          conversationId: context.target.conversationId,
          error: getErrorMessage(error),
        });
      });
  },
  syncDerivedFields(context) {
    enrolWrite(context, "projection", async () => {
      const { mutateConversation } = await resolveDeps();
      await mutateConversation(
        context.projectPath,
        conversationTargetStoreSessionName(context.target),
        context.target.conversationId,
        "conversation-manager.syncDerived",
        (c) => applySyncDerivedFields(context, c),
      );
    });
  },

  persistSnapshot(context, actor) {
    persistSnapshotAfterTransition(conversationStoreIdentity(context), actor);
  },

  markReadOnUserTurnStart(context) {
    enrolWrite(context, "mark_read", async () => {
      const deps = await resolveDeps();
      const { markReadOnUserTurnStart } =
        await import("@/lib/conversations/mark-unread");
      await markReadOnUserTurnStart(
        {
          ...context,
          ...conversationStoreIdentity(context),
          projectName: context.target.projectName,
        },
        {
          mutateConversation: deps.mutateConversation,
          publishSessionStatus: deps.publishSessionStatus,
        },
      );
    });
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
      projectName: context.target.projectName,
      sessionName: conversationTargetStoreSessionName(context.target),
      conversationId: context.target.conversationId,
      content: activeTurn.promptText.slice(0, 4_000),
    });
  },

  markUnreadOnFinish(context) {
    enrolWrite(context, "mark_unread", async () => {
      const deps = await resolveDeps();
      const { markUnreadOnFinish } =
        await import("@/lib/conversations/mark-unread");
      await markUnreadOnFinish(
        {
          ...context,
          ...conversationStoreIdentity(context),
          projectName: context.target.projectName,
        },
        {
          mutateConversation: deps.mutateConversation,
          publishSessionStatus: deps.publishSessionStatus,
        },
      );
    });
  },

  notifyProjectStatus(context) {
    // Only sentinel-session (project-scope) conversations notify; the callee
    // re-checks, but gating here keeps the durable write off the hot path for
    // every ordinary session conversation. Fire-and-forget with the same log
    // event the machine emitted before this moved behind the adapter.
    if (!isProjectSentinel(conversationTargetStoreSessionName(context.target)))
      return;
    void (async () => {
      const { notifyProjectConversationStatusFromContext } =
        await import("@/lib/project-conversations/status-notifications");
      await notifyProjectConversationStatusFromContext(context);
    })().catch((err) => {
      logger.warn("conversation-manager.project_notification_failed", {
        projectPath: context.projectPath,
        conversationId: context.target.conversationId,
        status: context.status,
        error: getErrorMessage(err),
      });
    });
  },
};

// ============================================================
// Ephemeral adapter — inert
// ============================================================

/**
 * No-op adapter for runtimes with no persisted ConversationState record. Every
 * durable side effect is skipped, so the runtime's entire life produces zero
 * state-store writes.
 */
export const ephemeralConversationPersistence: ConversationPersistenceAdapter =
  {
    async whenDurable() {},
    async reconcile() {},
    async afterCommit(_context, publish) {
      await publish();
    },
    syncDerivedFields() {},
    persistSnapshot() {},
    markReadOnUserTurnStart() {},
    triggerAutoNaming() {},
    markUnreadOnFinish() {},
    notifyProjectStatus() {},
  };

/** Resolve the construction-time persistence choice to its adapter. */
export function resolveConversationPersistenceAdapter(
  mode: ConversationPersistenceMode,
): ConversationPersistenceAdapter {
  return mode === "ephemeral"
    ? ephemeralConversationPersistence
    : durableConversationPersistence;
}
