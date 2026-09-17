/**
 * Conversation machine snapshot persistence.
 *
 * Persists the XState snapshot as a *resume-token projection* (see
 * `persisted-snapshot-codec`) into the owner-discriminated
 * `conversation_machine_snapshots` sidecar table — never onto the hot
 * conversation row. The projection drops `lastResult.contentBlocks` and the
 * `children` subtree (re-readable from the transcript / re-created lazily), so a
 * multi-MB XState snapshot becomes a few-KB resume token. Follows the same
 * debounce pattern as the workflow-level persistence module.
 */

import type { Snapshot } from "xstate";
import {
  getConversationMachineSnapshot as defaultGetConversationMachineSnapshot,
  upsertConversationMachineSnapshot as defaultUpsertConversationMachineSnapshot,
  deleteConversationMachineSnapshot as defaultDeleteConversationMachineSnapshot,
  type ConversationSnapshotOwner,
} from "@/lib/state-store";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  restorePersistedSnapshotEnvelope,
  toPersistedConversationSnapshot,
} from "./persisted-snapshot-codec";
const logger = createLogger("conversation-persistence");

/**
 * The sidecar `owner` discriminator for a conversation identified by its session
 * name: session-less project conversations carry the sentinel session name and
 * own their sidecar rows as `project`; every other conversation is `session`.
 */
function snapshotOwnerFor(sessionName: string): ConversationSnapshotOwner {
  return isProjectSentinel(sessionName) ? "project" : "session";
}

// ============================================================
// Dependency Injection
// ============================================================

export interface ConversationPersistenceDeps {
  getConversationMachineSnapshot: typeof defaultGetConversationMachineSnapshot;
  upsertConversationMachineSnapshot: typeof defaultUpsertConversationMachineSnapshot;
  deleteConversationMachineSnapshot: typeof defaultDeleteConversationMachineSnapshot;
}

let _deps: ConversationPersistenceDeps | null = null;

function getDeps(): ConversationPersistenceDeps {
  if (!_deps) {
    _deps = {
      getConversationMachineSnapshot: defaultGetConversationMachineSnapshot,
      upsertConversationMachineSnapshot:
        defaultUpsertConversationMachineSnapshot,
      deleteConversationMachineSnapshot:
        defaultDeleteConversationMachineSnapshot,
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
type SnapshotIdentity = {
  projectPath: string;
  sessionName: string;
  conversationId: string;
};
interface SnapshotWrites {
  captures: Set<Promise<void>>;
  writes: Set<Promise<void>>;
  latest?: () => Promise<void>;
  pending?: () => Promise<void>;
  failures: unknown[];
  capture?: () => void;
}
const snapshotWrites = new Map<string, SnapshotWrites>();
function writesFor(identity: SnapshotIdentity): SnapshotWrites {
  const key = debounceKey(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  let state = snapshotWrites.get(key);
  if (!state) {
    state = { captures: new Set(), writes: new Set(), failures: [] };
    snapshotWrites.set(key, state);
  }
  return state;
}
function startSnapshotWrite(
  state: SnapshotWrites,
  write: () => Promise<void>,
): Promise<void> {
  const pending = Promise.resolve().then(write);
  state.writes.add(pending);
  void pending.then(
    () => state.writes.delete(pending),
    (error) => {
      state.failures.push(error);
      state.writes.delete(pending);
    },
  );
  return pending;
}

/** Flushes captures enrolled by the current macrostep and their latest snapshot. */
export async function flushConversationSnapshot(
  identity: SnapshotIdentity,
): Promise<void> {
  const state = writesFor(identity);
  while (state.captures.size) await Promise.allSettled([...state.captures]);
  const key = debounceKey(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  clearTimeout(debounceTimers.get(key));
  debounceTimers.delete(key);
  if (state.pending) {
    const write = state.pending;
    state.pending = undefined;
    startSnapshotWrite(state, write);
  }
  await Promise.allSettled([...state.writes]);
  if (state.failures.length) throw state.failures[0];
}

/** Retry the retained snapshot once without executing another machine transition. */
export async function reconcileConversationSnapshot(
  identity: SnapshotIdentity,
): Promise<void> {
  const state = writesFor(identity);
  await Promise.allSettled([...state.captures, ...state.writes]);
  if (state.failures.length) {
    if (state.capture) state.capture();
    else if (state.latest) state.pending = state.latest;
    state.failures.length = 0;
  }
  await flushConversationSnapshot(identity);
}

export function forgetConversationSnapshot(identity: SnapshotIdentity): void {
  const key = debounceKey(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  const state = snapshotWrites.get(key);
  if (
    state &&
    (state.captures.size ||
      state.writes.size ||
      state.pending ||
      state.failures.length)
  )
    throw new Error("Cannot discard unsettled conversation snapshot writes");
  clearTimeout(debounceTimers.get(key));
  debounceTimers.delete(key);
  snapshotWrites.delete(key);
}

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
 * final state. The machine's `persistSnapshot` action schedules durable
 * transitions; lifecycle boundaries explicitly flush the latest capture.
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

  const state = writesFor({ projectPath, sessionName, conversationId });
  state.latest = () => writeSnapshot(sessionName, conversationId, snapshot);
  state.pending = state.latest;
  const doWrite = () => {
    debounceTimers.delete(key);
    const write = state.pending;
    state.pending = undefined;
    if (write) startSnapshotWrite(state, write);
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
  const state = writesFor(identity);
  state.capture = () => {
    persistConversationSnapshot(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
      actor.getPersistedSnapshot(),
      options,
    );
  };
  const capture = Promise.resolve().then(state.capture);
  state.captures.add(capture);
  void capture.then(
    () => state.captures.delete(capture),
    (error) => {
      state.captures.delete(capture);
      state.failures.push(error);
      logger.warn("conversation-persistence.snapshot_capture_failed", {
        conversationId: identity.conversationId,
        error: getErrorMessage(error),
      });
    },
  );
}

async function writeSnapshot(
  sessionName: string,
  conversationId: string,
  snapshot: Snapshot<unknown>,
): Promise<void> {
  try {
    // XState child inputs can contain callbacks that structuredClone cannot
    // clone. They are outside the durable resume contract, so project them out.
    const projected = toPersistedConversationSnapshot(snapshot);
    await getDeps().upsertConversationMachineSnapshot(
      snapshotOwnerFor(sessionName),
      conversationId,
      projected,
    );

    logger.debug("conversation-persistence.snapshot_saved", {
      conversationId,
    });
  } catch (err) {
    logger.error("conversation-persistence.snapshot_save_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
    throw err;
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

  // Undo the write-side `children` projection. Without it XState restores an
  // actor that holds the raw token instead of a machine snapshot, and the
  // failure is silent until a caller reaches for `can()` or `context`.
  restorePersistedSnapshotEnvelope(snapshot);

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
  _projectPath: string,
  sessionName: string,
  conversationId: string,
  expectedSchemaVersion: number,
): Promise<Snapshot<unknown> | null> {
  try {
    const snapshot = getDeps().getConversationMachineSnapshot(
      snapshotOwnerFor(sessionName),
      conversationId,
    );
    if (snapshot == null) return null;

    return validateRestoredSnapshot(
      snapshot,
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
 * Clear a conversation's persisted machine snapshot (deletes the sidecar row).
 */
export async function clearConversationSnapshot(
  _projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<void> {
  try {
    await getDeps().deleteConversationMachineSnapshot(
      snapshotOwnerFor(sessionName),
      conversationId,
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
  snapshotWrites.clear();
  _deps = null;
}
