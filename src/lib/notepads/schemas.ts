import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

// ============================================================
// Enums
// ============================================================

export const notepadScopeSchema = z.enum(["global", "project"]);
export type NotepadScope = z.infer<typeof notepadScopeSchema>;

/**
 * The user's cooperative guardrail over agent writes — enforced in the service
 * for agent-attributed callers only, never for the user's own edits.
 */
export const notepadWriteModeSchema = z.enum([
  "read-only",
  "append-only",
  "full-edit",
]);
export type NotepadWriteMode = z.infer<typeof notepadWriteModeSchema>;

/** Revision history is the safety net, so new notepads start agent-writable. */
export const NOTEPAD_DEFAULT_WRITE_MODE: NotepadWriteMode = "full-edit";

export const notepadAuthorKindSchema = z.enum(["user", "agent"]);
export type NotepadAuthorKind = z.infer<typeof notepadAuthorKindSchema>;

export const notepadRevisionOriginSchema = z.enum([
  "create",
  "edit",
  "append",
  "restore",
]);
export type NotepadRevisionOrigin = z.infer<typeof notepadRevisionOriginSchema>;

export const notepadSortSchema = z.enum(["name", "recency"]);
export type NotepadSort = z.infer<typeof notepadSortSchema>;

export const notepadWriteOperationSchema = z.enum(["update", "append"]);
export type NotepadWriteOperation = z.infer<typeof notepadWriteOperationSchema>;

// ============================================================
// Scope pairing
// ============================================================

/**
 * A notepad is global or owned by exactly one project — the same pairing the
 * `notepads` CHECK constraint holds at the storage layer, restated here so a
 * malformed pairing is refused before it reaches SQLite. A discriminated union
 * would encode it in the type, but the round-trip durability harness and the
 * repository row mappers both need a plain object schema.
 */
function checkScopePairing(
  value: { scope: NotepadScope; projectPath: string | null },
  ctx: z.RefinementCtx,
): void {
  const expectsProject = value.scope === "project";
  if (expectsProject === (value.projectPath !== null)) return;
  ctx.addIssue({
    code: "custom",
    path: ["projectPath"],
    message: expectsProject
      ? "project-scoped notepads require a project path"
      : "global notepads cannot carry a project path",
  });
}

// ============================================================
// Notepad entity
// ============================================================

// Persisted-row schemas are effect-free (no defaults/transforms) so they stay
// eligible for `parseTrusted` registration; creation defaults live on the
// boundary input schemas instead.
export const notepadSchema = registerTrustedSchema(
  z
    .object({
      /** Caller-generated, immutable: the only key references ever resolve by. */
      id: z.string().min(1),
      scope: notepadScopeSchema,
      projectPath: z.string().min(1).nullable(),
      name: z.string().min(1),
      /** Canonical Markdown text with inline reference XML and image tokens. */
      content: z.string(),
      /** Monotonic per-notepad counter — the agent write compare-and-swap token. */
      revision: z.number().int().positive(),
      writeMode: notepadWriteModeSchema,
      pinned: z.boolean(),
      archived: z.boolean(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .superRefine(checkScopePairing),
  "notepadSchema",
);
export type Notepad = z.infer<typeof notepadSchema>;

export const notepadRevisionSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    notepadId: z.string().min(1),
    revision: z.number().int().positive(),
    /** Full snapshot, so restore is a row copy rather than a reconstruction. */
    content: z.string(),
    authorKind: notepadAuthorKindSchema,
    /** The conversation an agent write claims; always null for a user write. */
    authorConversationId: z.string().min(1).nullable(),
    origin: notepadRevisionOriginSchema,
    /** The revision the write was based on — null for `create`. */
    baseRevision: z.number().int().positive().nullable(),
    restoredFromRevision: z.number().int().positive().nullable(),
    createdAt: z.string().min(1),
  }),
  "notepadRevisionSchema",
);
export type NotepadRevision = z.infer<typeof notepadRevisionSchema>;

/** Metadata for an image whose bytes live in the notepad content store. */
export const notepadImageSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    notepadId: z.string().min(1),
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    snapshotKey: z.string().min(1),
    createdAt: z.string().min(1),
  }),
  "notepadImageSchema",
);
export type NotepadImage = z.infer<typeof notepadImageSchema>;

// ============================================================
// Review comments
// ============================================================

