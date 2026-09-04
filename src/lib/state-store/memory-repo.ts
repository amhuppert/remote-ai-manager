import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_MAX_ALIASES,
  memoryArtifactRefSchema,
  memoryAuthorKindSchema,
  memoryBodyByteLength,
  memoryIndexModeSchema,
  memoryKindSchema,
  memoryLifecycleSchema,
  memoryLinkKindSchema,
  memoryLinkSchema,
  memoryNoteRevisionSchema,
  memoryNoteSchema,
  memoryScopeSchema,
  memoryStatusNoteSchema,
  memoryVisibilitySchema,
  type MemoryArtifactRef,
  type MemoryLink,
  type MemoryNote,
  type MemoryNoteRevision,
  type MemoryRevisionOrigin,
  type MemoryVisibility,
} from "@/lib/memory/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import { checkRowColumnSize } from "./row-size-telemetry";
import { stableStringify } from "./serialization";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.memory");

/**
 * Delivery candidates number in the tens, but the IN list is chunked anyway so
 * a large recall never trips SQLite's bound-variable ceiling.
 */
const LINK_QUERY_CHUNK = 500;

// ============================================================
// Repo-level write inputs
// ============================================================

/**
 * Creation persists the head note and its first revision snapshot together, so
 * the caller supplies both ids. `revision` is not an input: the repo owns the
 * counter, which is what makes it a trustworthy compare-and-swap token.
 *
 * `supersedes` carries the predecessor AND the revision id minted for the
 * archive snapshot that predecessor gains, because superseding is one
 * transaction that writes history on both notes.
 */
export const createMemoryNoteInputSchema = z.object({
  id: z.string().min(1),
  revisionId: z.string().min(1),
  slug: z.string().min(1),
  scope: memoryScopeSchema,
  projectPath: z.string().min(1).nullable(),
  sessionName: z.string().min(1).nullable(),
  sessionCreatedAt: z.string().min(1).nullable(),
  kind: memoryKindSchema,
  hook: z.string().min(1),
  body: z.string(),
  statusNote: memoryStatusNoteSchema.nullable(),
  aliases: z.array(z.string().min(1)).max(MEMORY_MAX_ALIASES),
  indexMode: memoryIndexModeSchema,
  lifecycle: memoryLifecycleSchema,
  reviewAfter: z.string().min(1).nullable(),
  expiresAt: z.string().min(1).nullable(),
  createdBy: memoryAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  supersedes: z
    .object({
      memoryId: z.string().min(1),
      archiveRevisionId: z.string().min(1),
      /**
       * Compare-and-swap on the note being RETIRED. Supersession archives the
       * predecessor and copies its content forward, so a caller that read
       * revision N states N here: the check has to happen inside this
       * transaction, because a pre-read comparison would let an edit land
       * between the read and the archive and be silently dropped from the
       * successor. Null is the write that competes with no author.
       */
      baseRevision: z.number().int().positive().nullable(),
    })
    .nullable(),
  /**
   * Handles that must be free among the scope owner's ACTIVE notes for this
   * write to land, checked inside the transaction. Promotion needs it: the
   * spec refuses a promotion colliding with an active project slug OR alias by
   * naming the holder (R10), and a service-level precheck cannot promise that
   * — another writer can claim the handle between the check and this insert,
   * leaving the predecessor archived behind a shadowed successor. Empty for
   * ordinary creates, whose alias semantics are unchanged.
   */
  requireFreeHandles: z.array(z.string().min(1)).optional(),
  createdAt: z.string().min(1),
});
export type CreateMemoryNoteInput = z.infer<typeof createMemoryNoteInputSchema>;

/**
 * The mutable half of a note. Scope, kind, and identity are absent on purpose:
 * a note changes scope by being SUPERSEDED by one at the new scope (the
 * session-end promotion path), never by mutation, which keeps every scope rule
 * a create-time decision and every link and watermark pointing at a record
 * whose meaning did not move under it.
 */
export const memoryNotePatchSchema = z.object({
  slug: z.string().min(1).optional(),
  hook: z.string().min(1).optional(),
  body: z.string().optional(),
  statusNote: memoryStatusNoteSchema.nullable().optional(),
  aliases: z.array(z.string().min(1)).max(MEMORY_MAX_ALIASES).optional(),
  indexMode: memoryIndexModeSchema.optional(),
  lifecycle: memoryLifecycleSchema.optional(),
  reviewAfter: z.string().min(1).nullable().optional(),
  expiresAt: z.string().min(1).nullable().optional(),
});
export type MemoryNotePatch = z.infer<typeof memoryNotePatchSchema>;

/**
 * `baseRevision` is the caller's compare-and-swap token. `null` states that
 * this write is not competing with an author — a server-initiated archive at
 * session end — and is the only way past the check; an agent or human edit
 * always states the revision it read.
 */
export const updateMemoryNoteInputSchema = z.object({
  memoryId: z.string().min(1),
  revisionId: z.string().min(1),
  baseRevision: z.number().int().positive().nullable(),
  patch: memoryNotePatchSchema,
  authorKind: memoryAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  writtenAt: z.string().min(1),
});
export type UpdateMemoryNoteInput = z.infer<typeof updateMemoryNoteInputSchema>;

export const archiveMemoryNoteInputSchema = z.object({
  memoryId: z.string().min(1),
  revisionId: z.string().min(1),
  baseRevision: z.number().int().positive().nullable(),
  authorKind: memoryAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  writtenAt: z.string().min(1),
});
export type ArchiveMemoryNoteInput = z.infer<
  typeof archiveMemoryNoteInputSchema
>;

export const restoreMemoryNoteInputSchema = archiveMemoryNoteInputSchema.extend(
  {
    /** The historical revision whose snapshot is copied forward as a new head. */
    restoreFromRevision: z.number().int().positive(),
  },
);
export type RestoreMemoryNoteInput = z.infer<
  typeof restoreMemoryNoteInputSchema
>;

export const memoryNoteListQuerySchema = z.object({
  visibility: memoryVisibilitySchema,
  /** Narrow the visible union to one scope; omitted reads the whole union. */
  scope: memoryScopeSchema.optional(),
  /**
   * Archived records are out of every default read: a superseded predecessor
   * stays fetchable by id and by an explicit archived listing, and never
   * competes with its successor for a bare slug (R4).
   */
  includeArchived: z.boolean(),
});
export type MemoryNoteListQuery = z.infer<typeof memoryNoteListQuerySchema>;

