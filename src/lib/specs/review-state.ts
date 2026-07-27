import { z } from "zod";

import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepoTransaction } from "@/lib/state-store/specs-repo";

import {
  bareElementHandleSchema,
  formatBareElementHandle,
  type BareElementHandle,
} from "./handles";
import type { Spec, SpecRevisionSnapshot } from "./schemas";
import type {
  RevisionSnapshot as LintRevisionSnapshot,
  SpecRecords,
} from "./lint";
import type { RevisionElement as DiffRevisionElement } from "./revision-diff";
import type { SignOffReviewSnapshot } from "./transitions";

/**
 * Renders through the handle module's formatter, so a number the grammar does
 * not admit yields no handle rather than a string the handle parser rejects.
 */
function bareHandle(handle: BareElementHandle): string | null {
  const parsed = bareElementHandleSchema.safeParse(handle);
  return parsed.success ? formatBareElementHandle(parsed.data) : null;
}

/**
 * The one derivation of an element's handle from a revision snapshot — which
 * element gets which number. Returns null when the element has no addressable
 * handle: sections, and rows whose own number (or whose parent requirement's
 * number) was never allocated. Such elements are addressed by their element id
 * instead.
 */
export function elementHandleInSnapshot(
  snapshot: SpecRevisionSnapshot,
  elementId: string,
): string | null {
  const row = snapshot.elements.find(({ element }) => element.id === elementId);
  if (row === undefined) return null;
  const { element } = row;
  if (element.kind === "section" || element.number === null) return null;
  if (element.kind === "criterion") {
    const parent = snapshot.elements.find(
      ({ element: candidate }) => candidate.id === element.parentElementId,
    )?.element;
    return parent === undefined || parent.number === null
      ? null
      : bareHandle({
          kind: "criterion",
          requirementNumber: parent.number,
          criterionNumber: element.number,
        });
  }
  if (element.kind === "requirement") {
    return bareHandle({
      kind: "requirement",
      requirementNumber: element.number,
    });
  }
  if (element.kind === "decision") {
    return bareHandle({ kind: "decision", number: element.number });
  }
  return bareHandle({ kind: "task", number: element.number });
}

function elementHandle(
  snapshot: SpecRevisionSnapshot,
  elementId: string,
): string {
  return elementHandleInSnapshot(snapshot, elementId) ?? elementId;
}

export function toLintSnapshot(
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
  review?: SpecReviewRepo,
): LintRevisionSnapshot {
  const assumptionsByElement = new Map<
    string,
    Array<{ id: string; handle: string }>
  >();
  for (const assumption of review?.findAssumptionsBySpecId(spec.id) ?? []) {
    if (assumption.element_id === null) continue;
    if (
      snapshot.revision.state !== "draft" &&
      snapshot.revision.proposedAt !== null &&
      assumption.created_at > snapshot.revision.proposedAt
    ) {
      continue;
    }
    const existing = assumptionsByElement.get(assumption.element_id) ?? [];
    existing.push({
      id: assumption.id,
      handle: formatBareElementHandle({
        kind: "assumption",
        number: assumption.number,
      }),
    });
    assumptionsByElement.set(assumption.element_id, existing);
  }

  return {
    specHandle: spec.slug,
    authoringStage: snapshot.revision.authoringStage,
    elements: snapshot.elements.map(({ element, version }) => ({
      id: element.id,
      handle: elementHandle(snapshot, element.id),
      ...(element.parentElementId === null
        ? {}
        : { parentElementId: element.parentElementId }),
      payloadHash: version.payloadHash,
      payload: version.payload,
      ...((assumptionsByElement.get(element.id)?.length ?? 0) === 0
        ? {}
        : {
            citations: assumptionsByElement
              .get(element.id)!
              .map((assumption) => ({
                kind: "assumption" as const,
                assumptionId: assumption.id,
                handle: assumption.handle,
              })),
          }),
    })),
  };
}

export function toDiffRows(
  snapshot: SpecRevisionSnapshot,
): DiffRevisionElement[] {
  return snapshot.elements.map(({ element, version }) => ({
    elementId: element.id,
    parentElementId: element.parentElementId,
    payloadHash: version.payloadHash,
    payload: version.payload,
  }));
}

export interface LoadedProposalState {
  draft: LintRevisionSnapshot;
  records: SpecRecords;
  reviewSnapshot: SignOffReviewSnapshot;
  baseSnapshot: SpecRevisionSnapshot | null;
}

