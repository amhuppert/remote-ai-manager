import { z } from "zod";
import { permitRefSchema } from "@/lib/control/schemas";

/** A supervisor that waits on other domains' operations. */
export const ownerKindSchema = z.enum(["context", "run"]);
export type OwnerKind = z.infer<typeof ownerKindSchema>;

export const ownerRefSchema = z
  .object({ kind: ownerKindSchema, id: z.string().min(1) })
  .strict();
export type OwnerRef = z.infer<typeof ownerRefSchema>;

/** The domain that executes a requested operation. */
export const executorKindSchema = z.enum([
  "conversation",
  "requests",
  "context",
  "workspace",
]);
export type ExecutorKind = z.infer<typeof executorKindSchema>;

/**
 * A requester's durable record that it awaits another domain's operation. The
 * executor deduplicates by `cause`; the request payload is the requester's
 * exact prepared request, opaque to the ledger.
 */
export const pendingIntentSchema = z
  .object({
    id: z.string().min(1),
    requester: ownerRefSchema,
    executor: executorKindSchema,
    cause: z.string().min(1),
    permit: permitRefSchema.nullable(),
    request: z.unknown(),
    recordedAt: z.string().min(1),
  })
  .strict();
export type PendingIntent = z.infer<typeof pendingIntentSchema>;

export type NewPendingIntent = Omit<PendingIntent, "id">;
