import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { agentBackendSchema } from "@/lib/shared/schemas";
import {
  encodeAgentSessionRefForStorage,
  persistedAgentSessionRefSchema,
} from "@/lib/shared/session-ref-codec";
import {
  askQuestionItemSchema,
  conversationOwnerSchema,
  conversationRoleSchema,
  conversationStatusSchema,
  forkedFromSchema,
  nameOriginSchema,
} from "@/lib/conversations/schemas";
import { pendingQueuedMessageSchema } from "@/lib/conversations/message-queue-schemas";
import {
  agentProfileSnapshotSchema,
  redactedAgentProfileSnapshotSchema,
  type RedactedAgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import { debugModeStateSchema } from "@/lib/debug-log/schemas";
import {
  mcpOverridesSchema,
  mcpRuntimeApplicationStateSchema,
} from "@/lib/mcp/schemas";
import {
  agentCapabilityOverridesSchema,
  agentCapabilityRuntimeApplicationStateSchema,
} from "@/lib/agent-capabilities/schemas";
import { PersistenceError, getErrorMessage } from "../shared/errors";
import { jsonOrNull, stableStringify } from "./serialization";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type {
  ConversationState,
  ForkedFrom,
} from "@/lib/conversations/schemas";

const logger = createLogger("state-store.conversation-codec");

export { stableStringify, jsonOrNull };

interface JsonParseSuccess<T> {
  ok: true;
  value: T;
}
interface JsonParseFailure {
  ok: false;
  issues: unknown;
}

export function parseJsonColumn<T>(
  field: string,
  raw: string | null,
  schema: z.ZodType<T>,
  treatNullAs: "absent" | "default",
  defaultValue?: T,
): JsonParseSuccess<T | undefined> | JsonParseFailure {
  if (raw === null) {
    if (treatNullAs === "absent") return { ok: true, value: undefined };
    return { ok: true, value: defaultValue };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: [field],
          message: getErrorMessage(err),
        },
      ],
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, issues: result.error.issues };
  return { ok: true, value: result.data };
}

export function throwConversationValidationError(
  conversationId: string,
  issues: unknown,
): never {
  logger.error("state-store.conversation-codec.schema_validation_failure", {
    conversationId,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "conversation",
    identifier: conversationId,
    issues,
  });
}

const pendingQuestionsArraySchema = z.array(askQuestionItemSchema);

/**
 * Loud-log an unparseable ref column (`backend_ref` / `forked_from`) and let
 * the caller substitute null instead of failing the whole row read. Unlike the
 * sessions repo's workflow columns, these columns are parsed by released
 * builds with a closed union, so shape evolution here must degrade gracefully:
 * a null `backendRef` means the next turn starts a fresh backend session (an
 * already-handled state), a null `forkedFrom` loses provenance display — both
 * strictly better than failing every conversation list read. The on-disk value
 * is left intact for a schema that understands it.
 */
function logRefColumnQuarantine(
  conversationId: string,
  column: string,
  issues: unknown,
): void {
  logger.error("state-store.conversation-codec.column_quarantined", {
    conversationId,
    column,
    issues,
  });
}

/**
 * Raw values of the conversation columns shared by both the `conversations` and
 * `project_conversations` tables — i.e. every conversation column except the
 * identity columns (`id`, `project_path`, `session_name`) and the project-only
 * `open` column. Both repos validate their own table-row shape first, then hand
 * the shared columns here for JSON/enum decoding.
 */
export interface SharedConversationRawColumns {
  name: string | null;
  name_origin: string;
  transcript_path: string | null;
  status: string;
  prompt_count: number;
  created_at: string;
  last_activity_at: string;
  source: string;
  summary: string | null;
  archived: 0 | 1;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  total_turns: number | null;
  pending_question_id: string | null;
  pending_questions: string | null;
  pending_prompt_text: string | null;
  forked_from: string | null;
  role: string | null;
  context_tokens: number | null;
  context_window_max: number | null;
  debug_mode: string | null;
  agent_backend: string;
  backend_ref: string | null;
  mcp_overrides: string | null;
  mcp_runtime: string | null;
  agent_capability_overrides: string | null;
  agent_capabilities_runtime: string | null;
  unread: 0 | 1;
  pending_queue: string | null;
  last_seen_alignment_version: number | null;
  pending_agent_notices: string | null;
  profile_snapshot: string | null;
  profile_locked_at: string | null;
  conversation_owner: string | null;
  turn_generation: number;
}

