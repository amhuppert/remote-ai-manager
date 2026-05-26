/**
 * Conversation machine snapshot persistence.
 *
 * Persists XState snapshots to the `machineSnapshot` field on each
 * ConversationState record. Follows the same debounce pattern as the
 * workflow-level persistence module.
 */

import type { Snapshot } from "xstate";
import { z } from "zod";
import {
  getConversation as defaultGetConversation,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { createLogger } from "@/lib/logging";
import type { ConversationState } from "@/lib/conversations/schemas";
const logger = createLogger("conversation-persistence");

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
 * Persist a conversation machine snapshot.
 * Debounced by default; use `immediate: true` for terminal states.
 */
export function persistConversationSnapshot(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  snapshot: Snapshot<unknown>,
  options?: { debounceMs?: number; immediate?: boolean },
): void {
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

  if (options?.immediate) {
    debounceTimers.delete(key);
    doWrite();
  } else {
    debounceTimers.set(key, setTimeout(doWrite, debounceMs));
  }
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
        conversation.machineSnapshot = snapshot;
      },
    );

    logger.debug("conversation-persistence.snapshot_saved", {
      conversationId,
    });
  } catch (err) {
    logger.error("conversation-persistence.snapshot_save_failed", {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
