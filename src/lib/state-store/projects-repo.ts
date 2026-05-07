import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  mcpOverridesSchema,
  projectRowSchema,
  type McpOverrides,
} from "../schemas";
import { PersistenceError, getErrorMessage } from "../errors";
import type { ProjectRow } from "@/types";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.projects");

export interface ProjectInput {
  rootPath: string;
  mcpOverrides?: McpOverrides;
}

export interface ProjectsRepo {
  findByRootPath(rootPath: string): ProjectRow | null;
  listAll(): ProjectRow[];
  listArchived(): ProjectRow[];
  listPinned(): ProjectRow[];
  upsert(project: ProjectInput): void;
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
const projectsTableRowSchema = z.object({
  root_path: z.string(),
  archived: z.union([z.literal(0), z.literal(1)]),
  pinned: z.union([z.literal(0), z.literal(1)]),
  pin_order: z.number().int().nullable(),
  mcp_overrides: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
type ProjectsTableRow = z.infer<typeof projectsTableRowSchema>;

interface SqlBindRow {
  root_path: string;
  archived: number;
  pinned: number;
  pin_order: number | null;
  mcp_overrides: string | null;
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
  const result = mcpOverridesSchema.safeParse(parsed);
  if (!result.success) return { ok: false, issues: result.error.issues };
  return { ok: true, value: result.data };
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

  const rowResult = projectsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowValidationFailure(
      candidateRootPath,
      rowResult.error.issues,
    );
  }
  const row: ProjectsTableRow = rowResult.data;

  const mcpResult = parseMcpOverridesColumn(row.root_path, row.mcp_overrides);
  if (!mcpResult.ok) {
    return logAndThrowValidationFailure(row.root_path, mcpResult.issues);
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

  const result = projectRowSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(row.root_path, result.error.issues);
  }
  return result.data;
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
  const listArchivedStmt = db.prepare(
    "SELECT * FROM projects WHERE archived = 1 ORDER BY created_at",
  );
  const listPinnedStmt = db.prepare(
    `SELECT * FROM projects
     WHERE pinned = 1
     ORDER BY (pin_order IS NULL), pin_order ASC, created_at ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO projects (root_path, mcp_overrides)
     VALUES (@root_path, @mcp_overrides)
     ON CONFLICT(root_path) DO UPDATE SET
       mcp_overrides = excluded.mcp_overrides,
       updated_at    = datetime('now')`,
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
        upsertStmt.run({
          root_path: project.rootPath,
          mcp_overrides: mcpJson,
        });
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
