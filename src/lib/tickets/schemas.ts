import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

// ============================================================
// Enums
// ============================================================

export const ticketWorkTypeSchema = z.enum([
  "feature",
  "bug",
  "research",
  "tech_debt",
  "performance",
]);
export type TicketWorkType = z.infer<typeof ticketWorkTypeSchema>;

export const ticketStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "closed",
]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const TICKET_DEFAULT_STATUS: TicketStatus = "not_started";

// ============================================================
// Ticket entity
// ============================================================

// Persisted-row schemas are effect-free (no defaults/transforms) so they stay
// eligible for `parseTrusted` registration; creation defaults live on the
// boundary input schemas instead.
export const ticketSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    projectPath: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string(),
    workType: ticketWorkTypeSchema,
    status: ticketStatusSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }),
  "ticketSchema",
);
export type Ticket = z.infer<typeof ticketSchema>;

// ============================================================
// Attachment payloads (discriminated union over the five kinds)
// ============================================================

// Members are `.strict()` so a payload carrying another kind's fields is
// rejected instead of silently stripped when rows round-trip through JSON.
const fileAttachmentPayloadSchema = z
  .object({
    kind: z.literal("file"),
    fileName: z.string().min(1),
    snapshotKey: z.string().min(1),
    mediaType: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  })
  .strict();

export const conversationAttachmentPayloadSchema = z
  .object({
    kind: z.literal("conversation"),
    projectPath: z.string().min(1),
    sessionName: z.string().nullable(),
    conversationId: z.string().min(1),
    snapshotKey: z.string().min(1),
    snapshotCapturedAt: z.string().min(1),
  })
  .strict();

const sessionAttachmentPayloadSchema = z
  .object({
    kind: z.literal("session"),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
  })
  .strict();

const relatedTicketAttachmentPayloadSchema = z
  .object({
    kind: z.literal("related_ticket"),
    ticketId: z.string().min(1),
    identifierSnapshot: z.string().min(1),
  })
  .strict();

const noteAttachmentPayloadSchema = z
  .object({
    kind: z.literal("note"),
    markdown: z.string(),
  })
  .strict();

export const ticketAttachmentPayloadSchema = z.discriminatedUnion("kind", [
  fileAttachmentPayloadSchema,
  conversationAttachmentPayloadSchema,
  sessionAttachmentPayloadSchema,
  relatedTicketAttachmentPayloadSchema,
  noteAttachmentPayloadSchema,
]);
export type TicketAttachmentPayload = z.infer<
  typeof ticketAttachmentPayloadSchema
>;
export type TicketAttachmentKind = TicketAttachmentPayload["kind"];

// Effect-free non-empty check (`.trim()` would transform the value).
const nonEmptyDescriptionSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: "description must be non-empty",
  });

export const ticketAttachmentSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    ticketId: z.string().min(1),
    description: nonEmptyDescriptionSchema,
    payload: ticketAttachmentPayloadSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }),
  "ticketAttachmentSchema",
);
export type TicketAttachment = z.infer<typeof ticketAttachmentSchema>;

export const deletedTicketAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  ticketId: z.string().min(1),
  kind: z.enum(["file", "conversation", "session", "related_ticket", "note"]),
  ticketUpdatedAt: z.string().min(1),
});

// ============================================================
// Session links
// ============================================================

export const ticketSessionStartModeSchema = z.enum(["agent", "prepared"]);
export type TicketSessionStartMode = z.infer<
  typeof ticketSessionStartModeSchema
>;

export const ticketSessionEndReasonSchema = z.enum([
  "finished",
  "deleted",
  "replaced",
]);
export type TicketSessionEndReason = z.infer<
  typeof ticketSessionEndReasonSchema
>;

export const ticketSessionLinkSchema = registerTrustedSchema(
  z.object({
    id: z.string().min(1),
    ticketId: z.string().min(1),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    /** Null only for legacy links whose exact session incarnation is unknowable. */
    sessionCreatedAt: z.string().min(1).nullable(),
    startMode: ticketSessionStartModeSchema,
    linkedAt: z.string().min(1),
    endedAt: z.string().min(1).nullable(),
    endReason: ticketSessionEndReasonSchema.nullable(),
  }),
  "ticketSessionLinkSchema",
);
export type TicketSessionLink = z.infer<typeof ticketSessionLinkSchema>;

