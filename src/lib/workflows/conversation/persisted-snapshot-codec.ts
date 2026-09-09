import {
  conversationTargetSchema,
  conversationTargetStoreSessionName,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
/**
 * Persisted-snapshot projection codec.
 *
 * The durable conversation-machine snapshot is a *resume token*, not an archive:
 * it must contain exactly what rehydration needs to resume the machine and
 * re-attach its backend, and nothing more. Content — the turn's `contentBlocks`
 * and the backend `transcript` — is the transcript file's job and is dropped
 * here; the XState `children` child-actor subtree is re-created lazily and is
 * dropped too. On the worst production row these two carried ~5MB (2.96MB of
 * `lastResult.contentBlocks` duplicating the transcript, 2.2MB of `children`).
 *
 * The projection creates a dual shape — the machine's `ConversationContext`
 * interface and this persisted schema can now diverge, and the failure mode (a
 * resume-relevant field silently dropped) surfaces only on a restart after a
 * crash. The drift guard is `CONVERSATION_CONTEXT_DISPOSITION`, typed
 * `satisfies Record<keyof ConversationContext, Disposition>`, so a newly added
 * context field fails `bun run typecheck` until its fate is decided.
 */

import { z } from "zod";
import type { Snapshot } from "xstate";
import {
  agentBackendSchema,
  agentSessionRefSchema,
} from "@/lib/shared/schemas";
import { continuationDispositionSchema } from "@/lib/agent-backends/errors";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { debugModeStateSchema } from "@/lib/debug-log/schemas";
import {
  askQuestionItemSchema,
  conversationRoleSchema,
  conversationScopeSchema,
  conversationStatusSchema,
  forkedFromSchema,
} from "@/lib/conversations/schemas";
import type { ConversationContext } from "./types";

// ============================================================
// Disposition contract (drift guard)
// ============================================================

/**
 * Fate of a `ConversationContext` field in the persisted resume token.
 * - `persist` — carried into the sidecar snapshot (verbatim, or for `lastResult`
 *   via its content-stripped scalar projection).
 * - `derive-on-rehydrate` — reconstructed when the actor is recreated, so it is
 *   not persisted.
 * - `drop` — not needed to resume and re-readable from the transcript.
 */
export type ConversationContextDisposition =
  | "persist"
  | "derive-on-rehydrate"
  | "drop";

/**
 * Every `ConversationContext` field's disposition. The persisted snapshot
 * restores the machine's context wholesale, so each field is the source of its
 * own resumed value. The target is reconstructed from the flat identity fields.
 * The two large content
 * carriers are not top-level context fields: `lastResult.contentBlocks` is a
 * sub-field stripped by {@link toPersistedConversationSnapshot}'s `lastResult`
 * projection, and `children` is an XState-envelope field dropped at the snapshot
 * root. This map exists as the compile-time exhaustiveness guard.
 */
export const CONVERSATION_CONTEXT_DISPOSITION = {
  _schemaVersion: "persist",
  target: "derive-on-rehydrate",
  projectPath: "persist",
  worktreePath: "persist",
  createdAt: "persist",
  lastActivityAt: "persist",
  status: "persist",
  promptCount: "persist",
  transcriptPath: "persist",
  agentBackend: "persist",
  backendRef: "persist",
  forkedFrom: "persist",
  role: "persist",
  transient: "persist",
  activeTurn: "persist",
  pendingQuestion: "persist",
  debugMode: "persist",
  debugGenerationNeedsPersistence: "persist",
  totals: "persist",
  lastResult: "persist",
  lastError: "persist",
  // The checkpoint repository is the authority for checkpoint phase; a resume
  // token that carried it could restore a stale hold or, worse, drop one.
  // Hydration reads the repository before the actor accepts work.
  checkpoint: "derive-on-rehydrate",
} satisfies Record<keyof ConversationContext, ConversationContextDisposition>;

/**
 * Compile-time exhaustiveness pin. `Exclude` yields `never` only when the map's
 * keys exactly cover the interface; adding a `ConversationContext` field makes
 * this non-`never` and fails the assignment during `bun run typecheck`,
 * independent of the `satisfies` above.
 */
type MissingDisposition = Exclude<
  keyof ConversationContext,
  keyof typeof CONVERSATION_CONTEXT_DISPOSITION
>;
const _dispositionExhaustive: MissingDisposition extends never ? true : false =
  true;
void _dispositionExhaustive;

/**
 * `lastResult` sub-fields the projection strips. Both are large, append-per-turn
 * arrays that duplicate the transcript file (the system of record for content);
 * every other `PromptActorResult` field is a scalar the machine's post-turn
 * logic reads (cost/tokens/duration via `accumulateTotals`, `structuredOutput`,
 * `error`), so they are retained.
 */
const DROPPED_LAST_RESULT_FIELDS = ["contentBlocks", "transcript"] as const;

// ============================================================
// Persisted projection schema
// ============================================================

const persistedTotalsSchema = z.object({
  totalCostUsd: z.number().nullable(),
  totalDurationMs: z.number().nullable(),
  totalTurns: z.number().nullable(),
  contextTokens: z.number().nullable(),
  contextWindowMax: z.number().nullable(),
});

const backgroundWaitSummarySchema = z.object({
  waitedTaskIds: z.array(z.string()),
  settledTaskIds: z.array(z.string()),
  timedOut: z.boolean(),
  durationMs: z.number(),
});

/**
 * `PromptActorResult` with the two large content arrays removed. Unknown keys
 * are stripped (Zod's default), a second net for a `contentBlocks` that escaped
 * the codec.
 */
const persistedLastResultSchema = z
  .object({
    backendRef: agentSessionRefSchema.nullable(),
    costUsd: z.number().nullable(),
    durationMs: z.number().nullable(),
    numTurns: z.number().nullable(),
    contextTokens: z.number().nullable(),
    contextWindow: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cachedInputTokens: z.number().nullable(),
    structuredOutput: z.unknown().optional(),
    aborted: z.boolean(),
    compacted: z.boolean(),
    abortReason: z.enum(["timeout", "stalled", "user", "shutdown"]).optional(),
    timeoutMs: z.number().optional(),
    error: z.string().nullable(),
    continuationDisposition: continuationDispositionSchema,
    backgroundWait: backgroundWaitSummarySchema.optional(),
  })
  .nullable();

/**
 * `activeTurn` is a rich TS-interface union owned by `types.ts`; the persisted
 * schema pins only the discriminator and `images` (the one growable payload) and
 * lets the remaining author-shaped fields pass through, so the persisted-blob
 * bounds gate can see the `images` array without this schema duplicating — and
 * drifting from — the full `ActiveTurn` interface.
 */
const persistedActiveTurnSchema = z
  .looseObject({
    kind: z.enum(["conversation_turn", "task_run"]),
    images: z.array(imagePayloadSchema).optional(),
  })
  .nullable();

const persistedPendingQuestionSchema = z
  .object({
    questionId: z.string(),
    questions: z.array(askQuestionItemSchema),
  })
  .nullable();

const persistedContextSchema = z.object({
  _schemaVersion: z.literal(1),
  conversationScope: conversationScopeSchema,
  projectPath: z.string(),
  projectName: z.string(),
  sessionName: z.string(),
  worktreePath: z.string(),
  conversationId: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  status: conversationStatusSchema,
  promptCount: z.number(),
  transcriptPath: z.string().nullable(),
  agentBackend: agentBackendSchema,
  backendRef: agentSessionRefSchema.nullable(),
  forkedFrom: forkedFromSchema,
  role: conversationRoleSchema,
  transient: z.boolean().optional(),
  activeTurn: persistedActiveTurnSchema,
  pendingQuestion: persistedPendingQuestionSchema,
  debugMode: debugModeStateSchema.nullable(),
  debugGenerationNeedsPersistence: z.boolean().optional(),
  totals: persistedTotalsSchema,
  lastResult: persistedLastResultSchema,
  lastError: z.string().nullable(),
});

/**
 * The full persisted resume token: the XState envelope (status, value, history,
 * and any other machine-internal fields) with the projected `context` and no
 * `children`. `looseObject` at the envelope preserves XState-internal fields the
 * machine needs to resolve state without this schema enumerating them.
 */
export const persistedConversationSnapshotSchema = z.looseObject({
  status: z.string(),
  value: z.unknown(),
  context: persistedContextSchema,
  historyValue: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type PersistedConversationSnapshot = z.infer<
  typeof persistedConversationSnapshotSchema
>;

// ============================================================
// Codec
// ============================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project `context.lastResult` by dropping the large content arrays and keeping
 * every scalar. Returns the input unchanged when it is not an object (null / a
 * missing result).
 */
function projectLastResult(rawLastResult: unknown): unknown {
  if (!isRecord(rawLastResult)) return rawLastResult;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawLastResult)) {
    if ((DROPPED_LAST_RESULT_FIELDS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Project the machine context: keep every `persist` field, apply the
 * `lastResult` content projection. Values other than `lastResult` are aliased
 * (never mutated) — the caller serializes the projection read-only.
 */
function projectContext(rawContext: unknown): unknown {
  if (!isRecord(rawContext)) return rawContext;
  const out: Record<string, unknown> = {};
  for (const [key, disposition] of Object.entries(
    CONVERSATION_CONTEXT_DISPOSITION,
  )) {
    if (disposition !== "persist") continue;
    if (!(key in rawContext)) continue;
    out[key] =
      key === "lastResult"
        ? projectLastResult(rawContext[key])
        : rawContext[key];
  }
  const target = conversationTargetSchema.safeParse(rawContext.target);
  if (target.success) {
    out.conversationScope = target.data.scope;
    out.projectName = target.data.projectName;
    out.sessionName = conversationTargetStoreSessionName(target.data);
    out.conversationId = target.data.conversationId;
  }
  return out;
}

/**
 * Project a live conversation-machine snapshot into its persisted resume token:
 * drop the `children` subtree, keep the rest of the XState envelope, and project
 * `context` per {@link CONVERSATION_CONTEXT_DISPOSITION}. Non-mutating — builds
 * fresh container objects and aliases retained leaf values.
 */
export function toPersistedConversationSnapshot(
  snapshot: Snapshot<unknown>,
): PersistedConversationSnapshot {
  const record = snapshot as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "children") continue;
    if (key === "context") {
      out.context = projectContext(value);
      continue;
    }
    out[key] = value;
  }
  return out as PersistedConversationSnapshot;
}

/**
 * Restore the XState envelope a persisted resume token has to present before
 * `createActor({ snapshot })` will accept it.
 *
 * The write side drops `children` on purpose (2.2MB on the worst row), but
 * XState's `StateMachine.restoreSnapshot` reads it unconditionally —
 * `Object.keys(snapshot.children)` — so a token without the key throws inside
 * the restore. `createActor` surfaces that through an asynchronous
 * unhandled-error hop instead of throwing to its caller, so nothing fails
 * loudly: the actor is created holding the RAW token, and every later
 * `getSnapshot()` answers with an object that has no `can()` and no `context`.
 * Rehydration then registers that actor as live, and callers crash far from
 * here — `getSnapshot().can(...)` in the event sender, `getSnapshot().context`
 * in the actor-ensure path.
 *
 * The empty subtree is the faithful inverse, not a patch over one: dropping
 * `children` encodes "child actors are re-created lazily", so the token means
 * "no live children", and `{}` is exactly that.
 */
export function restorePersistedSnapshotEnvelope(snapshot: unknown): void {
  if (!isRecord(snapshot)) return;
  if (!isRecord(snapshot.children)) snapshot.children = {};
  if (!isRecord(snapshot.context)) return;
  const context = snapshot.context;
  // A derive-on-rehydrate field is reconstructed by whoever restores the
  // token, never read from it: a raw row that carries one anyway — a
  // checkpoint projection, say — would otherwise restore a hold the
  // repository no longer records, or drop one it does. `target` is rebuilt
  // below from the flat identity fields.
  for (const [key, disposition] of Object.entries(
    CONVERSATION_CONTEXT_DISPOSITION,
  )) {
    if (disposition === "derive-on-rehydrate" && key !== "target")
      delete context[key];
  }
  const identity = z
    .object({
      projectName: z.string(),
      sessionName: z.string(),
      conversationId: z.string(),
    })
    .safeParse(context);
  if (!identity.success) return;
  context.target = targetFromStoreSessionName(
    identity.data.projectName,
    identity.data.sessionName,
    identity.data.conversationId,
  );
  delete context.projectName;
  delete context.sessionName;
  delete context.conversationId;
  delete context.conversationScope;
}
