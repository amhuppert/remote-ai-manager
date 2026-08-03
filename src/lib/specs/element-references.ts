import type { SpecElementKind, SpecElementPayload } from "./schemas";

export interface ElementCitation {
  kind: "element";
  elementId: string;
  handle: string;
}

export interface AssumptionCitation {
  kind: "assumption";
  assumptionId: string;
  handle: string;
}

export type InternalCitation = ElementCitation | AssumptionCitation;

/**
 * The element view every reference reader needs: identity, the payload that
 * carries the typed id arrays, and the structured citations resolved for it.
 */
export interface ReferenceSourceElement {
  id: string;
  payload: SpecElementPayload;
  citations?: readonly InternalCitation[];
}

export type SpecReferenceRelation =
  | "traces to"
  | "covers"
  | "depends on"
  | "cites"
  | "is contained by";

/**
 * `parentElementId` is element-row linkage rather than payload content, so
 * `elementReferences` never emits it: lint 9.6 reports dangling handles an
 * author wrote, and an orphaned criterion is a structural break with its own
 * diagnosis. The write guard enumerates containment separately and reports it
 * through this same vocabulary so one refusal shape covers both.
 */
export type SpecReferenceField =
  | "tracedRequirementElementIds"
  | "tracedDecisionElementIds"
  | "coveredCriterionElementIds"
  | "dependsOnTaskElementIds"
  | "citations"
  | "parentElementId";

/**
 * Which id namespace the target lives in. Assumptions are spec-level records
 * rather than revision content, so a citation of one cannot be resolved
 * against an element snapshot at all.
 */
export type ReferenceTargetSpace = "element" | "assumption";

export interface SpecElementReference {
  sourceElementId: string;
  field: SpecReferenceField;
  /** Position within its field, so a refusal can name the exact entry. */
  index: number;
  targetId: string;
  /** The handle the citation carried; null for the typed id arrays. */
  targetHandle: string | null;
  /** Null when any element kind satisfies the reference, as citations do. */
  expectedKind: SpecElementKind | null;
  relation: SpecReferenceRelation;
  targetSpace: ReferenceTargetSpace;
}

interface TypedReferenceGroup {
  field: Exclude<SpecReferenceField, "citations" | "parentElementId">;
  targetIds: readonly string[];
  expectedKind: SpecElementKind;
  relation: SpecReferenceRelation;
}

/**
 * The one place that knows which payload fields carry element identity. The
 * exhaustive switch makes a new element kind a compile error here rather than
 * a silently unvalidated relationship.
 */
function typedReferenceGroups(
  payload: SpecElementPayload,
): readonly TypedReferenceGroup[] {
  switch (payload.kind) {
    case "task":
      return [
        {
          field: "tracedRequirementElementIds",
          targetIds: payload.tracedRequirementElementIds,
          expectedKind: "requirement",
          relation: "traces to",
        },
        {
          field: "tracedDecisionElementIds",
          targetIds: payload.tracedDecisionElementIds,
          expectedKind: "decision",
          relation: "traces to",
        },
        {
          field: "coveredCriterionElementIds",
          targetIds: payload.coveredCriterionElementIds,
          expectedKind: "criterion",
          relation: "covers",
        },
        {
          field: "dependsOnTaskElementIds",
          targetIds: payload.dependsOnTaskElementIds,
          expectedKind: "task",
          relation: "depends on",
        },
      ];
    case "decision":
      return [
        {
          field: "tracedRequirementElementIds",
          targetIds: payload.tracedRequirementElementIds,
          expectedKind: "requirement",
          relation: "traces to",
        },
      ];
    case "section":
    case "requirement":
    case "criterion":
      return [];
  }
}

/**
 * Every relationship one element declares, typed arrays first in payload order
 * and then citations. Drafting and lint both read the graph through this, so a
 * relationship neither path can miss the other's view of it.
 */
