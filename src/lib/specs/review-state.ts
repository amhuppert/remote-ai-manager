import { z } from "zod";

import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepoTransaction } from "@/lib/state-store/specs-repo";

import {
  bareElementHandleSchema,
  formatBareElementHandle,
  type BareElementHandle,
} from "./handles";
import type { Spec, SpecAssumptionRow, SpecRevisionSnapshot } from "./schemas";
import type {
  RevisionSnapshot as LintRevisionSnapshot,
  SpecRecords,
} from "./lint";
import {
  createApprovalApplicability,
  type ApprovalCitationState,
  type ApprovalApplicability,
} from "./approval-applicability";
import { importBaselineRevisionId } from "./import-baseline";
import type {
  RevisionCitation as DiffRevisionCitation,
  RevisionCitationDiffContext,
  RevisionElement as DiffRevisionElement,
} from "./revision-diff";
import { ancestorIds, nearestApprovedAncestor } from "./revision-lineage";
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
): LintRevisionSnapshot {
  const assumptionsByElement = new Map<
    string,
    Array<{ id: string; handle: string }>
  >();
  for (const citation of snapshot.assumptionCitations) {
    const existing = assumptionsByElement.get(citation.elementId) ?? [];
    existing.push({
      id: citation.assumptionId,
      handle: formatBareElementHandle({
        kind: "assumption",
        number: citation.snapshot.number,
      }),
    });
    assumptionsByElement.set(citation.elementId, existing);
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

/**
 * Citations first, then the spec's own assumption rows. The citation snapshot
 * wins where both describe the same assumption: 9.6 and 9.8 judge a cited
 * assumption by the disposition the citation froze, not by whatever the mutable
 * row says now.
 *
 * The rows still have to be here, because an assumption may carry no element
 * attachment at all and therefore no citation. It exists, it is addressable as
 * `A<n>`, and lint's existence checks — prose references among them — would
 * otherwise call a perfectly real assumption unknown.
 */
export function toLintAssumptionRecords(
  snapshot: SpecRevisionSnapshot,
  specAssumptions: readonly SpecAssumptionRow[],
): NonNullable<SpecRecords["assumptions"]> {
  const assumptions = new Map<
    string,
    NonNullable<SpecRecords["assumptions"]>[number]
  >();
  for (const citation of snapshot.assumptionCitations) {
    if (assumptions.has(citation.assumptionId)) continue;
    assumptions.set(citation.assumptionId, {
      assumptionId: citation.assumptionId,
      handle: formatBareElementHandle({
        kind: "assumption",
        number: citation.snapshot.number,
      }),
      disposition: citation.snapshot.disposition,
    });
  }
  for (const assumption of specAssumptions) {
    if (assumptions.has(assumption.id)) continue;
    assumptions.set(assumption.id, {
      assumptionId: assumption.id,
      handle: formatBareElementHandle({
        kind: "assumption",
        number: assumption.number,
      }),
      disposition: assumption.disposition,
    });
  }
  return [...assumptions.values()].sort((left, right) =>
    left.handle.localeCompare(right.handle, undefined, { numeric: true }),
  );
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

export function toDiffCitations(
  snapshot: SpecRevisionSnapshot,
): DiffRevisionCitation[] {
  return snapshot.assumptionCitations.map(
    ({ elementId, assumptionId, snapshot: assumptionSnapshot }) => ({
      elementId,
      assumptionId,
      snapshot: assumptionSnapshot,
    }),
  );
}

export function toCitationDiffContext(
  base: SpecRevisionSnapshot | null,
  draft: SpecRevisionSnapshot,
): RevisionCitationDiffContext {
  return {
    baseCitationContractVersion:
      base?.revision.citationContractVersion ??
      draft.revision.citationContractVersion,
    draftCitationContractVersion: draft.revision.citationContractVersion,
    baseCitations: base === null ? [] : toDiffCitations(base),
    draftCitations: toDiffCitations(draft),
  };
}

/**
 * Reads each distinct revision snapshot once. Approvals accumulate on a spec
 * without bound and several of them name the same revision, so a per-approval
 * read would grow the work of every status and sign-off evaluation with the
 * approval count rather than with the number of revisions involved.
 */
export function cacheRevisionSnapshots(
  load: (revisionId: string) => SpecRevisionSnapshot | null,
): (revisionId: string) => SpecRevisionSnapshot | null {
  const loaded = new Map<string, SpecRevisionSnapshot | null>();
  return (revisionId) => {
    if (!loaded.has(revisionId)) loaded.set(revisionId, load(revisionId));
    return loaded.get(revisionId) ?? null;
  };
}

export interface LoadedProposalState {
  draft: LintRevisionSnapshot;
  records: SpecRecords;
  reviewSnapshot: SignOffReviewSnapshot;
  /**
   * The immediate parent (`basedOnRevisionId`) — what this review attempt
   * changed, and the baseline the review diff and approval carry-forward read.
   */
  reviewBaseSnapshot: SpecRevisionSnapshot | null;
  /**
   * The nearest approved ancestor — what still owes an admission. Null for a
   * spec no revision of which has ever been approved.
   */
  governanceBaseSnapshot: SpecRevisionSnapshot | null;
  /** The one authority on whether an approval satisfies this revision. */
  approvalApplies: ApprovalApplicability;
  /**
   * The import baseline revision's rows, null for a spec no import created.
   * Carried on the loaded state because the sign-off preconditions and the
   * status projection must read the same baseline.
   */
  importBaselineRows: DiffRevisionElement[] | null;
  importBaselineCitationState: ApprovalCitationState | null;
}

export type ProposalStateRepo = Pick<
  SpecsRepoTransaction,
  "getRevisionSnapshot" | "listRevisions"
>;

export function loadProposalState(
  repo: ProposalStateRepo,
  review: SpecReviewRepo,
  links: Pick<SpecLinksRepo, "findBySpecId">,
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
): LoadedProposalState {
  const loadSnapshot = cacheRevisionSnapshots((revisionId) =>
    revisionId === snapshot.revision.id
      ? snapshot
      : repo.getRevisionSnapshot(revisionId),
  );
  const baseSnapshot =
    snapshot.revision.basedOnRevisionId === null
      ? null
      : loadSnapshot(snapshot.revision.basedOnRevisionId);
  const revisions = repo.listRevisions(spec.id);
  const governanceBase = nearestApprovedAncestor(
    revisions,
    snapshot.revision.id,
  );
  const governanceBaseSnapshot =
    governanceBase === null ? null : loadSnapshot(governanceBase.id);
  const importBaselineRevision = importBaselineRevisionId(
    review.findGateAdmissionsBySpecId(spec.id),
  );
  const importBaselineSnapshot =
    importBaselineRevision === null
      ? null
      : loadSnapshot(importBaselineRevision);
  const importBaselineRows =
    importBaselineSnapshot === null ? null : toDiffRows(importBaselineSnapshot);
  const importBaselineCitationState =
    importBaselineSnapshot === null
      ? null
      : {
          citationContractVersion:
            importBaselineSnapshot.revision.citationContractVersion,
          citations: toDiffCitations(importBaselineSnapshot),
        };
  const draft = toLintSnapshot(spec, snapshot);
  const baseDraft =
    baseSnapshot === null ? undefined : toLintSnapshot(spec, baseSnapshot);
  const approvals = review.findApprovalsBySpecId(spec.id);
  const approvedElements = approvals.flatMap((approval) => {
    if (approval.element_id === null) return [];
    const approvedSnapshot = loadSnapshot(approval.revision_id);
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
  const assumptions = toLintAssumptionRecords(
    snapshot,
    review.findAssumptionsBySpecId(spec.id),
  );
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
      const approvedSnapshot = loadSnapshot(parsed.data.approvedRevisionId);
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
    governanceBaseRevisionId: governanceBase?.id ?? null,
    governanceBaseRevisionRows:
      governanceBaseSnapshot === null ? [] : toDiffRows(governanceBaseSnapshot),
    governanceBaseCitationState:
      governanceBaseSnapshot === null
        ? {
            citationContractVersion: snapshot.revision.citationContractVersion,
            citations: [],
          }
        : {
            citationContractVersion:
              governanceBaseSnapshot.revision.citationContractVersion,
            citations: toDiffCitations(governanceBaseSnapshot),
          },
    revisionRows: toDiffRows(snapshot),
    citationContractVersion: snapshot.revision.citationContractVersion,
    citations: toDiffCitations(snapshot),
    importBaselineRows,
    importBaselineCitationState,
    blockingThreads: review
      .findCommentsByRevision(snapshot.revision.id)
      .filter((comment) => comment.blocking === 1)
      .map((comment) => ({
        handle: comment.thread_id,
        resolved: comment.resolution !== "open",
      })),
    approvals: approvals.flatMap((approval) =>
      approval.subject_kind === "revision"
        ? []
        : [
            {
              subjectKind: approval.subject_kind,
              elementId: approval.element_id,
              revisionId: approval.revision_id,
              validity: approval.validity,
            },
          ],
    ),
  };
  return {
    draft,
    records,
    reviewSnapshot,
    reviewBaseSnapshot: baseSnapshot,
    governanceBaseSnapshot,
    importBaselineRows,
    importBaselineCitationState,
    approvalApplies: createApprovalApplicability({
      revisionId: snapshot.revision.id,
      basedOnRevisionId: snapshot.revision.basedOnRevisionId,
      ancestorRevisionIds: ancestorIds(revisions, snapshot.revision.id),
      revisionRows: reviewSnapshot.revisionRows,
      citationContractVersion: snapshot.revision.citationContractVersion,
      citations: toDiffCitations(snapshot),
      stateForRevision: (revisionId) => {
        const approved = loadSnapshot(revisionId);
        return approved === null
          ? null
          : {
              rows: toDiffRows(approved),
              citationContractVersion:
                approved.revision.citationContractVersion,
              citations: toDiffCitations(approved),
            };
      },
    }),
  };
}
