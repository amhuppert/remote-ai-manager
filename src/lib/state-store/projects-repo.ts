import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { mcpOverridesSchema, type McpOverrides } from "@/lib/mcp/schemas";
import {
  agentCapabilityOverridesSchema,
  type AgentCapabilityOverrides,
} from "@/lib/agent-capabilities/schemas";
import { projectRowSchema } from "@/lib/projects/schemas";
import { PersistenceError, getErrorMessage } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import type { ProjectRow } from "@/lib/projects/schemas";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.projects");

export interface ProjectInput {
  rootPath: string;
  mcpOverrides?: McpOverrides;
  agentCapabilityOverrides?: AgentCapabilityOverrides;
}

export interface ProjectsRepo {
  findByRootPath(rootPath: string): ProjectRow | null;
  listRootPaths(): string[];
  listAll(): ProjectRow[];
  listArchived(): ProjectRow[];
  listPinned(): ProjectRow[];
  upsert(project: ProjectInput): void;
  /**
   * Focused single-column write of `mcp_overrides` (JSON, or NULL to clear).
   * Preserves every sibling column (`agent_capability_overrides`,
   * `archived`/`pinned`/`pin_order`) — the row is UPDATEd in place, never
   * re-upserted from a full domain object, so an override edit never disturbs
   * unrelated project state.
   */
  setMcpOverrides(rootPath: string, value: McpOverrides | undefined): void;
  /**
   * Focused single-column write of `agent_capability_overrides` (JSON, or NULL
   * to clear). Preserves every sibling column, mirroring `setMcpOverrides`.
   */
  setAgentCapabilityOverrides(
    rootPath: string,
    value: AgentCapabilityOverrides | undefined,
  ): void;
  setArchived(rootPath: string, value: boolean): void;
  setPinned(rootPath: string, value: boolean): void;
  reorderPinned(orderedRootPaths: string[]): void;
  delete(rootPath: string): void;
}

/**
 * Raw column shape returned by `SELECT * FROM projects`. Validated through
 * `projectsTableRowSchema` at the persistence boundary so that any corrupt
 * value (e.g. `archived = 2`, non-integer `pin_order`) trips Zod
 * `safeParse` failure rather than being silently coerced.
 */