const pendingQueueArraySchema = z.array(pendingQueuedMessageSchema);
const pendingAgentNoticesArraySchema = z.array(z.string());

/**
 * Decode the shared conversation columns into the domain candidate fields
 * (camelCase, excluding `id`/`scope`/`open`/identity). Throws a
 * `PersistenceError` at the boundary when a column fails validation.
 */
export function decodeSharedConversationColumns(
  id: string,
  row: SharedConversationRawColumns,
): Record<string, unknown> {
  const statusResult = conversationStatusSchema.safeParse(row.status);
  if (!statusResult.success) {
    return throwConversationValidationError(id, statusResult.error.issues);
  }

  const sourceResult = z.enum(["cc", "imported"]).safeParse(row.source);
  if (!sourceResult.success) {
    return throwConversationValidationError(id, sourceResult.error.issues);
  }

  const nameOriginResult = nameOriginSchema.safeParse(row.name_origin);
  if (!nameOriginResult.success) {
    return throwConversationValidationError(id, nameOriginResult.error.issues);
  }

  const backendResult = agentBackendSchema.safeParse(row.agent_backend);
  if (!backendResult.success) {
    return throwConversationValidationError(id, backendResult.error.issues);
  }

  const roleResult = conversationRoleSchema.safeParse(row.role);
  if (!roleResult.success) {
    return throwConversationValidationError(id, roleResult.error.issues);
  }

  const pendingQuestions = parseJsonColumn(
    "pendingQuestions",
    row.pending_questions,
    pendingQuestionsArraySchema,
    "default",
    null,
  );
  if (!pendingQuestions.ok) {
    return throwConversationValidationError(id, pendingQuestions.issues);
  }

  let forkedFromValue: ForkedFrom | undefined;
  const forkedFrom = parseJsonColumn(
    "forkedFrom",
    row.forked_from,
    forkedFromSchema,
    "default",
    null,
  );
  if (forkedFrom.ok) {
    forkedFromValue = forkedFrom.value;
  } else {
    logRefColumnQuarantine(id, "forked_from", forkedFrom.issues);
    forkedFromValue = null;
  }

  const debugMode = parseJsonColumn(
    "debugMode",
    row.debug_mode,
    debugModeStateSchema,
    "default",
    null,
  );
  if (!debugMode.ok) {
    return throwConversationValidationError(id, debugMode.issues);
  }

  let backendRefValue: AgentSessionRef | null | undefined;
  const backendRef = parseJsonColumn(
    "backendRef",
    row.backend_ref,
    persistedAgentSessionRefSchema,
    "default",
    null,
  );
  if (backendRef.ok) {
    backendRefValue = backendRef.value;
  } else {
    logRefColumnQuarantine(id, "backend_ref", backendRef.issues);
    backendRefValue = null;
  }

  const mcpOverrides = parseJsonColumn(
    "mcpOverrides",
    row.mcp_overrides,
    mcpOverridesSchema,
    "absent",
  );
  if (!mcpOverrides.ok) {
    return throwConversationValidationError(id, mcpOverrides.issues);
  }

  const mcpRuntime = parseJsonColumn(
    "mcpRuntime",
    row.mcp_runtime,
    mcpRuntimeApplicationStateSchema,
    "absent",
  );
  if (!mcpRuntime.ok) {
    return throwConversationValidationError(id, mcpRuntime.issues);
  }

  const agentCaps = parseJsonColumn(
    "agentCapabilityOverrides",
    row.agent_capability_overrides,
    agentCapabilityOverridesSchema,
    "absent",
  );
  if (!agentCaps.ok) {
    return throwConversationValidationError(id, agentCaps.issues);
  }

  const agentCapsRuntime = parseJsonColumn(
    "agentCapabilitiesRuntime",
    row.agent_capabilities_runtime,
    agentCapabilityRuntimeApplicationStateSchema,
    "absent",
  );
  if (!agentCapsRuntime.ok) {
    return throwConversationValidationError(id, agentCapsRuntime.issues);
  }

  const pendingQueue = parseJsonColumn(
    "pendingQueue",
    row.pending_queue,
    pendingQueueArraySchema,
    "default",
    [],
  );
  if (!pendingQueue.ok) {
    return throwConversationValidationError(id, pendingQueue.issues);
  }

  const pendingAgentNotices = parseJsonColumn(
    "pendingAgentNotices",
    row.pending_agent_notices,
    pendingAgentNoticesArraySchema,
    "default",
    [],
  );
  if (!pendingAgentNotices.ok) {
    return throwConversationValidationError(id, pendingAgentNotices.issues);
  }

  // A null column decodes to a null snapshot — the legacy/no-profile state, not
  // an error. A PRESENT but unparseable snapshot is a boundary failure: unlike
  // the tolerant ref columns, a half-understood snapshot would let a turn run
  // under instructions nobody can account for, so it throws.
  const profileSnapshot = parseJsonColumn(
    "profileSnapshot",
    row.profile_snapshot,
    agentProfileSnapshotSchema,
    "default",
    null,
  );
  if (!profileSnapshot.ok) {
    return throwConversationValidationError(id, profileSnapshot.issues);
  }

  // A null column is the free conversation — the legacy and the ordinary state.
  // A PRESENT but unparseable owner throws: a half-understood claim is worse
  // than no claim, because a resumed turn would write into a conversation it
  // cannot prove it still holds.
  const owner = parseJsonColumn(
    "owner",
    row.conversation_owner,
    conversationOwnerSchema,
    "default",
    null,
  );
  if (!owner.ok) {
    return throwConversationValidationError(id, owner.issues);
  }

  const candidate: Record<string, unknown> = {
    name: row.name,
    nameOrigin: nameOriginResult.data,
    transcriptPath: row.transcript_path,
    status: statusResult.data,
    promptCount: row.prompt_count,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    source: sourceResult.data,
    summary: row.summary,
    archived: row.archived === 1,
    totalCostUsd: row.total_cost_usd,
    totalDurationMs: row.total_duration_ms,
    totalTurns: row.total_turns,
    pendingQuestionId: row.pending_question_id,
    pendingQuestions: pendingQuestions.value ?? null,
    pendingPromptText: row.pending_prompt_text,
    forkedFrom: forkedFromValue ?? null,
    role: roleResult.data,
    contextTokens: row.context_tokens,
    contextWindowMax: row.context_window_max,
    debugMode: debugMode.value ?? null,
    agentBackend: backendResult.data,
    backendRef: backendRefValue ?? null,
    unread: row.unread === 1,
    pendingQueue: pendingQueue.value ?? [],
    lastSeenAlignmentVersion: row.last_seen_alignment_version,
    pendingAgentNotices: pendingAgentNotices.value ?? [],
    profileSnapshot: profileSnapshot.value ?? null,
    profileLockedAt: row.profile_locked_at,
    owner: owner.value ?? null,
    turnGeneration: row.turn_generation,
  };
  if (mcpOverrides.value !== undefined) {
    candidate.mcpOverrides = mcpOverrides.value;
  }
  if (mcpRuntime.value !== undefined) {
    candidate.mcpRuntime = mcpRuntime.value;
  }
  if (agentCaps.value !== undefined) {
    candidate.agentCapabilityOverrides = agentCaps.value;
  }
  if (agentCapsRuntime.value !== undefined) {
    candidate.agentCapabilitiesRuntime = agentCapsRuntime.value;
  }
  return candidate;
}

