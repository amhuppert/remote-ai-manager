import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";
import {
  sessionCreationModeSchema,
  sessionSourceSchema,
  sessionStateSchema,
} from "@/lib/sessions/schemas";
import { PersistenceError, getErrorMessage } from "../shared/errors";
import {
  migrateLegacyExecution,
  needsLegacyMigration,
} from "@/lib/workflow-graph/migrate-legacy-execution";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.sessions");
const parallelLogger = createLogger("graph-workflow-parallel");

interface SessionListItemRow {
  session_name: string;
  worktree_path: string;
  branch_name: string;
  target_branch: string;
  parent_session_name: string | null;
  created_at: string;
  last_activity_at: string;
  archived: 0 | 1;
  finished: 0 | 1;
  source: string;
  creation_mode: string;
  tdd_enabled: 0 | 1;
  objective: string | null;
  has_active_graph_workflow: 0 | 1;
  workflow_envelopes: string | null;
}

export interface SessionsRepo {
  findByKey(projectPath: string, sessionName: string): SessionState | null;
  findByProject(projectPath: string): SessionState[];
  findListItemsByProject(projectPath: string): SessionListItemRow[];
  findAll(): { projectPath: string; session: SessionState }[];
  upsert(projectPath: string, session: SessionState): void;
  delete(projectPath: string, sessionName: string): void;
}

/**
 * Raw column shape for `SELECT * FROM sessions`. Validated through
 * `sessionsTableRowSchema` at the persistence boundary so corrupt values trip a
 * Zod safeParse failure rather than being silently coerced.
 */
const sessionsTableRowSchema = z.object({
  project_path: z.string(),
  session_name: z.string(),
  worktree_path: z.string(),
  branch_name: z.string(),
  created_at: z.string(),
  last_activity_at: z.string(),
  archived: z.union([z.literal(0), z.literal(1)]),
  finished: z.union([z.literal(0), z.literal(1)]),
  source: z.string(),
  objective: z.string().nullable(),
  creation_mode: z.string(),
  tdd_enabled: z.union([z.literal(0), z.literal(1)]),
  target_branch: z.string(),
  parent_session_name: z.string().nullable(),
  graph_workflow_execution: z.string().nullable(),
  graph_workflow_execution_history: z.string(),
  workflow_envelopes: z.string().nullable(),
  workflow_lanes: z.string().nullable(),
  mcp_overrides: z.string().nullable(),
  agent_capability_overrides: z.string().nullable(),
});
type SessionsTableRow = z.infer<typeof sessionsTableRowSchema>;

