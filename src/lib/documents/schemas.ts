import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

export const markdownDocumentOriginSchema = z.enum([
  "read",
  "write",
  "edit",
  "registered",
]);
export type MarkdownDocumentOrigin = z.infer<
  typeof markdownDocumentOriginSchema
>;

export const sessionMarkdownDocumentSchema = registerTrustedSchema(
  z.object({
    docPath: z.string().min(1),
    origin: markdownDocumentOriginSchema,
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
  }),
  "sessionMarkdownDocumentSchema",
);
export type SessionMarkdownDocument = z.infer<
  typeof sessionMarkdownDocumentSchema
>;

export const markdownDocumentListItemSchema = z.object({
  docPath: z.string().min(1),
  title: z.string().min(1),
  origin: markdownDocumentOriginSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  location: z.enum(["worktree", "external"]),
  registered: z.boolean(),
  description: z.string().nullable(),
});
export type MarkdownDocumentListItem = z.infer<
  typeof markdownDocumentListItemSchema
>;

export const markdownDocumentsResponseSchema = z.array(
  markdownDocumentListItemSchema,
);

/**
 * Query-param schema for the content-by-path endpoint. The raw `?path=` value
 * must be a non-empty string before it is normalized against the worktree.
 */
export const documentContentPathSchema = z.string().min(1);

/**
 * Response for the content-by-path endpoint. Intentionally DISTINCT from the
 * shared `contentResponseSchema` (`{ content }`): it also echoes the normalized
 * canonical `docPath` the content was actually read from, so the viewer can key
 * tabs and worktree comment anchoring consistently regardless of how the caller
 * addressed the file.
 */
export const documentContentResponseSchema = z.object({
  content: z.string(),
  docPath: z.string(),
});
export type DocumentContentResponse = z.infer<
  typeof documentContentResponseSchema
>;