const projectsTableRowSchema = registerTrustedSchema(
  z.object({
    root_path: z.string(),
    archived: z.union([z.literal(0), z.literal(1)]),
    pinned: z.union([z.literal(0), z.literal(1)]),
    pin_order: z.number().int().nullable(),
    mcp_overrides: z.string().nullable(),
    agent_capability_overrides: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  "projectsTableRowSchema",
);
type ProjectsTableRow = z.infer<typeof projectsTableRowSchema>;

interface SqlBindRow {
  root_path: string;
  archived: number;
  pinned: number;
  pin_order: number | null;
  mcp_overrides: string | null;
  agent_capability_overrides: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * Encode a validated ProjectRow as the column-name → SQLite-primitive bind
 * record used by both `domainToRow` and `canonicalRow`. JSON column values are
 * serialized with sorted-key recursion so that two domain values that are
 * deep-equal post-Zod-parse always produce identical bytes.
 */
function projectRowToSqlBind(row: ProjectRow): SqlBindRow {
  return {
    root_path: row.rootPath,
    archived: row.archived ? 1 : 0,
    pinned: row.pinned ? 1 : 0,
    pin_order: row.pinOrder,
    mcp_overrides:
      row.mcpOverrides === undefined ? null : stableStringify(row.mcpOverrides),
    agent_capability_overrides:
      row.agentCapabilityOverrides === undefined
        ? null
        : stableStringify(row.agentCapabilityOverrides),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function domainToProjectRow(row: ProjectRow): SqlBindRow {
  const validated = projectRowSchema.parse(row);
  return projectRowToSqlBind(validated);
}

export function canonicalProjectRow(row: ProjectRow): string {
  const bound = projectRowToSqlBind(projectRowSchema.parse(row));
  return stableStringify(bound);
}

function parseMcpOverridesColumn(
  rootPath: string,
  raw: string | null,
):
  | { ok: true; value: McpOverrides | undefined }
  | { ok: false; issues: unknown } {
  if (raw === null) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: ["mcpOverrides"],
          message: getErrorMessage(err),
          rootPath,
        },
      ],
    };
  }
  try {
    return { ok: true, value: parseTrusted(mcpOverridesSchema, parsed) };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function parseAgentCapabilityOverridesColumn(
  rootPath: string,
  raw: string | null,
):
  | { ok: true; value: AgentCapabilityOverrides | undefined }
  | { ok: false; issues: unknown } {
  if (raw === null) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: ["agentCapabilityOverrides"],
          message: getErrorMessage(err),
          rootPath,
        },
      ],
    };
  }
  try {
    return {
      ok: true,
      value: parseTrusted(agentCapabilityOverridesSchema, parsed),
    };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function logAndThrowValidationFailure(
  rootPath: string,
  issues: unknown,
): never {
  logger.error("state-store.projects.schema_validation_failure", {
    rootPath,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "project",
    identifier: rootPath,
    issues,
  });
}

function rowToDomain(rawRow: unknown): ProjectRow {
  const candidateRootPath =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { root_path?: unknown }).root_path === "string"
      ? (rawRow as { root_path: string }).root_path
      : "<unknown>";

  const row: ProjectsTableRow = parseTrusted(
    projectsTableRowSchema,
    rawRow,
    (issues) => logAndThrowValidationFailure(candidateRootPath, issues),
  );

  const mcpResult = parseMcpOverridesColumn(row.root_path, row.mcp_overrides);
  if (!mcpResult.ok) {
    return logAndThrowValidationFailure(row.root_path, mcpResult.issues);
  }

  const capResult = parseAgentCapabilityOverridesColumn(
    row.root_path,
    row.agent_capability_overrides,
  );
  if (!capResult.ok) {
    return logAndThrowValidationFailure(row.root_path, capResult.issues);
  }

  const candidate: Record<string, unknown> = {
    rootPath: row.root_path,
    archived: row.archived === 1,
    pinned: row.pinned === 1,
    pinOrder: row.pin_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (mcpResult.value !== undefined) candidate.mcpOverrides = mcpResult.value;
  if (capResult.value !== undefined) {
    candidate.agentCapabilityOverrides = capResult.value;
  }

  return parseTrusted(projectRowSchema, candidate, (issues) =>
    logAndThrowValidationFailure(row.root_path, issues),
  );
}

function timed<T>(op: string, rootPath: string | undefined, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (rootPath !== undefined) payload.rootPath = rootPath;
    logger.info(`state-store.projects.${op}.timing`, payload);
  }
}