/**
 * Raw values of the conversation columns a list-item projection reads: the
 * key/display columns plus the four small structured columns list surfaces
 * render (`debug_mode`, `pending_questions`, `forked_from`, `backend_ref`).
 * Deliberately omits every heavy blob (`machine_snapshot`, `pending_queue`,
 * the mcp/capability runtime columns) so the list-item read never pulls or
 * parses them.
 */
export interface ConversationListItemRawColumns {
  name: string | null;
  summary: string | null;
  status: string;
  role: string | null;
  archived: 0 | 1;
  agent_backend: string;
  backend_ref: string | null;
  transcript_path: string | null;
  last_activity_at: string;
  debug_mode: string | null;
  pending_question_id: string | null;
  pending_questions: string | null;
  forked_from: string | null;
  unread: 0 | 1;
  /**
   * The redacted profile identity, already narrowed by the SELECT's
   * `json_extract`s. `profile_snapshot` holds the profile's full instruction
   * text, so the list tier must never pull the column itself — extracting the
   * six safe scalars in SQL keeps this projection blob-free AND keeps the
   * instruction bytes out of the process on a store-wide feed read.
   */
  profile_tier: string | null;
  profile_id: string | null;
  profile_name: string | null;
  profile_revision: number | null;
  profile_source_content_hash: string | null;
  profile_resolved_instruction_hash: string | null;
}

