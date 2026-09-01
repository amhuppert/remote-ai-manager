import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { composeAppendedNotepadContent } from "@/lib/notepads/append-composition";
import {
  notepadAuthorKindSchema,
  notepadImageSchema,
  notepadRevisionSchema,
  notepadScopeSchema,
  notepadSchema,
  notepadSortSchema,
  notepadWriteModeSchema,
  type Notepad,
  type NotepadImage,
  type NotepadListItem,
  type NotepadRevision,
  type NotepadWriteMode,
} from "@/lib/notepads/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import { checkRowColumnSize } from "./row-size-telemetry";
import { projectNameFromPath } from "./tickets-repo";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.notepads");

// ============================================================
// Repo-level write inputs
// ============================================================

/**
 * Creation persists the head row and its first revision snapshot together, so
 * the caller supplies both ids. `revision` is not an input: the repo owns the
 * counter, which is what makes it a trustworthy compare-and-swap token.
 */
export const createNotepadRowInputSchema = z.object({
  id: z.string().min(1),
  revisionId: z.string().min(1),
  scope: notepadScopeSchema,
  projectPath: z.string().min(1).nullable(),
  name: z.string().min(1),
  content: z.string(),
  writeMode: notepadWriteModeSchema,
  authorKind: notepadAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
});
export type CreateNotepadRowInput = z.infer<typeof createNotepadRowInputSchema>;

export const updateNotepadOrganizationInputSchema = z.object({
  notepadId: z.string().min(1),
  name: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  writeMode: notepadWriteModeSchema.optional(),
  updatedAt: z.string().min(1),
});
export type UpdateNotepadOrganizationInput = z.infer<
  typeof updateNotepadOrganizationInputSchema
>;

export const notepadWriteOperationRowSchema = z.enum([
  "update",
  "append",
  "restore",
]);

/**
 * One content write. `enforceBaseRevision` is the caller's statement that this
 * is a compare-and-swap write (an agent's): a stale base is refused. A user
 * write leaves it false and is always persisted — refusing it would discard
 * keystrokes, the one loss revision history cannot cover.
 */
export const writeNotepadContentInputSchema = z.object({
  notepadId: z.string().min(1),
  revisionId: z.string().min(1),
  operation: notepadWriteOperationRowSchema,
  content: z.string(),
  authorKind: notepadAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  baseRevision: z.number().int().positive().nullable(),
  enforceBaseRevision: z.boolean(),
  /**
   * The write modes under which the service — which owns the policy — permits
   * this write. `null` means the write is not mode-governed (a user's).
   *
   * Carried into the transaction rather than checked by the caller because a
   * mode change does not advance the revision: a narrowing that commits after
   * the caller's decision leaves the compare-and-swap token valid, so only a
   * re-read against the row being written can catch it.
   */
  permittedWriteModes: z.array(notepadWriteModeSchema).nullable(),
  restoredFromRevision: z.number().int().positive().nullable(),
  writtenAt: z.string().min(1),
  /**
   * How long one editing burst keeps writing into the same revision row, or
   * null for a write that always opens its own revision (an agent's, a
   * restore, an append). Inside the window the head revision is rewritten in
   * place — same row, new content, new revision number — so a stream of
   * autosaves persists every keystroke without shredding history into one
   * entry per idle timer. The revision number still advances on every write,
   * so an agent's compare-and-swap token is never weakened by folding.
   */
  coalesceWindowMs: z.number().int().nonnegative().nullable(),
});
export type WriteNotepadContentInput = z.infer<
  typeof writeNotepadContentInputSchema
>;

export const notepadListRowQuerySchema = z.object({
  scope: notepadScopeSchema.optional(),
  projectPath: z.string().min(1).nullish(),
  includeArchived: z.boolean(),
  sort: notepadSortSchema,
});
export type NotepadListRowQuery = z.infer<typeof notepadListRowQuerySchema>;

export type CreateNotepadResult =
  | { status: "created"; notepad: Notepad }
  | { status: "name_taken" };

export type UpdateNotepadOrganizationResult =
  | { status: "updated"; notepad: Notepad }
  | { status: "name_taken" }
  | { status: "missing" };

