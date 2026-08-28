import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import {
  notepadToListItem,
  type NotepadsRepo,
  type WriteNotepadContentInput,
} from "@/lib/state-store/notepads-repo";
import { publishNotepadChange } from "./events";
import {
  createNotepadInputSchema,
  notepadContentWriteSchema,
  notepadListQuerySchema,
  restoreNotepadRevisionInputSchema,
  updateNotepadInputSchema,
  type Notepad,
  type NotepadAuthor,
  type NotepadChangedEvent,
  type NotepadListItem,
  type NotepadRevision,
  type NotepadWriteMode,
  type NotepadWriteOperation,
} from "./schemas";

const logger = createLogger("notepads.service");

// ============================================================
// Error vocabulary
// ============================================================

export interface NotepadValidationIssue {
  path: string;
  message: string;
}

/**
 * Every refusal names its subject and carries a server-authored rationale and
 * instruction, so an HTTP mapper and the CLI can render the same explanation
 * without re-deriving why the write was refused.
 */
export type NotepadError =
  | {
      code: "validation_failed";
      message: string;
      rationale: string;
      instruction: string;
      issues: NotepadValidationIssue[];
    }
  | {
      code: "not_found";
      message: string;
      rationale: string;
      instruction: string;
      notepadId: string;
    }
  | {
      code: "name_taken";
      message: string;
      rationale: string;
      instruction: string;
      name: string;
    }
  | {
      code: "write_mode_refused";
      message: string;
      rationale: string;
      instruction: string;
      writeMode: NotepadWriteMode;
      operation: NotepadWriteOperation | "set-write-mode";
    }
  | {
      code: "stale_revision";
      message: string;
      rationale: string;
      instruction: string;
      currentRevision: number;
      baseRevision: number;
    };

export type NotepadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NotepadError };

function failure<T>(error: NotepadError): NotepadResult<T> {
  return { ok: false, error };
}

function validationFailed<T>(error: z.ZodError): NotepadResult<T> {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  return failure({
    code: "validation_failed",
    message: `The notepad request is not valid: ${issues
      .map((issue) => `${issue.path || "<root>"} ${issue.message}`)
      .join("; ")}`,
    rationale: "The request did not satisfy the notepad input contract.",
    instruction: "Correct the named fields and retry.",
    issues,
  });
}

function notFound<T>(notepadId: string): NotepadResult<T> {
  return failure({
    code: "not_found",
    message: `Notepad ${notepadId} does not exist.`,
    rationale:
      "The notepad was deleted, or the id came from a stale reference. Ids are immutable, so a live notepad always answers to the id it was created with.",
    instruction:
      "List notepads to find the current id, or drop the reference if the notepad is gone.",
    notepadId,
  });
}

function nameTaken<T>(name: string): NotepadResult<T> {
  return failure({
    code: "name_taken",
    message: `A notepad named ${name} already exists in this scope.`,
    rationale: "Notepad names are unique within their scope.",
    instruction:
      "Choose a different name, or use the existing notepad in this scope.",
    name,
  });
}

/** Refusals name the mode the caller ran into — that is the actionable fact. */
function writeModeRefused<T>(
  writeMode: NotepadWriteMode,
  operation: NotepadWriteOperation | "set-write-mode",
): NotepadResult<T> {
  const attempt =
    operation === "set-write-mode"
      ? "change the write mode of"
      : `${operation} the content of`;
  return failure({
    code: "write_mode_refused",
    message: `This notepad's write mode is ${writeMode}, which does not allow an agent to ${attempt} it.`,
    rationale:
      operation === "set-write-mode"
        ? "The write mode is the user's control over agent access; an agent changing it would defeat the control."
        : `The user set this notepad to ${writeMode} to govern what agents may write to it.`,
    instruction:
      operation === "set-write-mode"
        ? "Ask the user to change the write mode from the notepad panel."
        : "Ask the user to widen the write mode, or write somewhere you are permitted to.",
    writeMode,
    operation,
  });
}

function staleRevision<T>(
  currentRevision: number,
  baseRevision: number,
): NotepadResult<T> {
  return failure({
    code: "stale_revision",
    message: `This write states revision ${baseRevision}, but the notepad is now at revision ${currentRevision}.`,
    rationale:
      "Another writer changed the notepad after the revision this write was based on, and overwriting it blind would discard their content.",
    instruction: `Read the notepad again and retry the write against revision ${currentRevision}.`,
    currentRevision,
    baseRevision,
  });
}

// ============================================================
// Service contract
// ============================================================

export type CreateNotepadServiceInput = z.input<
  typeof createNotepadInputSchema
>;
export type UpdateNotepadServiceInput = z.input<
  typeof updateNotepadInputSchema
