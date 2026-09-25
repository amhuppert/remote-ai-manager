import { createHash } from "node:crypto";

import type { RevisionElement } from "./revision-diff";
import type { RevisionCitation } from "./revision-diff";
import {
  subjectFingerprintSchema,
  type SpecApprovalRow,
  type SpecApprovalSubjectKind,
  type SpecApprovalValidity,
} from "./schemas";

/**
 * The approval subjects a human records against content. `revision` is the
 * sign-off itself, which admits the revision rather than a piece of its
 * content, so it is not decided here.
 */
export type ApprovalSubjectKind = Exclude<SpecApprovalSubjectKind, "revision">;

export interface ApprovalSubject {
  subjectKind: ApprovalSubjectKind;
  /** Null for the plan subject, which covers the task set as a whole. */
  elementId: string | null;
}

export interface ApprovalRecord extends ApprovalSubject {
  /** The revision whose content the approving human read. */
  revisionId: string;
  validity: SpecApprovalValidity;
  /** The subject as the approving human read it. */
  fingerprint: SubjectFingerprint;
}

/**
 * One element of a subject, keyed by its stable id. The id is part of the
 * fingerprint, not just the hash: `payload_hash` covers the payload alone, so
 * a replacement element repeats an approved hash under a new id, and the
 * product's direct-change rule calls that a remove plus an add rather than an
 * unchanged subject.
 */
export interface SubjectFingerprintPair {
  elementId: string;
  payloadHash: string;
}

export interface ApprovalCitationState {
  readonly citationContractVersion: 1 | 2;
  readonly citations: readonly RevisionCitation[];
}

export interface SubjectFingerprint {
  readonly elements: readonly SubjectFingerprintPair[];
  readonly citationContractVersion: 1 | 2;
  readonly citationCount: number;
  readonly citationSubhash: string;
}

/**
 * What a human actually approved when they approved this subject, as of one
 * revision's rows. Null when the revision does not carry the subject at all,
 * which no approval can match — there is nothing to have approved.
 *
 * A requirement carries its criteria because approving a requirement approves
 * what would satisfy it. Position is deliberately absent: reordering is not a
 * content change, and including it would silently widen invalidation.
 */
export function subjectFingerprint(
  rows: readonly RevisionElement[],
  subject: ApprovalSubject,
  citationState: ApprovalCitationState,
): SubjectFingerprint | null {
  let elements: SubjectFingerprintPair[];
  if (subject.subjectKind === "plan") {
    elements = rows
      .filter((row) => row.payload.kind === "task")
      .map(pairOf)
      .sort(byElementId);
  } else {
    if (subject.elementId === null) return null;
    const element = rows.find(
      (row) =>
        row.elementId === subject.elementId &&
        row.payload.kind === subject.subjectKind,
    );
    if (element === undefined) return null;
    elements =
      subject.subjectKind === "decision"
        ? [pairOf(element)]
        : [
            pairOf(element),
            ...rows
              .filter(
                (row) =>
                  row.payload.kind === "criterion" &&
                  row.parentElementId === subject.elementId,
              )
              .map(pairOf)
              .sort(byElementId),
          ];
  }
  const coveredElementIds = new Set(elements.map((pair) => pair.elementId));
  const citations = citationState.citations
    .filter((citation) => coveredElementIds.has(citation.elementId))
    .map(({ elementId, assumptionId, snapshot }) => ({
      elementId,
      assumptionId,
      snapshot,
    }))
    .sort(
      (left, right) =>
        left.elementId.localeCompare(right.elementId) ||
        left.assumptionId.localeCompare(right.assumptionId),
    );
  return {
    elements,
    citationContractVersion: citationState.citationContractVersion,
    citationCount: citations.length,
    citationSubhash: createHash("sha256")
      .update(canonicalJson(citations))
      .digest("hex"),
  };
}

