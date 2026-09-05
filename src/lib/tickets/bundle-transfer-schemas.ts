import { z } from "zod";

export const bundleTransferSchema = z
  .object({
    id: z.string().uuid(),
    mode: z.enum(["export", "import"]),
    status: z.enum([
      "preparing",
      "ready",
      "importing",
      "imported",
      "duplicate",
      "failed",
    ]),
    title: z.string(),
    documentCount: z.number().int().nonnegative(),
    omissions: z.array(z.object({ source: z.string(), reason: z.string() })),
    digest: z.string().nullable(),
    error: z.string().nullable(),
    ticketNumber: z.number().int().positive().nullable(),
  })
  .strict();
export type BundleTransfer = z.infer<typeof bundleTransferSchema>;
export const bundleTransferEventSchema = bundleTransferSchema.extend({
  type: z.literal("ticket-bundle-status"),
  projectName: z.string(),
});
export type BundleTransferEvent = z.infer<typeof bundleTransferEventSchema>;
