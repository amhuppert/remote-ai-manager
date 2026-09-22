import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

/**
 * Memory Note domain contracts (spec `memory`, R1-R4 and D1-D3).
 *
 * A Memory Note is markdown prose the state store owns: a one-line fact-bearing
 * hook, a capped body, and — on durable kinds only — one separately leased
 * `statusNote` holding the perishable half of the same capture. The separation
 * is the spec's central staleness decision (D2): a stale status line is withheld
 * while the durable hook and body keep flowing, which is impossible once status
 * is woven into the body prose.
 *
 * Persisted-row schemas here are effect-free (no defaults, no transforms) so
 * they stay eligible for `parseTrusted` registration; creation-time defaults
 * (the opening status lease, the generated slug) belong to the write path.
 */

/**
 * The body cap the spec states as 8 KiB, measured in BYTES. A character count
 * would let a body of multi-byte prose persist at up to four times the intended
 * size, and the cap exists to bound what one note can spend of a delivery
 * budget measured in bytes.
 */
export const MEMORY_BODY_MAX_BYTES = 8192;

/**
 * Aliases are hand-authored resolution handles (a rename leaves the old slug
 * behind as one), so the list is small by construction. The static bound is
 * what discharges the persisted-blob gate for the revision snapshot.
 */
export const MEMORY_MAX_ALIASES = 16;

/** A hook and a status line are single lines wherever they are rendered. */
const SINGLE_LINE = /^[^\r\n]+$/;

export const memoryScopeSchema = z.enum(["global", "project", "session"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryKindSchema = z.enum([
  "lesson",
  "procedure",
  "preference",
  "state",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryIndexModeSchema = z.enum(["auto", "always", "search-only"]);
export type MemoryIndexMode = z.infer<typeof memoryIndexModeSchema>;

export const memoryLifecycleSchema = z.enum(["proposed", "active", "archived"]);
export type MemoryLifecycle = z.infer<typeof memoryLifecycleSchema>;

export const memoryAuthorKindSchema = z.enum(["user", "agent"]);
export type MemoryAuthorKind = z.infer<typeof memoryAuthorKindSchema>;

export const memoryLinkKindSchema = z.enum(["about", "source"]);
export type MemoryLinkKind = z.infer<typeof memoryLinkKindSchema>;

export const memoryRevisionOriginSchema = z.enum([
  "create",
  "edit",
  "restore",
  "archive",
]);
export type MemoryRevisionOrigin = z.infer<typeof memoryRevisionOriginSchema>;

/**
 * The perishable half of a durable capture: one line, its own updated-at, and
 * its own review lease. `reviewAfter` is the statusNote's lease and is
 * independent of the note-level one, because the two levels are withheld
 * differently (R2).
 */
export const memoryStatusNoteSchema = z.object({
  text: z
    .string()
    .min(1)
    .regex(SINGLE_LINE, "statusNote text must be one line"),
  updatedAt: z.string().min(1),
  reviewAfter: z.string().min(1),
});
export type MemoryStatusNote = z.infer<typeof memoryStatusNoteSchema>;

export function memoryBodyByteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

interface ScopedKindShape {
  readonly scope: MemoryScope;
  readonly projectPath: string | null;
  readonly sessionName: string | null;
  readonly sessionCreatedAt: string | null;
  readonly kind: MemoryKind;
  readonly body: string;
  readonly statusNote: MemoryStatusNote | null;
}

/**
 * The rules that span fields, restated here so a malformed note is refused
 * before it reaches SQLite — the storage-layer CHECK constraints hold the same
 * three shapes from the other side.
 *
 * A discriminated union would encode the scope/owner pairing in the type, but
 * the round-trip durability harness and the repository row mappers both need a
 * plain object schema.
 */
function checkNoteInvariants(
  value: ScopedKindShape,
  ctx: z.RefinementCtx,
): void {
  const bytes = memoryBodyByteLength(value.body);
  if (bytes > MEMORY_BODY_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["body"],
      message: `body is ${bytes} bytes, over the ${MEMORY_BODY_MAX_BYTES}-byte (8 KiB) limit`,
    });
  }

  // Scope and owner in both directions: a project-scoped note can never lose
  // its owner, a global note can never acquire one, and a session note binds to
  // the exact incarnation (name plus created-at) rather than the reusable name.
  const expectsProject = value.scope !== "global";
  if (expectsProject !== (value.projectPath !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["projectPath"],
      message: expectsProject
        ? "project- and session-scoped notes require a project path"
        : "global notes cannot carry a project path",
    });
  }
  const expectsSession = value.scope === "session";
  if (expectsSession !== (value.sessionName !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["sessionName"],
      message: expectsSession
        ? "session-scoped notes require the session incarnation's name"
        : "only session-scoped notes carry a session name",
    });
  }
  if ((value.sessionName === null) !== (value.sessionCreatedAt === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["sessionCreatedAt"],
      message:
        "session identity is the incarnation: name and created-at are set together",
    });
  }

  // The wholly perishable kind lives at session scope and dies with it, so it
  // has no durable half to keep delivering and never nests a status line.
  if (value.kind === "state" && value.scope !== "session") {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: "the state kind is legal only at session scope",
    });
  }
  if (value.kind === "state" && value.statusNote !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["statusNote"],
      message: "a state note is wholly perishable and cannot nest a statusNote",
    });
  }
}