export const addMemoryLinkInputSchema = z.object({
  id: z.string().min(1),
  memoryId: z.string().min(1),
  kind: memoryLinkKindSchema,
  artifact: memoryArtifactRefSchema,
  createdAt: z.string().min(1),
});
export type AddMemoryLinkInput = z.infer<typeof addMemoryLinkInputSchema>;

// ============================================================
// Results
// ============================================================

/**
 * A size refusal names the limit and what was offered, so the caller can render
 * the spec's structured refusal without re-deriving either number.
 */
export interface MemoryBodyTooLarge {
  readonly status: "body_too_large";
  readonly limitBytes: number;
  readonly actualBytes: number;
}

export type CreateMemoryNoteResult =
  | { status: "created"; note: MemoryNote }
  | { status: "slug_taken"; slug: string }
  | { status: "supersedes_missing"; memoryId: string }
  | { status: "supersedes_stale"; currentRevision: number }
  | MemoryBodyTooLarge;

export type WriteMemoryNoteResult =
  | { status: "written"; note: MemoryNote; revision: MemoryNoteRevision }
  | { status: "stale"; currentRevision: number }
  | { status: "slug_taken"; slug: string }
  | { status: "missing" }
  | MemoryBodyTooLarge;

export type RestoreMemoryNoteResult =
  | WriteMemoryNoteResult
  | { status: "revision_missing"; revision: number };

export type AddMemoryLinkResult =
  | { status: "linked"; link: MemoryLink }
  | { status: "missing" };

/**
 * One lexical hit. `score` is FTS5's raw bm25 value, which is negative and
 * ORDERS ASCENDING (more negative is a better match); it is surfaced rather
 * than normalized so the recall path can compose it with its own signals.
 */
export interface MemorySearchHit {
  readonly note: MemoryNote;
  readonly score: number;
}

export interface MemoryRepo {
  create(input: CreateMemoryNoteInput): Promise<CreateMemoryNoteResult>;
  find(memoryId: string): Promise<MemoryNote | null>;
  /**
   * Every note in the visible scope union whose slug OR alias matches — the
   * repository primitive under bare-handle resolution, which must see all
   * candidates to disambiguate rather than silently pick one (R4.2).
   */
  findByHandle(
    handle: string,
    query: MemoryNoteListQuery,
  ): Promise<MemoryNote[]>;
  list(query: MemoryNoteListQuery): Promise<MemoryNote[]>;
  update(input: UpdateMemoryNoteInput): Promise<WriteMemoryNoteResult>;
  archive(input: ArchiveMemoryNoteInput): Promise<WriteMemoryNoteResult>;
  restore(input: RestoreMemoryNoteInput): Promise<RestoreMemoryNoteResult>;
  delete(memoryId: string): Promise<MemoryNote | null>;
  listRevisions(
    memoryId: string,
    limit?: number,
  ): Promise<MemoryNoteRevision[]>;
  findRevision(
    memoryId: string,
    revision: number,
  ): Promise<MemoryNoteRevision | null>;
  /**
   * Lexical search over the derived FTS5 index, restricted to the caller's
   * visible scope union and ordered best-first. Ranking beyond the lexical
   * score is the recall path's business (D5); this is the index primitive.
   */
  search(
    query: string,
    listQuery: MemoryNoteListQuery,
  ): Promise<MemorySearchHit[]>;
  /**
   * Drop and repopulate the whole search index from the canonical tables,
   * returning how many notes were indexed. The index is derived state, so this
   * is always safe and always sufficient to recover it.
   */
  rebuildSearchIndex(): Promise<number>;
  /**
   * Every scope owner's notes at once: the review-queue scan (R8, D6), which
   * evaluates every note's lease and expiry. Never a delivery read — delivery
   * goes through `list` with a visibility.
   */
  listAllScopes(query: { includeArchived: boolean }): Promise<MemoryNote[]>;
  addLink(input: AddMemoryLinkInput): Promise<AddMemoryLinkResult>;
  listLinks(memoryId: string): Promise<MemoryLink[]>;
  /** These notes' links only: the about-cue read on a delivery build (D6). */
  listLinksForNotes(memoryIds: readonly string[]): Promise<MemoryLink[]>;
  listLinksForArtifact(artifact: MemoryArtifactRef): Promise<MemoryLink[]>;
  removeLink(linkId: string): Promise<MemoryLink | null>;
}

// ============================================================
// Row schemas and mappers
// ============================================================

const memoryNotesTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    slug: z.string(),
    scope: z.string(),
    project_path: z.string().nullable(),
    session_name: z.string().nullable(),
    session_created_at: z.string().nullable(),
    kind: z.string(),
    hook: z.string(),
    body: z.string(),
    status_note_text: z.string().nullable(),
    status_note_updated_at: z.string().nullable(),
    status_note_review_after: z.string().nullable(),
    index_mode: z.string(),
    lifecycle: z.string(),
    review_after: z.string().nullable(),
    expires_at: z.string().nullable(),
    supersedes_id: z.string().nullable(),
    superseded_by_id: z.string().nullable(),
    created_by: z.string(),
    author_conversation_id: z.string().nullable(),
    revision: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  "memoryNotesTableRowSchema",
);

const memoryNoteRevisionsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    memory_id: z.string(),
    revision: z.number().int(),
    snapshot_json: z.string(),
    origin: z.string(),
    base_revision: z.number().int().nullable(),
    restored_from_revision: z.number().int().nullable(),
    author_kind: z.string(),
    author_conversation_id: z.string().nullable(),
    created_at: z.string(),
  }),
  "memoryNoteRevisionsTableRowSchema",
);

const memoryLinksTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    memory_id: z.string(),
    kind: z.string(),
    artifact_kind: z.string(),
    artifact_id: z.string().nullable(),
    artifact_context_id: z.string().nullable(),
    artifact_project_path: z.string().nullable(),
    artifact_session_name: z.string().nullable(),
    artifact_session_created_at: z.string().nullable(),
    created_at: z.string(),
  }),
  "memoryLinksTableRowSchema",
);

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.memory.schema_validation_failure", {
    entity,
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity,
    identifier,
    issues,
  });
}

