import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { DocumentRef } from "@/lib/document-comments/schemas";
import { normalizeMarkdownLocator } from "@/lib/documents/path";

export type RegisteredDocResolution =
  | { available: true; doc: ReferenceDocument; ref: DocumentRef }
  | {
      available: false;
      doc: ReferenceDocument;
      reason: "non-markdown" | "traversal" | "outside-worktree";
    };

/**
 * Resolve a registered reference document to a canonical, openable
 * `DocumentRef`, or mark it unavailable. The registry stores a `filePath` that
 * may be absolute; paths inside the session worktree become relative while
 * external paths keep a canonical absolute identity. Normalizing here ensures
 * the same file opened from Docs, Specs, or a transcript card resolves to one
 * viewer tab.
 */
export function resolveRegisteredDoc(
  doc: ReferenceDocument,
  projectName: string,
  sessionName: string,
  worktreeRoot: string,
): RegisteredDocResolution {
  const normalized = normalizeMarkdownLocator(doc.filePath, worktreeRoot);
  if (!normalized.ok) {
    return { available: false, doc, reason: normalized.reason };
  }
  const fileName = normalized.docPath.split("/").pop() ?? normalized.docPath;
  return {
    available: true,
    doc,
    ref: {
      projectName,
      sessionName,
      docPath: normalized.docPath,
      title: fileName,
    },
  };
}
