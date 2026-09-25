import type { SpecRevision } from "./schemas";

/**
 * Lineage is the nullable self-FK `basedOnRevisionId`. A revision list read
 * from storage can be structurally broken (a parent row that is gone, a parent
 * that belongs to another spec, or a cycle written by a bad edit), and every
 * caller here is choosing the base a new revision will copy its element
 * versions from. Guessing a base on broken lineage silently drops content, so
 * a broken walk raises this error instead of returning a null that reads like
 * "no approved ancestor exists".
 */
export type SpecRevisionLineageFailureReason =
  | "unknown_revision"
  | "missing_parent"
  | "cross_spec_parent";

export class SpecRevisionLineageError extends Error {
  constructor(
    readonly reason: SpecRevisionLineageFailureReason,
    /** The revision id that could not be resolved within this spec. */
    readonly revisionId: string,
    /** The revision that pointed at it; null when it is the walk's start. */
    readonly childRevisionId: string | null,
  ) {
    super(
      childRevisionId === null
        ? `revision ${revisionId} is not part of the supplied lineage (${reason})`
        : `revision ${childRevisionId} is based on revision ${revisionId}, which is not part of the same spec's lineage (${reason})`,
    );
    this.name = "SpecRevisionLineageError";
  }
}

export type OrdinaryContinuation =
  | { readonly kind: "reuse_draft"; readonly draft: SpecRevision }
  | {
      readonly kind: "clone_approved";
      readonly approved: SpecRevision;
      /**
       * Withdrawn revisions below `approved`, ordered by number. Their content
       * is not carried into the clone: a withdrawal ends its revision without
       * folding it forward, so continuing from the approved base drops it.
       * Terminal, so there is nothing to refuse — but the caller has to be
       * able to say what it left behind.
       */
      readonly skippedWithdrawn: readonly SpecRevision[];
    }
  | { readonly kind: "unavailable" };

function index(revisions: readonly SpecRevision[]): Map<string, SpecRevision> {
  return new Map(revisions.map((revision) => [revision.id, revision]));
}

function requireStart(
  byId: Map<string, SpecRevision>,
  revisionId: string,
): SpecRevision {
  const start = byId.get(revisionId);
  if (start === undefined) {
    throw new SpecRevisionLineageError("unknown_revision", revisionId, null);
  }
  return start;
}

/**
 * Walks parents, calling `visit` for each ancestor until the walk is cut short
 * or lineage runs out. The visited set makes a cycle terminate at its first
 * repeat rather than spinning.
 */
function walkAncestors(
  revisions: readonly SpecRevision[],
  revisionId: string,
  visit: (ancestor: SpecRevision) => "continue" | "stop",
): void {
  const byId = index(revisions);
  let current = requireStart(byId, revisionId);
  const visited = new Set<string>([current.id]);

  for (;;) {
    const parentId = current.basedOnRevisionId;
    if (parentId === null) return;
    const parent = byId.get(parentId);
    if (parent === undefined) {
      throw new SpecRevisionLineageError(
        "missing_parent",
        parentId,
        current.id,
      );
    }
    if (parent.specId !== current.specId) {
      throw new SpecRevisionLineageError(
        "cross_spec_parent",
        parent.id,
        current.id,
      );
    }
    if (visited.has(parent.id)) return;
    if (visit(parent) === "stop") return;
    visited.add(parent.id);
    current = parent;
  }
}

/** Ancestors of `revisionId`, excluding the revision itself. */
export function ancestorIds(
  revisions: readonly SpecRevision[],
  revisionId: string,
): Set<string> {
  const ancestors = new Set<string>();
  walkAncestors(revisions, revisionId, (ancestor) => {
    ancestors.add(ancestor.id);
    return "continue";
  });
  return ancestors;
}

/**
 * The closest approved revision above `revisionId`, following lineage rather
 * than revision numbers: a draft is based on the revision it amends, which is
 * not always the highest-numbered approved revision.
 */
export function nearestApprovedAncestor(
  revisions: readonly SpecRevision[],
  revisionId: string,
): SpecRevision | null {
  let approved: SpecRevision | null = null;
  walkAncestors(revisions, revisionId, (ancestor) => {
    if (ancestor.state !== "approved") return "continue";
    approved = ancestor;
    return "stop";
  });
  return approved;
}

/**
 * The revision whose content a gate's applicability is measured against: the
 * nearest approved ancestor, because that is the last content a human admitted.
 * Null when nothing above `revision` has ever been approved — every gate is
 * then applicable, which is what an unapproved spec owes.
 *
 * Separate from the immediate parent on purpose. A change that entered through
 * an attempt a human withdrew is unchanged against that attempt but still
 * unadmitted, so measuring applicability from the parent lets the follow-up
 * revision inherit an admission no human gave it.
 */
export function governanceBaseRevisionId(
  revisions: readonly SpecRevision[],
  revision: SpecRevision | null,
): string | null {
  if (revision === null) return null;
  return nearestApprovedAncestor(revisions, revision.id)?.id ?? null;
}

/**
 * Chooses the base for an ordinary authoring continuation (`spec amend`, a
 * create against an existing slug, a link reservation). A spec carries one
 * editable revision, so an open draft is always the one to continue.
 */
export function selectOrdinaryContinuation(
  revisions: readonly SpecRevision[],
): OrdinaryContinuation {
  const byNumber = [...revisions].sort((a, b) => a.number - b.number);
  const draft = byNumber.findLast((revision) => revision.state === "draft");
  if (draft !== undefined) return { kind: "reuse_draft", draft };

  const approved = byNumber.findLast(
    (revision) => revision.state === "approved",
  );
  if (approved !== undefined) {
    return {
      kind: "clone_approved",
      approved,
      skippedWithdrawn: byNumber.filter(
        (revision) =>
          revision.state === "withdrawn" &&
          ancestorIds(revisions, revision.id).has(approved.id),
      ),
    };
  }

  return { kind: "unavailable" };
}