export const notepadCommentStatusSchema = z.enum(["open", "resolved"]);
export type NotepadCommentStatus = z.infer<typeof notepadCommentStatusSchema>;

/**
 * The block-scoped anchor document comments already use
 * (`commentAnchorSchema`), with one substitution: the notepad's integer
 * revision stands in for that domain's content hash, because the revision
 * counter is the version every other notepad surface states. Scope is a SINGLE
 * block — one `sectionId` + `line`, with offsets into that block's text — and
 * `prefix`/`suffix` are stored context that exact-match re-anchoring does not
 * consult.
 *
 * The field set is mirrored rather than imported: `document-comments/schemas`
 * reaches the conversation schema graph, which a module the state store loads
 * at open has no business dragging in. `schemas.test.ts` pins the parity so the
 * two shapes cannot drift apart silently.
 */
export const notepadCommentAnchorSchema = registerTrustedSchema(
  z.object({
    sectionId: z.string(),
    headingLabel: z.string(),
    line: z.number().int().positive(),
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().nonnegative(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    /** The notepad revision the passage was quoted from. */
    notepadRevision: z.number().int().positive(),
  }),
  "notepadCommentAnchorSchema",
);
export type NotepadCommentAnchor = z.infer<typeof notepadCommentAnchorSchema>;

/**
 * A review comment on one notepad passage. Attribution matches
 * `notepad_revisions`: an agent names the conversation that wrote it, a user
 * names nothing. `resolvedAt` is an explicit `string | null` so a never-resolved
 * comment is distinguishable from a field dropped on round-trip.
 */
export const notepadCommentSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    notepadId: z.string().min(1),
    anchor: notepadCommentAnchorSchema,
    body: z.string().min(1),
    status: notepadCommentStatusSchema,
    authorKind: notepadAuthorKindSchema,
    authorConversationId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    resolvedAt: z.string().min(1).nullable(),
  }),
  "notepadCommentSchema",
);
export type NotepadComment = z.infer<typeof notepadCommentSchema>;

/** How a comment was answered. Replies are discussion, so they never resolve. */
export const notepadCommentReplySchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    commentId: z.string().min(1),
    body: z.string().min(1),
    authorKind: notepadAuthorKindSchema,
    authorConversationId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  }),
  "notepadCommentReplySchema",
);
export type NotepadCommentReply = z.infer<typeof notepadCommentReplySchema>;

/** A comment with its replies — the unit every listing surface reads. */
export const notepadCommentThreadSchema = z.object({
  comment: notepadCommentSchema,
  replies: z.array(notepadCommentReplySchema),
});
export type NotepadCommentThread = z.infer<typeof notepadCommentThreadSchema>;

/** Whether the quoted passage still resolves in the notepad's current text. */
export const notepadCommentAnchorStateSchema = z.enum(["anchored", "stale"]);
export type NotepadCommentAnchorState = z.infer<
  typeof notepadCommentAnchorStateSchema
>;

/**
 * The commented passage as a reader of the notepad sees it TODAY: the captured
 * quote, where it sits, and whether it still resolves there. Quote and location
 * are stated over the canonical text form — the same string `cctl notepad get`
 * returns — so an agent reading the listing can find the passage in what it
 * reads.
 */
export const notepadCommentPassageSchema = z.object({
  quote: z.string(),
  /** Heading label plus line, or the line alone above the first heading. */
  location: z.string(),
  state: notepadCommentAnchorStateSchema,
});
export type NotepadCommentPassage = z.infer<typeof notepadCommentPassageSchema>;

/** A thread plus its passage — what the agent listing and review surface read. */
export const resolvedNotepadCommentThreadSchema =
  notepadCommentThreadSchema.extend({ passage: notepadCommentPassageSchema });
export type ResolvedNotepadCommentThread = z.infer<
  typeof resolvedNotepadCommentThreadSchema
>;

// ============================================================
// Change-notice delivery watermarks
// ============================================================

/**
 * What a conversation was last shown of one notepad's open review comments
 * (R21). A count plus the newest open comment's timestamp rather than a set of
 * ids: the notice only has to answer "are there open comments this conversation
 * has not seen", and the pair answers it without storing review content or
 * growing with the thread.
 */