function rowToNote(rawRow: unknown, aliases: readonly string[]): MemoryNote {
  const row = parseTrusted(memoryNotesTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("memory_note", "<row>", issues),
  );
  return parseTrusted(
    memoryNoteSchema,
    {
      id: row.id,
      slug: row.slug,
      scope: row.scope,
      projectPath: row.project_path,
      sessionName: row.session_name,
      sessionCreatedAt: row.session_created_at,
      kind: row.kind,
      hook: row.hook,
      body: row.body,
      statusNote:
        row.status_note_text === null
          ? null
          : {
              text: row.status_note_text,
              updatedAt: row.status_note_updated_at,
              reviewAfter: row.status_note_review_after,
            },
      aliases: [...aliases],
      indexMode: row.index_mode,
      lifecycle: row.lifecycle,
      reviewAfter: row.review_after,
      expiresAt: row.expires_at,
      supersedesId: row.supersedes_id,
      supersededById: row.superseded_by_id,
      createdBy: row.created_by,
      authorConversationId: row.author_conversation_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    (issues) => logAndThrowValidationFailure("memory_note", row.id, issues),
  );
}

function rowToRevision(rawRow: unknown): MemoryNoteRevision {
  const row = parseTrusted(
    memoryNoteRevisionsTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure("memory_note_revision", "<row>", issues),
  );
  const snapshot: unknown = JSON.parse(row.snapshot_json);
  return parseTrusted(
    memoryNoteRevisionSchema,
    {
      id: row.id,
      memoryId: row.memory_id,
      revision: row.revision,
      snapshot,
      origin: row.origin,
      baseRevision: row.base_revision,
      restoredFromRevision: row.restored_from_revision,
      authorKind: row.author_kind,
      authorConversationId: row.author_conversation_id,
      createdAt: row.created_at,
    },
    (issues) =>
      logAndThrowValidationFailure("memory_note_revision", row.id, issues),
  );
}

/** The artifact identity columns, reassembled into the typed reference. */
function rowToArtifact(row: {
  artifact_kind: string;
  artifact_id: string | null;
  artifact_context_id: string | null;
  artifact_project_path: string | null;
  artifact_session_name: string | null;
  artifact_session_created_at: string | null;
}): unknown {
  if (row.artifact_kind === "session") {
    return {
      kind: "session",
      projectPath: row.artifact_project_path,
      sessionName: row.artifact_session_name,
      sessionCreatedAt: row.artifact_session_created_at,
    };
  }
  if (row.artifact_kind === "ticket") {
    return { kind: "ticket", ticketId: row.artifact_id };
  }
  if (row.artifact_kind === "spec") {
    return { kind: "spec", specId: row.artifact_id };
  }
  if (row.artifact_kind === "workflow_execution") {
    // One row kind for the run and its contexts: the context id beside the
    // execution id narrows the reference to one execution context, which
    // keeps the table's kind CHECK unchanged and execution-wide lookups
    // (context id NULL) distinct from per-context ones.
    return row.artifact_context_id === null
      ? { kind: "workflow_execution", executionId: row.artifact_id }
      : {
          kind: "workflow_context",
          executionId: row.artifact_id,
          contextId: row.artifact_context_id,
        };
  }
  // An unknown kind is returned as-is so the schema parse names it, rather
  // than being silently coerced into the last shape that happened to fit.
  return { kind: row.artifact_kind, artifactId: row.artifact_id };
}

function rowToLink(rawRow: unknown): MemoryLink {
  const row = parseTrusted(memoryLinksTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("memory_link", "<row>", issues),
  );
  return parseTrusted(
    memoryLinkSchema,
    {
      id: row.id,
      memoryId: row.memory_id,
      kind: row.kind,
      artifact: rowToArtifact(row),
      createdAt: row.created_at,
    },
    (issues) => logAndThrowValidationFailure("memory_link", row.id, issues),
  );
}

interface ArtifactColumns {
  readonly artifact_kind: string;
  readonly artifact_id: string | null;
  readonly artifact_context_id: string | null;
  readonly artifact_project_path: string | null;
  readonly artifact_session_name: string | null;
  readonly artifact_session_created_at: string | null;
}

function artifactToColumns(artifact: MemoryArtifactRef): ArtifactColumns {
  const empty = {
    artifact_id: null,
    artifact_context_id: null,
    artifact_project_path: null,
    artifact_session_name: null,
    artifact_session_created_at: null,
  };
  switch (artifact.kind) {
    case "ticket":
      return {
        ...empty,
        artifact_kind: "ticket",
        artifact_id: artifact.ticketId,
      };
    case "spec":
      return { ...empty, artifact_kind: "spec", artifact_id: artifact.specId };
    case "workflow_execution":
      return {
        ...empty,
        artifact_kind: "workflow_execution",
        artifact_id: artifact.executionId,
      };
    case "workflow_context":
      return {
        ...empty,
        artifact_kind: "workflow_execution",
        artifact_id: artifact.executionId,
        artifact_context_id: artifact.contextId,
      };
    case "session":
      return {
        artifact_kind: "session",
        artifact_id: null,
        artifact_context_id: null,
        artifact_project_path: artifact.projectPath,
        artifact_session_name: artifact.sessionName,
        artifact_session_created_at: artifact.sessionCreatedAt,
      };
  }
}

function noteToStatusColumns(note: MemoryNote) {
  return {
    status_note_text: note.statusNote?.text ?? null,
    status_note_updated_at: note.statusNote?.updatedAt ?? null,
    status_note_review_after: note.statusNote?.reviewAfter ?? null,
  };
}

function timed<T>(
  op: string,
  identifier: Record<string, unknown>,
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    logger.info(`state-store.memory.${op}.timing`, {
      ...identifier,
      durationMs,
    });
  }
}

function checkBodySize(
  memoryId: string,
  body: string,
): MemoryBodyTooLarge | null {
  const actualBytes = memoryBodyByteLength(body);
  if (actualBytes > MEMORY_BODY_MAX_BYTES) {
    return {
      status: "body_too_large",
      limitBytes: MEMORY_BODY_MAX_BYTES,
      actualBytes,
    };
  }
  checkRowColumnSize({
    logger,
    table: "memory_notes",
    column: "body",
    id: memoryId,
    value: body,
  });
  return null;
}

/**
 * The visible scope union as a SQL predicate (R3). A conversation with no
 * project sees global notes only; a session conversation additionally sees its
 * own incarnation, matched on name AND created-at so a later session reusing
 * the name reads none of it.
 */
