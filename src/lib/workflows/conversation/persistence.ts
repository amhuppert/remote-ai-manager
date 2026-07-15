/**
 * Conversation machine snapshot persistence.
 *
 * Persists XState snapshots to the `machineSnapshot` field on each
 * ConversationState record. Follows the same debounce pattern as the
 * workflow-level persistence module.
 */

import type { Snapshot } from "xstate";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  getConversation as defaultGetConversation,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { createLogger } from "@/lib/logging";
import {
  canonicalizeSessionRefsForStorageDeep,
  normalizeSessionRefsDeepInPlace,
} from "@/lib/shared/session-ref-codec";
import type { ConversationState } from "@/lib/conversations/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
const logger = createLogger("conversation-persistence");

// ============================================================
// AgentSessionRef codec at the snapshot boundary
// ============================================================

/**
 * Canonicalize every session ref in the snapshot before it is persisted. The
 * live actor snapshot is already canonical, so this is a no-op unless the tree
 * carries a legacy ref (e.g. from an unmigrated child snapshot). The walk is
 * recursive because refs live beyond the root context: an active XState child
 * snapshot carries `input.backendRef` (and `input.forkedFrom`). Clones on
 * rewrite — the live actor snapshot stays untouched.
 */
function withCanonicalRefs(
  conversationId: string,
  snapshot: Snapshot<unknown>,
): Snapshot<unknown> {
  const { value, rewrittenRefs } =
    canonicalizeSessionRefsForStorageDeep(snapshot);
  if (rewrittenRefs > 0) {
    logger.debug("conversation-persistence.snapshot_refs_canonicalized", {
      conversationId,
      rewrittenRefs,
    });
  }
  return value;
}

/**
 * Normalize persisted session refs (legacy or shadow-superset shapes,
 * anywhere in the tree — root context and child snapshot inputs) back to the
 * canonical `{ backend, ref }` before the actor is created. Mutates in place,
 * mirroring `coerceLegacyActiveTurn`.
 */
function normalizeSnapshotRefs(
  conversationId: string,
  snapshot: unknown,
): void {
  const rewrittenRefs = normalizeSessionRefsDeepInPlace(snapshot);
  if (rewrittenRefs > 0) {
    logger.debug("conversation-persistence.snapshot_refs_normalized", {
      conversationId,
      rewrittenRefs,
    });
  }
}

// ============================================================
// Legacy ActiveTurn coercion
// ============================================================

/**
 * Persisted snapshots written before the ActiveTurn discriminated union landed
 * stored activeTurn as a bare object without a `kind` field. The preprocessor
 * below stamps the legacy shape with `kind: "conversation_turn"` so the
 * in-memory ConversationContext sees the variant the machine expects, while
 * the rest of the object passes through untouched (passthrough preserves any
 * extra fields a future schema iteration may have added).
 *
 * Applied during snapshot restoration; production code never persists the
 * legacy shape again because every SUBMIT_PROMPT path now stamps `kind`.
 */
const persistedActiveTurnSchema = z
  .preprocess(
    (val) => {
      if (val == null || typeof val !== "object") return val;
      const obj = val as Record<string, unknown>;
      if ("kind" in obj) return obj;
      return { kind: "conversation_turn", ...obj };
    },
    z.union([
      z.looseObject({ kind: z.literal("conversation_turn") }),
      z.looseObject({ kind: z.literal("task_run") }),
    ]),
  )
  .nullable();

function coerceLegacyActiveTurn(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const context = (snapshot as { context?: Record<string, unknown> }).context;
  if (!context || typeof context !== "object") return;
  if (!("activeTurn" in context)) return;
  const parsed = persistedActiveTurnSchema.safeParse(context.activeTurn);
  if (parsed.success) {
    context.activeTurn = parsed.data;
  }
}

function normalizeSnapshotDebugGeneration(
  conversationId: string,
  snapshot: unknown,
): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const context = (snapshot as { context?: Record<string, unknown> }).context;
  if (!context || typeof context !== "object") return;
  const debugMode = context.debugMode;
  if (!debugMode || typeof debugMode !== "object") return;
  const record = debugMode as Record<string, unknown>;
  if (record.active !== true) return;
  if (
    typeof record.debugSessionId === "string" &&
    record.debugSessionId.length > 0
  ) {
    return;
  }

  const debugSessionId = randomUUID();
  record.debugSessionId = debugSessionId;
  context.debugGenerationNeedsPersistence = true;
  logger.info("conversation-persistence.debug_session_id_minted", {
    conversationId,
    debugSessionId,
  });
}

// ============================================================
// Dependency Injection
// ============================================================

export interface ConversationPersistenceDeps {
  mutateConversation: typeof defaultMutateConversation;
  getConversation: typeof defaultGetConversation;
}

let _deps: ConversationPersistenceDeps | null = null;

function getDeps(): ConversationPersistenceDeps {
  if (!_deps) {
    _deps = {
      mutateConversation: defaultMutateConversation,
      getConversation: defaultGetConversation,
    };
  }
  return _deps;
}

export function setPersistenceDeps(deps: ConversationPersistenceDeps): void {
  _deps = deps;
}

// ============================================================
// Debounce
// ============================================================

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_DEBOUNCE_MS = 500;