interface SqlBindRow {
  project_path: string;
  session_name: string;
  worktree_path: string;
  branch_name: string;
  created_at: string;
  last_activity_at: string;
  archived: number;
  finished: number;
  source: string;
  objective: string | null;
  creation_mode: string;
  tdd_enabled: number;
  target_branch: string;
  parent_session_name: string | null;
  graph_workflow_execution: string | null;
  graph_workflow_execution_history: string;
  workflow_envelopes: string | null;
  workflow_lanes: string | null;
  mcp_overrides: string | null;
  agent_capability_overrides: string | null;
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
 * Encode a validated SessionState as the column-name → SQLite-primitive bind
 * record used by both `domainToRow` and `canonicalRow`. JSON column values are
 * serialized with sorted-key recursion so that two domain values that are
 * deep-equal post-Zod-parse always produce identical bytes.
 */
function sessionToSqlBind(
  projectPath: string,
  session: SessionState,
): SqlBindRow {
  return {
    project_path: projectPath,
    session_name: session.sessionName,
    worktree_path: session.worktreePath,
    branch_name: session.branchName,
    created_at: session.createdAt,
    last_activity_at: session.lastActivityAt,
    archived: session.archived ? 1 : 0,
    finished: session.finished ? 1 : 0,
    source: session.source,
    objective: session.objective,
    creation_mode: session.creationMode,
    tdd_enabled: session.tddEnabled ? 1 : 0,
    target_branch: session.targetBranch,
    parent_session_name: session.parentSessionName,
    graph_workflow_execution: jsonOrNull(session.graphWorkflowExecution),
    graph_workflow_execution_history: stableStringify(
      session.graphWorkflowExecutionHistory,
    ),
    workflow_envelopes: jsonOrNull(session.workflowEnvelopes),
    workflow_lanes: jsonOrNull(session.workflowLanes),
    mcp_overrides: jsonOrNull(session.mcpOverrides),
    agent_capability_overrides: jsonOrNull(session.agentCapabilityOverrides),
  };
}

function domainToSessionRow(
  projectPath: string,
  session: SessionState,
): SqlBindRow {
  const validated = sessionStateSchema.parse(session);
  return sessionToSqlBind(projectPath, validated);
}

export function canonicalSessionRow(
  projectPath: string,
  session: SessionState,
): string {
  const validated = sessionStateSchema.parse(session);
  return stableStringify(sessionToSqlBind(projectPath, validated));
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
  projectPath: string,
  sessionName: string,
  issues: unknown,
): never {
  logger.error("state-store.sessions.schema_validation_failure", {
    projectPath,
    sessionName,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "session",
    identifier: `${projectPath}::${sessionName}`,
    issues,
  });
}

/**
 * Loud-log a forward-incompatible / corrupt *nullable* workflow column and let
 * the caller substitute the column's null/default. A feature branch that
 * extends a persisted enum (e.g. a new graph-workflow halt-reason variant) and
 * writes into the shared database leaves rows the current schema cannot parse;
 * hard-throwing here would take down every full-state read (readState,
 * mutateState, getSession) for one bad row. Degrading the offending column
 * in-memory keeps the rest of the session — and the app — usable, while the
 * error log preserves the full diagnostic. The on-disk value is left intact, so
 * a schema that understands the value will parse it on a later read.
 */
function logColumnQuarantine(
  projectPath: string,
  sessionName: string,
  column: string,
  issues: unknown,
): void {
  logger.error("state-store.sessions.column_quarantined", {
    projectPath,
    sessionName,
    column,
    issues,
  });
}

const opaqueRecordSchema = z.record(z.string(), z.unknown());
const graphWorkflowExecutionHistoryArraySchema = z.array(
  graphWorkflowExecutionSchema,
);

interface GraphWorkflowExecutionMigration {
  upgradedJson: string;
  executionId: string | null;
  repairedFields: string[];
}

interface GraphWorkflowExecutionLoadSuccess {
  ok: true;
  value: GraphWorkflowExecution | null;
  migration: GraphWorkflowExecutionMigration | null;
}

function loadGraphWorkflowExecutionColumn(
  rawJson: string | null,
): GraphWorkflowExecutionLoadSuccess | JsonParseFailure {
  if (rawJson === null) return { ok: true, value: null, migration: null };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: ["graphWorkflowExecution"],
          message: getErrorMessage(err),
        },
      ],
    };
  }

  if (parsedJson === null) return { ok: true, value: null, migration: null };

  let candidate: unknown = parsedJson;
  let migrationMeta: {
    executionId: string | null;
    repairedFields: string[];
  } | null = null;
  if (needsLegacyMigration(parsedJson)) {
    try {
      const result = migrateLegacyExecution(parsedJson);
      candidate = result.upgradedRecord;
      migrationMeta = {
        executionId: result.executionId,
        repairedFields: result.repairedFields,
      };
    } catch (err) {
      return {
        ok: false,
        issues: [
          {
            code: "legacy_migration_failed",
            path: ["graphWorkflowExecution"],
            message: getErrorMessage(err),
          },
        ],
      };
    }
  }

  const parseResult = graphWorkflowExecutionSchema
    .nullable()
    .safeParse(candidate);
  if (!parseResult.success) {
    return { ok: false, issues: parseResult.error.issues };
  }
  if (parseResult.data === null) {
    return { ok: true, value: null, migration: null };
  }
  if (migrationMeta === null) {
    return { ok: true, value: parseResult.data, migration: null };
  }
  return {
    ok: true,
    value: parseResult.data,
    migration: {
      upgradedJson: stableStringify(parseResult.data),
      executionId: migrationMeta.executionId,
      repairedFields: migrationMeta.repairedFields,
    },
  };
}