function visibilityCondition(visibility: MemoryVisibility): {
  readonly sql: string;
  readonly bind: Record<string, string>;
} {
  const clauses = ["scope = 'global'"];
  const bind: Record<string, string> = {};
  if (visibility.projectPath !== null) {
    clauses.push("(scope = 'project' AND project_path = @project_path)");
    bind.project_path = visibility.projectPath;
  }
  if (visibility.session !== null && visibility.projectPath !== null) {
    clauses.push(
      `(scope = 'session' AND project_path = @project_path
          AND session_name = @session_name
          AND session_created_at = @session_created_at)`,
    );
    bind.session_name = visibility.session.sessionName;
    bind.session_created_at = visibility.session.sessionCreatedAt;
  }
  return { sql: `(${clauses.join(" OR ")})`, bind };
}

/**
 * Turn free agent text into an FTS5 MATCH expression. Every token is quoted, so
 * a query carrying `-`, `*`, `"`, or a bare `OR` is searched for rather than
 * parsed as syntax — an unquoted user string is a query-syntax error waiting to
 * surface as a crash on the recall path.
 *
 * Tokens are joined with OR because this is the index primitive: a partial
 * lexical match is a candidate that bm25 ranks down, not a result to withhold.
 * Narrowing belongs to the recall contract that composes over it (D5).
 */