export const memoryNoteSchema = registerTrustedSchema(
  z
    .object({
      /** Immutable internal identity: link rows, revisions, and watermarks
       * resolve by it, and it never appears in default agent-facing text. */
      id: z.string().min(1),
      /** The scope-local agent-facing handle (D3). */
      slug: z.string().min(1),
      scope: memoryScopeSchema,
      projectPath: z.string().min(1).nullable(),
      sessionName: z.string().min(1).nullable(),
      /** The session's created-at: the incarnation half of session identity. */
      sessionCreatedAt: z.string().min(1).nullable(),
      kind: memoryKindSchema,
      hook: z
        .string()
        .min(1)
        .regex(SINGLE_LINE, "the hook must be a single line"),
      /** Markdown prose, capped in bytes by `checkNoteInvariants`. */
      body: z.string(),
      statusNote: memoryStatusNoteSchema.nullable(),
      aliases: z.array(z.string().min(1)).max(MEMORY_MAX_ALIASES),
      indexMode: memoryIndexModeSchema,
      lifecycle: memoryLifecycleSchema,
      /** The note-level review lease; null means the note never leases out. */
      reviewAfter: z.string().min(1).nullable(),
      expiresAt: z.string().min(1).nullable(),
      /** The predecessor this note replaced, and the successor that replaced
       * it — the supersession lineage read from either end. */
      supersedesId: z.string().min(1).nullable(),
      supersededById: z.string().min(1).nullable(),
      createdBy: memoryAuthorKindSchema,
      authorConversationId: z.string().min(1).nullable(),
      /** Monotonic per-note counter: the compare-and-swap token every edit
       * states (R1). */
      revision: z.number().int().positive(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .superRefine(checkNoteInvariants),
  "memoryNoteSchema",
);
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

/**
 * The native artifact a link resolves. Identity is the artifact's own immutable
 * one — a session's is its exact incarnation, so a reused session name cannot
 * inherit the previous incarnation's links.
 */
export const memoryArtifactRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), ticketId: z.string().min(1) }),
  z.object({ kind: z.literal("spec"), specId: z.string().min(1) }),
  z.object({
    kind: z.literal("session"),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    sessionCreatedAt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("workflow_execution"),
    executionId: z.string().min(1),
  }),
  // One execution context of a run — the unit linked-only delivery is exact
  // to (R10.1). Context ids are unique only within their execution, so the
  // reference carries both.
  z.object({
    kind: z.literal("workflow_context"),
    executionId: z.string().min(1),
    contextId: z.string().min(1),
  }),
]);
export type MemoryArtifactRef = z.infer<typeof memoryArtifactRefSchema>;

export const memoryArtifactKindSchema = z.enum([
  "ticket",
  "spec",
  "session",
  "workflow_execution",
  "workflow_context",
]);

/**
 * A link is a relationship and nothing more: `about` is a deterministic
 * relevance cue and `source` is provenance that never affects selection (R8).
 * Neither carries freshness state — a claim an artifact transition could
 * falsify is a claim about that artifact's state, which agents read live and
 * never record (D6) — so a link row holds no target and no observed token.
 */
export const memoryLinkSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    memoryId: z.string().min(1),
    kind: memoryLinkKindSchema,
    artifact: memoryArtifactRefSchema,
    createdAt: z.string().min(1),
  }),
  "memoryLinkSchema",
);
export type MemoryLink = z.infer<typeof memoryLinkSchema>;

/**
 * One revision holds the WHOLE note as it stood, so restore is a snapshot copy
 * forward rather than a reconstruction, and history stays readable after the
 * head has moved on.
 */
export const memoryNoteRevisionSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    memoryId: z.string().min(1),
    revision: z.number().int().positive(),
    snapshot: memoryNoteSchema,
    origin: memoryRevisionOriginSchema,
    /** The revision the write was based on — null for `create`. */
    baseRevision: z.number().int().positive().nullable(),
    restoredFromRevision: z.number().int().positive().nullable(),
    authorKind: memoryAuthorKindSchema,
    authorConversationId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  }),
  "memoryNoteRevisionSchema",
);
export type MemoryNoteRevision = z.infer<typeof memoryNoteRevisionSchema>;