/**
 * Lean per-session indicator payload for the project session-link map:
 * `active` reflects the instance-guarded derivation (an un-ended link whose
 * session instance is still the one that was linked), never raw link rows.
 */
export const ticketLinkSummarySchema = z.object({
  ticketId: z.string().min(1),
  projectName: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  active: z.boolean(),
  linkedAt: z.string().min(1),
  endedAt: z.string().min(1).nullable(),
});
export type TicketLinkSummary = z.infer<typeof ticketLinkSummarySchema>;

// ============================================================
// List item and detail
// ============================================================

export const ticketListItemSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  workType: ticketWorkTypeSchema,
  status: ticketStatusSchema,
  attachmentCount: z.number().int().nonnegative(),
  activeSessionName: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TicketListItem = z.infer<typeof ticketListItemSchema>;

export const ticketDetailSchema = ticketSchema.extend({
  projectName: z.string().min(1),
  attachments: z.array(ticketAttachmentSchema),
  sessions: z.array(ticketSessionLinkSchema),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

// ============================================================
// Resolved attachments (per-kind full-content retrieval)
// ============================================================

// A plain union, not a discriminated one: `related_ticket` has two arms
// (available/unavailable) that share the `kind` discriminator and differ on
// the literal `available` flag.
export const resolvedAttachmentSchema = z.union([
  z.object({
    kind: z.literal("file"),
    attachment: ticketAttachmentSchema,
    fileName: z.string().min(1),
    mediaType: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("conversation"),
    attachment: ticketAttachmentSchema,
    conversationId: z.string().min(1),
    sessionName: z.string().nullable(),
    /**
     * `retained_compaction` is a snapshot taken at attach time — a compaction,
     * never the full transcript; `sourceAvailable` says whether the source
     * conversation still exists for follow-up reads.
     */
    source: z.enum(["live_compaction", "retained_compaction"]),
    sourceAvailable: z.boolean(),
    markdown: z.string(),
    capturedAt: z.string(),
    readCommands: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("session"),
    attachment: ticketAttachmentSchema,
    projectName: z.string().min(1),
    sessionName: z.string().min(1),
    finished: z.boolean(),
    conversationIds: z.array(z.string()),
    readCommands: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("related_ticket"),
    attachment: ticketAttachmentSchema,
    available: z.literal(true),
    ticket: ticketDetailSchema,
    followCommand: z.string(),
  }),
  z.object({
    kind: z.literal("related_ticket"),
    attachment: ticketAttachmentSchema,
    available: z.literal(false),
    identifierSnapshot: z.string(),
  }),
  z.object({
    kind: z.literal("note"),
    attachment: ticketAttachmentSchema,
    markdown: z.string(),
  }),
]);
export type ResolvedAttachment = z.infer<typeof resolvedAttachmentSchema>;

// ============================================================
// Queries and request/response shapes (external boundaries; safeParse)
// ============================================================

export const ticketListSortSchema = z.enum(["created", "updated"]);
export type TicketListSort = z.infer<typeof ticketListSortSchema>;

export const ticketListQuerySchema = z.object({
  projectPath: z.string().min(1).optional(),
  status: ticketStatusSchema.optional(),
  workType: ticketWorkTypeSchema.optional(),
  sort: ticketListSortSchema.default("updated"),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const createTicketInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  workType: ticketWorkTypeSchema,
  status: ticketStatusSchema.default(TICKET_DEFAULT_STATUS),
});
export type CreateTicketInput = z.infer<typeof createTicketInputSchema>;

export const updateTicketFieldsSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  workType: ticketWorkTypeSchema.optional(),
  status: ticketStatusSchema.optional(),
});
export type UpdateTicketFields = z.infer<typeof updateTicketFieldsSchema>;

