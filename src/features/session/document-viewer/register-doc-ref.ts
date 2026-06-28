import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { DocumentRef } from "@/lib/document-comments/schemas";
import { normalizeDocPath } from "@/lib/documents/path";

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
 * may be absolute; we normalize it against the session worktree so an absolute
 * path inside the worktree becomes the relative `docPath`, while one outside (or
 * a non-markdown / traversal path) is unavailable rather than openable — the
 * viewer is markdown-only and worktree-confined (req 10.4). Normalizing here
 * keeps comment identity canonical, so the same file opened from Docs, Specs, or
 * a transcript card shares one comment set.
 */
export function resolveRegisteredDoc(
  doc: ReferenceDocument,
  projectName: string,
  sessionName: string,
  worktreeRoot: string,
): RegisteredDocResolution {
  const normalized = normalizeDocPath(doc.filePath, worktreeRoot);
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