export const notepadOpenCommentMarkerSchema = registerTrustedSchema(
  z.object({
    count: z.number().int().nonnegative(),
    /** Null when the notepad has no open comment at all. */
    latestCreatedAt: z.string().min(1).nullable(),
  }),
  "notepadOpenCommentMarkerSchema",
);
export type NotepadOpenCommentMarker = z.infer<
  typeof notepadOpenCommentMarkerSchema
>;

/**
 * Per conversation and notepad, the state last presented to the agent (D17).
 * Written when a reference is expanded into an agent-facing message, and
 * advanced again only after the backend accepts a message carrying a change
 * notice — so a delivery that fails before acceptance re-fires the notice.
 *
 * Content-free by construction: a watermark records versions, never the
 * notepad's text or a comment body.
 */
export const notepadDeliveryWatermarkSchema = registerTrustedSchema(
  z.object({
    conversationId: z.string().min(1),
    notepadId: z.string().min(1),
    /** The notepad revision whose content was last presented. */
    revision: z.number().int().positive(),
    openComments: notepadOpenCommentMarkerSchema,
    updatedAt: z.string().min(1),
  }),
  "notepadDeliveryWatermarkSchema",
);
export type NotepadDeliveryWatermark = z.infer<
  typeof notepadDeliveryWatermarkSchema
>;

// ============================================================
// List projection
// ============================================================

/**
 * Deliberately content-free: this projection rides SSE frames, and content can
 * be arbitrarily large. `.strict()` makes the omission enforceable rather than
 * conventional — a content-bearing projection is refused, not silently stripped.
 */
export const notepadListItemSchema = z
  .object({
    id: z.string().min(1),
    scope: notepadScopeSchema,
    projectPath: z.string().min(1).nullable(),
    projectName: z.string().min(1).nullable(),
    name: z.string().min(1),
    revision: z.number().int().positive(),
    writeMode: notepadWriteModeSchema,
    pinned: z.boolean(),
    archived: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type NotepadListItem = z.infer<typeof notepadListItemSchema>;

// ============================================================
// Boundary inputs
// ============================================================

/** Who is writing. Agent attribution is the claimed caller conversation. */
export const notepadAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      conversationId: z.string().min(1),
    })
    .strict(),
]);
export type NotepadAuthor = z.infer<typeof notepadAuthorSchema>;

export const createNotepadInputSchema = z
  .object({
    scope: notepadScopeSchema,
    projectPath: z.string().min(1).nullable(),
    name: z.string().min(1),
    content: z.string().default(""),
    writeMode: notepadWriteModeSchema.default(NOTEPAD_DEFAULT_WRITE_MODE),
    author: notepadAuthorSchema.default({ kind: "user" }),
  })
  .superRefine(checkScopePairing);
export type CreateNotepadInput = z.infer<typeof createNotepadInputSchema>;

/** Organization and write-mode changes; every field is independently optional. */
export const updateNotepadInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    writeMode: notepadWriteModeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "at least one field must be provided",
  });
export type UpdateNotepadInput = z.infer<typeof updateNotepadInputSchema>;

/**
 * An agent write MUST state the revision it is based on (the strict CAS
 * contract); a user write ordinarily does not, because a user save is never
 * refused for staleness — refusing it would discard keystrokes history cannot
 * recover. `enforceBaseRevision` is the narrow user opt-in for writes that are
 * conditional by nature (clip undo removes a suffix only while it is still the
 * tail): the stated base becomes a compare-and-swap, so a racing write refuses
 * instead of being silently overwritten.
 */
export const notepadContentWriteSchema = z
  .object({
    operation: notepadWriteOperationSchema,
    content: z.string(),
    author: notepadAuthorSchema,
    baseRevision: z.number().int().positive().optional(),
    enforceBaseRevision: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.author.kind === "agent" && value.baseRevision === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["baseRevision"],
        message: "agent writes must state the revision they are based on",
      });
    }
    if (
      value.enforceBaseRevision === true &&
      value.baseRevision === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baseRevision"],
        message: "an enforced write must state the revision it is based on",
      });
    }
  });
export type NotepadContentWrite = z.infer<typeof notepadContentWriteSchema>;

export const restoreNotepadRevisionInputSchema = z
  .object({
    revision: z.number().int().positive(),
    author: notepadAuthorSchema.default({ kind: "user" }),
  })
  .strict();
export type RestoreNotepadRevisionInput = z.infer<
  typeof restoreNotepadRevisionInputSchema
