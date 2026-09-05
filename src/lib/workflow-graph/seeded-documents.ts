import { z } from "zod";

export const SEEDED_DOCUMENT_MAX_BYTES = 262_144;
export const SEEDED_DOCUMENTS_MAX_BYTES = 1_048_576;
export const WORKFLOW_DOCUMENT_DIRECTORY = ".cc/graph-workflow-docs/";

export function isWorkflowDocumentPath(relativePath: string): boolean {
  if (!relativePath.startsWith(WORKFLOW_DOCUMENT_DIRECTORY)) return false;
  if (relativePath.includes("\\") || relativePath.includes("\0")) return false;
  return relativePath
    .slice(WORKFLOW_DOCUMENT_DIRECTORY.length)
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * A document the launching tier hands the engine to seed into a run: content
 * the tier already rendered, at a worktree-relative path under the shared
 * document directory. Deliberately opaque — the engine never learns what the
 * bytes mean, so no launching tier's vocabulary reaches this layer.
 */
export const seededWorkflowDocumentSchema = z.object({
  relativePath: z.string().trim().min(1).refine(isWorkflowDocumentPath, {
    message:
      "Seeded documents must name a file under .cc/graph-workflow-docs/ without traversal.",
  }),
  contents: z
    .string()
    .refine(
      (contents) =>
        new TextEncoder().encode(contents).byteLength <=
        SEEDED_DOCUMENT_MAX_BYTES,
      {
        message: `A seeded document may contain at most ${SEEDED_DOCUMENT_MAX_BYTES} UTF-8 bytes.`,
      },
    ),
  description: z.string(),
  readWhen: z.string(),
});
export type SeededWorkflowDocument = z.infer<
  typeof seededWorkflowDocumentSchema
>;

export const seededWorkflowDocumentsSchema = z
  .array(seededWorkflowDocumentSchema)
  .superRefine((documents, context) => {
    const seen = new Set<string>();
    let bytes = 0;
    documents.forEach((document, index) => {
      bytes += new TextEncoder().encode(document.contents).byteLength;
      if (seen.has(document.relativePath))
        context.addIssue({
          code: "custom",
          path: [index, "relativePath"],
          message: `Duplicate seeded document destination ${document.relativePath}.`,
        });
      seen.add(document.relativePath);
    });
    if (bytes > SEEDED_DOCUMENTS_MAX_BYTES)
      context.addIssue({
        code: "custom",
        path: [],
        message: `Seeded documents contain ${bytes} UTF-8 bytes; the per-plan limit is ${SEEDED_DOCUMENTS_MAX_BYTES}.`,
      });
  });