export function toMatchExpression(query: string): string | null {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== "");
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export function createMemoryRepo(db: Db, writeQueue: WriteQueue): MemoryRepo {
  const findNoteStmt = db.prepare(
    `SELECT * FROM memory_notes WHERE id = ? LIMIT 1`,
  );
  const aliasesByNoteStmt = db
    .prepare(
      `SELECT alias FROM memory_note_aliases WHERE memory_id = ?
        ORDER BY position ASC`,
    )
    .pluck();
  const deleteAliasesStmt = db.prepare(
    `DELETE FROM memory_note_aliases WHERE memory_id = ?`,
  );
  const insertAliasStmt = db.prepare(
    `INSERT INTO memory_note_aliases (memory_id, alias, position)
     VALUES (@memory_id, @alias, @position)`,
  );
  const insertNoteStmt = db.prepare(
    `INSERT INTO memory_notes
       (id, slug, scope, project_path, session_name, session_created_at, kind,
        hook, body, status_note_text, status_note_updated_at,
        status_note_review_after, index_mode, lifecycle, review_after,
        expires_at, supersedes_id, superseded_by_id, created_by,
        author_conversation_id, revision, created_at, updated_at)
     VALUES
       (@id, @slug, @scope, @project_path, @session_name, @session_created_at,
        @kind, @hook, @body, @status_note_text, @status_note_updated_at,
        @status_note_review_after, @index_mode, @lifecycle, @review_after,
        @expires_at, @supersedes_id, @superseded_by_id, @created_by,
        @author_conversation_id, @revision, @created_at, @updated_at)`,
  );
  const updateNoteStmt = db.prepare(
    `UPDATE memory_notes
        SET slug = @slug, hook = @hook, body = @body,
            status_note_text = @status_note_text,
            status_note_updated_at = @status_note_updated_at,
            status_note_review_after = @status_note_review_after,
            index_mode = @index_mode, lifecycle = @lifecycle,
            review_after = @review_after, expires_at = @expires_at,
            superseded_by_id = @superseded_by_id, revision = @revision,
            updated_at = @updated_at
      WHERE id = @id`,
  );
  const deleteNoteStmt = db.prepare(`DELETE FROM memory_notes WHERE id = ?`);
  const slugTakenStmt = db.prepare(
    `SELECT id FROM memory_notes
      WHERE slug = @slug AND scope = @scope
        AND IFNULL(project_path, '') = @project_key
        AND IFNULL(session_name, '') = @session_key
        AND IFNULL(session_created_at, '') = @incarnation_key
        AND lifecycle <> 'archived'
      LIMIT 1`,
  );
  const aliasHolderStmt = db.prepare(
    `SELECT n.id AS id FROM memory_notes n
       JOIN memory_note_aliases a ON a.memory_id = n.id
      WHERE a.alias = @handle AND n.scope = @scope
        AND IFNULL(n.project_path, '') = @project_key
        AND IFNULL(n.session_name, '') = @session_key
        AND IFNULL(n.session_created_at, '') = @incarnation_key
        AND n.lifecycle <> 'archived'
      LIMIT 1`,
  );
  const slugHolderStmt = db.prepare(
    `SELECT id FROM memory_notes
      WHERE slug = @handle AND scope = @scope
        AND IFNULL(project_path, '') = @project_key
        AND IFNULL(session_name, '') = @session_key
        AND IFNULL(session_created_at, '') = @incarnation_key
        AND lifecycle <> 'archived'
      LIMIT 1`,
  );
  const insertRevisionStmt = db.prepare(
    `INSERT INTO memory_note_revisions
       (id, memory_id, revision, snapshot_json, origin, base_revision,
        restored_from_revision, author_kind, author_conversation_id, created_at)
     VALUES
       (@id, @memory_id, @revision, @snapshot_json, @origin, @base_revision,
        @restored_from_revision, @author_kind, @author_conversation_id,
        @created_at)`,
  );
  const revisionsByNoteStmt = db.prepare(
    `SELECT * FROM memory_note_revisions WHERE memory_id = ?
      ORDER BY revision ASC`,
  );
  const boundedRevisionsByNoteStmt = db.prepare(
    `SELECT * FROM (
       SELECT * FROM memory_note_revisions WHERE memory_id = ?
        ORDER BY revision DESC LIMIT ?
     ) ORDER BY revision ASC`,
  );
  const findRevisionStmt = db.prepare(
    `SELECT * FROM memory_note_revisions WHERE memory_id = ? AND revision = ?
      LIMIT 1`,
  );
  const insertLinkStmt = db.prepare(
    `INSERT INTO memory_links
       (id, memory_id, kind, artifact_kind, artifact_id, artifact_context_id,
        artifact_project_path, artifact_session_name,
        artifact_session_created_at, created_at)
     VALUES
       (@id, @memory_id, @kind, @artifact_kind, @artifact_id,
        @artifact_context_id, @artifact_project_path, @artifact_session_name,
        @artifact_session_created_at, @created_at)`,
  );
  const findLinkIdentityStmt = db.prepare(
    `SELECT id FROM memory_links
      WHERE memory_id = @memory_id AND kind = @kind
        AND artifact_kind = @artifact_kind
        AND IFNULL(artifact_id, '') = IFNULL(@artifact_id, '')
        AND IFNULL(artifact_context_id, '') = IFNULL(@artifact_context_id, '')
        AND IFNULL(artifact_project_path, '') = IFNULL(@artifact_project_path, '')
        AND IFNULL(artifact_session_name, '') = IFNULL(@artifact_session_name, '')
        AND IFNULL(artifact_session_created_at, '')
            = IFNULL(@artifact_session_created_at, '')
      LIMIT 1`,
  );
  const findLinkStmt = db.prepare(
    `SELECT * FROM memory_links WHERE id = ? LIMIT 1`,
  );
  const linksByNoteStmt = db.prepare(
    `SELECT * FROM memory_links WHERE memory_id = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const deleteLinkStmt = db.prepare(`DELETE FROM memory_links WHERE id = ?`);
  const searchRowidStmt = db
    .prepare(`SELECT search_rowid FROM memory_notes WHERE id = ?`)
    .pluck();
  const deleteSearchRowStmt = db.prepare(
    `DELETE FROM memory_notes_fts WHERE rowid = ?`,
  );
  const insertSearchRowStmt = db.prepare(
    `INSERT INTO memory_notes_fts (rowid, slug, hook, aliases, body)
     VALUES (@rowid, @slug, @hook, @aliases, @body)`,
  );
  const clearSearchIndexStmt = db.prepare(
    `INSERT INTO memory_notes_fts (memory_notes_fts) VALUES ('delete-all')`,
  );
  const allNoteIdsStmt = db
    .prepare(`SELECT id FROM memory_notes ORDER BY search_rowid ASC`)
    .pluck();

  function readAliases(memoryId: string): string[] {
    return (aliasesByNoteStmt.all(memoryId) as unknown[]).filter(
      (alias): alias is string => typeof alias === "string",
    );
  }

  function readNote(memoryId: string): MemoryNote | null {
    const rawRow: unknown = findNoteStmt.get(memoryId);
    return rawRow === undefined
      ? null
      : rowToNote(rawRow, readAliases(memoryId));
  }

  function requireNote(memoryId: string): MemoryNote {
    const note = readNote(memoryId);
    if (note === null) {
      throw new PersistenceError({
        kind: "not_found",
        entity: "memory_note",
        identifier: memoryId,
      });
    }
    return note;
  }

  function writeAliases(memoryId: string, aliases: readonly string[]): void {
    deleteAliasesStmt.run(memoryId);
    aliases.forEach((alias, position) => {
      insertAliasStmt.run({ memory_id: memoryId, alias, position });
    });
  }

  function searchRowid(memoryId: string): number | null {
    const value: unknown = searchRowidStmt.get(memoryId);
    return typeof value === "number" ? value : null;
  }

  /**
   * Refresh one note's row in the derived index, inside the same transaction as
   * the canonical write. Delete-then-insert rather than an update because the
   * index is contentless: there is no stored row to modify in place.
   *
   * Only the searchable projection is written — slug, hook, the flattened
   * aliases, and the body. Lifecycle and scope are deliberately absent: those
   * are filtered through the join back to `memory_notes`, so an archived note
   * needs no reindexing and the index never holds a second copy of a fact the
   * canonical row owns.
   */
  function indexNote(note: MemoryNote): void {
    const rowid = searchRowid(note.id);
    if (rowid === null) return;
    deleteSearchRowStmt.run(rowid);
    insertSearchRowStmt.run({
      rowid,
      slug: note.slug,
      hook: note.hook,
      aliases: note.aliases.join(" "),
      body: note.body,
    });
  }

  function unindexNote(memoryId: string): void {
    const rowid = searchRowid(memoryId);
    if (rowid !== null) deleteSearchRowStmt.run(rowid);
  }

  /**
   * Whether an ACTIVE record in the same scope owner already answers to this
   * slug. Archived records are excluded, matching the partial unique index, so
   * a successor may take its superseded predecessor's slug.
   */
  function slugTaken(note: MemoryNote, exceptMemoryId?: string): boolean {
    const row = slugTakenStmt.get({
      slug: note.slug,
      scope: note.scope,
      project_key: note.projectPath ?? "",
      session_key: note.sessionName ?? "",
      incarnation_key: note.sessionCreatedAt ?? "",
    }) as { id: string } | undefined;
    if (row === undefined) return false;
    return row.id !== exceptMemoryId;
  }

  /**
   * Whether any ACTIVE note of this scope owner already answers to `handle`,
   * by slug or by alias. The predecessor is excluded because the same
   * transaction archives it, which is what frees its handles.
   */
  function handleTaken(
    note: MemoryNote,
    handle: string,
    exceptMemoryId?: string,
  ): boolean {
    const keys = {
      handle,
      scope: note.scope,
      project_key: note.projectPath ?? "",
      session_key: note.sessionName ?? "",
      incarnation_key: note.sessionCreatedAt ?? "",
    };
    for (const stmt of [slugHolderStmt, aliasHolderStmt]) {
      const row = stmt.get(keys) as { id: string } | undefined;
      if (row !== undefined && row.id !== exceptMemoryId) return true;
    }
    return false;
  }

  function appendRevision(
    note: MemoryNote,
    input: {
      readonly revisionId: string;
      readonly origin: MemoryRevisionOrigin;
      readonly baseRevision: number | null;
      readonly restoredFromRevision: number | null;
      readonly authorKind: MemoryNote["createdBy"];
      readonly authorConversationId: string | null;
      readonly createdAt: string;
    },
  ): void {
    const snapshotJson = stableStringify(note);
    checkRowColumnSize({
      logger,
      table: "memory_note_revisions",
      column: "snapshot_json",
      id: note.id,
      value: snapshotJson,
    });
    insertRevisionStmt.run({
      id: input.revisionId,
      memory_id: note.id,
      revision: note.revision,
      snapshot_json: snapshotJson,
      origin: input.origin,
      base_revision: input.baseRevision,
      restored_from_revision: input.restoredFromRevision,
      author_kind: input.authorKind,
      author_conversation_id: input.authorConversationId,
      created_at: input.createdAt,
    });
  }

  function persistHead(note: MemoryNote): void {
    updateNoteStmt.run({
      id: note.id,
      slug: note.slug,
      hook: note.hook,
      body: note.body,
      ...noteToStatusColumns(note),
      index_mode: note.indexMode,
      lifecycle: note.lifecycle,
      review_after: note.reviewAfter,
      expires_at: note.expiresAt,
      superseded_by_id: note.supersededById,
      revision: note.revision,
      updated_at: note.updatedAt,
    });
  }

  const createTx = db.transaction(
    (input: CreateMemoryNoteInput): CreateMemoryNoteResult => {
      const oversized = checkBodySize(input.id, input.body);
      if (oversized !== null) return oversized;

      const candidate = memoryNoteSchema.parse({
        id: input.id,
        slug: input.slug,
        scope: input.scope,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        sessionCreatedAt: input.sessionCreatedAt,
        kind: input.kind,
        hook: input.hook,
        body: input.body,
        statusNote: input.statusNote,
        aliases: input.aliases,
        indexMode: input.indexMode,
        lifecycle: input.lifecycle,
        reviewAfter: input.reviewAfter,
        expiresAt: input.expiresAt,
        supersedesId: input.supersedes?.memoryId ?? null,
        supersededById: null,
        createdBy: input.createdBy,
        authorConversationId: input.authorConversationId,
        revision: 1,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });

      const predecessor =
        input.supersedes === null ? null : readNote(input.supersedes.memoryId);
      if (input.supersedes !== null && predecessor === null) {
        return {
          status: "supersedes_missing",
          memoryId: input.supersedes.memoryId,
        };
      }
      if (
        input.supersedes !== null &&
        predecessor !== null &&
        input.supersedes.baseRevision !== null &&
        input.supersedes.baseRevision !== predecessor.revision
      ) {
        return {
          status: "supersedes_stale",
          currentRevision: predecessor.revision,
        };
      }

      // Every refusal is decided BEFORE the first write. A returned refusal
      // commits the transaction like any other return, so a slug check made
      // after the predecessor's archive would retire a note and create nothing
      // in its place. The predecessor itself is excluded from the check because
      // this transaction archives it, which is what frees its slug.
      if (slugTaken(candidate, predecessor?.id)) {
        return { status: "slug_taken", slug: candidate.slug };
      }
      // The caller's stated handles, checked here rather than before the call,
      // so a concurrent claim cannot slip between a precheck and this insert.
      for (const handle of input.requireFreeHandles ?? []) {
        if (handleTaken(candidate, handle, predecessor?.id)) {
          return { status: "slug_taken", slug: handle };
        }
      }

      // The archive lands before the insert, because the successor commonly
      // inherits the slug and the active-slug index would otherwise reject the
      // very write that retires the holder. The forward pointer is set
      // afterwards, once the successor row exists for the foreign key.
      if (predecessor !== null) {
        persistHead({
          ...predecessor,
          lifecycle: "archived",
          revision: predecessor.revision + 1,
          updatedAt: input.createdAt,
        });
      }

      insertNoteStmt.run({
        id: candidate.id,
        slug: candidate.slug,
        scope: candidate.scope,
        project_path: candidate.projectPath,
        session_name: candidate.sessionName,
        session_created_at: candidate.sessionCreatedAt,
        kind: candidate.kind,
        hook: candidate.hook,
        body: candidate.body,
        ...noteToStatusColumns(candidate),
        index_mode: candidate.indexMode,
        lifecycle: candidate.lifecycle,
        review_after: candidate.reviewAfter,
        expires_at: candidate.expiresAt,
        supersedes_id: candidate.supersedesId,
        superseded_by_id: null,
        created_by: candidate.createdBy,
        author_conversation_id: candidate.authorConversationId,
        revision: candidate.revision,
        created_at: candidate.createdAt,
        updated_at: candidate.updatedAt,
      });
      writeAliases(candidate.id, candidate.aliases);
      appendRevision(candidate, {
        revisionId: input.revisionId,
        origin: "create",
        baseRevision: null,
        restoredFromRevision: null,
        authorKind: candidate.createdBy,
        authorConversationId: candidate.authorConversationId,
        createdAt: candidate.createdAt,
      });

      if (predecessor !== null && input.supersedes !== null) {
        const archived = requireNote(predecessor.id);
        const withSuccessor: MemoryNote = {
          ...archived,
          supersededById: candidate.id,
        };
        persistHead(withSuccessor);
        appendRevision(withSuccessor, {
          revisionId: input.supersedes.archiveRevisionId,
          origin: "archive",
          baseRevision: predecessor.revision,
          restoredFromRevision: null,
          authorKind: candidate.createdBy,
          authorConversationId: candidate.authorConversationId,
          createdAt: input.createdAt,
        });
      }

      const created = requireNote(candidate.id);
      indexNote(created);
      return { status: "created", note: created };
    },
  );

  interface NoteWrite {
    readonly memoryId: string;
    readonly revisionId: string;
    readonly baseRevision: number | null;
    readonly origin: MemoryRevisionOrigin;
    readonly restoredFromRevision: number | null;
    readonly patch: MemoryNotePatch;
    readonly authorKind: MemoryNote["createdBy"];
    readonly authorConversationId: string | null;
    readonly writtenAt: string;
  }

  function applyWrite(write: NoteWrite): WriteMemoryNoteResult {
    const current = readNote(write.memoryId);
    if (current === null) return { status: "missing" };
    if (
      write.baseRevision !== null &&
      write.baseRevision !== current.revision
    ) {
      // Nothing has been written yet: the refused payload never reaches a
      // statement, so the caller's stale view cannot overwrite the winner.
      return { status: "stale", currentRevision: current.revision };
    }

    // Ahead of the schema parse, which enforces the same cap by throwing: an
    // oversized body is an ordinary caller mistake the write path answers with
    // a typed refusal naming the limit, not a persistence exception.
    const body = write.patch.body ?? current.body;
    if (body !== current.body) {
      const oversized = checkBodySize(current.id, body);
      if (oversized !== null) return oversized;
    }

    const next = memoryNoteSchema.parse({
      ...current,
      ...write.patch,
      revision: current.revision + 1,
      updatedAt: write.writtenAt,
    });
    if (next.lifecycle !== "archived" && slugTaken(next, next.id)) {
      return { status: "slug_taken", slug: next.slug };
    }

    persistHead(next);
    if (write.patch.aliases !== undefined) writeAliases(next.id, next.aliases);
    appendRevision(next, {
      revisionId: write.revisionId,
      origin: write.origin,
      baseRevision: current.revision,
      restoredFromRevision: write.restoredFromRevision,
      authorKind: write.authorKind,
      authorConversationId: write.authorConversationId,
      createdAt: write.writtenAt,
    });

    indexNote(next);

    const revision = findRevisionStmt.get(next.id, next.revision);
    if (revision === undefined) {
      throw new PersistenceError({
        kind: "not_found",
        entity: "memory_note_revision",
        identifier: `${next.id}@${next.revision}`,
      });
    }
    return {
      status: "written",
      note: requireNote(next.id),
      revision: rowToRevision(revision),
    };
  }

  const updateTx = db.transaction(
    (input: UpdateMemoryNoteInput): WriteMemoryNoteResult =>
      applyWrite({
        memoryId: input.memoryId,
        revisionId: input.revisionId,
        baseRevision: input.baseRevision,
        origin: "edit",
        restoredFromRevision: null,
        patch: input.patch,
        authorKind: input.authorKind,
        authorConversationId: input.authorConversationId,
        writtenAt: input.writtenAt,
      }),
  );

  const archiveTx = db.transaction(
    (input: ArchiveMemoryNoteInput): WriteMemoryNoteResult =>
      applyWrite({
        memoryId: input.memoryId,
        revisionId: input.revisionId,
        baseRevision: input.baseRevision,
        origin: "archive",
        restoredFromRevision: null,
        patch: { lifecycle: "archived" },
        authorKind: input.authorKind,
        authorConversationId: input.authorConversationId,
        writtenAt: input.writtenAt,
      }),
  );

  const restoreTx = db.transaction(
    (input: RestoreMemoryNoteInput): RestoreMemoryNoteResult => {
      const rawRevision: unknown = findRevisionStmt.get(
        input.memoryId,
        input.restoreFromRevision,
      );
      if (rawRevision === undefined) {
        return {
          status: "revision_missing",
          revision: input.restoreFromRevision,
        };
      }
      const { snapshot } = rowToRevision(rawRevision);
      // A restore copies the historical snapshot FORWARD as a new head rather
      // than rewinding the counter, so the compare-and-swap token every other
      // writer holds keeps moving in one direction.
      return applyWrite({
        memoryId: input.memoryId,
        revisionId: input.revisionId,
        baseRevision: input.baseRevision,
        origin: "restore",
        restoredFromRevision: input.restoreFromRevision,
        patch: {
          slug: snapshot.slug,
          hook: snapshot.hook,
          body: snapshot.body,
          statusNote: snapshot.statusNote,
          aliases: snapshot.aliases,
          indexMode: snapshot.indexMode,
          lifecycle: snapshot.lifecycle,
          reviewAfter: snapshot.reviewAfter,
          expiresAt: snapshot.expiresAt,
        },
        authorKind: input.authorKind,
        authorConversationId: input.authorConversationId,
        writtenAt: input.writtenAt,
      });
    },
  );

  const deleteTx = db.transaction((memoryId: string): MemoryNote | null => {
    const note = readNote(memoryId);
    if (note === null) return null;
    // Before the row goes: the index is keyed by the note's rowid, and the
    // virtual table is not reachable by the foreign-key cascade.
    unindexNote(memoryId);
    deleteNoteStmt.run(memoryId);
    return note;
  });

  const addLinkTx = db.transaction(
    (input: AddMemoryLinkInput): AddMemoryLinkResult => {
      const note = readNote(input.memoryId);
      if (note === null) return { status: "missing" };
      const columns = artifactToColumns(input.artifact);
      const identity = {
        memory_id: input.memoryId,
        kind: input.kind,
        ...columns,
      };
      const existing = findLinkIdentityStmt.get(identity) as
        | { id: string }
        | undefined;
      if (existing !== undefined) {
        // Re-linking the same thing lands on the row that already exists: the
        // link records a relationship, and a second row would say nothing new.
        return {
          status: "linked",
          link: rowToLink(findLinkStmt.get(existing.id)),
        };
      }
      insertLinkStmt.run({
        id: input.id,
        ...identity,
        created_at: input.createdAt,
      });
      return { status: "linked", link: rowToLink(findLinkStmt.get(input.id)) };
    },
  );

  const removeLinkTx = db.transaction((linkId: string): MemoryLink | null => {
    const rawRow: unknown = findLinkStmt.get(linkId);
    if (rawRow === undefined) return null;
    const link = rowToLink(rawRow);
    deleteLinkStmt.run(linkId);
    return link;
  });

  const rebuildSearchIndexTx = db.transaction((): number => {
    clearSearchIndexStmt.run();
    const ids = (allNoteIdsStmt.all() as unknown[]).filter(
      (id): id is string => typeof id === "string",
    );
    for (const id of ids) {
      const note = readNote(id);
      if (note !== null) indexNote(note);
    }
    return ids.length;
  });

  function readNotesWhere(
    conditions: readonly string[],
    bind: Record<string, string>,
  ): MemoryNote[] {
    const rows = db
      .prepare(
        `SELECT * FROM memory_notes WHERE ${conditions.join(" AND ")}
          ORDER BY updated_at DESC, id ASC`,
      )
      .all(bind) as unknown[];
    return rows.map((row) => {
      const parsed = parseTrusted(memoryNotesTableRowSchema, row, (issues) =>
        logAndThrowValidationFailure("memory_note", "<row>", issues),
      );
      return rowToNote(row, readAliases(parsed.id));
    });
  }

  function listConditions(query: MemoryNoteListQuery): {
    readonly conditions: string[];
    readonly bind: Record<string, string>;
  } {
    const visible = visibilityCondition(query.visibility);
    const conditions = [visible.sql];
    const bind = { ...visible.bind };
    if (query.scope !== undefined) {
      conditions.push("scope = @scope");
      bind.scope = query.scope;
    }
    if (!query.includeArchived) {
      conditions.push("lifecycle <> 'archived'");
    }
    return { conditions, bind };
  }

  return {
    async create(input) {
      const validated = createMemoryNoteInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("memory.create", () =>
        timed("create", { id: validated.id, scope: validated.scope }, () =>
          createTx.immediate(validated),
        ),
      );
    },

    async find(memoryId) {
      return timed("find", { memoryId }, () => readNote(memoryId));
    },

    async findByHandle(handle, query) {
      const validated = memoryNoteListQuerySchema.parse(query);
      const { conditions, bind } = listConditions(validated);
      return timed("findByHandle", { handle }, () =>
        readNotesWhere(
          [
            ...conditions,
            `(slug = @handle OR id IN (
               SELECT memory_id FROM memory_note_aliases WHERE alias = @handle
             ))`,
          ],
          { ...bind, handle },
        ),
      );
    },

    async list(query) {
      const validated = memoryNoteListQuerySchema.parse(query);
      const { conditions, bind } = listConditions(validated);
      return timed(
        "list",
        { scope: validated.scope ?? "union", filters: conditions.length },
        () => readNotesWhere(conditions, bind),
      );
    },

    async update(input) {
      const validated = updateMemoryNoteInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("memory.update", () =>
        timed("update", { memoryId: validated.memoryId }, () =>
          updateTx.immediate(validated),
        ),
      );
    },

    async archive(input) {
      const validated = archiveMemoryNoteInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("memory.archive", () =>
        timed("archive", { memoryId: validated.memoryId }, () =>
          archiveTx.immediate(validated),
        ),
      );
    },

    async restore(input) {
      const validated = restoreMemoryNoteInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("memory.restore", () =>
        timed(
          "restore",
          {
            memoryId: validated.memoryId,
            restoreFromRevision: validated.restoreFromRevision,
          },
          () => restoreTx.immediate(validated),
        ),
      );
    },

    async delete(memoryId) {
      return writeQueue.withWriteQueueSync("memory.delete", () =>
        timed("delete", { memoryId }, () => deleteTx.immediate(memoryId)),
      );
    },

    async listRevisions(memoryId, limit) {
      return timed("listRevisions", { memoryId, limit }, () => {
        const rows = (
          limit === undefined
            ? revisionsByNoteStmt.all(memoryId)
            : boundedRevisionsByNoteStmt.all(memoryId, limit)
        ) as unknown[];
        return rows.map(rowToRevision);
      });
    },

    async findRevision(memoryId, revision) {
      return timed("findRevision", { memoryId, revision }, () => {
        const rawRow: unknown = findRevisionStmt.get(memoryId, revision);
        return rawRow === undefined ? null : rowToRevision(rawRow);
      });
    },

    async search(query, listQuery) {
      const validated = memoryNoteListQuerySchema.parse(listQuery);
      const match = toMatchExpression(query);
      if (match === null) return [];
      const { conditions, bind } = listConditions(validated);
      return timed("search", { queryLength: query.length }, () => {
        const rows = db
          .prepare(
            // The FTS5 table is named in full rather than aliased: its
            // auxiliary functions and the MATCH operator resolve the virtual
            // table by name, and an alias makes both unresolvable.
            `SELECT n.*, bm25(memory_notes_fts) AS score
               FROM memory_notes_fts
               JOIN memory_notes n
                 ON n.search_rowid = memory_notes_fts.rowid
              WHERE memory_notes_fts MATCH @match
                AND ${conditions.join(" AND ")}
              ORDER BY score ASC, n.id ASC`,
          )
          .all({ ...bind, match }) as unknown[];
        return rows.map((row) => {
          const parsed = parseTrusted(
            memoryNotesTableRowSchema,
            row,
            (issues) =>
              logAndThrowValidationFailure("memory_note", "<row>", issues),
          );
          const score = (row as { score: unknown }).score;
          return {
            note: rowToNote(row, readAliases(parsed.id)),
            score: typeof score === "number" ? score : 0,
          };
        });
      });
    },

    async rebuildSearchIndex() {
      return writeQueue.withWriteQueueSync("memory.rebuildSearchIndex", () =>
        timed("rebuildSearchIndex", {}, () => rebuildSearchIndexTx.immediate()),
      );
    },

    async addLink(input) {
      const validated = addMemoryLinkInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("memory.addLink", () =>
        timed(
          "addLink",
          { memoryId: validated.memoryId, kind: validated.kind },
          () => addLinkTx.immediate(validated),
        ),
      );
    },

    async listAllScopes(query) {
      return timed(
        "listAllScopes",
        { includeArchived: query.includeArchived },
        () =>
          readNotesWhere(
            query.includeArchived ? ["1 = 1"] : ["lifecycle <> 'archived'"],
            {},
          ),
      );
    },

    async listLinks(memoryId) {
      return timed("listLinks", { memoryId }, () =>
        (linksByNoteStmt.all(memoryId) as unknown[]).map(rowToLink),
      );
    },

    async listLinksForNotes(memoryIds) {
      const ids = [...new Set(memoryIds)];
      if (ids.length === 0) return [];
      return timed("listLinksForNotes", { notes: ids.length }, () => {
        const links: MemoryLink[] = [];
        for (let start = 0; start < ids.length; start += LINK_QUERY_CHUNK) {
          const chunk = ids.slice(start, start + LINK_QUERY_CHUNK);
          const rows = db
            .prepare(
              `SELECT * FROM memory_links
                WHERE memory_id IN (${chunk.map(() => "?").join(", ")})
                ORDER BY created_at ASC, id ASC`,
            )
            .all(...chunk) as unknown[];
          links.push(...rows.map(rowToLink));
        }
        return links;
      });
    },

    async listLinksForArtifact(artifact) {
      const validated = memoryArtifactRefSchema.parse(artifact);
      const columns = artifactToColumns(validated);
      return timed(
        "listLinksForArtifact",
        { kind: columns.artifact_kind },
        () =>
          (
            db
              .prepare(
                `SELECT * FROM memory_links
                WHERE artifact_kind = @artifact_kind
                  AND IFNULL(artifact_id, '') = IFNULL(@artifact_id, '')
                  AND IFNULL(artifact_context_id, '')
                      = IFNULL(@artifact_context_id, '')
                  AND IFNULL(artifact_project_path, '')
                      = IFNULL(@artifact_project_path, '')
                  AND IFNULL(artifact_session_name, '')
                      = IFNULL(@artifact_session_name, '')
                  AND IFNULL(artifact_session_created_at, '')
                      = IFNULL(@artifact_session_created_at, '')
                ORDER BY created_at ASC, id ASC`,
              )
              .all(columns) as unknown[]
          ).map(rowToLink),
      );
    },

    async removeLink(linkId) {
      return writeQueue.withWriteQueueSync("memory.removeLink", () =>
        timed("removeLink", { linkId }, () => removeLinkTx.immediate(linkId)),
      );
    },
  };
}