/**
 * Domain projection of one conversation for list surfaces: the identity and
 * display fields plus the small structured fields (`debugMode`,
 * `pendingQuestions`, `forkedFrom`, `backendRef`) the cross-project and
 * active-conversation lists render. A strict subset of `ConversationState`,
 * carrying none of the heavy blobs.
 */
export type ConversationListItemFields = Pick<
  ConversationState,
  | "name"
  | "summary"
  | "status"
  | "role"
  | "archived"
  | "agentBackend"
  | "backendRef"
  | "transcriptPath"
  | "lastActivityAt"
  | "debugMode"
  | "pendingQuestionId"
  | "pendingQuestions"
  | "forkedFrom"
  | "unread"
> & {
  /**
   * The profile identity list surfaces render, already redacted (R6.3). Named
   * for the PUBLIC field rather than `profileSnapshot` so this projection is
   * structurally incapable of carrying instruction text — there is no key for
   * it to occupy.
   */
  redactedProfileSnapshot: RedactedAgentProfileSnapshot | null;
};

/**
 * Decode the list-item subset of a conversation row. Reuses the same enum and
 * JSON-column decoders as {@link decodeSharedConversationColumns} so the
 * list-item read and the full read never drift. Enum failures throw at the
 * boundary; the tolerant ref columns (`forked_from`, `backend_ref`) quarantine
 * to null, matching the full decoder's degrade-gracefully contract.
 */
export function decodeConversationListItemColumns(
  id: string,
  row: ConversationListItemRawColumns,
): ConversationListItemFields {
  const statusResult = conversationStatusSchema.safeParse(row.status);
  if (!statusResult.success) {
    return throwConversationValidationError(id, statusResult.error.issues);
  }

  const backendResult = agentBackendSchema.safeParse(row.agent_backend);
  if (!backendResult.success) {
    return throwConversationValidationError(id, backendResult.error.issues);
  }

  const roleResult = conversationRoleSchema.safeParse(row.role);
  if (!roleResult.success) {
    return throwConversationValidationError(id, roleResult.error.issues);
  }

  const pendingQuestions = parseJsonColumn(
    "pendingQuestions",
    row.pending_questions,
    pendingQuestionsArraySchema,
    "default",
    null,
  );
  if (!pendingQuestions.ok) {
    return throwConversationValidationError(id, pendingQuestions.issues);
  }

  let forkedFromValue: ForkedFrom | null = null;
  const forkedFrom = parseJsonColumn(
    "forkedFrom",
    row.forked_from,
    forkedFromSchema,
    "default",
    null,
  );
  if (forkedFrom.ok) {
    forkedFromValue = forkedFrom.value ?? null;
  } else {
    logRefColumnQuarantine(id, "forked_from", forkedFrom.issues);
  }

  const debugMode = parseJsonColumn(
    "debugMode",
    row.debug_mode,
    debugModeStateSchema,
    "default",
    null,
  );
  if (!debugMode.ok) {
    return throwConversationValidationError(id, debugMode.issues);
  }

  let backendRefValue: AgentSessionRef | null = null;
  const backendRef = parseJsonColumn(
    "backendRef",
    row.backend_ref,
    persistedAgentSessionRefSchema,
    "default",
    null,
  );
  if (backendRef.ok) {
    backendRefValue = backendRef.value ?? null;
  } else {
    logRefColumnQuarantine(id, "backend_ref", backendRef.issues);
  }

  return {
    name: row.name,
    summary: row.summary,
    status: statusResult.data,
    role: roleResult.data,
    archived: row.archived === 1,
    agentBackend: backendResult.data,
    backendRef: backendRefValue,
    transcriptPath: row.transcript_path,
    lastActivityAt: row.last_activity_at,
    debugMode: debugMode.value ?? null,
    pendingQuestionId: row.pending_question_id,
    pendingQuestions: pendingQuestions.value ?? null,
    forkedFrom: forkedFromValue,
    unread: row.unread === 1,
    redactedProfileSnapshot: decodeRedactedProfileColumns(id, row),
  };
}

