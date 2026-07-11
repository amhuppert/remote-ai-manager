import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import {
  markdownDocumentListItemSchema,
  type MarkdownDocumentListItem,
  type SessionMarkdownDocument,
} from "./schemas";
import { normalizeMarkdownLocator } from "./path";

function titleFromPath(docPath: string): string {
  return docPath.split("/").pop() ?? docPath;
}

export function mergeMarkdownDocuments(
  indexed: readonly SessionMarkdownDocument[],
  registered: readonly ReferenceDocument[],
  worktreePath: string,
): MarkdownDocumentListItem[] {
  const byPath = new Map<string, MarkdownDocumentListItem>();

  for (const document of indexed) {
    byPath.set(document.docPath, {
      ...document,
      title: titleFromPath(document.docPath),
      location: document.docPath.startsWith("/") ? "external" : "worktree",
      registered: false,
      description: null,
    });
  }

  for (const reference of registered) {
    const normalized = normalizeMarkdownLocator(
      reference.filePath,
      worktreePath,
    );
    if (!normalized.ok) continue;
    const existing = byPath.get(normalized.docPath);
    if (!existing) {
      byPath.set(normalized.docPath, {
        docPath: normalized.docPath,
        title: titleFromPath(normalized.docPath),
        origin: "registered",
        firstSeenAt: reference.createdAt,
        lastSeenAt: reference.createdAt,
        location: normalized.location,
        registered: true,
        description: reference.description,
      });
      continue;
    }

    byPath.set(normalized.docPath, {
      ...existing,
      origin:
        reference.createdAt > existing.lastSeenAt
          ? "registered"
          : existing.origin,
      firstSeenAt:
        reference.createdAt < existing.firstSeenAt
          ? reference.createdAt
          : existing.firstSeenAt,
      lastSeenAt:
        reference.createdAt > existing.lastSeenAt
          ? reference.createdAt
          : existing.lastSeenAt,
      registered: true,
      description: reference.description,
    });
  }

  return [...byPath.values()]
    .map((item) => markdownDocumentListItemSchema.parse(item))
    .sort(
      (a, b) =>
        b.lastSeenAt.localeCompare(a.lastSeenAt) ||
        a.docPath.localeCompare(b.docPath),
    );
}
