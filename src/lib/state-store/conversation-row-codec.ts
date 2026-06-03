import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { agentSessionRefSchema } from "@/lib/agent-backends/schemas";
import {
  askQuestionItemSchema,
  conversationRoleSchema,
  conversationStatusSchema,
  forkedFromSchema,
} from "@/lib/conversations/schemas";
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
import type { ConversationState } from "@/lib/conversations/schemas";

const logger = createLogger("state-store.conversation-codec");

/**
 * Deterministic JSON serialization with sorted object keys, so two domain
 * values that are deep-equal after a Zod parse always produce identical bytes
 * (used for canonical-row comparison and JSON column storage).
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

export function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stableStringify(value);
}

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
const machineSnapshotSchema = z.unknown();

/**
 * Raw values of the conversation columns shared by both the `conversations` and
 * `project_conversations` tables — i.e. every conversation column except the
 * identity columns (`id`, `project_path`, `session_name`) and the project-only
 * `open` column. Both repos validate their own table-row shape first, then hand
 * the shared columns here for JSON/enum decoding.
 */
export interface SharedConversationRawColumns {
  name: string | null;
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
  machine_snapshot: string | null;
  agent_backend: string;
  backend_ref: string | null;
  mcp_overrides: string | null;
  mcp_runtime: string | null;
  agent_capability_overrides: string | null;
  agent_capabilities_runtime: string | null;
  unread: 0 | 1;
}

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

  const forkedFrom = parseJsonColumn(
    "forkedFrom",
    row.forked_from,
    forkedFromSchema,
    "default",
    null,
  );
  if (!forkedFrom.ok) {
    return throwConversationValidationError(id, forkedFrom.issues);
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

  const machineSnapshot = parseJsonColumn(
    "machineSnapshot",
    row.machine_snapshot,
    machineSnapshotSchema,
    "default",
    null,
  );
  if (!machineSnapshot.ok) {
    return throwConversationValidationError(id, machineSnapshot.issues);
  }

  const backendRef = parseJsonColumn(
    "backendRef",
    row.backend_ref,
    agentSessionRefSchema,
    "default",
    null,
  );
  if (!backendRef.ok) {
    return throwConversationValidationError(id, backendRef.issues);
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

  const candidate: Record<string, unknown> = {
    name: row.name,
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
    forkedFrom: forkedFrom.value ?? null,
    role: roleResult.data,
    contextTokens: row.context_tokens,
    contextWindowMax: row.context_window_max,
    debugMode: debugMode.value ?? null,
    machineSnapshot: machineSnapshot.value ?? null,
    agentBackend: backendResult.data,
    backendRef: backendRef.value ?? null,
    unread: row.unread === 1,
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
 * SQLite-primitive bind values for the shared conversation columns (excluding
 * `id`/`project_path`/`session_name`/`open`). Opaque JSON columns are
 * serialized with `stableStringify` so deep-equal domain values produce
 * identical bytes.
 */
export interface SharedConversationBindColumns {
  name: string | null;
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
  machine_snapshot: string | null;
  agent_backend: string;
  backend_ref: string | null;
  mcp_overrides: string | null;
  mcp_runtime: string | null;
  agent_capability_overrides: string | null;
  agent_capabilities_runtime: string | null;
  unread: number;
}

export function encodeSharedConversationColumns(
  conversation: ConversationState,
): SharedConversationBindColumns {
  return {
    name: conversation.name,
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
    forked_from: jsonOrNull(conversation.forkedFrom),
    role: conversation.role,
    context_tokens: conversation.contextTokens,
    context_window_max: conversation.contextWindowMax,
    debug_mode: jsonOrNull(conversation.debugMode),
    machine_snapshot: jsonOrNull(conversation.machineSnapshot),
    agent_backend: conversation.agentBackend,
    backend_ref: jsonOrNull(conversation.backendRef),
    mcp_overrides: jsonOrNull(conversation.mcpOverrides),
    mcp_runtime: jsonOrNull(conversation.mcpRuntime),
    agent_capability_overrides: jsonOrNull(
      conversation.agentCapabilityOverrides,
    ),
    agent_capabilities_runtime: jsonOrNull(
      conversation.agentCapabilitiesRuntime,
    ),
    unread: conversation.unread ? 1 : 0,
  };
}
