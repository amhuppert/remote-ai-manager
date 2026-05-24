import { z } from "zod";

export const imageCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});

export const imageMediaTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

export const imagePayloadSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: imageMediaTypeSchema,
  base64Data: z.string().min(1),
  inlineMarkerIndex: z.number().int().positive().optional(),
});
export type ImagePayload = z.infer<typeof imagePayloadSchema>;