/**
 * The exact session incarnation a session-scoped note belongs to. Names are
 * reused across sessions, so the created-at is half of the identity: a later
 * session that takes the same name is a different incarnation and sees none of
 * the earlier one's notes (R3.1).
 */
export const memorySessionIncarnationSchema = z.object({
  sessionName: z.string().min(1),
  sessionCreatedAt: z.string().min(1),
});

/**
 * An incarnation named from OUTSIDE its project — the session-filtered review
 * queue and the promotion-candidate count (R10). A session name plus created-at
 * is only unique within a project: two projects can each hold a session of the
 * same name created in the same second, and a filter missing the project path
 * silently merges their candidates.
 */
export const memoryProjectSessionRefSchema =
  memorySessionIncarnationSchema.extend({
    projectPath: z.string().min(1),
  });
export type MemoryProjectSessionRef = z.infer<
  typeof memoryProjectSessionRefSchema
>;

/**
 * What one conversation can see: global always, plus its project, plus — for a
 * session conversation — its own incarnation (R3). A session without a project
 * is not a scope a conversation can occupy, so the pairing is refused rather
 * than silently widening the read.
 */
export const memoryVisibilitySchema = z
  .object({
    projectPath: z.string().min(1).nullable(),
    session: memorySessionIncarnationSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.session !== null && value.projectPath === null) {
      ctx.addIssue({
        code: "custom",
        path: ["projectPath"],
        message: "a session incarnation is always visible within its project",
      });
    }
  });
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;

// ============================================================
// Write-path contracts (spec R4, R9, D3, D8, D10)
// ============================================================

/**
 * The default review lease a statusNote receives whenever its text is written
 * (R2). Fourteen days is the spec's number; the freshness engine reads the
 * resulting `reviewAfter`, it does not recompute the default.
 */
export const MEMORY_STATUS_NOTE_LEASE_DAYS = 14;
export const MEMORY_STATUS_NOTE_LEASE_MS =
  MEMORY_STATUS_NOTE_LEASE_DAYS * 24 * 60 * 60 * 1000;

/**
 * A slug is the agent-facing handle (D3), so it is kept to the characters a
 * shell argument and a wikilink both carry unquoted.
 */
export const MEMORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const memorySlugSchema = z
  .string()
  .min(1)
  .regex(
    MEMORY_SLUG_PATTERN,
    "a slug is lowercase letters, digits, and single hyphens",
  );

/**
 * Who is writing and what they can see. The visibility is the actor's own
 * scope union (R3): it bounds handle resolution and is the authority every
 * write is checked against — a note's scope owner must lie inside it, which is
 * what makes "scope authority" one rule for both actor kinds. The kinds differ
 * only where the spec says they do: an agent's global create lands as a
 * proposal, and proposal approval is a human act (R9).
 */
export const memoryActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), visibility: memoryVisibilitySchema }),
  z.object({
    kind: z.literal("agent"),
    conversationId: z.string().min(1),
    visibility: memoryVisibilitySchema,
  }),
]);
export type MemoryActor = z.infer<typeof memoryActorSchema>;

/**
 * The scope owner comes from the actor, never from the request: `scope` picks
 * which level of the actor's visibility the note binds to. A request cannot
 * name another project or session, so the authority check is that the chosen
 * level exists in the actor's visibility rather than a comparison of paths.
 */
export const createMemoryNoteRequestSchema = z
  .object({
    scope: memoryScopeSchema,
    kind: memoryKindSchema,
    hook: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "the hook must be a single line"),
    body: z.string().default(""),
    /** Omitted: derived from the hook and made collision-safe (R4). */
    slug: memorySlugSchema.optional(),
    aliases: z
      .array(z.string().min(1).regex(SINGLE_LINE, "an alias is one line"))
      .max(MEMORY_MAX_ALIASES)
      .default([]),
    /** The status line's text; its lease and updated-at are stamped on write. */
    statusNote: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "statusNote text must be one line")
      .nullable()
      .default(null),
    indexMode: memoryIndexModeSchema.default("auto"),
    reviewAfter: z.string().min(1).nullable().default(null),
    expiresAt: z.string().min(1).nullable().default(null),
    /** A handle (slug, alias, or id) of the note this one replaces (R1). */
    supersedes: z.string().min(1).nullable().default(null),
  })
  .strict();
export type CreateMemoryNoteRequest = z.input<
  typeof createMemoryNoteRequestSchema
>;

/**
 * Lifecycle is absent on purpose: archive, restore, and the proposal acts each
 * own one transition, so an edit can never smuggle an approval (R9).
 */
