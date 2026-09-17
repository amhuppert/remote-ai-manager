import { z } from "zod";
import {
  memoryNoteSchema,
  memoryScopeSchema,
  memoryLinkSchema,
  memoryStatusNoteSchema,
  memoryReviewQueueEntrySchema,
  memoryRecallModeSchema,
  memoryIndexDeliveryKindSchema,
} from "@/lib/memory/schemas";

export const noteResponseSchema = z.object({ note: memoryNoteSchema });
export const noteListResponseSchema = z.object({
  notes: z.array(memoryNoteSchema),
});
export const lineageSchema = z.object({
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
});
export const noteDetailResponseSchema = z.object({
  note: memoryNoteSchema,
  links: z.array(memoryLinkSchema),
  lineage: lineageSchema,
});
export const createResponseSchema = z.object({
  note: memoryNoteSchema,
  advisories: z.object({
    overlapCandidates: z.array(
      z.object({
        slug: z.string(),
        scope: memoryScopeSchema,
        hook: z.string(),
      }),
    ),
    hookWarnings: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
});
export const linkResponseSchema = z.object({
  link: memoryLinkSchema,
  note: memoryNoteSchema,
});
export const reviewedResponseSchema = z.object({
  note: memoryNoteSchema,
  /** Present, and non-null, only for a status re-lease (R2.2). */
  statusReLease: memoryStatusNoteSchema.nullable(),
});
/**
 * Identities only. An observation verb that answered with a count would put a
 * note's retrieval history in front of an agent, which is the reasoning
 * `inv-no-popularity-or-telemetry-rank` exists to keep out of the loop.
 */
export const rederivedResponseSchema = z.object({
  observed: z.object({
    memoryId: z.string(),
    slug: z.string(),
    conversationId: z.string().nullable(),
    executionId: z.string().nullable(),
    contextId: z.string().nullable(),
  }),
});
export const promoteResponseSchema = z.object({
  promoted: memoryNoteSchema,
  superseded: memoryNoteSchema,
});
export const reviewQueueResponseSchema = z.object({
  entries: z.array(memoryReviewQueueEntrySchema),
});

/**
 * Only the fields these two verbs render. The pack and the block are composed,
 * budgeted, and closed with their own disclosure line server-side, so the CLI
 * relays that text rather than re-deriving a rendering from the records.
 */
export const recallResponseSchema = z.object({
  pack: z.object({
    mode: memoryRecallModeSchema,
    text: z.string(),
    showing: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    narrowCommand: z.string().nullable(),
    entries: z.array(
      z.object({
        note: memoryNoteSchema,
        tier: z.enum(["full", "hook"]),
        statusLine: z.string().nullable(),
        readCommand: z.string(),
      }),
    ),
  }),
});
export const indexResponseSchema = z.object({
  /** Which render came back — null when the conversation is told nothing. */
  mode: memoryIndexDeliveryKindSchema.nullable(),
  block: z
    .object({
      text: z.string(),
      bytes: z.number().int().nonnegative(),
      omitted: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      withheld: z.object({
        reviewDue: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        proposed: z.number().int().nonnegative(),
      }),
      entries: z.array(
        z.object({
          memoryId: z.string(),
          revision: z.number().int().positive(),
          slug: z.string(),
          scope: memoryScopeSchema,
          section: z.string(),
          statusDelivered: z.boolean(),
        }),
      ),
    })
    .nullable(),
});
export const exportResponseSchema = z.object({
  archive: z.string(),
  noteCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
});