>;
export type NotepadContentWriteServiceInput = z.input<
  typeof notepadContentWriteSchema
>;
export type RestoreNotepadServiceInput = z.input<
  typeof restoreNotepadRevisionInputSchema
>;
export type NotepadListServiceQuery = z.input<typeof notepadListQuerySchema>;

export interface NotepadService {
  create(input: CreateNotepadServiceInput): Promise<NotepadResult<Notepad>>;
  list(
    query: NotepadListServiceQuery,
  ): Promise<NotepadResult<NotepadListItem[]>>;
  get(notepadId: string): Promise<NotepadResult<Notepad>>;
  /**
   * Organization and write-mode changes. The author is required because the
   * write mode is the user's control over agents: an agent-attributed caller is
   * refused when the change would touch it.
   */
  update(
    notepadId: string,
    input: UpdateNotepadServiceInput,
    author: NotepadAuthor,
  ): Promise<NotepadResult<Notepad>>;
  delete(notepadId: string): Promise<NotepadResult<Notepad>>;
  writeContent(
    notepadId: string,
    input: NotepadContentWriteServiceInput,
  ): Promise<NotepadResult<Notepad>>;
  restore(
    notepadId: string,
    input: RestoreNotepadServiceInput,
  ): Promise<NotepadResult<Notepad>>;
  listRevisions(
    notepadId: string,
    limit?: number,
  ): Promise<NotepadResult<NotepadRevision[]>>;
  /**
   * One revision and its immediate predecessor, addressed by revision number
   * rather than by position in a bounded listing — so a selection or diff
   * target resolves however far the head has advanced past any listed page.
   * Ascending order like `listRevisions`; the create revision resolves alone.
   */
  resolveRevision(
    notepadId: string,
    revision: number,
  ): Promise<NotepadResult<NotepadRevision[]>>;
}

export interface NotepadServiceDeps {
  repo: NotepadsRepo;
  publish: PublishFn;
  /**
   * Removes the notepad's image bytes from the content store. The row cascade
   * reaches only the database, so without this the files outlive their rows.
   */
  deleteNotepadContent(notepadId: string): Promise<void>;
  now(): string;
  generateId(): string;
}

// ============================================================
// Write-mode policy
// ============================================================

/**
 * What an AGENT-attributed write may do at each mode. A user write never
 * consults this: the mode is the user's control over agents, not over
 * themselves, so mode-checking their own edits would lock them out of their own
 * notepad.
 *
 * `restore` is checked as an update: it replaces the whole content, so letting
 * it through on a read-only or append-only notepad would be a hole in exactly
 * the control the mode exists to provide.
 */
const AGENT_ALLOWED_OPERATIONS: Record<
  NotepadWriteMode,
  ReadonlySet<NotepadWriteOperation>
> = {
  "read-only": new Set(),
  "append-only": new Set<NotepadWriteOperation>(["append"]),
  "full-edit": new Set<NotepadWriteOperation>(["update", "append"]),
};

/**
 * The modes an agent may perform this operation under, handed to the repository
 * so the decision is applied against the row inside the write transaction.
 *
 * The check cannot stay here: changing the write mode does not advance the
 * revision, so a user narrowing the mode between this decision and the
 * serialized write would leave the compare-and-swap token valid and the write
 * would land under a mode that forbids it. The policy is still owned here —
 * only its evaluation point moved next to the row it governs.
 */
function agentPermittedModes(
  operation: NotepadWriteOperation,
): NotepadWriteMode[] {
  const modes = Object.keys(AGENT_ALLOWED_OPERATIONS) as NotepadWriteMode[];
  return modes.filter((mode) => AGENT_ALLOWED_OPERATIONS[mode].has(operation));
}

/**
 * How long consecutive user edits keep writing into one revision. The editor
 * autosaves every few seconds, which is the right cadence for durability and
 * the wrong one for history: without folding, a minute of typing buries the
 * revisions worth restoring under a dozen keystroke snapshots. Each save still
 * advances the revision number, so agents' compare-and-swap writes are
 * unaffected — only the number of rows the user browses changes.
 *
 * Agent writes, restores, and appends are deliberate single acts and never
 * fold, so a burst can never absorb another party's revision.
 */
export const USER_REVISION_COALESCE_WINDOW_MS = 2 * 60 * 1000;

