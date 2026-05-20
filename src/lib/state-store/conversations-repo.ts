import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  agentBackendSchema,
  agentCapabilityOverridesSchema,
  agentCapabilityRuntimeApplicationStateSchema,
  agentSessionRefSchema,
  askQuestionItemSchema,
  conversationStateSchema,
  conversationStatusSchema,
  conversationRoleSchema,
  debugModeStateSchema,
  forkedFromSchema,
  mcpOverridesSchema,
  mcpRuntimeApplicationStateSchema,
} from "../schemas";
import { PersistenceError, getErrorMessage } from "../errors";
import type { ConversationState, ConversationStatus } from "@/types";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.conversations");

export interface ConversationsRepo {
  findById(id: string): ConversationState | null;
  findByKey(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): ConversationState | null;
  findBySession(projectPath: string, sessionName: string): ConversationState[];
  findListItemsForProject(projectPath: string): Array<{
    id: string;
    sessionName: string;
    status: ConversationStatus;
    promptCount: number;
    lastActivityAt: string;
  }>;
  findAll(): {
    projectPath: string;
    sessionName: string;
    conversation: ConversationState;
  }[];
  upsert(
    projectPath: string,
    sessionName: string,
    conversation: ConversationState,
  ): void;
  delete(id: string): void;
  upsertWithSessionTouch(
    projectPath: string,
    sessionName: string,
    conversation: ConversationState,
    lastActivityAt: string,
  ): void;
}

/**
 * Raw column shape for `SELECT * FROM conversations`. Validated at the
 * persistence boundary so corrupt values trip a Zod safeParse failure rather
 * than being silently coerced.
 */
const conversationsTableRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  session_name: z.string(),
  name: z.string().nullable(),
  transcript_path: z.string().nullable(),
  status: z.string(),
  prompt_count: z.number().int(),
  created_at: z.string(),
  last_activity_at: z.string(),
  source: z.string(),
  summary: z.string().nullable(),
  archived: z.union([z.literal(0), z.literal(1)]),
  total_cost_usd: z.number().nullable(),
  total_duration_ms: z.number().int().nullable(),
  total_turns: z.number().int().nullable(),
  pending_question_id: z.string().nullable(),
  pending_questions: z.string().nullable(),
  pending_prompt_text: z.string().nullable(),
  forked_from: z.string().nullable(),
  role: z.string().nullable(),
  context_tokens: z.number().int().nullable(),
  context_window_max: z.number().int().nullable(),
  debug_mode: z.string().nullable(),
  machine_snapshot: z.string().nullable(),
  agent_backend: z.string(),
  backend_ref: z.string().nullable(),
  mcp_overrides: z.string().nullable(),
  mcp_runtime: z.string().nullable(),
  agent_capability_overrides: z.string().nullable(),
  agent_capabilities_runtime: z.string().nullable(),
});
type ConversationsTableRow = z.infer<typeof conversationsTableRowSchema>;

interface SqlBindRow {
  id: string;
  project_path: string;
  session_name: string;
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
}

function stableStringify(value: unknown): string {
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

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stableStringify(value);
}

/**
 * Encode a validated ConversationState as the column-name → SQLite-primitive
 * bind record used by both `domainToRow` and `canonicalRow`. Opaque JSON column
 * values are serialized with sorted-key recursion so that two domain values
 * that are deep-equal post-Zod-parse always produce identical bytes.
 */
function conversationToSqlBind(
  projectPath: string,
  sessionName: string,
  conversation: ConversationState,
): SqlBindRow {
  return {
    id: conversation.id,
    project_path: projectPath,
    session_name: sessionName,
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
  };
}

export function domainToConversationRow(
  projectPath: string,
  sessionName: string,
  conversation: ConversationState,
): SqlBindRow {
  const validated = conversationStateSchema.parse(conversation);
  return conversationToSqlBind(projectPath, sessionName, validated);
}

export function canonicalConversationRow(
  projectPath: string,
  sessionName: string,
  conversation: ConversationState,
): string {
  const validated = conversationStateSchema.parse(conversation);
  return stableStringify(
    conversationToSqlBind(projectPath, sessionName, validated),
  );
}

interface JsonParseSuccess<T> {
  ok: true;
  value: T;
}
interface JsonParseFailure {
  ok: false;
  issues: unknown;
}