>;

/**
 * Creating a comment is the review surface's act. No write-mode gate applies
 * anywhere on the comment surface: a comment is review discussion, not content
 * mutation, and the write mode governs what agents may write INTO a notepad.
 */
export const createNotepadCommentInputSchema = z
  .object({
    anchor: notepadCommentAnchorSchema,
    body: z.string().min(1),
    author: notepadAuthorSchema.default({ kind: "user" }),
  })
  .strict();
export type CreateNotepadCommentInput = z.infer<
  typeof createNotepadCommentInputSchema
>;

export const replyToNotepadCommentInputSchema = z
  .object({
    body: z.string().min(1),
    author: notepadAuthorSchema,
  })
  .strict();
export type ReplyToNotepadCommentInput = z.infer<
  typeof replyToNotepadCommentInputSchema
>;

/**
 * Resolve and reopen are the same write in opposite directions, so they are one
 * input. The author is required because both are user acts: an agent-attributed
 * caller is refused rather than served.
 */
export const setNotepadCommentStatusInputSchema = z
  .object({
    status: notepadCommentStatusSchema,
    author: notepadAuthorSchema,
  })
  .strict();
export type SetNotepadCommentStatusInput = z.infer<
  typeof setNotepadCommentStatusInputSchema
>;

/** An absent status lists every comment; present narrows to one state. */
export const notepadCommentListQuerySchema = z
  .object({ status: notepadCommentStatusSchema.optional() })
  .strict();
export type NotepadCommentListQuery = z.infer<
  typeof notepadCommentListQuerySchema
>;

/**
 * `projectPath` merges a project's notepads into the global listing; `scope`
 * narrows to one of the two. Archived notepads are hidden by default and
 * reachable only when explicitly requested.
 */
export const notepadListQuerySchema = z
  .object({
    scope: notepadScopeSchema.optional(),
    projectPath: z.string().min(1).nullish(),
    includeArchived: z.boolean().default(false),
    sort: notepadSortSchema.default("recency"),
  })
  .strict();
export type NotepadListQuery = z.infer<typeof notepadListQuerySchema>;

// ============================================================
// Reference wire attributes
// ============================================================

/**
 * Attributes of the canonical self-closing notepad reference emitted by the
 * reference picker and the prompt-editor serializer. Hyphenated keys match the
 * wire-format attribute names exactly; a tag missing a required one stays plain
 * text. `project-name` is absent on a global notepad, and `name` is a display
 * snapshot only — chips and agent reads resolve through `notepad-id`, which is
 * why a rename never strands a captured reference.
 */
export const notepadRefAttrsSchema = z
  .object({
    "notepad-id": z.string().min(1),
    name: z.string().min(1),
    scope: notepadScopeSchema,
    "project-name": z.string().min(1).optional(),
    "read-command": z.string().min(1),
  })
  .strict();
export type NotepadRefAttrs = z.infer<typeof notepadRefAttrsSchema>;

// ============================================================
// Change event
// ============================================================

/**
 * Wire-only live-update frame. `.strict()` so the SSE envelope owns `_sentAt`
 * (stamps on send, strips on receive) — an extra key reaching the schema is a
 * bug, not tolerated drift — and so a well-meaning caller cannot widen the
 * frame with the notepad's content, which the transport rules keep off the bus.
 */
export const notepadChangedEventSchema = z
  .object({
    type: z.literal("notepad-changed"),
    /**
     * `comment-activity` covers every review act — created, replied, resolved,
     * reopened, deleted — because the one reaction it drives refetches the
     * notepad's comments regardless of which act occurred. One event with a
     * change discriminator, never a sibling event.
     */
    change: z.enum([
      "created",
      "updated",
      "organized",
      "restored",
      "deleted",
      "comment-activity",
    ]),
    notepadId: z.string().min(1),
    scope: notepadScopeSchema,
    projectPath: z.string().min(1).nullable(),
    /** The new head revision for content changes; null otherwise. */
    revision: z.number().int().positive().nullable(),
    authorKind: notepadAuthorKindSchema.nullable(),
    /** Null when the notepad is gone, so a list reaction can drop the row. */
    listItem: notepadListItemSchema.nullable(),
  })
  .strict();
export type NotepadChangedEvent = z.infer<typeof notepadChangedEventSchema>;
