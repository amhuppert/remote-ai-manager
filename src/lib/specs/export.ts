import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecGateAdmissionRow,
  SpecQuestionRow,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionContentHash,
  type SpecsRepo,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import { toLintSnapshot } from "./review-state";

export interface SpecExportRevision {
  readonly snapshot: SpecRevisionSnapshot;
}

export interface SpecExportState {
  readonly spec: Spec;
  readonly revisions: SpecExportRevision[];
  readonly approvals: SpecApprovalRow[];
  readonly gateAdmissions: SpecGateAdmissionRow[];
  readonly questions: SpecQuestionRow[];
  readonly assumptions: SpecAssumptionRow[];
}

export interface SpecExportDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
}

export interface CanonicalMarkdownFile {
  readonly path: string;
  readonly content: string;
}

export interface CanonicalSpecBundle {
  readonly markdownFiles: CanonicalMarkdownFile[];
  readonly manifest: string;
}

export interface IntegrityMismatch {
  readonly revisionId: string;
  readonly expectedContentHash: string;
  readonly actualContentHash: string;
  readonly mismatchedElementIds: string[];
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly checkedRevisionIds: string[];
  readonly mismatches: IntegrityMismatch[];
}

export class SpecExportNotFoundError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} was not found`);
    this.name = "SpecExportNotFoundError";
  }
}

export async function loadSpecExportState(
  deps: SpecExportDeps,
  specId: string,
): Promise<SpecExportState> {
  const spec = await deps.specs.findById(specId);
  if (spec === null) throw new SpecExportNotFoundError(specId);
  const revisions = await deps.specs.listRevisions(spec.id);
  const snapshots = await Promise.all(
    revisions.map((revision) => deps.specs.getRevisionSnapshot(revision.id)),
  );
  const loadedRevisions = snapshots.map((snapshot, index) => {
    if (snapshot === null) {
      throw new SpecExportNotFoundError(revisions[index]!.id);
    }
    return { snapshot };
  });
  const gateAdmissions = loadedRevisions.flatMap(({ snapshot }) =>
    deps.review.findGateAdmissionsByRevision(snapshot.revision.id),
  );
  return {
    spec,
    revisions: loadedRevisions,
    approvals: deps.review.findApprovalsBySpecId(spec.id),
    gateAdmissions,
    questions: deps.review.findQuestionsBySpecId(spec.id),
    assumptions: deps.review.findAssumptionsBySpecId(spec.id),
  };
}

function revisionFileName(snapshot: SpecRevisionSnapshot): string {
  return `revisions/${String(snapshot.revision.number).padStart(4, "0")}-${snapshot.revision.state}.md`;
}

function renderElement(row: SpecRevisionElement, handle: string): string {
  const { payload } = row.version;
  switch (payload.kind) {
    case "section":
      return [
        `## ${payload.title}`,
        `<!-- element:${row.element.id} role:${payload.role} -->`,
        payload.body,
      ].join("\n\n");
    case "requirement":
      return [
        `## ${handle} — Requirement`,
        `<!-- element:${row.element.id} -->`,
        payload.statement,
        `- Priority: ${payload.priority}`,
        `- Risk: ${payload.risk}`,
      ].join("\n\n");
    case "criterion":
      return [
        `### ${handle} — Acceptance criterion`,
        `<!-- element:${row.element.id} parent:${row.element.parentElementId} -->`,
        payload.text,
        `Validation strategy: ${payload.validationStrategy.kinds.join(", ")}`,
        ...(payload.validationStrategy.note === undefined
          ? []
          : [payload.validationStrategy.note]),
      ].join("\n\n");
    case "decision":
      return [
        `## ${handle} — ${payload.title}`,
        `<!-- element:${row.element.id} -->`,
        `Chosen approach: ${payload.chosenApproach}`,
        `Reason: ${payload.reason}`,
        "Rejected alternatives:",
        ...(payload.rejectedAlternatives.length === 0
          ? ["- None"]
          : payload.rejectedAlternatives.map(
              (alternative) => `- ${alternative.label}: ${alternative.reason}`,
            )),
      ].join("\n\n");
    case "task":
      return [
        `## ${handle} — ${payload.title}`,
        `<!-- element:${row.element.id} -->`,
        payload.instructions,
        `- Requirements: ${payload.tracedRequirementElementIds.join(", ") || "None"}`,
        `- Criteria: ${payload.coveredCriterionElementIds.join(", ") || "None"}`,
        `- Dependencies: ${payload.dependsOnTaskElementIds.join(", ") || "None"}`,
        ...(payload.laneGroup === undefined
          ? []
          : [`- Lane group: ${payload.laneGroup}`]),
        ...(payload.touchedPaths === undefined
          ? []
          : [`- Touched paths: ${payload.touchedPaths.join(", ") || "None"}`]),
      ].join("\n\n");
  }
}