export const updateMemoryNoteRequestSchema = z
  .object({
    /** The compare-and-swap token: the revision the caller read (R1). */
    baseRevision: z.number().int().positive(),
    hook: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "the hook must be a single line")
      .optional(),
    body: z.string().optional(),
    /** A rename; the old slug stays behind as an alias (R4). */
    slug: memorySlugSchema.optional(),
    aliases: z
      .array(z.string().min(1).regex(SINGLE_LINE, "an alias is one line"))
      .max(MEMORY_MAX_ALIASES)
      .optional(),
    /** New text re-leases the line; null clears it; omitted leaves it. */
    statusNote: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "statusNote text must be one line")
      .nullable()
      .optional(),
    indexMode: memoryIndexModeSchema.optional(),
    reviewAfter: z.string().min(1).nullable().optional(),
    expiresAt: z.string().min(1).nullable().optional(),
  })
  .strict();
export type UpdateMemoryNoteRequest = z.input<
  typeof updateMemoryNoteRequestSchema
>;

/**
 * Ordinary whole-note lifecycle acts (archive, restore) state a base revision
 * only when the caller has one to state; null is the Library button acting on
 * what is on screen.
 */
export const memoryLifecycleActRequestSchema = z
  .object({
    baseRevision: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type MemoryLifecycleActRequest = z.input<
  typeof memoryLifecycleActRequestSchema
>;

/**
 * A proposal decision (approve, reject) always names the proposed revision the
 * human reviewed. Approval activates content unchanged, so an unstated base
 * would let a decision activate an edit the human never read, or overwrite a
 * rejection another tab recorded meanwhile (R9, D8).
 */
export const memoryProposalDecisionRequestSchema = z
  .object({
    baseRevision: z.number().int().positive(),
  })
  .strict();
export type MemoryProposalDecisionRequest = z.input<
  typeof memoryProposalDecisionRequestSchema
>;

export const restoreMemoryNoteRequestSchema = z
  .object({
    /** The historical revision copied forward as the new head (R1). */
    revision: z.number().int().positive(),
    baseRevision: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type RestoreMemoryNoteRequest = z.input<
  typeof restoreMemoryNoteRequestSchema
>;

/**
 * The promotion act (R10): a session note becomes a project note by being
 * superseded, never by mutation, so this is a create request in the shape of
 * the note it carries forward. Every content field is optional because the
 * common promotion changes nothing but the scope; a field that is stated is the
 * rewrite the spec allows in the same act.
 *
 * `slug` is the promoted note's project-scope handle. Omitted, the session
 * note's slug carries forward — and a collision is refused naming the holder
 * rather than suffixed, because a promoted note whose handle silently moved is
 * one no agent can address by the name it learned (R10, D8).
 */
export const promoteMemoryNoteRequestSchema = z
  .object({
    slug: memorySlugSchema.optional(),
    hook: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "the hook must be a single line")
      .optional(),
    body: z.string().optional(),
    aliases: z
      .array(z.string().min(1).regex(SINGLE_LINE, "an alias is one line"))
      .max(MEMORY_MAX_ALIASES)
      .optional(),
    /** New text re-leases the line; null clears it; omitted carries it forward. */
    statusNote: z
      .string()
      .min(1)
      .regex(SINGLE_LINE, "statusNote text must be one line")
      .nullable()
      .optional(),
    indexMode: memoryIndexModeSchema.optional(),
    /**
     * The compare-and-swap token: the session note's revision the promoter
     * read. Promotion retires that note, so a stated base that is no longer the
     * head is refused — the content being carried forward is not what was read.
     *
     * OMITTED is not "no check": it defaults to the revision the act itself
     * resolves, which is the only value that closes the window between that
     * read and the write. An explicit null is the deliberate opt-out, for a
     * server-initiated promotion that competes with no author.
     */
    baseRevision: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type PromoteMemoryNoteRequest = z.input<
  typeof promoteMemoryNoteRequestSchema
>;

/**
 * The completed incarnation session-end acts on (R10). The project path rides
 * along because a session incarnation is identified within its project, and the
 * caller is the session lifecycle, which holds both.
 */
export const memorySessionEndInputSchema = z
  .object({
    projectPath: z.string().min(1),
    session: memorySessionIncarnationSchema,
  })
  .strict();
export type MemorySessionEndInput = z.infer<typeof memorySessionEndInputSchema>;

export const linkMemoryNoteRequestSchema = z
  .object({
    kind: memoryLinkKindSchema,
    artifact: memoryArtifactRefSchema,
  })
  .strict();
export type LinkMemoryNoteRequest = z.input<typeof linkMemoryNoteRequestSchema>;

/** A link is removed by its id or by the identity it was created with. */
export const unlinkMemoryNoteRequestSchema = z.union([
  z.object({ linkId: z.string().min(1) }).strict(),
  linkMemoryNoteRequestSchema,
]);
export type UnlinkMemoryNoteRequest = z.input<
  typeof unlinkMemoryNoteRequestSchema
>;

/**
 * How a handle is looked up. Bare resolution sees active and proposed records
 * only; archived notes are reachable through the explicit flag (R4).
 */
export const memoryResolveOptionsSchema = z
  .object({
    scope: memoryScopeSchema.optional(),
    /**
     * The DEFAULT reach is ACTIVE ONLY (R4): a bare slug must never land on a
     * proposal still awaiting approval or on a retired record, or the same
     * handle would mean different notes as lifecycle moved under it. The two
     * widenings are named separately because they serve different surfaces —
     * `includeArchived` is the explicit archived filter a read asks for, and
     * `includeProposed` is how a WRITE reaches the proposal its own author is
     * still waiting on approval for.
     */
    includeArchived: z.boolean().default(false),
    includeProposed: z.boolean().default(false),
  })
  .strict();
export type MemoryResolveOptions = z.input<typeof memoryResolveOptionsSchema>;
/**
 * The narrowing a caller states to disambiguate a handle it already knows is
 * ambiguous. Separate from {@link MemoryResolveOptions} because a mutation
 * fixes its own lifecycle reach — an update may never land on a retired record,
 * whichever scope was named — so scope is the only half a writer may choose.
 */
export const memoryHandleNarrowingSchema = z
  .object({ scope: memoryScopeSchema.optional() })
  .strict();
export type MemoryHandleNarrowing = z.infer<typeof memoryHandleNarrowingSchema>;

/** Every record, whatever its lifecycle: the reach a destructive or historical act needs. */
export const MEMORY_RESOLVE_ANY_LIFECYCLE = {
  includeArchived: true,
  includeProposed: true,
} as const;

export const memoryNoteListRequestSchema = z
  .object({
    scope: memoryScopeSchema.optional(),
    lifecycle: memoryLifecycleSchema.optional(),
    includeArchived: z.boolean().default(false),
  })
  .strict();
export type MemoryNoteListRequest = z.input<typeof memoryNoteListRequestSchema>;

// ============================================================
// Change event (D10)
// ============================================================

/**
 * Every accepted mutation, including the two the freshness engine and the
 * session-end path publish (`reviewed`, `promoted`), so the Library reacts to
 * one event with a change discriminator rather than a family of siblings.
 */
export const memoryChangeKindSchema = z.enum([
  "created",
  "updated",
  "linked",
  "unlinked",
  "reviewed",
  "promoted",
  "archived",
  "deleted",
  "restored",
  "proposal-approved",
  "proposal-rejected",
  "superseded",
]);
export type MemoryChangeKind = z.infer<typeof memoryChangeKindSchema>;

/**
 * Wire-only live-update frame. `.strict()` so the SSE envelope owns `_sentAt`
 * (stamps on send, strips on receive), and so no caller can widen the frame
 * with the hook or body: the panel refetches what it shows, and prose never
 * rides the bus.
 */
export const memoryChangedEventSchema = z
  .object({
    type: z.literal("memory-changed"),
    change: memoryChangeKindSchema,
    memoryId: z.string().min(1),
    slug: z.string().min(1),
    scope: memoryScopeSchema,
    projectPath: z.string().min(1).nullable(),
    sessionName: z.string().min(1).nullable(),
    sessionCreatedAt: z.string().min(1).nullable(),
    /** The lifecycle and head revision AFTER the change (as deleted, for `deleted`). */
    lifecycle: memoryLifecycleSchema,
    revision: z.number().int().positive(),
    authorKind: memoryAuthorKindSchema,
    /** The link a `linked`/`unlinked` change concerns; null for every other change. */
    link: z
      .object({ id: z.string().min(1), kind: memoryLinkKindSchema })
      .nullable(),
  })
  .strict();
export type MemoryChangedEvent = z.infer<typeof memoryChangedEventSchema>;

// ============================================================
// Freshness contracts (spec R2, R8, D2, D6)
// ============================================================

/**
 * The short default lease a wholly perishable state note takes at capture
 * (R2). Session working state goes stale in days, not weeks: three days is
 * long enough to span a weekend and short enough that a forgotten state note
 * withholds itself before the next session inherits it.
 */
export const MEMORY_STATE_NOTE_LEASE_DAYS = 3;
export const MEMORY_STATE_NOTE_LEASE_MS =
  MEMORY_STATE_NOTE_LEASE_DAYS * 24 * 60 * 60 * 1000;

/**
 * What a review act refreshes: the note's own lease, or specifically the
 * statusNote's lease (R2). The two levels lease independently because they are
 * withheld independently.
 */
export const memoryReviewTargetSchema = z.enum(["note", "statusNote"]);

export const markMemoryReviewedRequestSchema = z
  .object({
    target: memoryReviewTargetSchema.default("note"),
    baseRevision: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type MarkMemoryReviewedRequest = z.input<
  typeof markMemoryReviewedRequestSchema
>;

/**
 * One attributed cause of staleness. A note in the review queue carries every
 * cause that applies, so the queue can say WHAT went stale — the status line's
 * lease or the note's own — rather than only that something did.
 */
export const memoryStalenessSchema = z.discriminatedUnion("cause", [
  z.object({
    cause: z.literal("lease"),
    target: memoryReviewTargetSchema,
  }),
  z.object({ cause: z.literal("expiry") }),
]);
export type MemoryStaleness = z.infer<typeof memoryStalenessSchema>;

/**
 * What ambient delivery may carry for one note: nothing (a stale or expired
 * note), the note without its stale status line, or the whole note (R2).
 */
export const memoryAmbientDeliverySchema = z.enum([
  "withhold",
  "deliver-without-status",
  "deliver",
]);
export type MemoryAmbientDelivery = z.infer<typeof memoryAmbientDeliverySchema>;

/**
 * One note the review queue holds, and why. A note earns its place by going
 * stale or by becoming a promotion candidate at its session's completion (R10)
 * — an entry with neither reason is not queue-worthy, which is what the refine
 * states, so the queue never grows a silent third membership rule.
 */
export const memoryReviewQueueEntrySchema = z
  .object({
    note: memoryNoteSchema,
    staleness: z.array(memoryStalenessSchema),
    noteReviewDue: z.boolean(),
    statusReviewDue: z.boolean(),
    expired: z.boolean(),
    /**
     * A durable note of a COMPLETED session incarnation: the session it was
     * learned in is over, so the knowledge either moves up to the project or
     * dies with the session's scope.
     */
    promotionCandidate: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.staleness.length === 0 && !value.promotionCandidate) {
      ctx.addIssue({
        code: "custom",
        path: ["staleness"],
        message:
          "a review-queue entry states why it is queued: staleness, promotion candidacy, or both",
      });
    }
  });
export type MemoryReviewQueueEntry = z.infer<
  typeof memoryReviewQueueEntrySchema
>;

// ============================================================
// Recall contract (spec R7, D5)
// ============================================================

/**
 * The rendered recall pack's ceiling in characters. Recall is one bounded tool
 * call, so the ceiling is the contract rather than a hint: entries are chosen
 * to fit it and what does not fit is disclosed, never silently dropped.
 */
export const MEMORY_RECALL_BUDGET_CHARS = 6000;

/**
 * How many records may occupy the full-body tier however small they are. The
 * spec's "best few fresh records" is a count as well as a budget: twenty tiny
 * bodies inside the character ceiling would still be a wall of prose rather
 * than a pack.
 */
export const MEMORY_RECALL_FULL_BODY_MAX = 5;

/**
 * The floor a stated budget must clear. Below it the mandatory frame — the
 * header and the showing-N-of-M closing with its narrowing command — cannot
 * be rendered, so the ceiling could only be honoured by truncating the very
 * disclosure that makes truncation visible. A budget under this is refused
 * with the limit named rather than silently overrun.
 */
export const MEMORY_RECALL_MIN_BUDGET_CHARS = 500;

/**
 * The longest query recall accepts. The closing line must reproduce the query
 * verbatim for the narrowing command to be runnable, so an unbounded query is
 * an unbounded frame — which is to say a request no budget can honour.
 */
export const MEMORY_RECALL_MAX_QUERY_CHARS = 200;

/**
 * How much of the query the header echoes. The header is a human-readable
 * title rather than a runnable command, so it may elide; the closing line's
 * narrowing command may not.
 */
export const MEMORY_RECALL_QUERY_ECHO_CHARS = 60;

/**
 * Which retrieval mode a recall ran in — the shape of the request, named once
 * so the pack, its header, and its narrowing command all read the same value
 * rather than each re-deriving it from the presence of a field.
 */
export const memoryRecallModeSchema = z.enum(["ambient", "query", "related"]);
export type MemoryRecallMode = z.infer<typeof memoryRecallModeSchema>;

/**
 * One recall call. The three modes are the presence of fields, not a mode
 * flag: no query is ambient, a query is search, and a related artifact is the
 * artifact mode (with or without a query alongside it). Visibility is never a
 * request field — it comes from the actor, exactly as it does on the write
 * path.
 */
export const memoryRecallRequestSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(
        MEMORY_RECALL_MAX_QUERY_CHARS,
        `a recall query is at most ${MEMORY_RECALL_MAX_QUERY_CHARS} characters`,
      )
      .nullable()
      .default(null),
    /** The related-artifact mode's subject: its `about` links resolve first. */
    related: memoryArtifactRefSchema.nullable().default(null),
    /**
     * The conversation's active artifacts. Ambient recall treats an `about`
     * link to one of them as the first ranking signal, which is the "active-
     * artifact bindings" half of the no-query mode (R7).
     */
    activeArtifacts: z.array(memoryArtifactRefSchema).max(16).default([]),
    /** Narrow the actor's visible union to one scope — recall's one filter. */
    scope: memoryScopeSchema.optional(),
    budgetChars: z
      .number()
      .int()
      .min(
        MEMORY_RECALL_MIN_BUDGET_CHARS,
        `a recall budget is at least ${MEMORY_RECALL_MIN_BUDGET_CHARS} characters`,
      )
      .default(MEMORY_RECALL_BUDGET_CHARS),
  })
  .strict();
export type MemoryRecallRequest = z.input<typeof memoryRecallRequestSchema>;

// ============================================================
// Ambient index contract (spec R5, R10, D4)
// ============================================================

/**
 * How much memory a conversation may read without asking (R10). `off` delivers
 * nothing ambiently; `linked-only` delivers exactly the notes about-linked to
 * the conversation's active artifacts; `ambient` delivers the whole generated
 * index. Explicit retrieval verbs stay available in every mode — the policy
 * governs what arrives unasked, never what an agent may deliberately read.
 */
export const memoryReadPolicySchema = z.enum(["off", "linked-only", "ambient"]);
export type MemoryReadPolicy = z.infer<typeof memoryReadPolicySchema>;

/**
 * Whether a conversation may WRITE memory (R10, D7), independent of what it
 * reads: `off` refuses every mutation verb with a typed refusal naming the
 * policy, while the retrieval verbs stay available. Independence matters
 * because the spec's shipped roles differ on each half separately.
 */
export const memoryContributionPolicySchema = z.enum(["on", "off"]);
export type MemoryContributionPolicy = z.infer<
  typeof memoryContributionPolicySchema
>;

/** One role's complete delivery policy: what arrives unasked, and whether it may write. */
export const memoryDeliveryPolicySchema = z
  .object({
    read: memoryReadPolicySchema,
    contribute: memoryContributionPolicySchema,
  })
  .strict();
export type MemoryDeliveryPolicy = z.infer<typeof memoryDeliveryPolicySchema>;

/**
 * An override tier states only the halves it means to change; an unstated
 * half inherits. Strict so a misspelled key in a workflow definition or
 * settings file is a parse error rather than a silently ignored override.
 */
export const memoryDeliveryPolicyOverrideSchema = z
  .object({
    read: memoryReadPolicySchema.optional(),
    contribute: memoryContributionPolicySchema.optional(),
  })
  .strict();

/**
 * The spec's shipped defaults (R10): ordinary conversations and workflow
 * implementers read ambiently and contribute; validators — and every other
 * independence-bearing role — get nothing unasked and write nothing. Ambient
 * priming is the independence hazard D7 names, which is why the validator
 * default is off rather than linked-only.
 */
export const MEMORY_CONVERSATION_POLICY_DEFAULT: MemoryDeliveryPolicy = {
  read: "ambient",
  contribute: "on",
};
export const MEMORY_IMPLEMENTER_POLICY_DEFAULT: MemoryDeliveryPolicy = {
  read: "ambient",
  contribute: "on",
};
export const MEMORY_VALIDATOR_POLICY_DEFAULT: MemoryDeliveryPolicy = {
  read: "off",
  contribute: "off",
};

/**
 * A settings-file policy: each half defaults independently so an operator can
 * state `{ read: "linked-only" }` and keep the shipped contribution value.
 * Strict, like every other global settings block.
 */
export function memoryDeliveryPolicySettingSchema(
  defaults: MemoryDeliveryPolicy,
) {
  return z
    .object({
      read: memoryReadPolicySchema.default(defaults.read),
      contribute: memoryContributionPolicySchema.default(defaults.contribute),
    })
    .strict()
    .default({ ...defaults });
}

/**
 * The full-block budget the spec names (R10.3, D4): 20 KiB or 120 hooks,
 * whichever binds first. The block is paid for once per conversation and then
 * carried as deltas, so a larger block is cheaper than a repeated smaller one;
 * the ceiling stays below whole-library size because the source system showed
 * tail attention loss near 106 index lines. Bytes rather than characters, for
 * the same reason the body cap is bytes — the budget bounds what a turn
 * spends, and a turn is billed in bytes on the wire, not in code points.
 */
export const MEMORY_INDEX_BUDGET_DEFAULT_BYTES = 20 * 1024;
export const MEMORY_INDEX_BUDGET_DEFAULT_HOOKS = 120;

/**
 * The floor a configured byte budget must clear. The block's frame — the
 * visibility line, the showing-N-of-M line with its follow-up command, the
 * withheld line, and the read hint — must always fit, because a budget that
 * could only be met by dropping the disclosure would truncate silently.
 */
export const MEMORY_INDEX_BUDGET_MIN_BYTES = 1024;

export const memoryIndexBudgetSchema = z
  .object({
    bytes: z.number().int().min(MEMORY_INDEX_BUDGET_MIN_BYTES),
    hooks: z.number().int().min(1),
  })
  .strict();
export type MemoryIndexBudget = z.infer<typeof memoryIndexBudgetSchema>;

// ============================================================
// Delivery watermarks and observation telemetry (spec R15)
// ============================================================

/**
 * The two ways a record reaches an agent: the ambient `<memory-index>` block a
 * turn injects unasked, and a recall pack the agent expanded by asking. R15
 * names both, and an evaluation that could not tell them apart could not say
 * whether the ambient block is doing the work the design claims for it.
 */
export const memoryDeliveryChannelSchema = z.enum(["index", "expanded"]);

/**
 * Per conversation, note, and channel: the note revision last put in front of
 * that conversation. An upsert, following the notepad delivery precedent — the
 * row states where the conversation stands, not how it got there.
 *
 * Content-free by construction: identities, a revision, and a timestamp, never
 * a hook or a body.
 */
export const memoryDeliveryWatermarkSchema = registerTrustedSchema(
  z.object({
    conversationId: z.string().min(1),
    memoryId: z.string().min(1),
    channel: memoryDeliveryChannelSchema,
    /** The note revision whose text was delivered. */
    revision: z.number().int().positive(),
    /**
     * Whether that delivery carried the note's status line. A delta reports a
     * status line withheld or restored since the conversation's last delivery,
     * and that transition is legible only against what was last delivered.
     */
    statusDelivered: z.boolean(),
    updatedAt: z.string().min(1),
  }),
  "memoryDeliveryWatermarkSchema",
);
export type MemoryDeliveryWatermark = z.infer<
  typeof memoryDeliveryWatermarkSchema
>;

/**
 * Which block a turn carried: the whole index, or only what changed since the
 * conversation's last delivery. The distinction is the delta design's (D4): a
 * conversation is due the full block on its first turn and after a context
 * loss, and a delta on every other turn.
 */
export const memoryIndexDeliveryKindSchema = z.enum(["full", "delta"]);
export type MemoryIndexDeliveryKind = z.infer<
  typeof memoryIndexDeliveryKindSchema
>;

/**
 * Where one conversation stands with the ambient index: when the full block it
 * still holds was composed, and when it last received anything at all. Read
 * before composition to decide what the next turn is due and, with the
 * per-note watermarks, what a delta has to carry; deleted outright on a
 * context loss, which is why there is no "reset at" column — an absent row IS
 * the conversation with no block.
 *
 * The instants are COMPOSITION instants supplied by the delivering seam, not
 * write clocks: a note created between composing a block and the turn being
 * accepted belongs to the next delta, and dating the state at settlement would
 * silently swallow it.
 *
 * Content-free by construction: one identity and three timestamps.
 */
export const memoryIndexDeliveryStateSchema = registerTrustedSchema(
  z.object({
    conversationId: z.string().min(1),
    /** When the full block this conversation still holds was composed. */
    lastFullAt: z.string().min(1),
    /** When the block the conversation last received — full or delta — was composed. */
    lastDeliveryAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }),
  "memoryIndexDeliveryStateSchema",
);
export type MemoryIndexDeliveryState = z.infer<
  typeof memoryIndexDeliveryStateSchema
>;

/**
 * The observations R15 gathers to revisit its evidence-gated defaults:
 * retrieval frequency per channel, promotion candidates offered against
 * promotions actually performed, and validator rounds spent re-deriving a fact
 * a linked note already held.
 *
 * Every one of them is an observation and nothing else. None is readable from
 * the composer or the recall ranker, by construction: they live in their own
 * table behind their own repository, so there is no counter for a ranking
 * comparison to reach (`inv-no-popularity-or-telemetry-rank`).
 */
export const memoryObservationKindSchema = z.enum([
  "retrieval_index",
  "retrieval_expanded",
  "promotion_candidate",
  "promoted",
  "validator_rederivation",
]);

/**
 * One aggregate counter per `(kind, memoryId)`. `count` is how many times the
 * observation was RECORDED — a note delivered on ten turns counts ten — while
 * the number of distinct notes behind a kind is that kind's row count.
 *
 * `memoryId` is null when the observation names no single record, which is the
 * ordinary shape of a validator re-derivation gathered without one.
 */
export const memoryObservationCounterSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    kind: memoryObservationKindSchema,
    memoryId: z.string().min(1).nullable(),
    count: z.number().int().positive(),
    firstObservedAt: z.string().min(1),
    lastObservedAt: z.string().min(1),
  }),
  "memoryObservationCounterSchema",
);
export type MemoryObservationCounter = z.infer<
  typeof memoryObservationCounterSchema
>;
