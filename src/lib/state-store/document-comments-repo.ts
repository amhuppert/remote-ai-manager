import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  documentCommentSchema,
  type DocumentComment,
} from "@/lib/document-comments/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.document-comments");

export interface DocumentCommentsRepo {
  findByDocument(
    projectPath: string,
    sessionName: string,
    docPath: string,
  ): DocumentComment[];
  findBySession(projectPath: string, sessionName: string): DocumentComment[];
  /**
   * Scoped lookup: returns the comment ONLY when it belongs to
   * `(projectPath, sessionName)`. PATCH/DELETE handlers use this so a known id
   * cannot mutate or delete a comment in another project/session.
   */
  findByIdInScope(
    projectPath: string,
    sessionName: string,
    id: string,
  ): DocumentComment | null;
  upsert(comment: DocumentComment): void;
  delete(id: string): void;
}

const documentCommentTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    project_path: z.string(),
    session_name: z.string(),
    doc_path: z.string(),
    section_id: z.string(),
    heading_label: z.string(),
    line: z.number().int(),
    char_start: z.number().int(),
    char_end: z.number().int(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    doc_revision: z.string(),
    note: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    sent_at: z.string().nullable(),
  }),
  "documentCommentTableRowSchema",
);
type DocumentCommentTableRow = z.infer<typeof documentCommentTableRowSchema>;

interface SqlBindRow {
  id: string;
  project_path: string;
  session_name: string;
  doc_path: string;
  section_id: string;
  heading_label: string;
  line: number;
  char_start: number;
  char_end: number;
  quote: string;
  prefix: string;
  suffix: string;
  doc_revision: string;
  note: string;
  status: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

function documentCommentToSqlBind(comment: DocumentComment): SqlBindRow {
  return {
    id: comment.id,
    project_path: comment.projectPath,
    session_name: comment.sessionName,
    doc_path: comment.docPath,
    section_id: comment.anchor.sectionId,
    heading_label: comment.anchor.headingLabel,
    line: comment.anchor.line,
    char_start: comment.anchor.charStart,
    char_end: comment.anchor.charEnd,
    quote: comment.anchor.quote,
    prefix: comment.anchor.prefix,
    suffix: comment.anchor.suffix,
    doc_revision: comment.anchor.docRevision,
    note: comment.note,
    status: comment.status,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    sent_at: comment.sentAt,
  };
}

function domainToDocumentCommentRow(comment: DocumentComment): SqlBindRow {
  const validated = documentCommentSchema.parse(comment);
  return documentCommentToSqlBind(validated);
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.document-comments.schema_validation_failure", {
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "document_comment",
    identifier,
    issues,
  });
}

function rowToDomain(rawRow: unknown): DocumentComment {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const row: DocumentCommentTableRow = parseTrusted(
    documentCommentTableRowSchema,
    rawRow,
    (issues) => logAndThrowValidationFailure(fallbackId, issues),
  );

  const candidate = {
    id: row.id,
    projectPath: row.project_path,
    sessionName: row.session_name,
    docPath: row.doc_path,
    anchor: {
      sectionId: row.section_id,
      headingLabel: row.heading_label,
      line: row.line,
      charStart: row.char_start,
      charEnd: row.char_end,
      quote: row.quote,
      prefix: row.prefix,
      suffix: row.suffix,
      docRevision: row.doc_revision,
    },
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };

  return parseTrusted(documentCommentSchema, candidate, (issues) =>
    logAndThrowValidationFailure(row.id, issues),
  );
}

function timed<T>(
  op: string,
  identifier: {
    id?: string;
    projectPath?: string;
    sessionName?: string;
    docPath?: string;
  },
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
    if (identifier.docPath !== undefined) payload.docPath = identifier.docPath;
    logger.info(`state-store.document-comments.${op}.timing`, payload);
  }
}

export function createDocumentCommentsRepo(db: Db): DocumentCommentsRepo {
  const findByDocumentStmt = db.prepare(
    `SELECT * FROM document_comments
     WHERE project_path = ? AND session_name = ? AND doc_path = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findBySessionStmt = db.prepare(
    `SELECT * FROM document_comments
     WHERE project_path = ? AND session_name = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findByIdInScopeStmt = db.prepare(
    `SELECT * FROM document_comments
     WHERE id = ? AND project_path = ? AND session_name = ?
     LIMIT 1`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO document_comments (
       id, project_path, session_name, doc_path,
       section_id, heading_label, line, char_start, char_end,
       quote, prefix, suffix, doc_revision,
       note, status, created_at, updated_at, sent_at
     ) VALUES (
       @id, @project_path, @session_name, @doc_path,
       @section_id, @heading_label, @line, @char_start, @char_end,
       @quote, @prefix, @suffix, @doc_revision,
       @note, @status, @created_at, @updated_at, @sent_at
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path  = excluded.project_path,
       session_name  = excluded.session_name,
       doc_path      = excluded.doc_path,
       section_id    = excluded.section_id,
       heading_label = excluded.heading_label,
       line          = excluded.line,
       char_start    = excluded.char_start,
       char_end      = excluded.char_end,
       quote         = excluded.quote,
       prefix        = excluded.prefix,
       suffix        = excluded.suffix,
       doc_revision  = excluded.doc_revision,
       note          = excluded.note,
       status        = excluded.status,
       created_at    = excluded.created_at,
       updated_at    = excluded.updated_at,
       sent_at       = excluded.sent_at`,
  );
  const deleteStmt = db.prepare(`DELETE FROM document_comments WHERE id = ?`);

  return {
    findByDocument(projectPath, sessionName, docPath) {
      return timed(
        "findByDocument",
        { projectPath, sessionName, docPath },
        () => {
          const rows = findByDocumentStmt.all(
            projectPath,
            sessionName,
            docPath,
          ) as unknown[];
          return rows.map(rowToDomain);
        },
      );
    },
    findBySession(projectPath, sessionName) {
      return timed("findBySession", { projectPath, sessionName }, () => {
        const rows = findBySessionStmt.all(
          projectPath,
          sessionName,
        ) as unknown[];
        return rows.map(rowToDomain);
      });
    },
    findByIdInScope(projectPath, sessionName, id) {
      return timed("findByIdInScope", { id, projectPath, sessionName }, () => {
        const row: unknown = findByIdInScopeStmt.get(
          id,
          projectPath,
          sessionName,
        );
        if (row === undefined) return null;
        return rowToDomain(row);
      });
    },
    upsert(comment) {
      timed(
        "upsert",
        {
          id: comment.id,
          projectPath: comment.projectPath,
          sessionName: comment.sessionName,
          docPath: comment.docPath,
        },
        () => {
          upsertStmt.run(domainToDocumentCommentRow(comment));
        },
      );
    },
    delete(id) {
      timed("delete", { id }, () => {
        deleteStmt.run(id);
      });
    },
  };
}
