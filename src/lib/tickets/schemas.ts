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

export const conversationSnapshotStatusSchema = z.enum([
  "pending",
  "captured",
  "failed",
]);
export type ConversationSnapshotStatus = z.infer<
  typeof conversationSnapshotStatusSchema
>;

export const conversationAttachmentPayloadSchema = z
  .object({
    kind: z.literal("conversation"),
    projectPath: z.string().min(1),
    sessionName: z.string().nullable(),
    conversationId: z.string().min(1),
    snapshotKey: z.string().min(1).nullable(),
    snapshotCapturedAt: z.string().min(1).nullable(),
    snapshotStatus: conversationSnapshotStatusSchema.optional(),
    snapshotError: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const status = payload.snapshotStatus ?? "captured";
    const captured = status === "captured";
    if (captured !== (payload.snapshotKey !== null)) {
      context.addIssue({
        code: "custom",
        path: ["snapshotKey"],
        message: captured
          ? "captured snapshots require a key"
          : `${status} snapshots cannot have a key`,
      });
    }
    if (captured !== (payload.snapshotCapturedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["snapshotCapturedAt"],
        message: captured
          ? "captured snapshots require a capture timestamp"
          : `${status} snapshots cannot have a capture timestamp`,
      });
    }
    if (status === "failed" && payload.snapshotError === undefined) {
      context.addIssue({
        code: "custom",
        path: ["snapshotError"],
        message: "failed snapshots require a safe error",
      });
    }
    if (status !== "failed" && payload.snapshotError !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["snapshotError"],
        message: `${status} snapshots cannot have an error`,
      });
    }
  });
export type ConversationAttachmentPayload = z.infer<
  typeof conversationAttachmentPayloadSchema
>;

export function effectiveSnapshotStatus(
  payload: ConversationAttachmentPayload,
): ConversationSnapshotStatus {
  return payload.snapshotStatus ?? "captured";
}

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
    kind: z.literal("conversation"),
    state: z.literal("pending"),
    attachment: ticketAttachmentSchema,
    conversationId: z.string().min(1),
    sessionName: z.string().nullable(),
    retryCommand: z.string().min(1),
  }),
  z.object({
    kind: z.literal("conversation"),
    state: z.literal("failed"),
    attachment: ticketAttachmentSchema,
    conversationId: z.string().min(1),
    sessionName: z.string().nullable(),
    error: z.string().min(1).max(500),
    retryCommand: z.string().min(1),
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
  // A set of statuses to include (membership); absent means every status.
  statuses: z.array(ticketStatusSchema).min(1).optional(),
  workType: ticketWorkTypeSchema.optional(),
  sort: ticketListSortSchema.default("updated"),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const quickTicketBundleKeySchema = z.enum([
  "route",
  "identities",
  "conversation",
  "cctl",
  "build",
  "screenshot",
  "clientErrors",
]);
export type QuickTicketBundleKey = z.infer<typeof quickTicketBundleKeySchema>;

export const quickTicketClientErrorSchema = z
  .object({
    ts: z.iso.datetime(),
    kind: z.enum(["window", "unhandledrejection", "console", "query"]),
    message: z.string().min(1).max(500),
    stackHead: z.array(z.string().min(1).max(500)).max(3),
  })
  .strict();
export type QuickTicketClientError = z.infer<
  typeof quickTicketClientErrorSchema
>;

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BASE64_LENGTH = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodedBase64Size(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Prefix(value: string, byteLimit: number): number[] {
  const bytes: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const character of value) {
    if (character === "=") break;
    const digit = BASE64_ALPHABET.indexOf(character);
    if (digit < 0) return [];
    accumulator = (accumulator << 6) | digit;
    bitCount += 6;
    if (bitCount < 8) continue;
    bitCount -= 8;
    bytes.push((accumulator >> bitCount) & 0xff);
    if (bytes.length === byteLimit) return bytes;
    accumulator &= (1 << bitCount) - 1;
  }
  return bytes;
}

function hasScreenshotMagic(
  base64: string,
  mediaType: "image/png" | "image/webp",
): boolean {
  const bytes = decodeBase64Prefix(base64, 12);
  if (mediaType === "image/png") {
    const png = [137, 80, 78, 71, 13, 10, 26, 10];
    return png.every((value, index) => bytes[index] === value);
  }
  return (
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  );
}

export const quickTicketScreenshotSchema = z
  .object({
    mediaType: z.enum(["image/webp", "image/png"]),
    base64: z
      .string()
      .min(1)
      .max(MAX_SCREENSHOT_BASE64_LENGTH)
      .regex(CANONICAL_BASE64_PATTERN),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .strict()
  .superRefine((screenshot, context) => {
    if (decodedBase64Size(screenshot.base64) > MAX_SCREENSHOT_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["base64"],
        message: "screenshot exceeds the 2 MB decoded limit",
      });
    }
    if (screenshot.width * screenshot.height > 16_777_216) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "screenshot dimensions exceed the pixel limit",
      });
    }
    if (!hasScreenshotMagic(screenshot.base64, screenshot.mediaType)) {
      context.addIssue({
        code: "custom",
        path: ["base64"],
        message: "screenshot bytes do not match its media type",
      });
    }
  });