export const ticketIdentitySchema = z.object({
  projectName: z.string().min(1),
  number: z.number().int().positive(),
});
export type TicketIdentity = z.infer<typeof ticketIdentitySchema>;

export const deletedTicketSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
  number: z.number().int().positive(),
});
export type DeletedTicket = z.infer<typeof deletedTicketSchema>;

// ============================================================
// Ticket reference (inline `<ticket-ref ... />` XML tag)
// ============================================================

// Attributes of the canonical self-closing ticket reference emitted by the
// copy-reference control and the prompt-editor serializer. Hyphenated keys
// match the wire-format attribute names exactly. All attributes are required —
// a tag missing any of them stays plain text. Refs carry display identity and
// a globally-valid read command, never paths, snapshot keys, or content.
export const ticketRefAttrsSchema = z.object({
  "project-name": z.string().min(1),
  "ticket-number": z.string().regex(/^\d+$/),
  identifier: z.string().min(1),
  title: z.string().min(1),
  "read-command": z.string().min(1),
});
export type TicketRefAttrs = z.infer<typeof ticketRefAttrsSchema>;

// ============================================================
// Typed errors
// ============================================================

export const ticketValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type TicketValidationIssue = z.infer<typeof ticketValidationIssueSchema>;

export const ticketErrorSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("ticket_not_found"),
    identifier: z.string(),
  }),
  z.object({
    code: z.literal("validation_failed"),
    issues: z.array(ticketValidationIssueSchema),
  }),
  // The design's error contract maps a missing attachment to a 404 like any
  // other missing entity; the canonical union omitted a code for it, so this
  // variant is the additive resolution (identifier names the host ticket).
  z.object({
    code: z.literal("attachment_not_found"),
    identifier: z.string(),
    attachmentId: z.string(),
  }),
  z.object({
    code: z.literal("active_session"),
    sessionName: z.string(),
  }),
  z.object({
    code: z.literal("start_in_progress"),
    identifier: z.string(),
  }),
  z.object({
    code: z.literal("content_unavailable"),
    attachmentId: z.string(),
    reason: z.string(),
  }),
  // The design's canonical union carries a single preparation code, but its
  // error-handling table splits the failure by phase: content failures
  // (compaction, snapshots — ticket untouched, 422) versus post-provision
  // preparation failures (materialization, charter, final link — 500 after
  // compensation). `phase` is the additive resolution so routes can honor
  // both rows without a second code.
  z.object({
    code: z.literal("context_preparation_failed"),
    phase: z.enum(["content", "preparation"]),
    reason: z.string(),
  }),
  z.object({
    code: z.literal("session_provision_failed"),
    reason: z.string(),
  }),
]);
export type TicketError = z.infer<typeof ticketErrorSchema>;

export type TicketResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TicketError };

// ============================================================
// Start work
// ============================================================

export const ticketStartModeSchema = z.enum(["agent", "prepared"]);
export type TicketStartMode = z.infer<typeof ticketStartModeSchema>;

/** The start endpoint's success body — also the CLI's parse contract. */
export const startTicketOutputSchema = z.object({
  ticket: ticketDetailSchema,
  sessionName: z.string(),
  conversationId: z.string(),
  initialPromptQueued: z.boolean(),
});
export type StartTicketOutput = z.infer<typeof startTicketOutputSchema>;

// ============================================================
// Change event
// ============================================================

// `.strict()` so the SSE envelope owns `_sentAt` (stamps on send, strips on
// receive) — an extra key reaching the schema is a bug, not tolerated drift.
export const ticketChangedEventSchema = z
  .object({
    type: z.literal("ticket-changed"),
    change: z.enum(["created", "updated", "deleted", "attachments", "session"]),
    projectName: z.string().min(1),
    ticketNumber: z.number().int().positive(),
    listItem: ticketListItemSchema.nullable(),
    attachmentIndexChanged: z.boolean(),
    linkedSessionName: z.string().min(1).optional(),
  })
  .strict();
export type TicketChangedEvent = z.infer<typeof ticketChangedEventSchema>;
