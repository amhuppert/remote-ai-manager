import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { referenceDocumentSchema } from "../schemas";
import { PersistenceError } from "../errors";
import type { ReferenceDocument } from "@/types";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.reference-documents");

export interface ReferenceDocumentsRepo {
  findBySession(projectPath: string, sessionName: string): ReferenceDocument[];
  findById(id: string): ReferenceDocument | null;
  findAll(): {
    projectPath: string;
    sessionName: string;
    doc: ReferenceDocument;
  }[];
  upsert(
    projectPath: string,
    sessionName: string,
    doc: ReferenceDocument,
  ): void;
  delete(id: string): void;
}

const referenceDocumentsTableRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  session_name: z.string(),
  file_path: z.string(),
  description: z.string(),
  created_at: z.string(),
});
type ReferenceDocumentsTableRow = z.infer<
  typeof referenceDocumentsTableRowSchema
>;

interface SqlBindRow {
  id: string;
  project_path: string;
  session_name: string;
  file_path: string;
  description: string;
  created_at: string;
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

function referenceDocumentToSqlBind(
  projectPath: string,
  sessionName: string,
  doc: ReferenceDocument,
): SqlBindRow {
  return {
    id: doc.id,
    project_path: projectPath,
    session_name: sessionName,
    file_path: doc.filePath,
    description: doc.description,
    created_at: doc.createdAt,
  };
}

function domainToReferenceDocumentRow(
  projectPath: string,
  sessionName: string,
  doc: ReferenceDocument,
): SqlBindRow {
  const validated = referenceDocumentSchema.parse(doc);
  return referenceDocumentToSqlBind(projectPath, sessionName, validated);
}

export function canonicalReferenceDocumentRow(
  projectPath: string,
  sessionName: string,
  doc: ReferenceDocument,
): string {
  const validated = referenceDocumentSchema.parse(doc);
  return stableStringify(
    referenceDocumentToSqlBind(projectPath, sessionName, validated),
  );
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.reference-documents.schema_validation_failure", {
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "reference_document",
    identifier,
    issues,
  });
}

function rowToDomain(rawRow: unknown): {
  projectPath: string;
  sessionName: string;
  doc: ReferenceDocument;
} {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const rowResult = referenceDocumentsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowValidationFailure(fallbackId, rowResult.error.issues);
  }
  const row: ReferenceDocumentsTableRow = rowResult.data;

  const candidate = {
    id: row.id,
    filePath: row.file_path,
    description: row.description,
    createdAt: row.created_at,
  };

  const result = referenceDocumentSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(row.id, result.error.issues);
  }
  return {
    projectPath: row.project_path,
    sessionName: row.session_name,
    doc: result.data,
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
    if (identifier.id !== undefined) payload.id = identifier.id;
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    if (identifier.sessionName !== undefined) {
      payload.sessionName = identifier.sessionName;
    }
    logger.info(`state-store.reference-documents.${op}.timing`, payload);
  }
}

export function createReferenceDocumentsRepo(db: Db): ReferenceDocumentsRepo {
  const findBySessionStmt = db.prepare(
    `SELECT * FROM reference_documents
     WHERE project_path = ? AND session_name = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findByIdStmt = db.prepare(
    `SELECT * FROM reference_documents WHERE id = ? LIMIT 1`,
  );
  const findAllStmt = db.prepare(
    `SELECT * FROM reference_documents
     ORDER BY project_path ASC, session_name ASC, created_at ASC, id ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO reference_documents (
       id, project_path, session_name, file_path, description, created_at
     ) VALUES (
       @id, @project_path, @session_name, @file_path, @description, @created_at
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path = excluded.project_path,
       session_name = excluded.session_name,
       file_path    = excluded.file_path,
       description  = excluded.description,
       created_at   = excluded.created_at
     ON CONFLICT(project_path, session_name, file_path) DO UPDATE SET
       id           = excluded.id,
       description  = excluded.description,
       created_at   = excluded.created_at`,
  );
  const deleteStmt = db.prepare(`DELETE FROM reference_documents WHERE id = ?`);

  return {
    findBySession(projectPath, sessionName) {
      return timed("findBySession", { projectPath, sessionName }, () => {
        const rows = findBySessionStmt.all(
          projectPath,
          sessionName,
        ) as unknown[];
        return rows.map((row) => rowToDomain(row).doc);
      });
    },
    findById(id) {
      return timed("findById", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToDomain(row).doc;
      });
    },
    findAll() {
      return timed("findAll", {}, () => {
        const rows = findAllStmt.all() as unknown[];
        return rows.map(rowToDomain);
      });
    },
    upsert(projectPath, sessionName, doc) {
      timed("upsert", { id: doc.id, projectPath, sessionName }, () => {
        const bind = domainToReferenceDocumentRow(
          projectPath,
          sessionName,
          doc,
        );
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