/**
 * Rebuild the redacted snapshot from the SELECT's extracted scalars. A legacy
 * row (null `profile_snapshot`) extracts to all-nulls and decodes to null,
 * matching the full decoder's reading of the same column.
 *
 * Quarantines rather than throws: a list feed spanning every conversation in
 * the store must not be taken down by one row whose profile columns cannot be
 * read. The conversation still lists, showing no profile.
 */
function decodeRedactedProfileColumns(
  id: string,
  row: ConversationListItemRawColumns,
): RedactedAgentProfileSnapshot | null {
  if (row.profile_id === null) return null;

  const parsed = redactedAgentProfileSnapshotSchema.safeParse({
    tier: row.profile_tier,
    id: row.profile_id,
    name: row.profile_name,
    revision: row.profile_revision,
    sourceContentHash: row.profile_source_content_hash,
    resolvedInstructionHash: row.profile_resolved_instruction_hash,
  });
  if (parsed.success) return parsed.data;

  logRefColumnQuarantine(id, "profile_snapshot", parsed.error.issues);
  return null;
}

/**
 * Serialize `backendRef` for its column as the canonical `{backend, ref}`
 * shape (see session-ref-codec).
 */
function encodeBackendRefColumn(
  ref: ConversationState["backendRef"],
): string | null {
  if (!ref) return null;
  return jsonOrNull(encodeAgentSessionRefForStorage(ref));
}

/**
 * Serialize `forkedFrom` for its column, canonicalizing the embedded
 * `sourceBackendRef` (see session-ref-codec).
 */
function encodeForkedFromColumn(
  forkedFrom: ConversationState["forkedFrom"],
): string | null {
  if (!forkedFrom) return null;
  if (!forkedFrom.sourceBackendRef) return jsonOrNull(forkedFrom);
  return jsonOrNull({
    ...forkedFrom,
    sourceBackendRef: encodeAgentSessionRefForStorage(
      forkedFrom.sourceBackendRef,
    ),
  });
}

/**
 * SQLite-primitive bind values for the shared conversation columns (excluding
 * `id`/`project_path`/`session_name`/`open`). Opaque JSON columns are
 * serialized with `stableStringify` so deep-equal domain values produce
 * identical bytes.
 */
export interface SharedConversationBindColumns {
  name: string | null;
  name_origin: string;
  transcript_path: string | null;
  status: string;
  prompt_count: number;
  created_at: string;
  last_activity_at: string;
  source: string;
  summary: string | null;
  archived: number;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  total_turns: number | null;
  pending_question_id: string | null;
  pending_questions: string | null;
  pending_prompt_text: string | null;
  forked_from: string | null;
  role: string | null;
  context_tokens: number | null;
  context_window_max: number | null;
  debug_mode: string | null;
  agent_backend: string;
  backend_ref: string | null;
  mcp_overrides: string | null;
  mcp_runtime: string | null;
  agent_capability_overrides: string | null;
  agent_capabilities_runtime: string | null;
  unread: number;
  pending_queue: string | null;
  last_seen_alignment_version: number | null;
  pending_agent_notices: string | null;
  profile_snapshot: string | null;
  profile_locked_at: string | null;
  conversation_owner: string | null;
  turn_generation: number;
}