function parseJsonColumn<T>(
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

function logAndThrowValidationFailure(
  conversationId: string,
  issues: unknown,
): never {
  logger.error("state-store.conversations.schema_validation_failure", {
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

function rowToDomain(rawRow: unknown): {
  projectPath: string;
  sessionName: string;
  conversation: ConversationState;
} {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const rowResult = conversationsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowValidationFailure(fallbackId, rowResult.error.issues);
  }
  const row: ConversationsTableRow = rowResult.data;

  const statusResult = conversationStatusSchema.safeParse(row.status);
  if (!statusResult.success) {
    return logAndThrowValidationFailure(row.id, statusResult.error.issues);
  }

  const sourceResult = z.enum(["cc", "imported"]).safeParse(row.source);
  if (!sourceResult.success) {
    return logAndThrowValidationFailure(row.id, sourceResult.error.issues);
  }

  const backendResult = agentBackendSchema.safeParse(row.agent_backend);
  if (!backendResult.success) {
    return logAndThrowValidationFailure(row.id, backendResult.error.issues);
  }

  const roleResult = conversationRoleSchema.safeParse(row.role);
  if (!roleResult.success) {
    return logAndThrowValidationFailure(row.id, roleResult.error.issues);
  }

  const pendingQuestions = parseJsonColumn(
    "pendingQuestions",
    row.pending_questions,
    pendingQuestionsArraySchema,
    "default",
    null,
  );
  if (!pendingQuestions.ok) {
    return logAndThrowValidationFailure(row.id, pendingQuestions.issues);
  }

  const forkedFrom = parseJsonColumn(
    "forkedFrom",
    row.forked_from,
    forkedFromSchema,
    "default",
    null,
  );
  if (!forkedFrom.ok) {
    return logAndThrowValidationFailure(row.id, forkedFrom.issues);
  }

  const debugMode = parseJsonColumn(
    "debugMode",
    row.debug_mode,
    debugModeStateSchema,
    "default",
    null,
  );
  if (!debugMode.ok) {
    return logAndThrowValidationFailure(row.id, debugMode.issues);
  }

  const machineSnapshot = parseJsonColumn(
    "machineSnapshot",
    row.machine_snapshot,
    machineSnapshotSchema,
    "default",
    null,
  );
  if (!machineSnapshot.ok) {
    return logAndThrowValidationFailure(row.id, machineSnapshot.issues);
  }

  const backendRef = parseJsonColumn(
    "backendRef",
    row.backend_ref,
    agentSessionRefSchema,
    "default",
    null,
  );
  if (!backendRef.ok) {
    return logAndThrowValidationFailure(row.id, backendRef.issues);
  }

  const mcpOverrides = parseJsonColumn(
    "mcpOverrides",
    row.mcp_overrides,
    mcpOverridesSchema,
    "absent",
  );
  if (!mcpOverrides.ok) {
    return logAndThrowValidationFailure(row.id, mcpOverrides.issues);
  }

  const mcpRuntime = parseJsonColumn(
    "mcpRuntime",
    row.mcp_runtime,
    mcpRuntimeApplicationStateSchema,
    "absent",
  );
  if (!mcpRuntime.ok) {
    return logAndThrowValidationFailure(row.id, mcpRuntime.issues);
  }

  const agentCaps = parseJsonColumn(
    "agentCapabilityOverrides",
    row.agent_capability_overrides,
    agentCapabilityOverridesSchema,
    "absent",
  );
  if (!agentCaps.ok) {
    return logAndThrowValidationFailure(row.id, agentCaps.issues);
  }

  const agentCapsRuntime = parseJsonColumn(
    "agentCapabilitiesRuntime",
    row.agent_capabilities_runtime,
    agentCapabilityRuntimeApplicationStateSchema,
    "absent",
  );
  if (!agentCapsRuntime.ok) {
    return logAndThrowValidationFailure(row.id, agentCapsRuntime.issues);
  }

  const candidate: Record<string, unknown> = {
    id: row.id,
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

  const result = conversationStateSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(row.id, result.error.issues);
  }
  return {
    projectPath: row.project_path,
    sessionName: row.session_name,
    conversation: result.data,
  };
}

function timed<T>(
  op: string,
  identifier: { id?: string; projectPath?: string; sessionName?: string },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.id !== undefined) payload.conversationId = identifier.id;
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    if (identifier.sessionName !== undefined) {
      payload.sessionName = identifier.sessionName;
    }
    logger.info(`state-store.conversations.${op}.timing`, payload);
  }
}

export function createConversationsRepo(db: Db): ConversationsRepo {
  const findByIdStmt = db.prepare(
    `SELECT * FROM conversations WHERE id = ? LIMIT 1`,
  );
  const findByKeyStmt = db.prepare(
    `SELECT * FROM conversations
     WHERE project_path = ? AND session_name = ? AND id = ?
     LIMIT 1`,
  );
  const findBySessionStmt = db.prepare(
    `SELECT * FROM conversations
     WHERE project_path = ? AND session_name = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findListItemsForProjectStmt = db.prepare(
    `SELECT id, session_name, status, prompt_count, last_activity_at
     FROM conversations
     WHERE project_path = ?`,
  );
  const findAllStmt = db.prepare(
    `SELECT * FROM conversations
     ORDER BY project_path ASC, session_name ASC, created_at ASC, id ASC`,
  );
  // Conversation rows are leaf rows from the FK perspective, so OR REPLACE is
  // technically allowed; we use ON CONFLICT(id) DO UPDATE for codebase
  // consistency with the parent-row UPSERT rule (sessions/projects).
  const upsertStmt = db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, name, transcript_path, status,
       prompt_count, created_at, last_activity_at, source, summary, archived,
       total_cost_usd, total_duration_ms, total_turns, pending_question_id,
       pending_questions, pending_prompt_text, forked_from, role, context_tokens, context_window_max,
       debug_mode, machine_snapshot, agent_backend, backend_ref,
       mcp_overrides, mcp_runtime, agent_capability_overrides, agent_capabilities_runtime
     ) VALUES (
       @id, @project_path, @session_name, @name, @transcript_path, @status,
       @prompt_count, @created_at, @last_activity_at, @source, @summary, @archived,
       @total_cost_usd, @total_duration_ms, @total_turns, @pending_question_id,
       @pending_questions, @pending_prompt_text, @forked_from, @role, @context_tokens, @context_window_max,
       @debug_mode, @machine_snapshot, @agent_backend, @backend_ref,
       @mcp_overrides, @mcp_runtime, @agent_capability_overrides, @agent_capabilities_runtime
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path               = excluded.project_path,
       session_name               = excluded.session_name,
       name                       = excluded.name,
       transcript_path            = excluded.transcript_path,
       status                     = excluded.status,
       prompt_count               = excluded.prompt_count,
       created_at                 = excluded.created_at,
       last_activity_at           = excluded.last_activity_at,
       source                     = excluded.source,
       summary                    = excluded.summary,
       archived                   = excluded.archived,
       total_cost_usd             = excluded.total_cost_usd,
       total_duration_ms          = excluded.total_duration_ms,
       total_turns                = excluded.total_turns,
       pending_question_id        = excluded.pending_question_id,
       pending_questions          = excluded.pending_questions,
       pending_prompt_text        = excluded.pending_prompt_text,
       forked_from                = excluded.forked_from,
       role                       = excluded.role,
       context_tokens             = excluded.context_tokens,
       context_window_max         = excluded.context_window_max,
       debug_mode                 = excluded.debug_mode,
       machine_snapshot           = excluded.machine_snapshot,
       agent_backend              = excluded.agent_backend,
       backend_ref                = excluded.backend_ref,
       mcp_overrides              = excluded.mcp_overrides,
       mcp_runtime                = excluded.mcp_runtime,
       agent_capability_overrides = excluded.agent_capability_overrides,
       agent_capabilities_runtime = excluded.agent_capabilities_runtime`,
  );
  const deleteStmt = db.prepare(`DELETE FROM conversations WHERE id = ?`);
  const sessionTouchStmt = db.prepare(
    `UPDATE sessions
     SET last_activity_at = ?
     WHERE project_path = ? AND session_name = ?`,
  );

  const upsertWithSessionTouchTxn = db.transaction(
    (bind: SqlBindRow, lastActivityAt: string) => {
      upsertStmt.run(bind);
      sessionTouchStmt.run(
        lastActivityAt,
        bind.project_path,
        bind.session_name,
      );
    },
  );

  return {
    findById(id) {
      return timed("findById", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToDomain(row).conversation;
      });
    },
    findByKey(projectPath, sessionName, conversationId) {
      return timed(
        "findByKey",
        { projectPath, sessionName, id: conversationId },
        () => {
          const row: unknown = findByKeyStmt.get(
            projectPath,
            sessionName,
            conversationId,
          );
          if (row === undefined) return null;
          return rowToDomain(row).conversation;
        },
      );
    },
    findBySession(projectPath, sessionName) {
      return timed("findBySession", { projectPath, sessionName }, () => {
        const rows = findBySessionStmt.all(
          projectPath,
          sessionName,
        ) as unknown[];
        return rows.map((row) => rowToDomain(row).conversation);
      });
    },
    findListItemsForProject(projectPath) {
      return timed("findListItemsForProject", { projectPath }, () => {
        const rows = findListItemsForProjectStmt.all(projectPath) as Array<{
          id: string;
          session_name: string;
          status: ConversationStatus;
          prompt_count: number;
          last_activity_at: string;
        }>;
        return rows.map((row) => ({
          id: row.id,
          sessionName: row.session_name,
          status: row.status,
          promptCount: row.prompt_count,
          lastActivityAt: row.last_activity_at,
        }));
      });
    },
    findAll() {
      return timed("findAll", {}, () => {
        const rows = findAllStmt.all() as unknown[];
        return rows.map(rowToDomain);
      });
    },
    upsert(projectPath, sessionName, conversation) {
      timed("upsert", { id: conversation.id, projectPath, sessionName }, () => {
        const bind = domainToConversationRow(
          projectPath,
          sessionName,
          conversation,
        );
        upsertStmt.run(bind);
      });
    },
    delete(id) {
      timed("delete", { id }, () => {
        deleteStmt.run(id);
      });
    },
    upsertWithSessionTouch(
      projectPath,
      sessionName,
      conversation,
      lastActivityAt,
    ) {
      timed(
        "upsertWithSessionTouch",
        { id: conversation.id, projectPath, sessionName },
        () => {
          const bind = domainToConversationRow(
            projectPath,
            sessionName,
            conversation,
          );
          upsertWithSessionTouchTxn.immediate(bind, lastActivityAt);
        },
      );
    },
  };
}