function rowToDomain(rawRow: unknown): {
  projectPath: string;
  session: SessionState;
  graphWorkflowExecutionMigration: GraphWorkflowExecutionMigration | null;
} {
  const fallbackProjectPath =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { project_path?: unknown }).project_path === "string"
      ? (rawRow as { project_path: string }).project_path
      : "<unknown>";
  const fallbackSessionName =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { session_name?: unknown }).session_name === "string"
      ? (rawRow as { session_name: string }).session_name
      : "<unknown>";

  const rowResult = sessionsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowValidationFailure(
      fallbackProjectPath,
      fallbackSessionName,
      rowResult.error.issues,
    );
  }
  const row: SessionsTableRow = rowResult.data;

  const sourceResult = sessionSourceSchema.safeParse(row.source);
  if (!sourceResult.success) {
    return logAndThrowValidationFailure(
      row.project_path,
      row.session_name,
      sourceResult.error.issues,
    );
  }

  const creationModeResult = sessionCreationModeSchema.safeParse(
    row.creation_mode,
  );
  if (!creationModeResult.success) {
    return logAndThrowValidationFailure(
      row.project_path,
      row.session_name,
      creationModeResult.error.issues,
    );
  }

  let graphWorkflowExecution: GraphWorkflowExecution | null = null;
  let graphWorkflowExecutionMigration: GraphWorkflowExecutionMigration | null =
    null;
  const gwExec = loadGraphWorkflowExecutionColumn(row.graph_workflow_execution);
  if (gwExec.ok) {
    graphWorkflowExecution = gwExec.value;
    graphWorkflowExecutionMigration = gwExec.migration;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "graphWorkflowExecution",
      gwExec.issues,
    );
  }

  let graphWorkflowExecutionHistory: GraphWorkflowExecution[] = [];
  const gwHistory = parseJsonColumn(
    "graphWorkflowExecutionHistory",
    row.graph_workflow_execution_history,
    graphWorkflowExecutionHistoryArraySchema,
    "default",
    [],
  );
  if (gwHistory.ok) {
    graphWorkflowExecutionHistory = gwHistory.value ?? [];
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "graphWorkflowExecutionHistory",
      gwHistory.issues,
    );
  }

  let workflowEnvelopes: z.infer<typeof opaqueRecordSchema> | undefined;
  const envelopes = parseJsonColumn(
    "workflowEnvelopes",
    row.workflow_envelopes,
    opaqueRecordSchema,
    "absent",
  );
  if (envelopes.ok) {
    workflowEnvelopes = envelopes.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "workflowEnvelopes",
      envelopes.issues,
    );
  }

  let workflowLanes: z.infer<typeof opaqueRecordSchema> | undefined;
  const lanes = parseJsonColumn(
    "workflowLanes",
    row.workflow_lanes,
    opaqueRecordSchema,
    "absent",
  );
  if (lanes.ok) {
    workflowLanes = lanes.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "workflowLanes",
      lanes.issues,
    );
  }

  let mcpOverrides: z.infer<typeof mcpOverridesSchema> | undefined;
  const mcp = parseJsonColumn(
    "mcpOverrides",
    row.mcp_overrides,
    mcpOverridesSchema,
    "absent",
  );
  if (mcp.ok) {
    mcpOverrides = mcp.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "mcpOverrides",
      mcp.issues,
    );
  }

  let agentCapabilityOverrides:
    | z.infer<typeof agentCapabilityOverridesSchema>
    | undefined;
  const agentCaps = parseJsonColumn(
    "agentCapabilityOverrides",
    row.agent_capability_overrides,
    agentCapabilityOverridesSchema,
    "absent",
  );
  if (agentCaps.ok) {
    agentCapabilityOverrides = agentCaps.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "agentCapabilityOverrides",
      agentCaps.issues,
    );
  }

  const candidate: Record<string, unknown> = {
    sessionName: row.session_name,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    archived: row.archived === 1,
    finished: row.finished === 1,
    source: sourceResult.data,
    objective: row.objective,
    creationMode: creationModeResult.data,
    tddEnabled: row.tdd_enabled === 1,
    targetBranch: row.target_branch,
    parentSessionName: row.parent_session_name,
    graphWorkflowExecution,
    graphWorkflowExecutionHistory,
    conversations: [],
    referenceDocuments: [],
  };
  if (workflowEnvelopes !== undefined)
    candidate.workflowEnvelopes = workflowEnvelopes;
  if (workflowLanes !== undefined) candidate.workflowLanes = workflowLanes;
  if (mcpOverrides !== undefined) candidate.mcpOverrides = mcpOverrides;
  if (agentCapabilityOverrides !== undefined) {
    candidate.agentCapabilityOverrides = agentCapabilityOverrides;
  }

  const result = sessionStateSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(
      row.project_path,
      row.session_name,
      result.error.issues,
    );
  }
  return {
    projectPath: row.project_path,
    session: result.data,
    graphWorkflowExecutionMigration,
  };
}