export type WriteNotepadContentResult =
  | { status: "written"; notepad: Notepad; revision: NotepadRevision }
  | { status: "write_mode_refused"; writeMode: NotepadWriteMode }
  | { status: "stale"; currentRevision: number }
  | { status: "missing" };

export interface NotepadsRepo {
  create(input: CreateNotepadRowInput): Promise<CreateNotepadResult>;
  find(notepadId: string): Promise<Notepad | null>;
  findListItem(notepadId: string): Promise<NotepadListItem | null>;
  list(query: NotepadListRowQuery): Promise<NotepadListItem[]>;
  /** Notepad ids for a project — feeds notepad-content blob cleanup. */
  listNotepadIds(projectPath: string): Promise<string[]>;
  updateOrganization(
    input: UpdateNotepadOrganizationInput,
  ): Promise<UpdateNotepadOrganizationResult>;
  delete(notepadId: string): Promise<Notepad | null>;
  writeContent(
    input: WriteNotepadContentInput,
  ): Promise<WriteNotepadContentResult>;
  listRevisions(notepadId: string, limit?: number): Promise<NotepadRevision[]>;
  findRevision(
    notepadId: string,
    revision: number,
  ): Promise<NotepadRevision | null>;
  addImage(image: NotepadImage): Promise<NotepadImage>;
  findImage(notepadId: string, imageId: string): Promise<NotepadImage | null>;
  listImages(notepadId: string): Promise<NotepadImage[]>;
  deleteImage(notepadId: string, imageId: string): Promise<NotepadImage | null>;
}

// ============================================================
// Row schemas and mappers
// ============================================================

const notepadsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    scope: z.string(),
    project_path: z.string().nullable(),
    name: z.string(),
    content: z.string(),
    revision: z.number().int(),
    write_mode: z.string(),
    pinned: z.number().int(),
    archived: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  "notepadsTableRowSchema",
);

const notepadRevisionsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    notepad_id: z.string(),
    revision: z.number().int(),
    content: z.string(),
    author_kind: z.string(),
    author_conversation_id: z.string().nullable(),
    origin: z.string(),
    base_revision: z.number().int().nullable(),
    restored_from_revision: z.number().int().nullable(),
    created_at: z.string(),
  }),
  "notepadRevisionsTableRowSchema",
);

const notepadImagesTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    notepad_id: z.string(),
    file_name: z.string(),
    media_type: z.string(),
    size_bytes: z.number().int(),
    sha256: z.string(),
    snapshot_key: z.string(),
    created_at: z.string(),
  }),
  "notepadImagesTableRowSchema",
);

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.notepads.schema_validation_failure", {
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