function renderRevisionMarkdown(
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
): string {
  const handles = new Map(
    toLintSnapshot(spec, snapshot).elements.map((element) => [
      element.id,
      element.handle,
    ]),
  );
  return [
    `# ${spec.name}`,
    `- Spec: ${spec.slug}`,
    `- Revision: ${snapshot.revision.number}`,
    `- State: ${snapshot.revision.state}`,
    `- Authoring stage: ${snapshot.revision.authoringStage}`,
    `- Content hash: ${snapshot.revision.contentHash ?? "editable"}`,
    ...snapshot.elements.map((row) =>
      renderElement(row, handles.get(row.element.id) ?? row.element.id),
    ),
    "",
  ].join("\n\n");
}

function manifestFor(state: SpecExportState): unknown {
  return {
    formatVersion: 1,
    spec: state.spec,
    revisions: state.revisions.map(({ snapshot }) => {
      const handles = new Map(
        toLintSnapshot(state.spec, snapshot).elements.map((element) => [
          element.id,
          element.handle,
        ]),
      );
      return {
        id: snapshot.revision.id,
        number: snapshot.revision.number,
        state: snapshot.revision.state,
        authoringStage: snapshot.revision.authoringStage,
        basedOnRevisionId: snapshot.revision.basedOnRevisionId,
        contentHash: snapshot.revision.contentHash,
        proposedAt: snapshot.revision.proposedAt,
        approvedAt: snapshot.revision.approvedAt,
        createdAt: snapshot.revision.createdAt,
        elements: snapshot.elements.map(({ element, version }) => ({
          id: element.id,
          handle: handles.get(element.id) ?? element.id,
          kind: element.kind,
          number: element.number,
          parentElementId: element.parentElementId,
          position: version.position,
          payload: version.payload,
          payloadHash: version.payloadHash,
          elementVersion: version.elementVersion,
        })),
      };
    }),
    approvals: [...state.approvals].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    gateAdmissions: [...state.gateAdmissions].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    questions: [...state.questions].sort(
      (left, right) => left.number - right.number,
    ),
    assumptions: [...state.assumptions].sort(
      (left, right) => left.number - right.number,
    ),
  };
}

export function renderCanonicalBundle(
  state: SpecExportState,
): CanonicalSpecBundle {
  return {
    markdownFiles: state.revisions.map(({ snapshot }) => ({
      path: revisionFileName(snapshot),
      content: renderRevisionMarkdown(state.spec, snapshot),
    })),
    manifest: `${stableStringify(manifestFor(state))}\n`,
  };
}

export function verifyExportState(state: SpecExportState): IntegrityReport {
  const checkedRevisionIds: string[] = [];
  const mismatches: IntegrityMismatch[] = [];
  for (const { snapshot } of state.revisions) {
    const expectedContentHash = snapshot.revision.contentHash;
    if (expectedContentHash === null) continue;
    checkedRevisionIds.push(snapshot.revision.id);
    const actualContentHash = computeSpecRevisionContentHash(
      snapshot.revision.authoringStage,
      snapshot.elements,
    );
    const mismatchedElementIds = snapshot.elements
      .filter(
        ({ version }) =>
          computeSpecElementPayloadHash(version.payload) !==
          version.payloadHash,
      )
      .map(({ element }) => element.id);
    if (
      actualContentHash === expectedContentHash &&
      mismatchedElementIds.length === 0
    ) {
      continue;
    }
    mismatches.push({
      revisionId: snapshot.revision.id,
      expectedContentHash,
      actualContentHash,
      mismatchedElementIds,
    });
  }
  return {
    ok: mismatches.length === 0,
    checkedRevisionIds,
    mismatches,
  };
}
