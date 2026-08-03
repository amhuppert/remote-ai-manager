import {
  describeReferenceIssue,
  validateAffectedReferences,
  type ReferenceIssue,
  type ReferenceSourceElement,
} from "./element-references";
import type { SpecElementPayload, SpecRevisionSnapshot } from "./schemas";

/**
 * The revision view the write guard reasons over: payload references plus the
 * containment link, which lives on the element row rather than in content.
 */
export interface GuardedElement extends ReferenceSourceElement {
  parentElementId: string | null;
}

/**
 * One element the caller intends the revision to carry (or stop carrying)
 * after this transaction. A write states the payload and the parent the
 * element ends up with, so staging never has to guess whether an upsert
 * created or updated the row.
 */
export type StagedElementMutation =
  | {
      readonly op: "write";
      readonly elementId: string;
      readonly payload: SpecElementPayload;
      readonly parentElementId: string | null;
    }
  | { readonly op: "remove"; readonly elementId: string };

export interface StagedRevisionWrite {
  /** Every element the revision would carry once this transaction commits. */
  readonly finalSnapshot: GuardedElement[];
  /** Elements whose own outgoing references this write decides. */
  readonly affectedSources: string[];
  /** Elements this write introduced or removed, so incoming links move. */
  readonly affectedTargets: string[];
}

/** Only criteria are contained, and only a requirement can contain one. */
const CONTAINER_KIND = "requirement" as const;

/**
 * The revision content a staged write is judged against. A revision that does
 * not exist yet — the first save of a brand-new spec — carries nothing, which
 * is exactly what an empty list says.
 */
export function guardedElements(
  snapshot: SpecRevisionSnapshot | null,
): GuardedElement[] {
  return (snapshot?.elements ?? []).map(({ element, version }) => ({
    id: element.id,
    payload: version.payload,
    parentElementId: element.parentElementId,
  }));
}

/**
 * Applies the whole intended mutation set to the current revision content
 * without touching persistence, so every owner can judge its complete result
 * before committing any of it. Order within the input never matters: a batch
 * that writes a task before the criterion it covers stages the same final
 * snapshot as the reverse order.
 */
export function stageRevisionWrite(
  current: readonly GuardedElement[],
  mutations: readonly StagedElementMutation[],
): StagedRevisionWrite {
  const staged = new Map(current.map((element) => [element.id, element]));
  const affectedSources: string[] = [];
  const affectedTargets: string[] = [];

  for (const mutation of mutations) {
    if (mutation.op === "remove") {
      staged.delete(mutation.elementId);
      affectedTargets.push(mutation.elementId);
      continue;
    }
    // An element the revision does not carry yet also moves every incoming
    // link that named it, so introductions are judged from both directions.
    if (!staged.has(mutation.elementId)) {
      affectedTargets.push(mutation.elementId);
    }
    affectedSources.push(mutation.elementId);
    staged.set(mutation.elementId, {
      id: mutation.elementId,
      payload: mutation.payload,
      parentElementId: mutation.parentElementId,
    });
  }

  return {
    finalSnapshot: [...staged.values()],
    affectedSources,
    affectedTargets,
  };
}

/**
 * The staged write's verdict: payload references through the shared validator,
 * plus the containment link, which no payload field carries and which a
 * removal is the only ordinary way to break.
 */
export function validateStagedWrite(
  staged: StagedRevisionWrite,
): ReferenceIssue[] {
  return [
    ...validateAffectedReferences(
      staged.finalSnapshot,
      staged.affectedSources,
      staged.affectedTargets,
    ),
    ...affectedContainmentIssues(staged),
  ];
}

function affectedContainmentIssues(
  staged: StagedRevisionWrite,
): ReferenceIssue[] {
  const sources = new Set(staged.affectedSources);
  const targets = new Set(staged.affectedTargets);
  if (sources.size === 0 && targets.size === 0) return [];

  const kindById = new Map(
    staged.finalSnapshot.map((element) => [element.id, element.payload.kind]),
  );
  const issues: ReferenceIssue[] = [];
  for (const element of staged.finalSnapshot) {
    const parentElementId = element.parentElementId;
    if (parentElementId === null) continue;
    if (!sources.has(element.id) && !targets.has(parentElementId)) continue;

    const actualKind = kindById.get(parentElementId) ?? null;
    if (actualKind === CONTAINER_KIND) continue;
    issues.push({
      code: actualKind === null ? "missing_target" : "wrong_kind",
      sourceElementId: element.id,
      field: "parentElementId",
      index: 0,
      targetId: parentElementId,
      expectedKind: CONTAINER_KIND,
      actualKind,
      relation: "is contained by",
    });
  }
  return issues;
}

/**
 * The refusal every mutation owner reports for a staged write that would leave
 * a reference pointing at content the revision does not carry. It names the
 * ways out, because a caller told only "this dangles" retries the identical
 * write. Containment gets its own sentence: a parent link is fixed at
 * creation, so repointing it is an instruction no write can obey.
 */
export interface DanglingReferenceRefusal {
  readonly code: "dangling_reference";
  readonly unmetConditions: string[];
  readonly instruction: string;
  readonly details: Record<string, unknown>;
}

export function danglingReferenceRefusal(
  issues: readonly ReferenceIssue[],
): DanglingReferenceRefusal {
  const contained = issues.filter(({ field }) => field === "parentElementId");
  const referencing = issues.filter(({ field }) => field !== "parentElementId");
  const sentences: string[] = [];
  if (referencing.length > 0) {
    sentences.push(
      `Rewrite or remove ${joinIds(sourceIds(referencing))} in the same write: drop the entry, repoint it at an element this revision carries, or remove the source alongside its target.`,
    );
  }
  if (contained.length > 0) {
    sentences.push(
      `${joinIds(sourceIds(contained))} cannot be repointed, because containment is fixed at creation: bring ${joinIds(targetIds(contained))} back into this revision in the same write — with "reintroduceHistorical": true when the identity is historical — or remove ${joinIds(sourceIds(contained))} instead.`,
    );
  }
  return {
    code: "dangling_reference",
    unmetConditions: issues.map(describeReferenceIssue),
    instruction: `Nothing was written. ${sentences.join(" ")}`,
    details: { references: issues.map((issue) => ({ ...issue })) },
  };
}

function sourceIds(issues: readonly ReferenceIssue[]): string[] {
  return [...new Set(issues.map(({ sourceElementId }) => sourceElementId))];
}

function targetIds(issues: readonly ReferenceIssue[]): string[] {
  return [...new Set(issues.map(({ targetId }) => targetId))];
}

function joinIds(ids: readonly string[]): string {
  if (ids.length <= 2) return ids.join(" and ");
  return `${ids.slice(0, -1).join(", ")}, and ${ids.at(-1) ?? ""}`;
}