function rowToNotepad(rawRow: unknown): Notepad {
  const row = parseTrusted(notepadsTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("notepad", "<row>", issues),
  );
  return parseTrusted(
    notepadSchema,
    {
      id: row.id,
      scope: row.scope,
      projectPath: row.project_path,
      name: row.name,
      content: row.content,
      revision: row.revision,
      writeMode: row.write_mode,
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    (issues) => logAndThrowValidationFailure("notepad", row.id, issues),
  );
}

function rowToRevision(rawRow: unknown): NotepadRevision {
  const row = parseTrusted(notepadRevisionsTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("notepad_revision", "<row>", issues),
  );
  return parseTrusted(
    notepadRevisionSchema,
    {
      id: row.id,
      notepadId: row.notepad_id,
      revision: row.revision,
      content: row.content,
      authorKind: row.author_kind,
      authorConversationId: row.author_conversation_id,
      origin: row.origin,
      baseRevision: row.base_revision,
      restoredFromRevision: row.restored_from_revision,
      createdAt: row.created_at,
    },
    (issues) =>
      logAndThrowValidationFailure("notepad_revision", row.id, issues),
  );
}

function rowToImage(rawRow: unknown): NotepadImage {
  const row = parseTrusted(notepadImagesTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("notepad_image", "<row>", issues),
  );
  return parseTrusted(
    notepadImageSchema,
    {
      id: row.id,
      notepadId: row.notepad_id,
      fileName: row.file_name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      snapshotKey: row.snapshot_key,
      createdAt: row.created_at,
    },
    (issues) => logAndThrowValidationFailure("notepad_image", row.id, issues),
  );
}

/**
 * The content-free projection listings and SSE frames carry. Exported because
 * the service publishes it from the notepad a mutation already returned rather
 * than re-reading the row, and both paths must produce the identical shape.
 */
export function notepadToListItem(notepad: Notepad): NotepadListItem {
  return {
    id: notepad.id,
    scope: notepad.scope,
    projectPath: notepad.projectPath,
    projectName:
      notepad.projectPath === null
        ? null
        : projectNameFromPath(notepad.projectPath),
    name: notepad.name,
    revision: notepad.revision,
    writeMode: notepad.writeMode,
    pinned: notepad.pinned,
    archived: notepad.archived,
    createdAt: notepad.createdAt,
    updatedAt: notepad.updatedAt,
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
    logger.info(`state-store.notepads.${op}.timing`, {
      ...identifier,
      durationMs,
    });
  }
}

/** The revision origin each write operation records in history. */
const ORIGIN_BY_OPERATION = {
  update: "edit",
  append: "append",
  restore: "restore",
} as const;

/**
 * Measure the canonical text actually being persisted, in both columns that
 * hold it. Called from inside the write transaction — the derivation is a
 * length scan and the emission is deferred past the critical section — so the
 * measured value is the composed result, not an append payload that understates
 * what the row grew to.
 */
function checkContentSize(notepadId: string, content: string): void {
  checkRowColumnSize({
    logger,
    table: "notepads",
    column: "content",
    id: notepadId,
    value: content,
  });
  checkRowColumnSize({
    logger,
    table: "notepad_revisions",
    column: "content",
    id: notepadId,
    value: content,
  });
}

const LIST_ORDER_BY: Record<NotepadListRowQuery["sort"], string> = {
  name: "pinned DESC, name COLLATE NOCASE ASC, id ASC",
  recency: "pinned DESC, updated_at DESC, id ASC",
};

export function createNotepadsRepo(
  db: Db,
  writeQueue: WriteQueue,
): NotepadsRepo {
  const findByIdStmt = db.prepare(
    `SELECT * FROM notepads WHERE id = ? LIMIT 1`,
  );
  // The scoped-name lookup mirrors the unique index expression, so a conflict
  // is a typed result rather than a raised SQLITE_CONSTRAINT the caller would
  // have to decode.
  const findByScopedNameStmt = db.prepare(
    `SELECT id FROM notepads
      WHERE scope = @scope AND IFNULL(project_path, '') = @project_key
        AND name = @name
      LIMIT 1`,
  );
  const insertNotepadStmt = db.prepare(
    `INSERT INTO notepads
       (id, scope, project_path, name, content, revision, write_mode, pinned,
        archived, created_at, updated_at)
     VALUES
       (@id, @scope, @project_path, @name, @content, 1, @write_mode, 0, 0,
        @created_at, @created_at)`,
  );
  const insertRevisionStmt = db.prepare(
    `INSERT INTO notepad_revisions
       (id, notepad_id, revision, content, author_kind, author_conversation_id,
        origin, base_revision, restored_from_revision, created_at)
     VALUES
       (@id, @notepad_id, @revision, @content, @author_kind,
        @author_conversation_id, @origin, @base_revision,
        @restored_from_revision, @created_at)`,
  );
  const foldRevisionStmt = db.prepare(
    `UPDATE notepad_revisions
        SET content = @content, revision = @revision
      WHERE id = @id`,
  );
  const advanceHeadStmt = db.prepare(
    `UPDATE notepads
        SET content = @content, revision = @revision, updated_at = @updated_at
      WHERE id = @id`,
  );
  const deleteNotepadStmt = db.prepare(`DELETE FROM notepads WHERE id = ?`);
  const notepadIdsByProjectStmt = db
    .prepare(`SELECT id FROM notepads WHERE project_path = ? ORDER BY id ASC`)
    .pluck();
  const revisionsByNotepadStmt = db.prepare(
    `SELECT * FROM notepad_revisions WHERE notepad_id = ?
      ORDER BY revision ASC`,
  );
  const boundedRevisionsByNotepadStmt = db.prepare(
    `SELECT * FROM (
       SELECT * FROM notepad_revisions WHERE notepad_id = ?
        ORDER BY revision DESC LIMIT ?
     ) ORDER BY revision ASC`,
  );
  const findRevisionStmt = db.prepare(
    `SELECT * FROM notepad_revisions WHERE notepad_id = ? AND revision = ?
      LIMIT 1`,
  );
  const insertImageStmt = db.prepare(
    `INSERT INTO notepad_images
       (id, notepad_id, file_name, media_type, size_bytes, sha256, snapshot_key,
        created_at)
     VALUES
       (@id, @notepad_id, @file_name, @media_type, @size_bytes, @sha256,
        @snapshot_key, @created_at)`,
  );
  const findImageStmt = db.prepare(
    `SELECT * FROM notepad_images WHERE id = ? AND notepad_id = ? LIMIT 1`,
  );
  const imagesByNotepadStmt = db.prepare(
    `SELECT * FROM notepad_images WHERE notepad_id = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const deleteImageStmt = db.prepare(
    `DELETE FROM notepad_images WHERE id = ? AND notepad_id = ?`,
  );

  function readNotepad(notepadId: string): Notepad | null {
    const rawRow: unknown = findByIdStmt.get(notepadId);
    return rawRow === undefined ? null : rowToNotepad(rawRow);
  }

  function scopedNameTaken(
    scope: string,
    projectPath: string | null,
    name: string,
    exceptNotepadId?: string,
  ): boolean {
    const row = findByScopedNameStmt.get({
      scope,
      project_key: projectPath ?? "",
      name,
    }) as { id: string } | undefined;
    if (row === undefined) return false;
    return row.id !== exceptNotepadId;
  }

  const createTx = db.transaction(
    (input: CreateNotepadRowInput): CreateNotepadResult => {
      if (scopedNameTaken(input.scope, input.projectPath, input.name)) {
        return { status: "name_taken" };
      }
      checkContentSize(input.id, input.content);
      insertNotepadStmt.run({
        id: input.id,
        scope: input.scope,
        project_path: input.projectPath,
        name: input.name,
        content: input.content,
        write_mode: input.writeMode,
        created_at: input.createdAt,
      });
      insertRevisionStmt.run({
        id: input.revisionId,
        notepad_id: input.id,
        revision: 1,
        content: input.content,
        author_kind: input.authorKind,
        author_conversation_id: input.authorConversationId,
        origin: "create",
        base_revision: null,
        restored_from_revision: null,
        created_at: input.createdAt,
      });
      const notepad = readNotepad(input.id);
      if (notepad === null) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "notepad",
          identifier: input.id,
        });
      }
      return { status: "created", notepad };
    },
  );

  const updateOrganizationTx = db.transaction(
    (
      input: UpdateNotepadOrganizationInput,
    ): UpdateNotepadOrganizationResult => {
      const current = readNotepad(input.notepadId);
      if (current === null) return { status: "missing" };
      if (
        input.name !== undefined &&
        scopedNameTaken(
          current.scope,
          current.projectPath,
          input.name,
          current.id,
        )
      ) {
        return { status: "name_taken" };
      }
      const sets: string[] = ["updated_at = @updated_at"];
      const bind: Record<string, string | number> = {
        id: input.notepadId,
        updated_at: input.updatedAt,
      };
      if (input.name !== undefined) {
        sets.push("name = @name");
        bind.name = input.name;
      }
      if (input.pinned !== undefined) {
        sets.push("pinned = @pinned");
        bind.pinned = input.pinned ? 1 : 0;
      }
      if (input.archived !== undefined) {
        sets.push("archived = @archived");
        bind.archived = input.archived ? 1 : 0;
      }
      if (input.writeMode !== undefined) {
        sets.push("write_mode = @write_mode");
        bind.write_mode = input.writeMode;
      }
      db.prepare(`UPDATE notepads SET ${sets.join(", ")} WHERE id = @id`).run(
        bind,
      );
      const notepad = readNotepad(input.notepadId);
      if (notepad === null) return { status: "missing" };
      return { status: "updated", notepad };
    },
  );

  /**
   * The revision row this write folds into, or null when it must open its own.
   * A burst folds only into the head revision it wrote itself: same author kind
   * with no conversation attribution (the browser), an ordinary edit rather
   * than the create/restore/append rows that mark deliberate moments, and still
   * inside the caller's window measured from when the burst started.
   */
  function revisionToFoldInto(
    headRevision: number,
    input: WriteNotepadContentInput,
  ): NotepadRevision | null {
    if (input.coalesceWindowMs === null) return null;
    if (ORIGIN_BY_OPERATION[input.operation] !== "edit") return null;
    const rawHead: unknown = findRevisionStmt.get(
      input.notepadId,
      headRevision,
    );
    if (rawHead === undefined) return null;
    const head = rowToRevision(rawHead);
    if (head.origin !== "edit") return null;
    if (head.authorKind !== input.authorKind) return null;
    if (head.authorConversationId !== input.authorConversationId) return null;
    const age = Date.parse(input.writtenAt) - Date.parse(head.createdAt);
    if (Number.isNaN(age) || age < 0) return null;
    return age <= input.coalesceWindowMs ? head : null;
  }

  const writeContentTx = db.transaction(
    (input: WriteNotepadContentInput): WriteNotepadContentResult => {
      const current = readNotepad(input.notepadId);
      if (current === null) return { status: "missing" };
      // Ahead of the staleness check: a mode refusal is terminal, so reporting
      // a retryable stale revision instead would send the caller into a loop.
      if (
        input.permittedWriteModes !== null &&
        !input.permittedWriteModes.includes(current.writeMode)
      ) {
        return { status: "write_mode_refused", writeMode: current.writeMode };
      }
      if (
        input.enforceBaseRevision &&
        input.baseRevision !== current.revision
      ) {
        return { status: "stale", currentRevision: current.revision };
      }

      const content =
        input.operation === "append"
          ? composeAppendedNotepadContent(current.content, input.content)
          : input.content;
      const revision = current.revision + 1;
      checkContentSize(input.notepadId, content);

      const foldInto = revisionToFoldInto(current.revision, input);
      if (foldInto !== null) {
        // The burst's own row absorbs the save: content and revision number
        // advance, while created_at stays at the burst's start so the window
        // it is measured against cannot be pushed forward indefinitely.
        foldRevisionStmt.run({ id: foldInto.id, content, revision });
      } else {
        insertRevisionStmt.run({
          id: input.revisionId,
          notepad_id: input.notepadId,
          revision,
          content,
          author_kind: input.authorKind,
          author_conversation_id: input.authorConversationId,
          origin: ORIGIN_BY_OPERATION[input.operation],
          base_revision: input.baseRevision,
          restored_from_revision: input.restoredFromRevision,
          created_at: input.writtenAt,
        });
      }
      advanceHeadStmt.run({
        id: input.notepadId,
        content,
        revision,
        updated_at: input.writtenAt,
      });

      const notepad = readNotepad(input.notepadId);
      const rawRevision: unknown = findRevisionStmt.get(
        input.notepadId,
        revision,
      );
      if (notepad === null || rawRevision === undefined) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "notepad",
          identifier: input.notepadId,
        });
      }
      return {
        status: "written",
        notepad,
        revision: rowToRevision(rawRevision),
      };
    },
  );

  const deleteTx = db.transaction((notepadId: string): Notepad | null => {
    const notepad = readNotepad(notepadId);
    if (notepad === null) return null;
    deleteNotepadStmt.run(notepadId);
    return notepad;
  });

  const addImageTx = db.transaction((image: NotepadImage): NotepadImage => {
    insertImageStmt.run({
      id: image.id,
      notepad_id: image.notepadId,
      file_name: image.fileName,
      media_type: image.mediaType,
      size_bytes: image.sizeBytes,
      sha256: image.sha256,
      snapshot_key: image.snapshotKey,
      created_at: image.createdAt,
    });
    return image;
  });

  const deleteImageTx = db.transaction(
    (notepadId: string, imageId: string): NotepadImage | null => {
      const rawRow: unknown = findImageStmt.get(imageId, notepadId);
      if (rawRow === undefined) return null;
      const image = rowToImage(rawRow);
      deleteImageStmt.run(imageId, notepadId);
      return image;
    },
  );

  return {
    async create(input) {
      const validated = createNotepadRowInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("notepads.create", () =>
        timed("create", { id: validated.id, scope: validated.scope }, () =>
          createTx.immediate(validated),
        ),
      );
    },

    async find(notepadId) {
      return timed("find", { notepadId }, () => readNotepad(notepadId));
    },

    async findListItem(notepadId) {
      return timed("findListItem", { notepadId }, () => {
        const notepad = readNotepad(notepadId);
        return notepad === null ? null : notepadToListItem(notepad);
      });
    },

    async list(query) {
      const validated = notepadListRowQuerySchema.parse(query);
      const conditions: string[] = [];
      const bind: Record<string, string> = {};
      if (validated.scope !== undefined) {
        conditions.push("scope = @scope");
        bind.scope = validated.scope;
        if (
          validated.scope === "project" &&
          validated.projectPath !== undefined &&
          validated.projectPath !== null
        ) {
          conditions.push("project_path = @project_path");
          bind.project_path = validated.projectPath;
        }
      } else if (
        validated.projectPath !== undefined &&
        validated.projectPath !== null
      ) {
        // No scope filter plus a project means "everything this project's
        // sessions can reach": its own notepads merged with the global ones.
        conditions.push("(scope = 'global' OR project_path = @project_path)");
        bind.project_path = validated.projectPath;
      }
      if (!validated.includeArchived) {
        conditions.push("archived = 0");
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      return timed("list", { filters: conditions.length }, () => {
        const rows = db
          .prepare(
            `SELECT * FROM notepads ${where}
              ORDER BY ${LIST_ORDER_BY[validated.sort]}`,
          )
          .all(bind) as unknown[];
        return rows.map((row) => notepadToListItem(rowToNotepad(row)));
      });
    },

    async listNotepadIds(projectPath) {
      return timed("listNotepadIds", { projectPath }, () =>
        (notepadIdsByProjectStmt.all(projectPath) as unknown[]).filter(
          (id): id is string => typeof id === "string",
        ),
      );
    },

    async updateOrganization(input) {
      const validated = updateNotepadOrganizationInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("notepads.updateOrganization", () =>
        timed("updateOrganization", { notepadId: validated.notepadId }, () =>
          updateOrganizationTx.immediate(validated),
        ),
      );
    },

    async delete(notepadId) {
      return writeQueue.withWriteQueueSync("notepads.delete", () =>
        timed("delete", { notepadId }, () => deleteTx.immediate(notepadId)),
      );
    },

    async writeContent(input) {
      const validated = writeNotepadContentInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("notepads.writeContent", () =>
        timed(
          "writeContent",
          {
            notepadId: validated.notepadId,
            operation: validated.operation,
            authorKind: validated.authorKind,
          },
          () => writeContentTx.immediate(validated),
        ),
      );
    },

    async listRevisions(notepadId, limit) {
      return timed("listRevisions", { notepadId, limit }, () => {
        const rows = (
          limit === undefined
            ? revisionsByNotepadStmt.all(notepadId)
            : boundedRevisionsByNotepadStmt.all(notepadId, limit)
        ) as unknown[];
        return rows.map(rowToRevision);
      });
    },

    async findRevision(notepadId, revision) {
      return timed("findRevision", { notepadId, revision }, () => {
        const rawRow: unknown = findRevisionStmt.get(notepadId, revision);
        return rawRow === undefined ? null : rowToRevision(rawRow);
      });
    },

    async addImage(image) {
      const validated = notepadImageSchema.parse(image);
      return writeQueue.withWriteQueueSync("notepads.addImage", () =>
        timed(
          "addImage",
          { id: validated.id, notepadId: validated.notepadId },
          () => addImageTx.immediate(validated),
        ),
      );
    },

    async findImage(notepadId, imageId) {
      return timed("findImage", { notepadId, imageId }, () => {
        const rawRow: unknown = findImageStmt.get(imageId, notepadId);
        return rawRow === undefined ? null : rowToImage(rawRow);
      });
    },

    async listImages(notepadId) {
      return timed("listImages", { notepadId }, () =>
        (imagesByNotepadStmt.all(notepadId) as unknown[]).map(rowToImage),
      );
    },

    async deleteImage(notepadId, imageId) {
      return writeQueue.withWriteQueueSync("notepads.deleteImage", () =>
        timed("deleteImage", { notepadId, imageId }, () =>
          deleteImageTx.immediate(notepadId, imageId),
        ),
      );
    },
  };
}
