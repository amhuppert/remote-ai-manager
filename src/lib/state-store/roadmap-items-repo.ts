import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  roadmapItemSchema,
  roadmapItemStatusSchema,
  roadmapItemTypeSchema,
} from "../schemas";
import { PersistenceError } from "../errors";
import type { RoadmapItem } from "@/types";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.roadmap-items");

export interface RoadmapItemsRepo {
  findByProject(projectPath: string): RoadmapItem[];
  findById(id: string): RoadmapItem | null;
  findAll(): { projectPath: string; item: RoadmapItem }[];
  upsert(projectPath: string, item: RoadmapItem, sortOrder?: number): void;
  delete(id: string): void;
}

const roadmapItemsTableRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  archived: z.union([z.literal(0), z.literal(1)]),
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
type RoadmapItemsTableRow = z.infer<typeof roadmapItemsTableRowSchema>;

interface SqlBindRow {
  id: string;
  project_path: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  archived: number;
  sort_order: number;
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

function roadmapItemToSqlBind(
  projectPath: string,
  item: RoadmapItem,
  sortOrder: number,
): SqlBindRow {
  return {
    id: item.id,
    project_path: projectPath,
    title: item.title,
    description: item.description,
    type: item.type,
    status: item.status,
    archived: item.archived ? 1 : 0,
    sort_order: sortOrder,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

export function domainToRoadmapItemRow(
  projectPath: string,
  item: RoadmapItem,
  sortOrder: number,
): SqlBindRow {
  const validated = roadmapItemSchema.parse(item);
  return roadmapItemToSqlBind(projectPath, validated, sortOrder);
}

export function canonicalRoadmapItemRow(
  projectPath: string,
  item: RoadmapItem,
  sortOrder: number,
): string {
  const validated = roadmapItemSchema.parse(item);
  return stableStringify(
    roadmapItemToSqlBind(projectPath, validated, sortOrder),
  );
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.roadmap-items.schema_validation_failure", {
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "roadmap_item",
    identifier,
    issues,
  });
}

function rowToDomain(rawRow: unknown): {
  projectPath: string;
  item: RoadmapItem;
} {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const rowResult = roadmapItemsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowValidationFailure(fallbackId, rowResult.error.issues);
  }
  const row: RoadmapItemsTableRow = rowResult.data;

  const typeResult = roadmapItemTypeSchema.safeParse(row.type);
  if (!typeResult.success) {
    return logAndThrowValidationFailure(row.id, typeResult.error.issues);
  }

  const statusResult = roadmapItemStatusSchema.safeParse(row.status);
  if (!statusResult.success) {
    return logAndThrowValidationFailure(row.id, statusResult.error.issues);
  }

  const candidate = {
    id: row.id,
    title: row.title,
    description: row.description,
    type: typeResult.data,
    status: statusResult.data,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  const result = roadmapItemSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(row.id, result.error.issues);
  }
  return { projectPath: row.project_path, item: result.data };
}

function timed<T>(
  op: string,
  identifier: { id?: string; projectPath?: string },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.id !== undefined) payload.id = identifier.id;
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    logger.info(`state-store.roadmap-items.${op}.timing`, payload);
  }
}

export function createRoadmapItemsRepo(db: Db): RoadmapItemsRepo {
  const findByProjectStmt = db.prepare(
    `SELECT * FROM roadmap_items
     WHERE project_path = ?
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  const findByIdStmt = db.prepare(
    `SELECT * FROM roadmap_items WHERE id = ? LIMIT 1`,
  );
  const findAllStmt = db.prepare(
    `SELECT * FROM roadmap_items
     ORDER BY project_path ASC, sort_order ASC, created_at ASC, id ASC`,
  );
  // Leaf table — INSERT OR REPLACE would also be safe, but ON CONFLICT(id) DO
  // UPDATE matches the codebase convention used in projects/sessions/conversations.
  const upsertStmt = db.prepare(
    `INSERT INTO roadmap_items (
       id, project_path, title, description, type, status, archived,
       sort_order, created_at, updated_at
     ) VALUES (
       @id, @project_path, @title, @description, @type, @status, @archived,
       @sort_order, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path = excluded.project_path,
       title        = excluded.title,
       description  = excluded.description,
       type         = excluded.type,
       status       = excluded.status,
       archived     = excluded.archived,
       sort_order   = excluded.sort_order,
       created_at   = excluded.created_at,
       updated_at   = excluded.updated_at`,
  );
  const deleteStmt = db.prepare(`DELETE FROM roadmap_items WHERE id = ?`);

  return {
    findByProject(projectPath) {
      return timed("findByProject", { projectPath }, () => {
        const rows = findByProjectStmt.all(projectPath) as unknown[];
        return rows.map((row) => rowToDomain(row).item);
      });
    },
    findById(id) {
      return timed("findById", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToDomain(row).item;
      });
    },
    findAll() {
      return timed("findAll", {}, () => {
        const rows = findAllStmt.all() as unknown[];
        return rows.map(rowToDomain);
      });
    },
    upsert(projectPath, item, sortOrder = 0) {
      timed("upsert", { id: item.id, projectPath }, () => {
        const bind = domainToRoadmapItemRow(projectPath, item, sortOrder);
        upsertStmt.run(bind);
      });
    },
    delete(id) {
      timed("delete", { id }, () => {
        deleteStmt.run(id);
      });
    },
  };
}