export function loadProposalState(
  repo: SpecsRepoTransaction,
  review: SpecReviewRepo,
  links: Pick<SpecLinksRepo, "findBySpecId">,
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
): LoadedProposalState {
  const baseSnapshot =
    snapshot.revision.basedOnRevisionId === null
      ? null
      : repo.getRevisionSnapshot(snapshot.revision.basedOnRevisionId);
  const draft = toLintSnapshot(spec, snapshot, review);
  const baseDraft =
    baseSnapshot === null
      ? undefined
      : toLintSnapshot(spec, baseSnapshot, review);
  const approvals = review.findApprovalsBySpecId(spec.id);
  const approvedElements = approvals.flatMap((approval) => {
    if (approval.element_id === null) return [];
    const approvedSnapshot = repo.getRevisionSnapshot(approval.revision_id);
    const approvedVersion = approvedSnapshot?.elements.find(
      ({ element }) => element.id === approval.element_id,
    )?.version;
    return approvedVersion === undefined
      ? []
      : [
          {
            elementId: approval.element_id,
            approvedPayloadHash: approvedVersion.payloadHash,
          },
        ];
  });
  const knownElements = new Map(
    [...(baseDraft?.elements ?? []), ...draft.elements].map((element) => [
      element.id,
      {
        elementId: element.id,
        handle: element.handle,
        kind: element.payload.kind,
      },
    ]),
  );
  const assumptions = review.findAssumptionsBySpecId(spec.id).map((row) => ({
    assumptionId: row.id,
    handle: formatBareElementHandle({ kind: "assumption", number: row.number }),
    disposition: row.disposition,
  }));
  const materializedTasks = links
    .findBySpecId(spec.id)
    .filter(
      (link) =>
        link.category === "materialized_from" && link.snapshot_json !== null,
    )
    .flatMap((link) => {
      const parsed = z
        .object({
          approvedRevisionId: z.string().min(1),
          taskElementId: z.string().min(1),
        })
        .safeParse(JSON.parse(link.snapshot_json!));
      if (!parsed.success) return [];
      const approvedSnapshot = repo.getRevisionSnapshot(
        parsed.data.approvedRevisionId,
      );
      if (approvedSnapshot === null) return [];
      const task = approvedSnapshot.elements.find(
        ({ element, version }) =>
          element.id === parsed.data.taskElementId &&
          version.payload.kind === "task",
      );
      if (task === undefined || task.version.payload.kind !== "task") return [];
      return [
        {
          taskElementId: task.element.id,
          handle: elementHandle(approvedSnapshot, task.element.id),
          scope: {
            tracedRequirementElementIds:
              task.version.payload.tracedRequirementElementIds,
            tracedDecisionElementIds:
              task.version.payload.tracedDecisionElementIds,
            coveredCriterionElementIds:
              task.version.payload.coveredCriterionElementIds,
            dependsOnTaskElementIds:
              task.version.payload.dependsOnTaskElementIds,
          },
        },
      ];
    });
  const records: SpecRecords = {
    ...(baseDraft === undefined ? {} : { baseRevision: baseDraft }),
    knownElements: [...knownElements.values()],
    approvedElements,
    questions: review.findQuestionsBySpecId(spec.id).map((row) => ({
      questionId: row.id,
      handle: formatBareElementHandle({ kind: "question", number: row.number }),
      status: row.status,
    })),
    assumptions,
    materializedTasks,
  };
  const reviewSnapshot: SignOffReviewSnapshot = {
    revisionId: snapshot.revision.id,
    baseRevisionRows: baseSnapshot === null ? [] : toDiffRows(baseSnapshot),
    revisionRows: toDiffRows(snapshot),
    blockingThreads: review
      .findCommentsByRevision(snapshot.revision.id)
      .filter((comment) => comment.blocking === 1)
      .map((comment) => ({
        handle: comment.thread_id,
        resolved: comment.resolution !== "open",
      })),
    approvals: approvals
      .filter((approval) => approval.subject_kind !== "revision")
      .map((approval) => ({
        subjectKind: approval.subject_kind as
          | "requirement"
          | "decision"
          | "plan",
        ...(approval.element_id === null
          ? {}
          : { elementId: approval.element_id }),
        revisionId: approval.revision_id,
        validity: approval.validity,
      })),
  };
  return { draft, records, reviewSnapshot, baseSnapshot };
}