export function sameSubjectFingerprint(
  left: SubjectFingerprint | null,
  right: SubjectFingerprint | null,
  allowEmptyCitationContractUpgrade = false,
): boolean {
  if (left === null || right === null) return false;
  const elementsMatch =
    left.elements.length === right.elements.length &&
    left.elements.every(
      (pair, index) =>
        pair.elementId === right.elements[index]?.elementId &&
        pair.payloadHash === right.elements[index]?.payloadHash,
    );
  if (!elementsMatch) return false;
  if (left.citationContractVersion === right.citationContractVersion) {
    return left.citationSubhash === right.citationSubhash;
  }
  return (
    allowEmptyCitationContractUpgrade &&
    left.citationContractVersion === 2 &&
    right.citationContractVersion === 1 &&
    left.citationCount === 0 &&
    right.citationCount === 0
  );
}

export interface ApprovalApplicabilityContext {
  /** The revision every approval is judged against. */
  revisionId: string;
  /**
   * Ancestors of `revisionId`. The caller resolves lineage, which fails closed
   * on a broken or cross-spec parent rather than answering "no ancestors".
   */
  ancestorRevisionIds: ReadonlySet<string>;
  revisionRows: readonly RevisionElement[];
  citationContractVersion: 1 | 2;
  citations: readonly RevisionCitation[];
  /** The direct lineage parent's citation contract; null without a parent. */
  parentCitationContractVersion: 1 | 2 | null;
}

export type ApprovalApplicability = (approval: ApprovalRecord) => boolean;

/**
 * The one authority on whether an approval satisfies a subject of this
 * revision, used by pending status, approval-request validation, and sign-off
 * preconditions alike. A second rule anywhere lets one surface report "nothing
 * pending" while another refuses the same transition.
 *
 * An approval applies only when all of these hold: it is still valid; its
 * revision is this revision or an ancestor of it, so it belongs to this line
 * of content rather than an abandoned branch; and the subject's keyed
 * fingerprint is identical to the one the human approved. The fingerprint is
 * compared against the approval's own record, never re-read from the
 * approval's revision: a draft is edited in place, so its rows no longer say
 * what the human read.
 */
export function createApprovalApplicability(
  context: ApprovalApplicabilityContext,
): ApprovalApplicability {
  const fingerprints = new Map<string, SubjectFingerprint | null>();
  const currentFingerprint = (
    subject: ApprovalSubject,
  ): SubjectFingerprint | null => {
    const key = `${subject.subjectKind}\u0000${subject.elementId ?? ""}`;
    if (!fingerprints.has(key)) {
      fingerprints.set(
        key,
        subjectFingerprint(context.revisionRows, subject, context),
      );
    }
    return fingerprints.get(key) ?? null;
  };

  return (approval) => {
    if (approval.validity !== "valid") return false;
    if (
      approval.revisionId !== context.revisionId &&
      !context.ancestorRevisionIds.has(approval.revisionId)
    ) {
      return false;
    }
    const current = currentFingerprint(approval);
    const allowEmptyCitationContractUpgrade =
      current?.citationContractVersion === 2 &&
      approval.fingerprint.citationContractVersion === 1 &&
      context.parentCitationContractVersion === 1;
    return sameSubjectFingerprint(
      current,
      approval.fingerprint,
      allowEmptyCitationContractUpgrade,
    );
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** The record an applicability check reads; null for a revision sign-off. */
export function approvalRecordFromRow(
  row: SpecApprovalRow,
): ApprovalRecord | null {
  if (
    row.subject_kind === "revision" ||
    row.subject_fingerprint_json === null
  ) {
    return null;
  }
  return {
    subjectKind: row.subject_kind,
    elementId: row.element_id,
    revisionId: row.revision_id,
    validity: row.validity,
    fingerprint: subjectFingerprintSchema.parse(
      JSON.parse(row.subject_fingerprint_json),
    ),
  };
}

export function serializeSubjectFingerprint(
  fingerprint: SubjectFingerprint,
): string {
  return canonicalJson(fingerprint);
}

export function approvalAppliesToRevision(
  context: ApprovalApplicabilityContext,
  approval: ApprovalRecord,
): boolean {
  return createApprovalApplicability(context)(approval);
}

function pairOf(row: RevisionElement): SubjectFingerprintPair {
  return { elementId: row.elementId, payloadHash: row.payloadHash };
}

function byElementId(
  left: SubjectFingerprintPair,
  right: SubjectFingerprintPair,
): number {
  return left.elementId.localeCompare(right.elementId);
}