function timed<T>(
  op: string,
  projectPath: string | undefined,
  sessionName: string | undefined,
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (projectPath !== undefined) payload.projectPath = projectPath;
    if (sessionName !== undefined) payload.sessionName = sessionName;
    logger.info(`state-store.sessions.${op}.timing`, payload);
  }
}

const SESSION_COLUMN_KEYS = Object.keys(sessionsTableRowSchema.shape) as Array<
  keyof SessionsTableRow
>;

function rawSessionRowsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of SESSION_COLUMN_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function createSessionsRepo(db: Db): SessionsRepo {
  type ParsedSessionRow = { projectPath: string; session: SessionState };
  const findAllCache = new Map<
    string,
    { rawRow: Record<string, unknown>; parsed: ParsedSessionRow }
  >();
  let cacheVersion = 0;
  let lastFindAllVersion = -1;
  let lastFindAllResult: ParsedSessionRow[] = [];
  const findByKeyStmt = db.prepare(
    `SELECT * FROM sessions
     WHERE project_path = ? AND session_name = ?
     LIMIT 1`,
  );
  const findByProjectStmt = db.prepare(
    `SELECT * FROM sessions
     WHERE project_path = ?
     ORDER BY created_at ASC, session_name ASC`,
  );
  const findListItemsByProjectStmt = db.prepare(
    `SELECT
       session_name, worktree_path, branch_name, target_branch,
       parent_session_name, created_at, last_activity_at,
       archived, finished, source, creation_mode, tdd_enabled, objective,
       CASE WHEN graph_workflow_execution IS NOT NULL
         AND json_extract(graph_workflow_execution, '$.status')
           NOT IN ('completed', 'failed', 'cancelled')
         THEN 1 ELSE 0 END AS has_active_graph_workflow,
       workflow_envelopes
     FROM sessions
     WHERE project_path = ?
     ORDER BY last_activity_at DESC`,
  );
  const findAllStmt = db.prepare(
    `SELECT * FROM sessions
     ORDER BY project_path ASC, created_at ASC, session_name ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at, archived, finished, source,
       objective, creation_mode, tdd_enabled, target_branch,
       parent_session_name, graph_workflow_execution,
       graph_workflow_execution_history, workflow_envelopes,
       workflow_lanes, mcp_overrides, agent_capability_overrides
     ) VALUES (
       @project_path, @session_name, @worktree_path, @branch_name,
       @created_at, @last_activity_at, @archived, @finished, @source,
       @objective, @creation_mode, @tdd_enabled, @target_branch,
       @parent_session_name, @graph_workflow_execution,
       @graph_workflow_execution_history, @workflow_envelopes,
       @workflow_lanes, @mcp_overrides, @agent_capability_overrides
     )
     ON CONFLICT(project_path, session_name) DO UPDATE SET
       worktree_path                    = excluded.worktree_path,
       branch_name                      = excluded.branch_name,
       created_at                       = excluded.created_at,
       last_activity_at                 = excluded.last_activity_at,
       archived                         = excluded.archived,
       finished                         = excluded.finished,
       source                           = excluded.source,
       objective                        = excluded.objective,
       creation_mode                    = excluded.creation_mode,
       tdd_enabled                      = excluded.tdd_enabled,
       target_branch                    = excluded.target_branch,
       parent_session_name              = excluded.parent_session_name,
       graph_workflow_execution         = excluded.graph_workflow_execution,
       graph_workflow_execution_history = excluded.graph_workflow_execution_history,
       workflow_envelopes               = excluded.workflow_envelopes,
       workflow_lanes                   = excluded.workflow_lanes,
       mcp_overrides                    = excluded.mcp_overrides,
       agent_capability_overrides       = excluded.agent_capability_overrides`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM sessions WHERE project_path = ? AND session_name = ?`,
  );
  const updateGraphWorkflowExecutionStmt = db.prepare(
    `UPDATE sessions SET graph_workflow_execution = ?
     WHERE project_path = ? AND session_name = ?`,
  );

  function applyGraphWorkflowExecutionMigration(
    projectPath: string,
    sessionName: string,
    migration: GraphWorkflowExecutionMigration,
  ): void {
    updateGraphWorkflowExecutionStmt.run(
      migration.upgradedJson,
      projectPath,
      sessionName,
    );
    parallelLogger.info("graph-workflow.parallel.legacy_migrated", {
      projectPath,
      sessionName,
      executionId: migration.executionId,
      repairedFields: migration.repairedFields,
    });
  }

  return {
    findByKey(projectPath, sessionName) {
      return timed("findByKey", projectPath, sessionName, () => {
        const row: unknown = findByKeyStmt.get(projectPath, sessionName);
        if (row === undefined) return null;
        const result = rowToDomain(row);
        if (result.graphWorkflowExecutionMigration !== null) {
          applyGraphWorkflowExecutionMigration(
            result.projectPath,
            result.session.sessionName,
            result.graphWorkflowExecutionMigration,
          );
        }
        return result.session;
      });
    },
    findByProject(projectPath) {
      return timed("findByProject", projectPath, undefined, () => {
        const rows = findByProjectStmt.all(projectPath) as unknown[];
        return rows.map((row) => {
          const result = rowToDomain(row);
          if (result.graphWorkflowExecutionMigration !== null) {
            applyGraphWorkflowExecutionMigration(
              result.projectPath,
              result.session.sessionName,
              result.graphWorkflowExecutionMigration,
            );
          }
          return result.session;
        });
      });
    },
    findListItemsByProject(projectPath) {
      return timed("findListItemsByProject", projectPath, undefined, () => {
        return findListItemsByProjectStmt.all(
          projectPath,
        ) as SessionListItemRow[];
      });
    },
    findAll() {
      return timed("findAll", undefined, undefined, () => {
        if (cacheVersion === lastFindAllVersion) {
          return lastFindAllResult;
        }
        const rows = findAllStmt.all() as Array<Record<string, unknown>>;
        const out: ParsedSessionRow[] = new Array(rows.length);
        const seenKeys = new Set<string>();
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]!;
          const key = `${row.project_path as string}\u0000${row.session_name as string}`;
          seenKeys.add(key);
          const cached = findAllCache.get(key);
          if (cached !== undefined && rawSessionRowsEqual(cached.rawRow, row)) {
            out[i] = cached.parsed;
            continue;
          }
          const result = rowToDomain(row);
          if (result.graphWorkflowExecutionMigration !== null) {
            applyGraphWorkflowExecutionMigration(
              result.projectPath,
              result.session.sessionName,
              result.graphWorkflowExecutionMigration,
            );
          }
          const parsed: ParsedSessionRow = {
            projectPath: result.projectPath,
            session: result.session,
          };
          findAllCache.set(key, { rawRow: row, parsed });
          out[i] = parsed;
        }
        if (findAllCache.size > seenKeys.size) {
          for (const key of findAllCache.keys()) {
            if (!seenKeys.has(key)) findAllCache.delete(key);
          }
        }
        lastFindAllVersion = cacheVersion;
        lastFindAllResult = out;
        return out;
      });
    },
    upsert(projectPath, session) {
      timed("upsert", projectPath, session.sessionName, () => {
        const bind = domainToSessionRow(projectPath, session);
        upsertStmt.run(bind);
        cacheVersion += 1;
      });
    },
    delete(projectPath, sessionName) {
      timed("delete", projectPath, sessionName, () => {
        deleteStmt.run(projectPath, sessionName);
        cacheVersion += 1;
      });
    },
  };
}