export const quickTicketDiagnosticsSchema = z
  .object({
    capturedAt: z.iso.datetime(),
    route: z
      .object({
        url: z.string().min(1).max(4096),
        viewState: z.string().max(2000),
      })
      .strict(),
    identities: z
      .object({
        projectName: z.string().min(1).max(200).optional(),
        sessionName: z.string().min(1).max(200).optional(),
        conversationId: z.string().min(1).max(200).optional(),
        workflowExecutionId: z.string().min(1).max(200).optional(),
        deepLinks: z
          .array(
            z
              .object({
                label: z.string().min(1).max(100),
                href: z.string().min(1).max(4096),
              })
              .strict(),
          )
          .max(12),
      })
      .strict(),
    clientErrors: z.array(quickTicketClientErrorSchema).max(25),
    screenshot: quickTicketScreenshotSchema.optional(),
    removed: z
      .array(quickTicketBundleKeySchema)
      .max(quickTicketBundleKeySchema.options.length),
  })
  .strict()
  .superRefine((diagnostics, context) => {
    if (new Set(diagnostics.removed).size !== diagnostics.removed.length) {
      context.addIssue({
        code: "custom",
        path: ["removed"],
        message: "removed bundle keys must be unique",
      });
    }
  });
export type QuickTicketDiagnostics = z.infer<
  typeof quickTicketDiagnosticsSchema
>;

export const quickTicketConversationContextSchema = z
  .object({
    sourceProjectName: z.string().min(1).max(200),
    sessionName: z.string().min(1).max(200).nullable(),
    conversationId: z.string().min(1).max(200),
    title: z.string().min(1).max(500).optional(),
  })
  .strict();
export type QuickTicketConversationContext = z.infer<
  typeof quickTicketConversationContextSchema
>;

export const quickTicketCreateWarningSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("conversation_source_unavailable"),
    message: z.string().min(1).max(500),
  }),
]);
export type QuickTicketCreateWarning = z.infer<
  typeof quickTicketCreateWarningSchema
>;

export const createTicketResponseSchema = z.object({
  ticket: ticketDetailSchema,
  warnings: z.array(quickTicketCreateWarningSchema),
});
export type CreateTicketResponse = z.infer<typeof createTicketResponseSchema>;

export const createTicketInputSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().default(""),
    workType: ticketWorkTypeSchema,
    status: ticketStatusSchema.default(TICKET_DEFAULT_STATUS),
    conversationContext: quickTicketConversationContextSchema.optional(),
    diagnostics: quickTicketDiagnosticsSchema.optional(),
    autoStartRequested: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (input.diagnostics && input.workType !== "bug") {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "diagnostics are only available for bug tickets",
      });
    }
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