export function encodeSharedConversationColumns(
  conversation: ConversationState,
): SharedConversationBindColumns {
  return {
    name: conversation.name,
    name_origin: conversation.nameOrigin,
    transcript_path: conversation.transcriptPath,
    status: conversation.status,
    prompt_count: conversation.promptCount,
    created_at: conversation.createdAt,
    last_activity_at: conversation.lastActivityAt,
    source: conversation.source,
    summary: conversation.summary,
    archived: conversation.archived ? 1 : 0,
    total_cost_usd: conversation.totalCostUsd,
    total_duration_ms: conversation.totalDurationMs,
    total_turns: conversation.totalTurns,
    pending_question_id: conversation.pendingQuestionId,
    pending_questions: jsonOrNull(conversation.pendingQuestions),
    pending_prompt_text: conversation.pendingPromptText,
    forked_from: encodeForkedFromColumn(conversation.forkedFrom),
    role: conversation.role,
    context_tokens: conversation.contextTokens,
    context_window_max: conversation.contextWindowMax,
    debug_mode: jsonOrNull(conversation.debugMode),
    agent_backend: conversation.agentBackend,
    backend_ref: encodeBackendRefColumn(conversation.backendRef),
    mcp_overrides: jsonOrNull(conversation.mcpOverrides),
    mcp_runtime: jsonOrNull(conversation.mcpRuntime),
    agent_capability_overrides: jsonOrNull(
      conversation.agentCapabilityOverrides,
    ),
    agent_capabilities_runtime: jsonOrNull(
      conversation.agentCapabilitiesRuntime,
    ),
    unread: conversation.unread ? 1 : 0,
    pending_queue: jsonOrNull(conversation.pendingQueue),
    last_seen_alignment_version: conversation.lastSeenAlignmentVersion,
    pending_agent_notices: jsonOrNull(conversation.pendingAgentNotices),
    profile_snapshot: jsonOrNull(conversation.profileSnapshot),
    profile_locked_at: conversation.profileLockedAt,
    conversation_owner: jsonOrNull(conversation.owner),
    turn_generation: conversation.turnGeneration,
  };
}

/**
 * Every persisted, mutable conversation column and the single domain field it
 * derives from, paired with the serializer that turns that field into its
 * SQLite-primitive bind value. This is the per-column write authority: it
 * deliberately omits the identity columns (`id`/`project_path`/`session_name`,
 * never updated) and `last_activity_at` (the store/repo restamp it on every
 * mutate, so the repo writes it explicitly rather than diffing it).
 *
 * Strictly 1:1 — no column derives from more than one domain field, and no
 * domain field maps to more than one column — so a per-top-level-field
 * reference diff maps cleanly to columns. The four non-column top-level fields
 * (`scope`, `open`, `spawnedSessionIds`, `activeTurnSource`) are intentionally
 * absent: they have no column on the `conversations` table, so a mutate
 * touching only them yields zero changed columns here.
 */
