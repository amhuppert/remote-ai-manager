import { actorProvenanceSchema, type SpecCommentRow } from "./schemas";
import type { SpecCommentView } from "./view-schemas";

export interface SpecCommentProjectionContext {
  /** Current-revision handle assignment; comments on elements outside it keep a null handle. */
  handleByElementId: ReadonlyMap<string, string>;
  revisionNumberById: ReadonlyMap<string, number>;
}

function parseJsonColumn(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * The quote is buried inside the opaque anchor, so it is narrowed out
 * structurally rather than by importing the Studio's anchor schema — the specs
 * domain deliberately treats anchors as writer-owned blobs.
 */
function quoteOf(anchor: unknown): string | null {
  if (typeof anchor !== "object" || anchor === null) return null;
  const candidate = (anchor as Record<string, unknown>).quote;
  return typeof candidate === "string" ? candidate : null;
}

export function projectSpecComment(
  row: SpecCommentRow,
  context: SpecCommentProjectionContext,
): SpecCommentView {
  const anchor = parseJsonColumn(row.anchor_json);
  const author = actorProvenanceSchema.safeParse(
    parseJsonColumn(row.author_json),
  );
  return {
    id: row.id,
    threadId: row.thread_id,
    parentCommentId: row.parent_comment_id,
    elementId: row.element_id,
    handle: context.handleByElementId.get(row.element_id) ?? null,
    revisionId: row.revision_id,
    revisionNumber: context.revisionNumberById.get(row.revision_id) ?? null,
    anchor,
    quote: quoteOf(anchor),
    body: row.body,
    author: author.success ? author.data : null,
    blocking: row.blocking === 1,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
