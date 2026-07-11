import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  sessionMarkdownDocumentSchema,
  type SessionMarkdownDocument,
} from "@/lib/documents/schemas";
import {
  parseTrusted,
  registerTrustedSchema,
} from "@/lib/shared/parse-trusted";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.session-markdown-documents");

const rowSchema = registerTrustedSchema(
  z.object({
    doc_path: z.string(),
    origin: z.string(),
    first_seen_at: z.string(),
    last_seen_at: z.string(),
  }),
  "sessionMarkdownDocumentsTableRowSchema",
);

export interface SessionMarkdownDocumentsRepo {
  findBySession(
    projectPath: string,
    sessionName: string,
  ): SessionMarkdownDocument[];
  exists(projectPath: string, sessionName: string, docPath: string): boolean;
  upsertMany(
    projectPath: string,
    sessionName: string,
    documents: readonly SessionMarkdownDocument[],
  ): void;
}

function rowToDomain(row: unknown): SessionMarkdownDocument {
  const parsed = parseTrusted(rowSchema, row, (issues) => {
    logger.error(
      "state-store.session-markdown-documents.schema_validation_failure",
      {
        issues,
      },
    );
    throw new Error("Invalid session Markdown document row");
  });
  return sessionMarkdownDocumentSchema.parse({
    docPath: parsed.doc_path,
    origin: parsed.origin,
    firstSeenAt: parsed.first_seen_at,
    lastSeenAt: parsed.last_seen_at,
  });
}

export function createSessionMarkdownDocumentsRepo(
  db: Db,
): SessionMarkdownDocumentsRepo {
  const findBySessionStmt = db.prepare(
    `SELECT doc_path, origin, first_seen_at, last_seen_at
       FROM session_markdown_documents
      WHERE project_path = ? AND session_name = ?
      ORDER BY last_seen_at DESC, doc_path ASC`,
  );
  const existsStmt = db.prepare(
    `SELECT 1
       FROM session_markdown_documents
      WHERE project_path = ? AND session_name = ? AND doc_path = ?
      LIMIT 1`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO session_markdown_documents (
       project_path, session_name, doc_path, origin, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_path, session_name, doc_path) DO UPDATE SET
       origin = excluded.origin,
       last_seen_at = excluded.last_seen_at`,
  );
  const upsertTransaction = db.transaction(
    (
      projectPath: string,
      sessionName: string,
      documents: readonly SessionMarkdownDocument[],
    ) => {
      for (const document of documents) {
        const parsed = sessionMarkdownDocumentSchema.parse(document);
        upsertStmt.run(
          projectPath,
          sessionName,
          parsed.docPath,
          parsed.origin,
          parsed.firstSeenAt,
          parsed.lastSeenAt,
        );
      }
    },
  );

  return {
    findBySession(projectPath, sessionName) {
      const start = performance.now();
      try {
        return (
          findBySessionStmt.all(projectPath, sessionName) as unknown[]
        ).map(rowToDomain);
      } finally {
        logger.debug("state-store.session-markdown-documents.find.complete", {
          projectPath,
          sessionName,
          durationMs: +(performance.now() - start).toFixed(3),
        });
      }
    },
    exists(projectPath, sessionName, docPath) {
      return existsStmt.get(projectPath, sessionName, docPath) !== undefined;
    },
    upsertMany(projectPath, sessionName, documents) {
      if (documents.length === 0) return;
      const start = performance.now();
      try {
        upsertTransaction(projectPath, sessionName, documents);
      } finally {
        logger.debug("state-store.session-markdown-documents.upsert.complete", {
          projectPath,
          sessionName,
          documentCount: documents.length,
          durationMs: +(performance.now() - start).toFixed(3),
        });
      }
    },
  };
}