export function createNotepadService(deps: NotepadServiceDeps): NotepadService {
  function publishChange(
    change: NotepadChangedEvent["change"],
    notepad: Notepad,
    options: {
      revision?: number | null;
      authorKind?: NotepadChangedEvent["authorKind"];
      listItem?: NotepadListItem | null;
    } = {},
  ): void {
    publishNotepadChange({
      publish: deps.publish,
      logger,
      change,
      notepadId: notepad.id,
      scope: notepad.scope,
      projectPath: notepad.projectPath,
      revision: options.revision ?? null,
      authorKind: options.authorKind ?? null,
      // Projected from the notepad the mutation already returned rather than
      // re-read, so publication adds no query to a committed write.
      listItem:
        options.listItem === undefined
          ? notepadToListItem(notepad)
          : options.listItem,
    });
  }

  /**
   * One content-write path for update, append, and restore: decide the
   * write-mode policy for agent callers, then hand the repository a write that
   * states both that decision and whether it is a compare-and-swap. Both are
   * applied against the row inside the write transaction.
   */
  async function writeContentInternal(input: {
    notepadId: string;
    operation: WriteNotepadContentInput["operation"];
    modeCheckedAs: NotepadWriteOperation;
    content: string;
    author: NotepadAuthor;
    baseRevision: number | null;
    restoredFromRevision: number | null;
    change: NotepadChangedEvent["change"];
  }): Promise<NotepadResult<Notepad>> {
    const isAgent = input.author.kind === "agent";

    const written = await deps.repo.writeContent({
      notepadId: input.notepadId,
      revisionId: deps.generateId(),
      operation: input.operation,
      content: input.content,
      authorKind: input.author.kind,
      authorConversationId:
        input.author.kind === "agent" ? input.author.conversationId : null,
      baseRevision: input.baseRevision,
      // Only an agent write is a compare-and-swap. A user save whose base is
      // stale still lands as the next revision — refusing it would discard
      // keystrokes, the one loss revision history cannot recover.
      enforceBaseRevision: isAgent,
      // A user write is not mode-governed: the mode is their control over
      // agents, not over themselves.
      permittedWriteModes: isAgent
        ? agentPermittedModes(input.modeCheckedAs)
        : null,
      restoredFromRevision: input.restoredFromRevision,
      writtenAt: deps.now(),
      // Only the user's own editing burst folds: an agent write is one
      // deliberate act, and a restore or append is a moment history must keep
      // as its own entry.
      coalesceWindowMs:
        !isAgent && input.operation === "update"
          ? USER_REVISION_COALESCE_WINDOW_MS
          : null,
    });

    if (written.status === "missing") return notFound(input.notepadId);
    if (written.status === "write_mode_refused") {
      logger.info("notepads.service.write_mode_refused", {
        notepadId: input.notepadId,
        writeMode: written.writeMode,
        operation: input.modeCheckedAs,
      });
      return writeModeRefused(written.writeMode, input.modeCheckedAs);
    }
    if (written.status === "stale") {
      logger.info("notepads.service.stale_write_refused", {
        notepadId: input.notepadId,
        currentRevision: written.currentRevision,
        baseRevision: input.baseRevision,
      });
      return staleRevision(written.currentRevision, input.baseRevision ?? 0);
    }

    logger.info("notepads.service.content_written", {
      notepadId: input.notepadId,
      operation: input.operation,
      authorKind: input.author.kind,
      revision: written.notepad.revision,
    });
    publishChange(input.change, written.notepad, {
      revision: written.notepad.revision,
      authorKind: input.author.kind,
    });
    return { ok: true, value: written.notepad };
  }

  return {
    async create(input) {
      const parsed = createNotepadInputSchema.safeParse(input);
      if (!parsed.success) return validationFailed(parsed.error);
      const { scope, projectPath, name, content, writeMode, author } =
        parsed.data;

      const created = await deps.repo.create({
        id: deps.generateId(),
        revisionId: deps.generateId(),
        scope,
        projectPath,
        name,
        content,
        writeMode,
        authorKind: author.kind,
        authorConversationId:
          author.kind === "agent" ? author.conversationId : null,
        createdAt: deps.now(),
      });
      if (created.status === "name_taken") {
        logger.info("notepads.service.create.name_taken", { scope, name });
        return nameTaken(name);
      }

      logger.info("notepads.service.created", {
        notepadId: created.notepad.id,
        scope,
        writeMode,
      });
      publishChange("created", created.notepad, {
        revision: created.notepad.revision,
        authorKind: author.kind,
      });
      return { ok: true, value: created.notepad };
    },

    async list(query) {
      const parsed = notepadListQuerySchema.safeParse(query);
      if (!parsed.success) return validationFailed(parsed.error);
      const items = await deps.repo.list({
        ...(parsed.data.scope !== undefined
          ? { scope: parsed.data.scope }
          : {}),
        ...(parsed.data.projectPath !== undefined
          ? { projectPath: parsed.data.projectPath }
          : {}),
        includeArchived: parsed.data.includeArchived,
        sort: parsed.data.sort,
      });
      return { ok: true, value: items };
    },

    async get(notepadId) {
      const notepad = await deps.repo.find(notepadId);
      if (notepad === null) return notFound(notepadId);
      return { ok: true, value: notepad };
    },

    async update(notepadId, input, author) {
      const parsed = updateNotepadInputSchema.safeParse(input);
      if (!parsed.success) return validationFailed(parsed.error);

      const current = await deps.repo.find(notepadId);
      if (current === null) return notFound(notepadId);

      // An agent can never loosen its own leash: the mode is the user's control.
      if (parsed.data.writeMode !== undefined && author.kind === "agent") {
        logger.info("notepads.service.write_mode_change_refused", {
          notepadId,
          writeMode: current.writeMode,
        });
        return writeModeRefused(current.writeMode, "set-write-mode");
      }

      const updated = await deps.repo.updateOrganization({
        notepadId,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.pinned !== undefined
          ? { pinned: parsed.data.pinned }
          : {}),
        ...(parsed.data.archived !== undefined
          ? { archived: parsed.data.archived }
          : {}),
        ...(parsed.data.writeMode !== undefined
          ? { writeMode: parsed.data.writeMode }
          : {}),
        updatedAt: deps.now(),
      });
      if (updated.status === "missing") return notFound(notepadId);
      if (updated.status === "name_taken") {
        return nameTaken(parsed.data.name ?? current.name);
      }

      logger.info("notepads.service.organized", {
        notepadId,
        renamed: parsed.data.name !== undefined,
        pinned: parsed.data.pinned,
        archived: parsed.data.archived,
        writeMode: parsed.data.writeMode,
      });
      publishChange("organized", updated.notepad, {
        authorKind: author.kind,
      });
      return { ok: true, value: updated.notepad };
    },

    async delete(notepadId) {
      const deleted = await deps.repo.delete(notepadId);
      if (deleted === null) return notFound(notepadId);

      // Blob cleanup runs only once no live row can reference the bytes, and it
      // never fails the deletion: an orphaned directory is recoverable from the
      // warning below, a half-deleted notepad is not.
      try {
        await deps.deleteNotepadContent(notepadId);
      } catch (error) {
        logger.warn("notepads.service.content_cleanup_failed", {
          notepadId,
          orphanPathKey: notepadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.info("notepads.service.deleted", {
        notepadId,
        scope: deleted.scope,
      });
      publishChange("deleted", deleted, { listItem: null });
      return { ok: true, value: deleted };
    },

    async writeContent(notepadId, input) {
      const parsed = notepadContentWriteSchema.safeParse(input);
      if (!parsed.success) return validationFailed(parsed.error);
      const { operation, content, author, baseRevision } = parsed.data;

      return writeContentInternal({
        notepadId,
        operation,
        modeCheckedAs: operation,
        content,
        author,
        baseRevision: baseRevision ?? null,
        restoredFromRevision: null,
        change: "updated",
      });
    },

    async restore(notepadId, input) {
      const parsed = restoreNotepadRevisionInputSchema.safeParse(input);
      if (!parsed.success) return validationFailed(parsed.error);
      const { revision, author } = parsed.data;

      const source = await deps.repo.findRevision(notepadId, revision);
      if (source === null) {
        // Distinguishing the missing notepad from the missing revision would
        // add a lookup for no actionable difference: either way, that content
        // is not there to restore.
        return notFound(notepadId);
      }

      const current = await deps.repo.find(notepadId);
      if (current === null) return notFound(notepadId);

      return writeContentInternal({
        notepadId,
        operation: "restore",
        modeCheckedAs: "update",
        content: source.content,
        author,
        // Restore is a user act taken against what is on screen; the CAS token
        // it states is the current head, so it never races itself.
        baseRevision: author.kind === "agent" ? current.revision : null,
        restoredFromRevision: revision,
        change: "restored",
      });
    },

    async listRevisions(notepadId, limit) {
      const notepad = await deps.repo.find(notepadId);
      if (notepad === null) return notFound(notepadId);
      const revisions = await deps.repo.listRevisions(notepadId, limit);
      return { ok: true, value: revisions };
    },

    async resolveRevision(notepadId, revision) {
      const target = await deps.repo.findRevision(notepadId, revision);
      // As with restore: the missing notepad and the missing revision are the
      // same actionable fact — that revision is not there to read.
      if (target === null) return notFound(notepadId);
      // The repo owns a dense revision counter — create writes revision 1,
      // every later write head+1, and history is never pruned — so the
      // immediate predecessor of revision N is exactly N-1.
      const predecessor =
        revision > 1
          ? await deps.repo.findRevision(notepadId, revision - 1)
          : null;
      return {
        ok: true,
        value: predecessor === null ? [target] : [predecessor, target],
      };
    },
  };
}