export function createProjectsRepo(db: Db): ProjectsRepo {
  const findStmt = db.prepare(
    "SELECT * FROM projects WHERE root_path = ? LIMIT 1",
  );
  const listAllStmt = db.prepare("SELECT * FROM projects ORDER BY created_at");
  const listRootPathsStmt = db.prepare(
    "SELECT root_path FROM projects ORDER BY created_at",
  );
  const listArchivedStmt = db.prepare(
    "SELECT * FROM projects WHERE archived = 1 ORDER BY created_at",
  );
  const listPinnedStmt = db.prepare(
    `SELECT * FROM projects
     WHERE pinned = 1
     ORDER BY (pin_order IS NULL), pin_order ASC, created_at ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO projects (root_path, mcp_overrides, agent_capability_overrides)
     VALUES (@root_path, @mcp_overrides, @agent_capability_overrides)
     ON CONFLICT(root_path) DO UPDATE SET
       mcp_overrides              = excluded.mcp_overrides,
       agent_capability_overrides = excluded.agent_capability_overrides,
       updated_at                 = datetime('now')`,
  );
  const setMcpOverridesStmt = db.prepare(
    `UPDATE projects
     SET mcp_overrides = ?, updated_at = datetime('now')
     WHERE root_path = ?`,
  );
  const setAgentCapabilityOverridesStmt = db.prepare(
    `UPDATE projects
     SET agent_capability_overrides = ?, updated_at = datetime('now')
     WHERE root_path = ?`,
  );
  const setArchivedStmt = db.prepare(
    `UPDATE projects
     SET archived = ?, updated_at = datetime('now')
     WHERE root_path = ?`,
  );
  const setPinnedStmt = db.prepare(
    `UPDATE projects
     SET pinned = ?, pin_order = NULL, updated_at = datetime('now')
     WHERE root_path = ?`,
  );
  const setPinOrderStmt = db.prepare(
    `UPDATE projects
     SET pin_order = ?, updated_at = datetime('now')
     WHERE root_path = ?`,
  );
  const deleteStmt = db.prepare("DELETE FROM projects WHERE root_path = ?");

  const reorderPinnedTxn = db.transaction((orderedRootPaths: string[]) => {
    for (let i = 0; i < orderedRootPaths.length; i++) {
      setPinOrderStmt.run(i, orderedRootPaths[i]);
    }
  });

  return {
    findByRootPath(rootPath) {
      return timed("findByRootPath", rootPath, () => {
        const row: unknown = findStmt.get(rootPath);
        if (row === undefined) return null;
        return rowToDomain(row);
      });
    },
    listRootPaths() {
      return timed("listRootPaths", undefined, () => {
        const rows = listRootPathsStmt.all() as Array<{ root_path: string }>;
        return rows.map((row) => row.root_path);
      });
    },
    listAll() {
      return timed("listAll", undefined, () => {
        const rows = listAllStmt.all() as unknown[];
        return rows.map(rowToDomain);
      });
    },
    listArchived() {
      return timed("listArchived", undefined, () => {
        const rows = listArchivedStmt.all() as unknown[];
        return rows.map(rowToDomain);
      });
    },
    listPinned() {
      return timed("listPinned", undefined, () => {
        const rows = listPinnedStmt.all() as unknown[];
        return rows.map(rowToDomain);
      });
    },
    upsert(project) {
      timed("upsert", project.rootPath, () => {
        const mcpJson =
          project.mcpOverrides === undefined
            ? null
            : stableStringify(mcpOverridesSchema.parse(project.mcpOverrides));
        const capJson =
          project.agentCapabilityOverrides === undefined
            ? null
            : stableStringify(
                agentCapabilityOverridesSchema.parse(
                  project.agentCapabilityOverrides,
                ),
              );
        upsertStmt.run({
          root_path: project.rootPath,
          mcp_overrides: mcpJson,
          agent_capability_overrides: capJson,
        });
      });
    },
    setMcpOverrides(rootPath, value) {
      timed("setMcpOverrides", rootPath, () => {
        const json =
          value === undefined
            ? null
            : stableStringify(mcpOverridesSchema.parse(value));
        setMcpOverridesStmt.run(json, rootPath);
      });
    },
    setAgentCapabilityOverrides(rootPath, value) {
      timed("setAgentCapabilityOverrides", rootPath, () => {
        const json =
          value === undefined
            ? null
            : stableStringify(agentCapabilityOverridesSchema.parse(value));
        setAgentCapabilityOverridesStmt.run(json, rootPath);
      });
    },
    setArchived(rootPath, value) {
      timed("setArchived", rootPath, () => {
        setArchivedStmt.run(value ? 1 : 0, rootPath);
      });
    },
    setPinned(rootPath, value) {
      timed("setPinned", rootPath, () => {
        setPinnedStmt.run(value ? 1 : 0, rootPath);
      });
    },
    reorderPinned(orderedRootPaths) {
      timed("reorderPinned", undefined, () => {
        reorderPinnedTxn(orderedRootPaths);
      });
    },
    delete(rootPath) {
      timed("delete", rootPath, () => {
        deleteStmt.run(rootPath);
      });
    },
  };
}