const CONVERSATION_COLUMN_MAP = [
  ["name", "name", (c: ConversationState) => c.name],
  ["nameOrigin", "name_origin", (c: ConversationState) => c.nameOrigin],
  [
    "transcriptPath",
    "transcript_path",
    (c: ConversationState) => c.transcriptPath,
  ],
  ["status", "status", (c: ConversationState) => c.status],
  ["promptCount", "prompt_count", (c: ConversationState) => c.promptCount],
  ["createdAt", "created_at", (c: ConversationState) => c.createdAt],
  ["source", "source", (c: ConversationState) => c.source],
  ["summary", "summary", (c: ConversationState) => c.summary],
  ["archived", "archived", (c: ConversationState) => (c.archived ? 1 : 0)],
  ["totalCostUsd", "total_cost_usd", (c: ConversationState) => c.totalCostUsd],
  [
    "totalDurationMs",
    "total_duration_ms",
    (c: ConversationState) => c.totalDurationMs,
  ],
  ["totalTurns", "total_turns", (c: ConversationState) => c.totalTurns],
  [
    "pendingQuestionId",
    "pending_question_id",
    (c: ConversationState) => c.pendingQuestionId,
  ],
  [
    "pendingQuestions",
    "pending_questions",
    (c: ConversationState) => jsonOrNull(c.pendingQuestions),
  ],
  [
    "pendingPromptText",
    "pending_prompt_text",
    (c: ConversationState) => c.pendingPromptText,
  ],
  [
    "forkedFrom",
    "forked_from",
    (c: ConversationState) => encodeForkedFromColumn(c.forkedFrom),
  ],
  ["role", "role", (c: ConversationState) => c.role],
  [
    "contextTokens",
    "context_tokens",
    (c: ConversationState) => c.contextTokens,
  ],
  [
    "contextWindowMax",
    "context_window_max",
    (c: ConversationState) => c.contextWindowMax,
  ],
  [
    "debugMode",
    "debug_mode",
    (c: ConversationState) => jsonOrNull(c.debugMode),
  ],
  ["agentBackend", "agent_backend", (c: ConversationState) => c.agentBackend],
  [
    "backendRef",
    "backend_ref",
    (c: ConversationState) => encodeBackendRefColumn(c.backendRef),
  ],
  [
    "mcpOverrides",
    "mcp_overrides",
    (c: ConversationState) => jsonOrNull(c.mcpOverrides),
  ],
  [
    "mcpRuntime",
    "mcp_runtime",
    (c: ConversationState) => jsonOrNull(c.mcpRuntime),
  ],
  [
    "agentCapabilityOverrides",
    "agent_capability_overrides",
    (c: ConversationState) => jsonOrNull(c.agentCapabilityOverrides),
  ],
  [
    "agentCapabilitiesRuntime",
    "agent_capabilities_runtime",
    (c: ConversationState) => jsonOrNull(c.agentCapabilitiesRuntime),
  ],
  ["unread", "unread", (c: ConversationState) => (c.unread ? 1 : 0)],
  [
    "pendingQueue",
    "pending_queue",
    (c: ConversationState) => jsonOrNull(c.pendingQueue),
  ],
  [
    "lastSeenAlignmentVersion",
    "last_seen_alignment_version",
    (c: ConversationState) => c.lastSeenAlignmentVersion,
  ],
  [
    "pendingAgentNotices",
    "pending_agent_notices",
    (c: ConversationState) => jsonOrNull(c.pendingAgentNotices),
  ],
  [
    "owner",
    "conversation_owner",
    (c: ConversationState) => jsonOrNull(c.owner),
  ],
  [
    "turnGeneration",
    "turn_generation",
    (c: ConversationState) => c.turnGeneration,
  ],
  [
    "profileSnapshot",
    "profile_snapshot",
    (c: ConversationState) => jsonOrNull(c.profileSnapshot),
  ],
  [
    "profileLockedAt",
    "profile_locked_at",
    (c: ConversationState) => c.profileLockedAt,
  ],
] as const satisfies ReadonlyArray<
  readonly [
    keyof ConversationState,
    string,
    (c: ConversationState) => string | number | null,
  ]
>;

export type ChangedConversationColumns = Record<string, string | number | null>;

/**
 * Compare `base` against `next` field-by-field (top-level reference equality)
 * and return only the columns whose source field changed, already serialized
 * to their SQLite-primitive bind values via the same serializers the full-row
 * encoder uses (zero column drift). Excludes `last_activity_at` and the
 * identity columns — the repo restamps `last_activity_at` itself.
 *
 * `base` and `next` must be distinct objects (e.g. the row loaded before the
 * mutator and the value Immer's `produce` returns), so structural sharing makes
 * `next[field] !== base[field]` exactly "this field's persisted bytes may have
 * changed". Serialization happens lazily, only for changed fields, so an
 * untouched `machine_snapshot`/`pending_queue` is never re-stringified.
 */
export function diffChangedConversationColumns(
  base: ConversationState,
  next: ConversationState,
): ChangedConversationColumns {
  const changed: ChangedConversationColumns = {};
  for (const [field, column, encode] of CONVERSATION_COLUMN_MAP) {
    if (next[field] !== base[field]) {
      changed[column] = encode(next);
    }
  }
  return changed;
}