export function elementReferences(
  element: ReferenceSourceElement,
): SpecElementReference[] {
  const references: SpecElementReference[] = [];

  for (const group of typedReferenceGroups(element.payload)) {
    group.targetIds.forEach((targetId, index) => {
      references.push({
        sourceElementId: element.id,
        field: group.field,
        index,
        targetId,
        targetHandle: null,
        expectedKind: group.expectedKind,
        relation: group.relation,
        targetSpace: "element",
      });
    });
  }

  (element.citations ?? []).forEach((citation, index) => {
    references.push({
      sourceElementId: element.id,
      field: "citations",
      index,
      targetId:
        citation.kind === "element"
          ? citation.elementId
          : citation.assumptionId,
      targetHandle: citation.handle,
      expectedKind: null,
      relation: "cites",
      targetSpace: citation.kind === "element" ? "element" : "assumption",
    });
  });

  return references;
}

export function enumerateElementReferences(
  elements: readonly ReferenceSourceElement[],
): SpecElementReference[] {
  return elements.flatMap(elementReferences);
}

export type ReferenceIssueCode = "missing_target" | "wrong_kind";

export interface ReferenceIssue {
  code: ReferenceIssueCode;
  sourceElementId: string;
  field: SpecReferenceField;
  index: number;
  targetId: string;
  expectedKind: SpecElementKind | null;
  /** The kind the final snapshot carries; null when it carries nothing. */
  actualKind: SpecElementKind | null;
  relation: SpecReferenceRelation;
}

/**
 * Judges a staged write before it commits: `finalSnapshot` is the complete
 * element set the revision would carry afterwards, so a batch resolves forward
 * references regardless of the order its items arrive in.
 *
 * Only relationships the write moved are judged — outgoing references of every
 * changed source, and incoming references to every target the write removed,
 * re-kinded or introduced. Sweeping the whole snapshot instead would let one
 * pre-existing bad reference block every later repair of the same revision;
 * the propose-time lint remains the sweep that catches those.
 *
 * Assumption citations resolve against spec-level assumption records rather
 * than revision content, so they are outside this snapshot's authority.
 */
export function validateAffectedReferences(
  finalSnapshot: readonly ReferenceSourceElement[],
  affectedSources: Iterable<string>,
  affectedTargets: Iterable<string>,
): ReferenceIssue[] {
  const sources = new Set(affectedSources);
  const targets = new Set(affectedTargets);
  if (sources.size === 0 && targets.size === 0) {
    return [];
  }

  const kindById = new Map(
    finalSnapshot.map((element) => [element.id, element.payload.kind]),
  );
  const issues: ReferenceIssue[] = [];

  for (const reference of enumerateElementReferences(finalSnapshot)) {
    if (reference.targetSpace !== "element") {
      continue;
    }
    if (
      !sources.has(reference.sourceElementId) &&
      !targets.has(reference.targetId)
    ) {
      continue;
    }

    const actualKind = kindById.get(reference.targetId) ?? null;
    if (actualKind === null) {
      issues.push(issueOf("missing_target", reference, null));
      continue;
    }
    if (
      reference.expectedKind !== null &&
      actualKind !== reference.expectedKind
    ) {
      issues.push(issueOf("wrong_kind", reference, actualKind));
    }
  }

  return issues;
}

/**
 * The refusal wording, kept next to the rule so every mutation owner reports a
 * dangling reference the same way: which entry of which field, and what the
 * revision carries there instead.
 */
export function describeReferenceIssue(issue: ReferenceIssue): string {
  const location = `${issue.sourceElementId}.${issue.field}[${issue.index}]`;
  const expected = issue.expectedKind ?? "element";
  if (issue.code === "missing_target") {
    return `${location} ${issue.relation} ${expected} ${issue.targetId}, which is not in this revision.`;
  }
  return `${location} ${issue.relation} ${issue.targetId}, which is a ${issue.actualKind}, not a ${expected}.`;
}

function issueOf(
  code: ReferenceIssueCode,
  reference: SpecElementReference,
  actualKind: SpecElementKind | null,
): ReferenceIssue {
  return {
    code,
    sourceElementId: reference.sourceElementId,
    field: reference.field,
    index: reference.index,
    targetId: reference.targetId,
    expectedKind: reference.expectedKind,
    actualKind,
    relation: reference.relation,
  };
}