function debounceKey(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): string {
  return `${projectPath}::${sessionName}::${conversationId}`;
}

// ============================================================
// Public API
// ============================================================

/**
 * A transient lane (see `ConversationContext.transient`) has no
 * ConversationState record, so persisting its snapshot would fail with
 * `snapshot_save_failed` on every write. The flag travels inside the
 * snapshot's machine context, so the gate sits ahead of the debounce and
 * covers every persist call.
 */
function isTransientSnapshot(snapshot: Snapshot<unknown>): boolean {
  const context = (snapshot as { context?: { transient?: unknown } }).context;
  return context?.transient === true;
}

/**
 * Persist a conversation machine snapshot, debounced (500 ms default).
 * Conversation actors are long-lived with zero final states, so there is no
 * terminal flush: the machine's `persistSnapshot` action fires on every
 * durable transition and the debounce collapses bursts into one write.
 */
export function persistConversationSnapshot(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  snapshot: Snapshot<unknown>,
  options?: { debounceMs?: number },
): void {
  if (isTransientSnapshot(snapshot)) {
    logger.debug("conversation-persistence.snapshot_skipped_transient", {
      conversationId,
    });
    return;
  }
  const key = debounceKey(projectPath, sessionName, conversationId);
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const doWrite = () => {
    debounceTimers.delete(key);
    void writeSnapshot(projectPath, sessionName, conversationId, snapshot);
  };

  debounceTimers.set(key, setTimeout(doWrite, debounceMs));
}

/**
 * The machine's `persistSnapshot` action body: capture and persist the
 * actor's snapshot for the transition that is currently settling.
 *
 * XState executes transition actions while the macrostep is still being
 * resolved — the actor's committed snapshot is only swapped in after the
 * transition returns — so a synchronous `getPersistedSnapshot()` here would
 * capture the PREVIOUS macrostep and the durable snapshot would lag one event
 * behind (e.g. a BACKEND_INIT persist would miss the just-assigned
 * backendRef). Deferring the capture to a microtask samples the actor after
 * the transition has settled; the debounce then collapses multiple captures
 * from one event burst into a single write of the freshest snapshot.
 */
export function persistSnapshotAfterTransition(
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  actor: { getPersistedSnapshot(): Snapshot<unknown> },
  options?: { debounceMs?: number },
): void {
  queueMicrotask(() => {
    try {
      persistConversationSnapshot(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
        actor.getPersistedSnapshot(),
        options,
      );
    } catch (err) {
      // Fire-and-forget — snapshot persistence must not halt the machine.
      logger.warn("conversation-persistence.snapshot_capture_failed", {
        conversationId: identity.conversationId,
        error: getErrorMessage(err),
      });
    }
  });
}

async function writeSnapshot(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  snapshot: Snapshot<unknown>,
): Promise<void> {
  try {
    await getDeps().mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "conversation-persistence.save",
      (conversation: ConversationState) => {
        conversation.machineSnapshot = withCanonicalRefs(
          conversationId,
          snapshot,
        );
      },
    );

    logger.debug("conversation-persistence.snapshot_saved", {
      conversationId,
    });
  } catch (err) {
    logger.error("conversation-persistence.snapshot_save_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Validate an already-loaded snapshot against the expected schema version.
 * Pure function — does not read state. Use this when the caller already has
 * the snapshot in memory (e.g. during startup rehydration loops) to avoid
 * O(N) full-state reads inside a per-conversation loop.
 */
export function validateRestoredSnapshot(
  snapshot: unknown,
  conversationId: string,
  expectedSchemaVersion: number,
): Snapshot<unknown> | null {
  if (!snapshot) return null;

  const context = (snapshot as { context?: { _schemaVersion?: number } })
    .context;
  if (context?._schemaVersion !== expectedSchemaVersion) {
    logger.warn("conversation-persistence.schema_mismatch", {
      conversationId,
      expected: expectedSchemaVersion,
      actual: context?._schemaVersion,
    });
    return null;
  }

  coerceLegacyActiveTurn(snapshot);
  normalizeSnapshotRefs(conversationId, snapshot);
  normalizeSnapshotDebugGeneration(conversationId, snapshot);

  logger.info("conversation-persistence.snapshot_restored", {
    conversationId,
  });
  return snapshot as Snapshot<unknown>;
}

/**
 * Restore a conversation machine snapshot from persisted state.
 * Returns the snapshot if found and schema version matches, null otherwise.
 */
export async function restoreConversationSnapshot(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  expectedSchemaVersion: number,
): Promise<Snapshot<unknown> | null> {
  try {
    const conversation = await getDeps().getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) return null;

    return validateRestoredSnapshot(
      conversation.machineSnapshot,
      conversationId,
      expectedSchemaVersion,
    );
  } catch (err) {
    logger.error("conversation-persistence.snapshot_restore_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Clear a conversation's persisted machine snapshot.
 */
export async function clearConversationSnapshot(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<void> {
  try {
    await getDeps().mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "conversation-persistence.clear",
      (conversation: ConversationState) => {
        conversation.machineSnapshot = null;
      },
    );
  } catch (err) {
    logger.error("conversation-persistence.snapshot_clear_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
  }
}

/** Reset state for testing — do not use in production. */
export function _resetForTesting(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  _deps = null;
}
