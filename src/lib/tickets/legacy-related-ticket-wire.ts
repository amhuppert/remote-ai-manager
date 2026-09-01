import { z } from "zod";
import { ticketDetailSchema } from "./schemas";

export const legacyRelatedTicketAddBodySchema = z
  .object({
    description: z.string(),
    payload: z
      .object({
        kind: z.literal("related_ticket"),
        projectName: z.string().min(1),
        number: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const legacyRelatedTicketPayloadSchema = z
  .object({
    kind: z.literal("related_ticket"),
    ticketId: z.string().min(1),
    identifierSnapshot: z.string().min(1),
  })
  .strict();

export const legacyRelatedTicketAttachmentSchema = z
  .object({
    id: z.string().min(1),
    ticketId: z.string().min(1),
    description: z.string().refine((value) => value.trim().length > 0),
    payload: legacyRelatedTicketPayloadSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type LegacyRelatedTicketAttachment = z.infer<
  typeof legacyRelatedTicketAttachmentSchema
>;

export const legacyResolvedRelatedTicketSchema = z.union([
  z
    .object({
      kind: z.literal("related_ticket"),
      attachment: legacyRelatedTicketAttachmentSchema,
      available: z.literal(true),
      ticket: ticketDetailSchema,
      followCommand: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("related_ticket"),
      attachment: legacyRelatedTicketAttachmentSchema,
      available: z.literal(false),
      identifierSnapshot: z.string().min(1),
    })
    .strict(),
]);
export type LegacyResolvedRelatedTicket = z.infer<
  typeof legacyResolvedRelatedTicketSchema
>;

export const legacyDeletedRelatedTicketAttachmentSchema = z
  .object({
    attachmentId: z.string().min(1),
    ticketId: z.string().min(1),
    kind: z.literal("related_ticket"),
    ticketUpdatedAt: z.string().min(1),
  })
  .strict();
export type LegacyDeletedRelatedTicketAttachment = z.infer<
  typeof legacyDeletedRelatedTicketAttachmentSchema
>;
