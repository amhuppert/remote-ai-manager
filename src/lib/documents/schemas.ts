import { z } from "zod";

/**
 * Query-param schema for the content-by-path endpoint. The raw `?path=` value
 * must be a non-empty string before it is normalized against the worktree.
 */
export const documentContentPathSchema = z.string().min(1);

/**
 * Response for the content-by-path endpoint. Intentionally DISTINCT from the
 * shared `contentResponseSchema` (`{ content }`): it also echoes the normalized
 * worktree-relative `docPath` the content was actually read from, so the viewer
 * can key comments/anchoring by the canonical identity regardless of whether
 * the caller addressed the file with a relative or absolute-inside-worktree
 * path.
 */
export const documentContentResponseSchema = z.object({
  content: z.string(),
  docPath: z.string(),
});
export type DocumentContentResponse = z.infer<
  typeof documentContentResponseSchema
>;
