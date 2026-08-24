import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  isTerminalStatus,
  type GraphWorkflowStatus,
  type SeededWorkflowDocument,
} from "@/lib/workflow-graph/spec-bridge";
import type {
  ActorProvenance,
  Spec,
  SpecApprovalRow,
  SpecAssumptionCitationsMutatedEventPayload,
  SpecAssumptionRow,
  SpecExecutionRow,
  SpecEventRow,
  SpecGateAdmissionRow,
  SpecQuestionRow,
  SpecReviewRecordMutatedEventPayload,
  SpecRevision,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import {
  actorProvenanceSchema,
  specApprovalRowSchema,
  specAssumptionCitationsMutatedEventPayloadSchema,
  specAssumptionCitationSchema,
  specAssumptionRowSchema,
  specAuthoringStageSchema,
  specElementKindSchema,
  specElementPayloadSchema,
  specEventRowSchema,
  specGateAdmissionRowSchema,
  specQuestionRowSchema,
  specRevisionStateSchema,
  specReviewRecordMutatedEventPayloadSchema,
  specSchema,
} from "@/lib/specs/schemas";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionCitationHash,
  computeSpecRevisionContentHash,
  type SpecsRepo,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import type { LinkedWorkflowObservation } from "./abandon-coordinator";
import { pinnedSpecDocumentPath } from "./delivery-plan";
import {
  describeReferenceIssue,
  validateAffectedReferences,
} from "./element-references";
import type {
  SpecWorkflowCleanupObservation,
  SpecWorkflowCleanupTarget,
} from "./execution-service";
import {
  DISMISS_SUPERSEDED_SURFACE,
  HUMAN_REVIEW_SURFACE,
  liveProposals,
  supersedingRevision,
} from "./proposal-integrity";
import { validateCanonicalAuditHistory } from "./canonical-audit-history";
import { toLintSnapshot } from "./review-state";
import type { IntegrityReport, SpecConsistencyFinding } from "./view-schemas";

export interface SpecExportRevision {
  readonly snapshot: SpecRevisionSnapshot;
}

/**
 * A delivery execution paired with where its linked run actually stands. The
 * observation is the abandon coordinator's own vocabulary and comes from the
 * same `observe` seam, so verification and cleanup can never disagree about
 * whether a run is still live or still owns the session's slot.
 */
export interface SpecExportExecution {
  readonly execution: SpecExecutionRow;
  readonly linkedWorkflow: LinkedWorkflowObservation;
}

export interface SpecExportState {
  readonly spec: Spec;
  readonly revisions: SpecExportRevision[];
  readonly approvals: SpecApprovalRow[];
  readonly gateAdmissions: SpecGateAdmissionRow[];
  readonly questions: SpecQuestionRow[];
  readonly assumptions: SpecAssumptionRow[];
  readonly executions: SpecExportExecution[];
  readonly attentionAuditEvents: SpecEventRow[];
}

export interface SpecExportDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
  delivery: SpecDeliveryRepo;
  events: Pick<SpecEventsRepo, "findBySpecId">;
  /**
   * The `observe` half of the production spec→workflow cleanup port. Verify
   * only ever reads through it: reporting an orphan must never move one.
   */
  observeLinkedWorkflow(
    target: SpecWorkflowCleanupTarget,
  ): Promise<SpecWorkflowCleanupObservation>;
}

export interface CanonicalMarkdownFile {
  readonly path: string;
  readonly content: string;
}

export interface CanonicalSpecBundle {
  readonly markdownFiles: CanonicalMarkdownFile[];
  readonly manifest: string;
}

export const CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION = 4;

/**
 * The ordering contract the repository enforces, stated in the export so a
 * reader of a bundle does not have to infer it from the rows (R24.12).
 * `position` is one global order per revision — not a per-parent order — and
 * nesting is read from the parent element alone.
 */
const ELEMENT_ORDERING_CONTRACT = {
  scope: "revision",
  sortKeys: ["position", "elementId"],
  elementIdCollation: "utf8-byte",
  nesting: "parentElementId",
  renderedTraversal: "parent-then-children",
  omittedPositionOnCreate: "append",
} as const;

export type CanonicalSpecBundleFailure =
  | {
      readonly ok: false;
      readonly code: "bundle_format_mismatch";
      readonly message: string;
      readonly instruction: string;
      readonly issue: { readonly path: string; readonly message: string };
      readonly currentFormatVersion: number;
      readonly againstFormatVersion: number | null;
    }
  | {
      readonly ok: false;
      readonly code: "integrity_mismatch";
      readonly message: string;
      readonly instruction: string;
      readonly issue: { readonly path: string; readonly message: string };
    };

export type CanonicalSpecBundleComparison =
  | { readonly ok: true }
  | CanonicalSpecBundleFailure;

export type CanonicalSpecBundleDecodeResult =
  | { readonly ok: true; readonly value: CanonicalSpecBundle }
  | CanonicalSpecBundleFailure;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().min(1);
const nullableTimestampSchema = timestampSchema.nullable();
const gateAdmissionActorSchema = z.union([
  actorProvenanceSchema,
  z.object({ kind: z.literal("system") }).strict(),
]);

const canonicalMarkdownFileSchema = z
  .object({ path: z.string().min(1), content: z.string() })
  .strict();

const canonicalSpecBundleInputSchema = z
  .object({
    markdownFiles: z.array(canonicalMarkdownFileSchema),
    manifest: z.string(),
  })
  .strict();

const canonicalManifestElementSchema = z
  .object({
    id: z.string().min(1),
    handle: z.string().min(1),
    kind: specElementKindSchema,
    number: z.number().int().positive().nullable(),
    parentElementId: z.string().min(1).nullable(),
    position: z.number().int().nonnegative(),
    payload: specElementPayloadSchema,
    payloadHash: sha256Schema,
    elementVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((element, context) => {
    if (element.kind !== element.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "payload kind must match the element kind",
      });
    }
    if (element.kind === "section") {
      if (element.number !== null) {
        context.addIssue({
          code: "custom",
          path: ["number"],
          message: "section elements are not numbered",
        });
      }
      if (element.parentElementId !== null) {
        context.addIssue({
          code: "custom",
          path: ["parentElementId"],
          message: "section elements do not have parents",
        });
      }
      return;
    }
    if (element.number === null) {
      context.addIssue({
        code: "custom",
        path: ["number"],
        message: "addressable elements are numbered",
      });
    }
    if (element.kind === "criterion") {
      if (element.parentElementId === null) {
        context.addIssue({
          code: "custom",
          path: ["parentElementId"],
          message: "criteria belong to a requirement",
        });
      }
      return;
    }
    if (element.parentElementId !== null) {
      context.addIssue({
        code: "custom",
        path: ["parentElementId"],
        message: "only criteria have parent elements",
      });
    }
  });

const canonicalManifestRevisionSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    state: specRevisionStateSchema,
    authoringStage: specAuthoringStageSchema,
    basedOnRevisionId: z.string().min(1).nullable(),
    contentHash: sha256Schema.nullable(),
    citationContractVersion: z.union([z.literal(1), z.literal(2)]),
    citationVersion: z.number().int().positive(),
    citationHash: sha256Schema,
    proposedAt: nullableTimestampSchema,
    approvedAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    elements: z.array(canonicalManifestElementSchema),
    assumptionCitations: z.array(specAssumptionCitationSchema),
  })
  .strict()
  .superRefine((revision, context) => {
    const frozen = revision.state !== "draft";
    if ((revision.contentHash !== null) !== frozen) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message:
          "contentHash is null exactly while the revision remains a draft",
      });
    }
    if ((revision.proposedAt !== null) !== frozen) {
      context.addIssue({
        code: "custom",
        path: ["proposedAt"],
        message:
          "proposedAt is present exactly after the revision leaves draft",
      });
    }
    if ((revision.approvedAt !== null) !== (revision.state === "approved")) {
      context.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: "approvedAt is present exactly for an approved revision",
      });
    }
    if (revision.state === "draft" && revision.citationContractVersion !== 2) {
      context.addIssue({
        code: "custom",
        path: ["citationContractVersion"],
        message: "draft revisions use the citation-aware contract",
      });
    }
  });

const canonicalSpecManifestSchema = z
  .object({
    formatVersion: z.literal(CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION),
    elementOrdering: z
      .object({
        scope: z.literal(ELEMENT_ORDERING_CONTRACT.scope),
        sortKeys: z.tuple([
          z.literal(ELEMENT_ORDERING_CONTRACT.sortKeys[0]),
          z.literal(ELEMENT_ORDERING_CONTRACT.sortKeys[1]),
        ]),
        elementIdCollation: z.literal(
          ELEMENT_ORDERING_CONTRACT.elementIdCollation,
        ),
        nesting: z.literal(ELEMENT_ORDERING_CONTRACT.nesting),
        renderedTraversal: z.literal(
          ELEMENT_ORDERING_CONTRACT.renderedTraversal,
        ),
        omittedPositionOnCreate: z.literal(
          ELEMENT_ORDERING_CONTRACT.omittedPositionOnCreate,
        ),
      })
      .strict(),
    spec: specSchema,
    revisions: z.array(canonicalManifestRevisionSchema).min(1),
    approvals: z.array(specApprovalRowSchema.strict()),
    gateAdmissions: z.array(specGateAdmissionRowSchema.strict()),
    questions: z.array(specQuestionRowSchema.strict()),
    assumptions: z.array(specAssumptionRowSchema.strict()),
    attentionAuditEvents: z.array(specEventRowSchema.strict()),
  })
  .strict();

type CanonicalSpecManifest = z.infer<typeof canonicalSpecManifestSchema>;

const CANONICAL_BUNDLE_INTEGRITY_INSTRUCTION =
  "Export a fresh canonical bundle, then verify against that file.";

function bundleFormatMismatch(
  againstFormatVersion: number | null,
): CanonicalSpecBundleFailure {
  if (againstFormatVersion === null) {
    return {
      ok: false,
      code: "bundle_format_mismatch",
      currentFormatVersion: CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION,
      againstFormatVersion,
      message: `canonical bundle format is missing or invalid; current format is ${CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION}`,
      instruction: CANONICAL_BUNDLE_INTEGRITY_INSTRUCTION,
      issue: {
        path: "bundle.manifest.formatVersion",
        message: `expected current format ${CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION}, found missing or invalid format`,
      },
    };
  }
  return {
    ok: false,
    code: "bundle_format_mismatch",
    currentFormatVersion: CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION,
    againstFormatVersion,
    message: `canonical bundle format ${againstFormatVersion} differs from current format ${CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION}`,
    instruction: CANONICAL_BUNDLE_INTEGRITY_INSTRUCTION,
    issue: {
      path: "bundle.manifest.formatVersion",
      message: `expected current format ${CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION}, found ${againstFormatVersion}`,
    },
  };
}

function bundleIntegrityMismatch(
  path: string,
  message: string,
): CanonicalSpecBundleFailure {
  return {
    ok: false,
    code: "integrity_mismatch",
    message: "canonical bundle failed strict format-4 verification",
    instruction: CANONICAL_BUNDLE_INTEGRITY_INSTRUCTION,
    issue: { path, message },
  };
}

function issuePath(prefix: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (current, segment) =>
      typeof segment === "number"
        ? `${current}[${segment}]`
        : `${current}.${String(segment)}`,
    prefix,
  );
}

function firstSchemaFailure(
  prefix: string,
  issues: readonly {
    readonly path: PropertyKey[];
    readonly message: string;
    readonly code?: string;
    readonly keys?: string[];
  }[],
): CanonicalSpecBundleFailure {
  const issue = issues[0];
  const unknownKey =
    issue?.code === "unrecognized_keys" ? issue.keys?.[0] : undefined;
  return bundleIntegrityMismatch(
    issue === undefined
      ? prefix
      : issuePath(
          prefix,
          unknownKey === undefined ? issue.path : [...issue.path, unknownKey],
        ),
    issue?.message ?? "is malformed",
  );
}

function stateFromCanonicalManifest(
  manifest: CanonicalSpecManifest,
): SpecExportState {
  return {
    spec: manifest.spec,
    revisions: manifest.revisions.map((revision) => ({
      snapshot: {
        revision: {
          id: revision.id,
          specId: manifest.spec.id,
          number: revision.number,
          state: revision.state,
          authoringStage: revision.authoringStage,
          basedOnRevisionId: revision.basedOnRevisionId,
          contentHash: revision.contentHash,
          citationContractVersion: revision.citationContractVersion,
          citationVersion: revision.citationVersion,
          citationHash: revision.citationHash,
          proposedAt: revision.proposedAt,
          approvedAt: revision.approvedAt,
          externalDelivery: null,
          createdAt: revision.createdAt,
        },
        elements: revision.elements.map((element) => ({
          element: {
            id: element.id,
            specId: manifest.spec.id,
            kind: element.kind,
            number: element.number,
            parentElementId: element.parentElementId,
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: revision.id,
            elementId: element.id,
            position: element.position,
            payload: element.payload,
            payloadHash: element.payloadHash,
            elementVersion: element.elementVersion,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        })),
        assumptionCitations: revision.assumptionCitations,
      },
    })),
    approvals: manifest.approvals,
    gateAdmissions: manifest.gateAdmissions,
    questions: manifest.questions,
    assumptions: manifest.assumptions,
    executions: [],
    attentionAuditEvents: manifest.attentionAuditEvents,
  };
}

function assertCanonicalManifestIntegrity(
  manifest: CanonicalSpecManifest,
  state: SpecExportState,
): void {
  const revisionIds = new Set<string>();
  const revisionNumbers = new Set<number>();
  const elementIdsByRevision = new Map<string, ReadonlySet<string>>();
  const elementKindsByRevision = new Map<string, ReadonlyMap<string, string>>();
  const elementIdentityById = new Map<
    string,
    {
      readonly kind: string;
      readonly number: number | null;
      readonly parentElementId: string | null;
    }
  >();
  let priorRevisionNumber = 0;

  for (const [revisionIndex, revision] of manifest.revisions.entries()) {
    const path = `revisions[${revisionIndex}]`;
    assertUnique(revisionIds, revision.id, `${path}.id`, "revision id");
    assertUnique(
      revisionNumbers,
      revision.number,
      `${path}.number`,
      "revision number",
    );
    if (revision.number <= priorRevisionNumber) {
      throw new SpecExportIntegrityError(
        `${path}.number`,
        "revisions must be ordered by increasing revision number",
      );
    }
    priorRevisionNumber = revision.number;

    const snapshot = state.revisions[revisionIndex]!.snapshot;
    const elementIds = new Set<string>();
    const elementKinds = new Map<string, string>();
    let priorElement: { position: number; id: string } | null = null;
    for (const [elementIndex, element] of revision.elements.entries()) {
      const elementPath = `${path}.elements[${elementIndex}]`;
      assertUnique(elementIds, element.id, `${elementPath}.id`, "element id");
      elementKinds.set(element.id, element.kind);
      const priorIdentity = elementIdentityById.get(element.id);
      if (priorIdentity === undefined) {
        elementIdentityById.set(element.id, {
          kind: element.kind,
          number: element.number,
          parentElementId: element.parentElementId,
        });
      } else {
        for (const field of ["kind", "number", "parentElementId"] as const) {
          if (element[field] !== priorIdentity[field]) {
            throw new SpecExportIntegrityError(
              `${elementPath}.${field}`,
              "stable element identity differs across revisions",
            );
          }
        }
      }
      if (
        priorElement !== null &&
        (element.position < priorElement.position ||
          (element.position === priorElement.position &&
            compareUtf8Bytes(element.id, priorElement.id) <= 0))
      ) {
        throw new SpecExportIntegrityError(
          `${elementPath}.position`,
          "elements must be ordered by position then element id",
        );
      }
      priorElement = { position: element.position, id: element.id };
      if (
        element.parentElementId !== null &&
        !revision.elements.some(
          (candidate) => candidate.id === element.parentElementId,
        )
      ) {
        throw new SpecExportIntegrityError(
          `${elementPath}.parentElementId`,
          "parent element is missing from the revision",
        );
      }
      if (
        element.kind === "criterion" &&
        element.parentElementId !== null &&
        revision.elements.find(
          (candidate) => candidate.id === element.parentElementId,
        )?.kind !== "requirement"
      ) {
        throw new SpecExportIntegrityError(
          `${elementPath}.parentElementId`,
          "criterion parent must be a requirement in the same revision",
        );
      }
      if (
        computeSpecElementPayloadHash(element.payload) !== element.payloadHash
      ) {
        throw new SpecExportIntegrityError(
          `${elementPath}.payloadHash`,
          "does not match the element payload",
        );
      }
    }
    elementIdsByRevision.set(revision.id, elementIds);
    elementKindsByRevision.set(revision.id, elementKinds);
    const referenceIssue = validateAffectedReferences(
      revision.elements.map((element) => ({
        id: element.id,
        payload: element.payload,
      })),
      elementIds,
      elementIds,
    )[0];
    if (referenceIssue !== undefined) {
      const sourceIndex = revision.elements.findIndex(
        (element) => element.id === referenceIssue.sourceElementId,
      );
      throw new SpecExportIntegrityError(
        `${path}.elements[${sourceIndex}].payload.${referenceIssue.field}[${referenceIssue.index}]`,
        describeReferenceIssue(referenceIssue),
      );
    }

    const handles = new Map(
      toLintSnapshot(state.spec, snapshot).elements.map((element) => [
        element.id,
        element.handle,
      ]),
    );
    const revisionHandles = new Set<string>();
    for (const [elementIndex, element] of revision.elements.entries()) {
      const expectedHandle = handles.get(element.id) ?? element.id;
      if (element.handle !== expectedHandle) {
        throw new SpecExportIntegrityError(
          `${path}.elements[${elementIndex}].handle`,
          "does not match the canonical element handle",
        );
      }
      assertUnique(
        revisionHandles,
        element.handle,
        `${path}.elements[${elementIndex}].handle`,
        "element handle",
      );
    }

    const actualContentHash = computeSpecRevisionContentHash(
      revision.authoringStage,
      snapshot.elements,
    );
    if (
      revision.contentHash !== null &&
      revision.contentHash !== actualContentHash
    ) {
      throw new SpecExportIntegrityError(
        `${path}.contentHash`,
        "does not match the revision content",
      );
    }

    let priorCitationKey: string | null = null;
    for (const [
      citationIndex,
      citation,
    ] of revision.assumptionCitations.entries()) {
      const citationPath = `${path}.assumptionCitations[${citationIndex}]`;
      if (
        citation.specId !== manifest.spec.id ||
        citation.revisionId !== revision.id
      ) {
        throw new SpecExportIntegrityError(
          citation.specId !== manifest.spec.id
            ? `${citationPath}.specId`
            : `${citationPath}.revisionId`,
          "citation belongs to another spec revision",
        );
      }
      if (!elementIds.has(citation.elementId)) {
        throw new SpecExportIntegrityError(
          `${citationPath}.elementId`,
          "citation element is missing from the revision",
        );
      }
      const citationKey = `${citation.elementId}\u0000${citation.assumptionId}`;
      if (
        priorCitationKey !== null &&
        compareCodeUnits(citationKey, priorCitationKey) <= 0
      ) {
        throw new SpecExportIntegrityError(
          citationPath,
          "citations must be unique and ordered by element id then assumption id",
        );
      }
      priorCitationKey = citationKey;
    }
    const actualCitationHash = computeSpecRevisionCitationHash(
      revision.citationContractVersion,
      revision.assumptionCitations,
    );
    if (revision.citationHash !== actualCitationHash) {
      throw new SpecExportIntegrityError(
        `${path}.citationHash`,
        "does not match the revision citations",
      );
    }
    if (
      revision.citationContractVersion === 1 &&
      revision.citationVersion !== 1
    ) {
      throw new SpecExportIntegrityError(
        `${path}.citationVersion`,
        "legacy citation-contract revisions remain at citation version 1",
      );
    }
    if (revision.citationContractVersion === 1) {
      for (const [
        citationIndex,
        citation,
      ] of revision.assumptionCitations.entries()) {
        if (citation.snapshot.captureKind !== "legacy_backfill") {
          throw new SpecExportIntegrityError(
            `${path}.assumptionCitations[${citationIndex}].snapshot.captureKind`,
            "legacy citation-contract revisions contain only migration backfills",
          );
        }
      }
    }
  }

  const revisionsById = new Map(
    manifest.revisions.map((revision) => [revision.id, revision]),
  );
  for (const [index, revision] of manifest.revisions.entries()) {
    if (
      (index === 0 && revision.basedOnRevisionId !== null) ||
      (index > 0 && revision.basedOnRevisionId === null)
    ) {
      throw new SpecExportIntegrityError(
        `revisions[${index}].basedOnRevisionId`,
        index === 0
          ? "the first revision is the only root revision"
          : "later revisions must name an earlier base revision",
      );
    }
    if (revision.basedOnRevisionId === null) continue;
    const baseRevision = revisionsById.get(revision.basedOnRevisionId);
    if (baseRevision === undefined) {
      throw new SpecExportIntegrityError(
        `revisions[${index}].basedOnRevisionId`,
        "base revision is missing from the bundle",
      );
    }
    if (baseRevision.number >= revision.number) {
      throw new SpecExportIntegrityError(
        `revisions[${index}].basedOnRevisionId`,
        "base revision must precede the derived revision",
      );
    }
  }

  const approvalIds = new Set<string>();
  const approvalsById = new Map<string, SpecApprovalRow>();
  let priorApprovalId: string | null = null;
  for (const [index, approval] of manifest.approvals.entries()) {
    assertUnique(
      approvalIds,
      approval.id,
      `approvals[${index}].id`,
      "approval id",
    );
    if (
      priorApprovalId !== null &&
      compareCodeUnits(approval.id, priorApprovalId) <= 0
    ) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].id`,
        "approvals must be ordered by id",
      );
    }
    priorApprovalId = approval.id;
    approvalsById.set(approval.id, approval);
    if (approval.spec_id !== manifest.spec.id) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].spec_id`,
        "approval belongs to another spec",
      );
    }
    if (!revisionIds.has(approval.revision_id)) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].revision_id`,
        "approval revision is missing from the bundle",
      );
    }
    const approvalRevision = revisionsById.get(approval.revision_id);
    if (approvalRevision?.state === "draft") {
      throw new SpecExportIntegrityError(
        `approvals[${index}].revision_id`,
        "approvals cannot belong to an editable draft",
      );
    }
    const approvalRevisionElements = elementIdsByRevision.get(
      approval.revision_id,
    );
    if (
      approval.element_id !== null &&
      !approvalRevisionElements?.has(approval.element_id)
    ) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].element_id`,
        "approval element is missing from the bundle",
      );
    }
    const elementKind =
      approval.element_id === null
        ? null
        : elementKindsByRevision
            .get(approval.revision_id)
            ?.get(approval.element_id);
    if (
      (approval.subject_kind === "revision" ||
        approval.subject_kind === "plan") &&
      approval.element_id !== null
    ) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].element_id`,
        `${approval.subject_kind} approvals do not name an element`,
      );
    }
    if (
      (approval.subject_kind === "requirement" ||
        approval.subject_kind === "decision") &&
      (approval.element_id === null || elementKind !== approval.subject_kind)
    ) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].element_id`,
        `${approval.subject_kind} approvals name a ${approval.subject_kind} element in their revision`,
      );
    }
    if (
      approval.subject_kind === "plan" &&
      approvalRevision?.authoringStage !== "plan"
    ) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].subject_kind`,
        "plan approvals belong to plan-stage revisions",
      );
    }
    if (
      approval.subject_kind === "revision" &&
      approvalRevision?.state !== "approved"
    ) {
      throw new SpecExportIntegrityError(
        `approvals[${index}].revision_id`,
        "revision approvals belong to approved revisions",
      );
    }
  }

  const gateAdmissionIds = new Set<string>();
  let priorGateAdmissionId: string | null = null;
  for (const [index, admission] of manifest.gateAdmissions.entries()) {
    assertUnique(
      gateAdmissionIds,
      admission.id,
      `gateAdmissions[${index}].id`,
      "gate admission id",
    );
    if (
      priorGateAdmissionId !== null &&
      compareCodeUnits(admission.id, priorGateAdmissionId) <= 0
    ) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].id`,
        "gate admissions must be ordered by id",
      );
    }
    priorGateAdmissionId = admission.id;
    if (admission.spec_id !== manifest.spec.id) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].spec_id`,
        "gate admission belongs to another spec",
      );
    }
    if (
      admission.revision_id !== null &&
      !revisionIds.has(admission.revision_id)
    ) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].revision_id`,
        "gate admission revision is missing from the bundle",
      );
    }
    if (
      admission.approval_id !== null &&
      !approvalIds.has(admission.approval_id)
    ) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].approval_id`,
        "gate admission approval is missing from the bundle",
      );
    }
    if (
      (admission.basis === "human_approval") !==
      (admission.approval_id !== null)
    ) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].approval_id`,
        admission.basis === "human_approval"
          ? "human approval admissions require an approval"
          : `${admission.basis} admissions are not backed by an approval`,
      );
    }
    const admissionApproval =
      admission.approval_id === null
        ? undefined
        : approvalsById.get(admission.approval_id);
    if (
      admission.basis === "human_approval" &&
      (admissionApproval?.subject_kind !== "revision" ||
        admissionApproval.element_id !== null ||
        admissionApproval.validity !== "valid")
    ) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].approval_id`,
        "human approval admissions require a valid revision approval",
      );
    }
    if (
      admissionApproval !== undefined &&
      admission.revision_id !== admissionApproval.revision_id
    ) {
      throw new SpecExportIntegrityError(
        `gateAdmissions[${index}].revision_id`,
        "gate admission revision differs from its approval revision",
      );
    }
    parseGateAdmissionActor(
      admission.actor_json,
      `gateAdmissions[${index}].actor_json`,
    );
  }

  // Attention attachments name durable spec element identities, not revision
  // membership. Format 4 carries revision snapshots rather than the complete
  // element registry, so an identity removed from every snapshot remains a
  // valid display attachment and cannot be membership-checked here.
  let priorQuestionNumber = 0;
  for (const [index, question] of manifest.questions.entries()) {
    if (question.number <= priorQuestionNumber) {
      throw new SpecExportIntegrityError(
        `questions[${index}].number`,
        "questions must be ordered by number",
      );
    }
    priorQuestionNumber = question.number;
  }
  const assumptionsById = new Map(
    manifest.assumptions.map((assumption) => [assumption.id, assumption]),
  );
  let priorAssumptionNumber = 0;
  for (const [index, assumption] of manifest.assumptions.entries()) {
    if (assumption.number <= priorAssumptionNumber) {
      throw new SpecExportIntegrityError(
        `assumptions[${index}].number`,
        "assumptions must be ordered by number",
      );
    }
    priorAssumptionNumber = assumption.number;
  }
  for (const [revisionIndex, revision] of manifest.revisions.entries()) {
    for (const [
      citationIndex,
      citation,
    ] of revision.assumptionCitations.entries()) {
      const assumption = assumptionsById.get(citation.assumptionId);
      if (assumption === undefined) {
        throw new SpecExportIntegrityError(
          `revisions[${revisionIndex}].assumptionCitations[${citationIndex}].assumptionId`,
          "citation assumption is missing from the bundle",
        );
      }
      assertCitationSnapshotIdentity(
        citation.snapshot,
        assumption,
        `revisions[${revisionIndex}].assumptionCitations[${citationIndex}].snapshot`,
      );
      if (
        revision.citationContractVersion === 1 &&
        revision.proposedAt !== null &&
        assumption.created_at > revision.proposedAt
      ) {
        throw new SpecExportIntegrityError(
          `revisions[${revisionIndex}].assumptionCitations[${citationIndex}].snapshot.createdAt`,
          "legacy citation backfills cannot postdate revision proposal",
        );
      }
    }
  }

  let priorEventId = 0;
  for (const [index, event] of manifest.attentionAuditEvents.entries()) {
    if (event.id <= priorEventId) {
      throw new SpecExportIntegrityError(
        `attentionAuditEvents[${index}].id`,
        "attention audit events must be ordered by id",
      );
    }
    priorEventId = event.id;
  }

  assertAttentionExportIntegrity(state);
  assertCanonicalManifestJsonColumns(manifest);
}

/**
 * Decode a canonical bundle as an inert verification artifact. This validates
 * and re-renders format 4 without creating or replacing any durable spec.
 */
export function decodeCanonicalSpecBundle(
  input: unknown,
): CanonicalSpecBundleDecodeResult {
  if (
    typeof input === "object" &&
    input !== null &&
    "manifest" in input &&
    typeof input.manifest === "string"
  ) {
    try {
      const candidateManifest: unknown = JSON.parse(input.manifest);
      const candidateFormatVersion =
        typeof candidateManifest === "object" &&
        candidateManifest !== null &&
        "formatVersion" in candidateManifest
          ? candidateManifest.formatVersion
          : null;
      if (
        typeof candidateFormatVersion !== "number" ||
        !Number.isSafeInteger(candidateFormatVersion) ||
        candidateFormatVersion <= 0
      ) {
        return bundleFormatMismatch(null);
      }
      if (
        candidateFormatVersion !== CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION
      ) {
        return bundleFormatMismatch(candidateFormatVersion);
      }
    } catch {
      // The strict current-format path below reports malformed JSON after it
      // verifies the bundle wrapper, keeping both issue locations precise.
    }
  }

  const bundleResult = canonicalSpecBundleInputSchema.safeParse(input);
  if (!bundleResult.success) {
    return firstSchemaFailure("bundle", bundleResult.error.issues);
  }
  const bundle = bundleResult.data;

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(bundle.manifest);
  } catch {
    return bundleIntegrityMismatch("bundle.manifest", "is not valid JSON");
  }

  const formatVersion =
    typeof manifestValue === "object" &&
    manifestValue !== null &&
    "formatVersion" in manifestValue
      ? manifestValue.formatVersion
      : null;
  if (
    typeof formatVersion !== "number" ||
    !Number.isSafeInteger(formatVersion) ||
    formatVersion <= 0
  ) {
    return bundleFormatMismatch(null);
  }
  if (formatVersion !== CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION) {
    return bundleFormatMismatch(formatVersion);
  }

  const manifestResult = canonicalSpecManifestSchema.safeParse(manifestValue);
  if (!manifestResult.success) {
    return firstSchemaFailure("bundle.manifest", manifestResult.error.issues);
  }
  const manifest = manifestResult.data;
  const state = stateFromCanonicalManifest(manifest);
  try {
    assertCanonicalManifestIntegrity(manifest, state);
  } catch (error) {
    if (error instanceof SpecExportIntegrityError) {
      return bundleIntegrityMismatch(
        `bundle.manifest.${error.path}`,
        error.message.replace(
          /^spec export integrity violation at [^:]+:\s*/,
          "",
        ),
      );
    }
    return bundleIntegrityMismatch(
      "bundle.manifest",
      "could not be verified as canonical format 4",
    );
  }

  const canonicalManifest = `${stableStringify(manifestFor(state))}\n`;
  if (bundle.manifest !== canonicalManifest) {
    return bundleIntegrityMismatch(
      "bundle.manifest",
      "does not match canonical format-4 rendering",
    );
  }

  const expectedMarkdownFiles = state.revisions.map(({ snapshot }) => ({
    path: revisionFileName(snapshot),
    content: renderRevisionMarkdown(state.spec, snapshot),
  }));
  if (bundle.markdownFiles.length < expectedMarkdownFiles.length) {
    return bundleIntegrityMismatch(
      `bundle.markdownFiles[${bundle.markdownFiles.length}]`,
      "is missing the canonical file for a manifest revision",
    );
  }
  if (bundle.markdownFiles.length > expectedMarkdownFiles.length) {
    return bundleIntegrityMismatch(
      `bundle.markdownFiles[${expectedMarkdownFiles.length}]`,
      "is not named by any manifest revision",
    );
  }
  for (const [index, expected] of expectedMarkdownFiles.entries()) {
    const actual = bundle.markdownFiles[index]!;
    if (actual.path !== expected.path) {
      return bundleIntegrityMismatch(
        `bundle.markdownFiles[${index}].path`,
        "does not match the canonical revision path",
      );
    }
    if (actual.content !== expected.content) {
      return bundleIntegrityMismatch(
        `bundle.markdownFiles[${index}].content`,
        "does not match canonical revision rendering",
      );
    }
  }

  return { ok: true, value: bundle };
}

function firstCanonicalValueDifference(
  current: unknown,
  against: unknown,
  path: string,
): string | null {
  if (Object.is(current, against)) return null;
  if (Array.isArray(current) && Array.isArray(against)) {
    const sharedLength = Math.min(current.length, against.length);
    for (let index = 0; index < sharedLength; index++) {
      const difference = firstCanonicalValueDifference(
        current[index],
        against[index],
        `${path}[${index}]`,
      );
      if (difference !== null) return difference;
    }
    return current.length === against.length
      ? null
      : `${path}[${sharedLength}]`;
  }
  if (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current) &&
    typeof against === "object" &&
    against !== null &&
    !Array.isArray(against)
  ) {
    const currentRecord = current as Record<string, unknown>;
    const againstRecord = against as Record<string, unknown>;
    const keys = [
      ...new Set([
        ...Object.keys(currentRecord),
        ...Object.keys(againstRecord),
      ]),
    ].sort();
    for (const key of keys) {
      if (!(key in currentRecord) || !(key in againstRecord)) {
        return `${path}.${key}`;
      }
      const difference = firstCanonicalValueDifference(
        currentRecord[key],
        againstRecord[key],
        `${path}.${key}`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  return path;
}

function firstCanonicalBundleDifference(
  current: CanonicalSpecBundle,
  against: CanonicalSpecBundle,
): string {
  const manifestDifference = firstCanonicalValueDifference(
    JSON.parse(current.manifest) as unknown,
    JSON.parse(against.manifest) as unknown,
    "bundle.manifest",
  );
  if (manifestDifference !== null) return manifestDifference;

  const sharedLength = Math.min(
    current.markdownFiles.length,
    against.markdownFiles.length,
  );
  for (let index = 0; index < sharedLength; index++) {
    const currentFile = current.markdownFiles[index]!;
    const againstFile = against.markdownFiles[index]!;
    if (currentFile.path !== againstFile.path) {
      return `bundle.markdownFiles[${index}].path`;
    }
    if (currentFile.content !== againstFile.content) {
      return `bundle.markdownFiles[${index}].content`;
    }
  }
  return current.markdownFiles.length === against.markdownFiles.length
    ? "bundle"
    : `bundle.markdownFiles[${sharedLength}]`;
}

export function compareCanonicalSpecBundles(
  current: CanonicalSpecBundle,
  against: CanonicalSpecBundle,
): CanonicalSpecBundleComparison {
  const decodedCurrent = decodeCanonicalSpecBundle(current);
  if (!decodedCurrent.ok) return decodedCurrent;
  const decodedAgainst = decodeCanonicalSpecBundle(against);
  if (!decodedAgainst.ok) return decodedAgainst;
  if (isDeepStrictEqual(decodedCurrent.value, decodedAgainst.value)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "integrity_mismatch",
    message: "current canonical export differs",
    instruction:
      "Review the live spec or export a fresh canonical bundle before continuing.",
    issue: {
      path: firstCanonicalBundleDifference(
        decodedCurrent.value,
        decodedAgainst.value,
      ),
      message: "differs from the current canonical export",
    },
  };
}

/**
 * The report type is the schema's, not a parallel hand-written copy: the wire
 * contract and the producer cannot drift apart if there is only one of them.
 */
export type { IntegrityReport };
export type IntegrityMismatch = IntegrityReport["mismatches"][number];

export class SpecExportNotFoundError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} was not found`);
    this.name = "SpecExportNotFoundError";
  }
}

export class SpecExportIntegrityError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`spec export integrity violation at ${path}: ${detail}`);
    this.name = "SpecExportIntegrityError";
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
  const executions = await Promise.all(
    deps.delivery.findExecutionsBySpecId(spec.id).map(async (execution) => ({
      execution,
      linkedWorkflow: await observeLinkedWorkflow(
        deps,
        spec.projectPath,
        execution,
      ),
    })),
  );
  return {
    spec,
    revisions: loadedRevisions,
    approvals: deps.review.findApprovalsBySpecId(spec.id),
    gateAdmissions,
    questions: deps.review.findQuestionsBySpecId(spec.id),
    assumptions: deps.review.findAssumptionsBySpecId(spec.id),
    executions,
    attentionAuditEvents: deps.events
      .findBySpecId(spec.id)
      .filter(
        (event) =>
          event.event_type === "spec-review-record-mutated" ||
          event.event_type === "spec-assumption-citations-mutated",
      ),
  };
}

/**
 * The run an execution is answerable for. `linked_workflow_execution_id` is the
 * coordinator's pinned target and wins where it exists; falling back to
 * `workflow_execution_id` is what reaches the pre-coordinator rows, which were
 * abandoned without ever pinning anything and are exactly the orphans verify
 * has to find.
 */
async function observeLinkedWorkflow(
  deps: SpecExportDeps,
  projectPath: string,
  execution: SpecExecutionRow,
): Promise<LinkedWorkflowObservation> {
  const workflowExecutionId =
    execution.linked_workflow_execution_id ?? execution.workflow_execution_id;
  if (workflowExecutionId === null || execution.session_name === null) {
    return { kind: "never_launched" };
  }
  const observation = await deps.observeLinkedWorkflow({
    projectPath,
    sessionName: execution.session_name,
    workflowExecutionId,
  });
  return observation.kind === "missing"
    ? { kind: "missing", workflowExecutionId }
    : { ...observation, workflowExecutionId };
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
        // Optional payload fields stay absent when undeclared, so two bundles
        // in the same canonical format compare equal; a declared lane is
        // ordinary content that differs like any other field.
        ...(payload.executionLane === undefined
          ? []
          : [`- Execution lane: ${payload.executionLane}`]),
        ...(payload.touchedPaths === undefined
          ? []
          : [`- Touched paths: ${payload.touchedPaths.join(", ") || "None"}`]),
      ].join("\n\n");
  }
}

function renderedRevisionElements(
  elements: readonly SpecRevisionElement[],
): SpecRevisionElement[] {
  const ordered = [...elements].sort((left, right) =>
    left.version.position === right.version.position
      ? compareUtf8Bytes(left.element.id, right.element.id)
      : left.version.position - right.version.position,
  );
  const childrenByParent = new Map<string, SpecRevisionElement[]>();
  const knownElementIds = new Set(ordered.map(({ element }) => element.id));
  for (const row of ordered) {
    const parentElementId = row.element.parentElementId;
    if (parentElementId === null || !knownElementIds.has(parentElementId)) {
      continue;
    }
    const siblings = childrenByParent.get(parentElementId) ?? [];
    siblings.push(row);
    childrenByParent.set(parentElementId, siblings);
  }

  const rendered: SpecRevisionElement[] = [];
  const emitted = new Set<string>();
  const appendSubtree = (row: SpecRevisionElement): void => {
    if (emitted.has(row.element.id)) return;
    emitted.add(row.element.id);
    rendered.push(row);
    for (const child of childrenByParent.get(row.element.id) ?? []) {
      appendSubtree(child);
    }
  };

  for (const row of ordered) {
    if (
      row.element.parentElementId === null ||
      !knownElementIds.has(row.element.parentElementId)
    ) {
      appendSubtree(row);
    }
  }
  for (const row of ordered) appendSubtree(row);
  return rendered;
}

export function renderRevisionMarkdown(
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
    `- Citation contract: ${snapshot.revision.citationContractVersion}`,
    `- Citation version: ${snapshot.revision.citationVersion}`,
    `- Citation hash: ${snapshot.revision.citationHash}`,
    ...renderedRevisionElements(snapshot.elements).map((row) =>
      renderElement(row, handles.get(row.element.id) ?? row.element.id),
    ),
    "",
  ].join("\n\n");
}

function manifestFor(state: SpecExportState): unknown {
  return {
    // Format 4 binds revision-owned citations and complete attention history.
    // Bundle comparison reports this boundary separately from content drift.
    formatVersion: CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION,
    elementOrdering: ELEMENT_ORDERING_CONTRACT,
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
        citationContractVersion: snapshot.revision.citationContractVersion,
        citationVersion: snapshot.revision.citationVersion,
        citationHash: snapshot.revision.citationHash,
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
        assumptionCitations: [...snapshot.assumptionCitations].sort(
          (left, right) =>
            compareCodeUnits(left.elementId, right.elementId) ||
            compareCodeUnits(left.assumptionId, right.assumptionId),
        ),
      };
    }),
    approvals: [...state.approvals].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    ),
    gateAdmissions: [...state.gateAdmissions]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((admission) => ({
        ...admission,
        actor_json: canonicalizeJsonColumn(admission.actor_json),
      })),
    questions: [...state.questions]
      .sort((left, right) => left.number - right.number)
      .map((question) => ({
        ...question,
        provenance_json: canonicalizeJsonColumn(question.provenance_json),
      })),
    assumptions: [...state.assumptions]
      .sort((left, right) => left.number - right.number)
      .map((assumption) => ({
        ...assumption,
        proposed_by_json: canonicalizeJsonColumn(assumption.proposed_by_json),
      })),
    attentionAuditEvents: [...state.attentionAuditEvents]
      .sort((left, right) => left.id - right.id)
      .map((event) => ({
        ...event,
        actor_json: canonicalizeJsonColumn(event.actor_json),
        payload_json: canonicalizeJsonColumn(event.payload_json),
      })),
  };
}

/**
 * Re-exported at the renderer's own surface: the locator is declared beside the
 * governance entry that cites it, in a module the plan-authoring surfaces can
 * import without pulling the export renderer's dependencies with it.
 */
export { pinnedSpecDocumentPath };

/**
 * The pinned spec revision as the document seeded into every lane worktree at
 * launch. Rendered through the same {@link renderRevisionMarkdown} the canonical
 * bundle uses, so a lane reads byte-for-byte what `cctl spec export` writes for
 * that revision — one renderer, no second copy to drift.
 *
 * It renders the SNAPSHOT the caller pins, never live spec state: an amendment
 * proposed mid-run moves the spec's draft, and a validator judging the run must
 * still judge the contract the run was launched against.
 */
export function buildPinnedSpecDocument(
  spec: Spec,
  pinned: SpecRevisionSnapshot,
): SeededWorkflowDocument {
  return {
    relativePath: pinnedSpecDocumentPath(spec.slug),
    contents: renderRevisionMarkdown(spec, pinned),
    description: `The pinned spec ${spec.slug} at revision ${pinned.revision.number} — the contract this run implements.`,
    readWhen:
      "Read before judging whether work satisfies the spec; it is the pinned contract, not live spec state.",
  };
}

export function renderCanonicalBundle(
  state: SpecExportState,
): CanonicalSpecBundle {
  assertAttentionExportIntegrity(state);
  return {
    markdownFiles: state.revisions.map(({ snapshot }) => ({
      path: revisionFileName(snapshot),
      content: renderRevisionMarkdown(state.spec, snapshot),
    })),
    manifest: `${stableStringify(manifestFor(state))}\n`,
  };
}

export function assertCanonicalExportState(state: SpecExportState): void {
  const manifestResult = canonicalSpecManifestSchema.safeParse(
    manifestFor(state),
  );
  if (!manifestResult.success) {
    throw schemaIntegrityError(
      "manifest",
      "canonical manifest",
      manifestResult.error.issues,
    );
  }
  assertCanonicalManifestIntegrity(manifestResult.data, state);
}

export function renderVerifiedCanonicalBundle(
  state: SpecExportState,
): CanonicalSpecBundle {
  assertCanonicalExportState(state);
  return renderCanonicalBundle(state);
}

export function verifyExportState(state: SpecExportState): IntegrityReport {
  assertAttentionExportIntegrity(state);
  const checkedRevisionIds: string[] = [];
  const mismatches: IntegrityMismatch[] = [];
  for (const { snapshot } of state.revisions) {
    const expectedContentHash = snapshot.revision.contentHash;
    checkedRevisionIds.push(snapshot.revision.id);
    const actualContentHash = computeSpecRevisionContentHash(
      snapshot.revision.authoringStage,
      snapshot.elements,
    );
    const expectedCitationHash = snapshot.revision.citationHash;
    const actualCitationHash = computeSpecRevisionCitationHash(
      snapshot.revision.citationContractVersion,
      snapshot.assumptionCitations,
    );
    const mismatchedElementIds = snapshot.elements
      .filter(
        ({ version }) =>
          computeSpecElementPayloadHash(version.payload) !==
          version.payloadHash,
      )
      .map(({ element }) => element.id);
    if (
      (expectedContentHash === null ||
        actualContentHash === expectedContentHash) &&
      actualCitationHash === expectedCitationHash &&
      mismatchedElementIds.length === 0
    ) {
      continue;
    }
    mismatches.push({
      revisionId: snapshot.revision.id,
      expectedContentHash,
      actualContentHash,
      expectedCitationHash,
      actualCitationHash,
      mismatchedElementIds,
    });
  }
  if (mismatches.length === 0) {
    assertCanonicalExportState(state);
  }
  return {
    ok: mismatches.length === 0,
    checkedRevisionIds,
    mismatches,
    consistencyFindings: [
      ...executionLifecycleFindings(state),
      ...proposalIntegrityFindings(state),
    ],
  };
}

function assertAttentionExportIntegrity(state: SpecExportState): void {
  const questionIds = new Set<string>();
  const questionNumbers = new Set<number>();
  for (const [index, question] of state.questions.entries()) {
    const path = `questions[${index}]`;
    const parsed = specQuestionRowSchema.safeParse(question);
    if (!parsed.success) {
      throw schemaIntegrityError(path, "question", parsed.error.issues);
    }
    if (question.spec_id !== state.spec.id) {
      throw new SpecExportIntegrityError(
        `${path}.spec_id`,
        "question belongs to another spec",
      );
    }
    assertUnique(questionIds, question.id, `${path}.id`, "question id");
    assertUnique(
      questionNumbers,
      question.number,
      `${path}.number`,
      "question number",
    );
    parseActor(question.provenance_json, `${path}.provenance_json`);
  }

  const assumptionIds = new Set<string>();
  const assumptionNumbers = new Set<number>();
  const assumptionsById = new Map<string, SpecAssumptionRow>();
  for (const [index, assumption] of state.assumptions.entries()) {
    const path = `assumptions[${index}]`;
    const parsed = specAssumptionRowSchema.safeParse(assumption);
    if (!parsed.success) {
      throw schemaIntegrityError(path, "assumption", parsed.error.issues);
    }
    if (assumption.spec_id !== state.spec.id) {
      throw new SpecExportIntegrityError(
        `${path}.spec_id`,
        "assumption belongs to another spec",
      );
    }
    assertUnique(assumptionIds, assumption.id, `${path}.id`, "assumption id");
    assertUnique(
      assumptionNumbers,
      assumption.number,
      `${path}.number`,
      "assumption number",
    );
    parseActor(assumption.proposed_by_json, `${path}.proposed_by_json`);
    assumptionsById.set(assumption.id, assumption);
  }

  const successorByPredecessor = new Map<string, string>();
  const successorByOperation = new Map<string, string>();
  for (const [index, assumption] of state.assumptions.entries()) {
    const predecessorId = assumption.supersedes_assumption_id;
    if (predecessorId === null) continue;
    const path = `assumptions[${index}].supersedes_assumption_id`;
    const predecessor = assumptionsById.get(predecessorId);
    if (predecessor === undefined) {
      throw new SpecExportIntegrityError(
        path,
        `supersession predecessor ${predecessorId} is missing`,
      );
    }
    if (
      predecessor.disposition === "proposed" ||
      predecessor.disposition === "withdrawn"
    ) {
      throw new SpecExportIntegrityError(
        path,
        `supersession predecessor ${predecessorId} was not disposed`,
      );
    }
    if (predecessor.created_at > assumption.created_at) {
      throw new SpecExportIntegrityError(
        `assumptions[${index}].created_at`,
        "supersession predecessor cannot postdate its successor",
      );
    }
    const existingSuccessor = successorByPredecessor.get(predecessorId);
    if (existingSuccessor !== undefined) {
      throw new SpecExportIntegrityError(
        path,
        `supersession predecessor ${predecessorId} has multiple successors (${existingSuccessor}, ${assumption.id})`,
      );
    }
    successorByPredecessor.set(predecessorId, assumption.id);

    const operationId = assumption.supersession_operation_id;
    if (operationId === null) continue;
    const existingOperation = successorByOperation.get(operationId);
    if (existingOperation !== undefined) {
      throw new SpecExportIntegrityError(
        `assumptions[${index}].supersession_operation_id`,
        `supersession operation ${operationId} identifies multiple successors (${existingOperation}, ${assumption.id})`,
      );
    }
    successorByOperation.set(operationId, assumption.id);
  }
  assertAcyclicAssumptionLineage(state.assumptions, assumptionsById);

  const revisionIds = new Set(
    state.revisions.map(({ snapshot }) => snapshot.revision.id),
  );
  const eventIds = new Set<number>();
  for (const [index, event] of state.attentionAuditEvents.entries()) {
    const path = `attentionAuditEvents[${index}]`;
    if (event.spec_id !== state.spec.id) {
      throw new SpecExportIntegrityError(
        `${path}.spec_id`,
        "attention audit event belongs to another spec",
      );
    }
    assertUnique(eventIds, event.id, `${path}.id`, "attention audit event id");
    const actor = parseActor(event.actor_json, `${path}.actor_json`);
    const payload = parseAuditPayload(event.payload_json, path);

    if (event.event_type === "spec-review-record-mutated") {
      const parsed =
        specReviewRecordMutatedEventPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw schemaIntegrityError(
          `${path}.payload_json`,
          "attention audit event",
          parsed.error.issues,
        );
      }
      const knownRecord =
        parsed.data.recordKind === "question"
          ? questionIds.has(parsed.data.recordId)
          : assumptionIds.has(parsed.data.recordId);
      if (!knownRecord) {
        throw new SpecExportIntegrityError(
          `${path}.payload_json.recordId`,
          `attention audit event names missing ${parsed.data.recordKind} ${parsed.data.recordId}`,
        );
      }
      assertRecordMutationEventSemantics(parsed.data, actor, path);
      continue;
    }

    if (event.event_type === "spec-assumption-citations-mutated") {
      const parsed =
        specAssumptionCitationsMutatedEventPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw schemaIntegrityError(
          `${path}.payload_json`,
          "attention audit event",
          parsed.error.issues,
        );
      }
      assertCitationAuditEntriesOrdered(
        parsed.data.added,
        `${path}.payload_json.added`,
      );
      assertCitationAuditEntriesOrdered(
        parsed.data.removed,
        `${path}.payload_json.removed`,
      );
      assertCitationAuditEntriesOrdered(
        parsed.data.refreshed,
        `${path}.payload_json.refreshed`,
      );
      assertCitationAuditPayloadIntegrity(
        parsed.data,
        assumptionsById,
        `${path}.payload_json`,
      );
      if (!revisionIds.has(parsed.data.revisionId)) {
        throw new SpecExportIntegrityError(
          `${path}.payload_json.revisionId`,
          `attention audit event names missing revision ${parsed.data.revisionId}`,
        );
      }
      continue;
    }

    throw new SpecExportIntegrityError(
      `${path}.event_type`,
      `unsupported attention audit event family ${event.event_type}`,
    );
  }

  const auditHistoryIssue = validateCanonicalAuditHistory({
    questions: state.questions,
    assumptions: state.assumptions,
    revisionSnapshots: state.revisions.map(({ snapshot }) => snapshot),
    attentionAuditEvents: state.attentionAuditEvents,
  });
  if (auditHistoryIssue !== null) {
    throw new SpecExportIntegrityError(
      auditHistoryIssue.path,
      auditHistoryIssue.message,
    );
  }
}

function assertAcyclicAssumptionLineage(
  assumptions: readonly SpecAssumptionRow[],
  assumptionsById: ReadonlyMap<string, SpecAssumptionRow>,
): void {
  for (const assumption of assumptions) {
    const visited = new Set<string>();
    let current: SpecAssumptionRow | undefined = assumption;
    while (current.supersedes_assumption_id !== null) {
      if (visited.has(current.id)) {
        throw new SpecExportIntegrityError(
          "assumptions",
          `supersession lineage containing ${current.id} is cyclic`,
        );
      }
      visited.add(current.id);
      current = assumptionsById.get(current.supersedes_assumption_id);
      if (current === undefined) break;
    }
  }
}

function assertUnique<T>(
  values: Set<T>,
  value: T,
  path: string,
  label: string,
): void {
  if (values.has(value)) {
    throw new SpecExportIntegrityError(
      path,
      `${label} ${String(value)} repeats`,
    );
  }
  values.add(value);
}

function canonicalizeJsonColumn(value: string): string {
  return stableStringify(JSON.parse(value) as unknown);
}

function assertCanonicalManifestJsonColumns(
  manifest: CanonicalSpecManifest,
): void {
  for (const [index, admission] of manifest.gateAdmissions.entries()) {
    const path = `gateAdmissions[${index}].actor_json`;
    const actor = parseGateAdmissionActor(admission.actor_json, path);
    assertCanonicalJsonColumn(admission.actor_json, actor, path);
  }
  const actorColumns = [
    ...manifest.questions.map((row, index) => ({
      value: row.provenance_json,
      path: `questions[${index}].provenance_json`,
    })),
    ...manifest.assumptions.map((row, index) => ({
      value: row.proposed_by_json,
      path: `assumptions[${index}].proposed_by_json`,
    })),
    ...manifest.attentionAuditEvents.map((row, index) => ({
      value: row.actor_json,
      path: `attentionAuditEvents[${index}].actor_json`,
    })),
  ];
  for (const column of actorColumns) {
    const actor = parseActor(column.value, column.path);
    assertCanonicalJsonColumn(column.value, actor, column.path);
  }
  for (const [index, event] of manifest.attentionAuditEvents.entries()) {
    const path = `attentionAuditEvents[${index}].payload_json`;
    const payload = parseAuditPayload(
      event.payload_json,
      `attentionAuditEvents[${index}]`,
    );
    assertCanonicalJsonColumn(event.payload_json, payload, path);
  }
}

function assertCanonicalJsonColumn(
  raw: string,
  parsed: unknown,
  path: string,
): void {
  if (raw !== stableStringify(parsed)) {
    throw new SpecExportIntegrityError(
      path,
      "nested JSON must use canonical encoding",
    );
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertCitationAuditEntriesOrdered(
  entries: readonly {
    readonly elementId: string;
    readonly assumptionId: string;
  }[],
  path: string,
): void {
  let priorKey: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const key = `${entry.elementId}\u0000${entry.assumptionId}`;
    if (priorKey !== null && compareCodeUnits(key, priorKey) <= 0) {
      throw new SpecExportIntegrityError(
        `${path}[${index}]`,
        "citation audit entries must be unique and ordered by element id then assumption id",
      );
    }
    priorKey = key;
  }
}

function assertCitationAuditPayloadIntegrity(
  payload: SpecAssumptionCitationsMutatedEventPayload,
  assumptionsById: ReadonlyMap<string, SpecAssumptionRow>,
  path: string,
): void {
  const keys = new Set<string>();
  type AuditEntry = Pick<
    SpecAssumptionCitationsMutatedEventPayload["added"][number],
    "elementId" | "assumptionId"
  >;
  type AuditSnapshot =
    SpecAssumptionCitationsMutatedEventPayload["added"][number]["snapshot"];
  const assertEntry = (
    collection: "added" | "removed" | "refreshed",
    index: number,
    entry: AuditEntry,
    snapshots: readonly (readonly [string, AuditSnapshot])[],
  ): void => {
    const entryPath = `${path}.${collection}[${index}]`;
    const key = `${entry.elementId}\u0000${entry.assumptionId}`;
    if (keys.has(key)) {
      throw new SpecExportIntegrityError(
        entryPath,
        "citation audit delta collections must be disjoint",
      );
    }
    keys.add(key);
    const assumption = assumptionsById.get(entry.assumptionId);
    if (assumption === undefined) {
      throw new SpecExportIntegrityError(
        `${entryPath}.assumptionId`,
        "citation audit entry names a missing assumption",
      );
    }
    for (const [snapshotField, snapshot] of snapshots) {
      if (snapshot.assumptionId !== entry.assumptionId) {
        throw new SpecExportIntegrityError(
          `${entryPath}.${snapshotField}.assumptionId`,
          "citation audit snapshot identity differs from its entry",
        );
      }
      assertCitationSnapshotIdentity(
        snapshot,
        assumption,
        `${entryPath}.${snapshotField}`,
      );
    }
  };

  for (const collection of ["added", "removed"] as const) {
    for (const [index, entry] of payload[collection].entries()) {
      assertEntry(collection, index, entry, [["snapshot", entry.snapshot]]);
    }
  }
  for (const [index, entry] of payload.refreshed.entries()) {
    assertEntry("refreshed", index, entry, [
      ["beforeSnapshot", entry.beforeSnapshot],
      ["afterSnapshot", entry.afterSnapshot],
    ]);
  }
}

function assertRecordMutationEventSemantics(
  payload: SpecReviewRecordMutatedEventPayload,
  actor: ActorProvenance,
  path: string,
): void {
  const humanOnly =
    payload.operation === "answered" || payload.operation === "disposed";
  const requiredActor = humanOnly ? "human" : "agent";
  if (actor.kind !== requiredActor) {
    throw new SpecExportIntegrityError(
      `${path}.actor_json.kind`,
      `${payload.operation} record events require a ${requiredActor} actor`,
    );
  }

  if (payload.before === null && payload.after.recordVersion !== 1) {
    throw new SpecExportIntegrityError(
      `${path}.payload_json.after.recordVersion`,
      "record creation events begin at record version 1",
    );
  }

  const before = payload.before;
  const after = payload.after;
  switch (payload.operation) {
    case "opened":
      if (after.kind !== "question" || after.status !== "open") {
        throwRecordLifecycleError(path, after, "open");
      }
      return;
    case "proposed":
      if (after.kind !== "assumption" || after.disposition !== "proposed") {
        throwRecordLifecycleError(path, after, "proposed");
      }
      return;
    case "imported":
      return;
    case "edited":
      if (
        before === null ||
        (after.kind === "question" &&
          (before.kind !== "question" ||
            before.status !== "open" ||
            after.status !== "open")) ||
        (after.kind === "assumption" &&
          (before.kind !== "assumption" ||
            before.disposition !== "proposed" ||
            after.disposition !== "proposed"))
      ) {
        throwRecordLifecycleError(
          path,
          after,
          after.kind === "question" ? "open" : "proposed",
        );
      }
      return;
    case "answered":
      if (
        before === null ||
        before.kind !== "question" ||
        before.status !== "open" ||
        after.kind !== "question" ||
        after.status !== "answered"
      ) {
        throwRecordLifecycleError(path, after, "answered");
      }
      return;
    case "disposed":
      if (
        before === null ||
        before.kind !== "assumption" ||
        before.disposition !== "proposed" ||
        after.kind !== "assumption" ||
        !["confirmed", "rejected", "deferred"].includes(after.disposition)
      ) {
        throwRecordLifecycleError(path, after, "a disposed lifecycle");
      }
      return;
    case "withdrawn":
      if (
        before === null ||
        (after.kind === "question" &&
          (before.kind !== "question" ||
            before.status !== "open" ||
            after.status !== "withdrawn")) ||
        (after.kind === "assumption" &&
          (before.kind !== "assumption" ||
            before.disposition !== "proposed" ||
            after.disposition !== "withdrawn"))
      ) {
        throwRecordLifecycleError(path, after, "withdrawn");
      }
      return;
    case "superseded":
      if (
        before === null ||
        before.kind !== "assumption" ||
        !["confirmed", "rejected", "deferred"].includes(before.disposition) ||
        after.kind !== "assumption" ||
        after.disposition !== before.disposition ||
        before.supersededByAssumptionId !== null ||
        after.supersededByAssumptionId !== payload.successorAssumptionId
      ) {
        throwRecordLifecycleError(path, after, "superseded");
      }
      return;
  }
}

function throwRecordLifecycleError(
  path: string,
  snapshot: SpecReviewRecordMutatedEventPayload["after"],
  expected: string,
): never {
  const field = snapshot.kind === "question" ? "status" : "disposition";
  throw new SpecExportIntegrityError(
    `${path}.payload_json.after.${field}`,
    `record event operation requires ${expected} after-state`,
  );
}

function assertCitationSnapshotIdentity(
  snapshot: {
    readonly capturedAt: string;
    readonly number: number;
    readonly proposedBy: ActorProvenance;
    readonly supersedesAssumptionId: string | null;
    readonly createdAt: string;
  },
  assumption: SpecAssumptionRow,
  path: string,
): void {
  if (snapshot.number !== assumption.number) {
    throw new SpecExportIntegrityError(
      `${path}.number`,
      "citation snapshot number differs from its assumption identity",
    );
  }
  const proposedBy = parseActor(
    assumption.proposed_by_json,
    `${path}.proposedBy`,
  );
  if (!isDeepStrictEqual(snapshot.proposedBy, proposedBy)) {
    throw new SpecExportIntegrityError(
      `${path}.proposedBy`,
      "citation snapshot provenance differs from its assumption identity",
    );
  }
  if (snapshot.supersedesAssumptionId !== assumption.supersedes_assumption_id) {
    throw new SpecExportIntegrityError(
      `${path}.supersedesAssumptionId`,
      "citation snapshot predecessor differs from its assumption identity",
    );
  }
  if (snapshot.createdAt !== assumption.created_at) {
    throw new SpecExportIntegrityError(
      `${path}.createdAt`,
      "citation snapshot creation time differs from its assumption identity",
    );
  }
  if (snapshot.capturedAt < snapshot.createdAt) {
    throw new SpecExportIntegrityError(
      `${path}.capturedAt`,
      "citation snapshot cannot precede assumption creation",
    );
  }
}

function parseActor(value: string, path: string): ActorProvenance {
  let actor: unknown;
  try {
    actor = JSON.parse(value);
  } catch {
    throw new SpecExportIntegrityError(path, "actor provenance is not JSON");
  }
  const parsed = actorProvenanceSchema.safeParse(actor);
  if (!parsed.success) {
    throw schemaIntegrityError(path, "actor provenance", parsed.error.issues);
  }
  return parsed.data;
}

function parseGateAdmissionActor(
  value: string,
  path: string,
): z.infer<typeof gateAdmissionActorSchema> {
  let actor: unknown;
  try {
    actor = JSON.parse(value);
  } catch {
    throw new SpecExportIntegrityError(path, "actor provenance is not JSON");
  }
  const parsed = gateAdmissionActorSchema.safeParse(actor);
  if (!parsed.success) {
    throw schemaIntegrityError(path, "actor provenance", parsed.error.issues);
  }
  return parsed.data;
}

function parseAuditPayload(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new SpecExportIntegrityError(
      `${path}.payload_json`,
      "attention audit event payload is not JSON",
    );
  }
}

function schemaIntegrityError(
  path: string,
  label: string,
  issues: readonly {
    readonly path: PropertyKey[];
    readonly message: string;
    readonly code?: string;
    readonly keys?: string[];
  }[],
): SpecExportIntegrityError {
  const issue = issues[0];
  const unknownKey =
    issue?.code === "unrecognized_keys" ? issue.keys?.[0] : undefined;
  const fullPath =
    issue === undefined
      ? path
      : issuePath(
          path,
          unknownKey === undefined ? issue.path : [...issue.path, unknownKey],
        );
  return new SpecExportIntegrityError(
    fullPath,
    `${label} is malformed${issue === undefined ? "" : `: ${issue.message}`}`,
  );
}

/**
 * Whether the pinned run still holds the session's execution lease. Not the
 * row's position: a terminal record left in the active row holds nothing and
 * is normalized into History by the next launch, so reporting it as owning
 * the session would be a finding with no act behind it.
 */
function ownsExecutionSlot(linked: LinkedWorkflowObservation): boolean {
  return linked.kind === "active" && linked.leaseHeld;
}

/** The placed run, or null when nothing was launched or nothing remains. */
function placedWorkflow(linked: LinkedWorkflowObservation): {
  workflowExecutionId: string;
  status: GraphWorkflowStatus;
} | null {
  return linked.kind === "active" || linked.kind === "archived"
    ? { workflowExecutionId: linked.workflowExecutionId, status: linked.status }
    : null;
}

function linkedWorkflowId(linked: LinkedWorkflowObservation): string | null {
  return linked.kind === "never_launched" ? null : linked.workflowExecutionId;
}

/**
 * The two ways a delivery execution can be left in a state nothing will move
 * on its own (design §10).
 *
 * The `abandoning` finding is deliberately NOT gated on the linked run: the
 * two cleanup phases leave different residues — `abort_workflow` can leave the
 * run still holding the lease, and `finalize` leaves it lease-free while the
 * spec execution is still stuck. Gating on liveness would report the first and
 * silently drop the second, which is the one no other surface shows.
 */
function executionLifecycleFindings(
  state: SpecExportState,
): SpecConsistencyFinding[] {
  const findings: SpecConsistencyFinding[] = [];
  for (const { execution, linkedWorkflow } of state.executions) {
    const placed = placedWorkflow(linkedWorkflow);
    const common = {
      family: "execution-lifecycle",
      specExecutionId: execution.id,
      cleanupPhase: execution.cleanup_phase,
      workflowExecutionId: linkedWorkflowId(linkedWorkflow),
      workflowStatus: placed === null ? null : placed.status,
      ownsExecutionSlot: ownsExecutionSlot(linkedWorkflow),
    } as const;
    if (execution.state === "abandoning") {
      findings.push({
        ...common,
        code: "abandon_cleanup_unfinished",
        detail: `Spec execution ${execution.id} stopped mid-abandonment at the ${execution.cleanup_phase ?? "abort_workflow"} phase${
          execution.cleanup_last_error === null
            ? ""
            : `: ${execution.cleanup_last_error}`
        }`,
        remedy: `Retry the same command to resume the cleanup from where it stopped: cctl spec abandon ${state.spec.slug} --execution ${execution.id} --reason <reason>`,
      });
      continue;
    }
    if (execution.state !== "abandoned") continue;
    // Only a run that still HOLDS the lease is an orphan with an exit. A
    // lease-free record — archived, or terminal but not yet normalized —
    // blocks nothing and is relocated by the next launch, so reporting it
    // would be a finding no act could ever clear.
    if (linkedWorkflow.kind !== "active" || !linkedWorkflow.leaseHeld) continue;
    const { workflowExecutionId, status } = linkedWorkflow;
    // Terminality is the lifecycle contract's answer, never a local one.
    const live = !isTerminalStatus(status);
    // No coordinator re-entry exists from `abandoned`, so re-running abandon
    // would report success over the orphan instead of clearing it. The exit is
    // workflow-side, and WHICH verb follows from the blocker's own state: a
    // halted run holds the lease because its halt is resumable, and abandon is
    // the one act that ends that tenure while preserving the halt reason;
    // anything else still holding it is ended by abort, which releases on its
    // own.
    findings.push({
      ...common,
      code: "abandoned_execution_workflow_unreleased",
      detail: `Spec execution ${execution.id} is abandoned, but graph workflow execution ${workflowExecutionId} is ${live ? "still live" : "still holding this session's execution lease"} (${status})`,
      remedy:
        status === "halted"
          ? `Abandon it with 'cctl workflow abandon --reason <reason> --execution ${workflowExecutionId}'`
          : `Abort it with 'cctl workflow live abort --reason <reason>' — that releases the lease`,
    });
  }
  return findings;
}

/**
 * Ticket #50's dead end, reported until it is disposed of. Eligibility comes
 * from the shared supersession predicate, so verify can never offer a dismissal
 * the dismiss act would refuse — or stay silent on one it would accept.
 *
 * A lone live proposal nothing has forked past is the ordinary "awaiting
 * review" state and is not a finding; a second live proposal is, because one of
 * the two has to be disposed of before either can be signed off.
 */
function proposalIntegrityFindings(
  state: SpecExportState,
): SpecConsistencyFinding[] {
  const revisions: SpecRevision[] = state.revisions.map(
    ({ snapshot }) => snapshot.revision,
  );
  const live = liveProposals(revisions);
  return live.flatMap((proposal): SpecConsistencyFinding[] => {
    const superseding = supersedingRevision(revisions, proposal.id);
    if (superseding !== null) {
      return [
        {
          family: "proposal-integrity",
          code: "superseded_proposal",
          revisionId: proposal.id,
          revisionNumber: proposal.number,
          supersededByRevisionId: superseding.id,
          detail: `Revision ${proposal.number} (${proposal.id}) is still proposed, but approved revision ${superseding.number} (${superseding.id}) forked past it`,
          remedy: `Dismiss revision ${proposal.id} from ${DISMISS_SUPERSEDED_SURFACE}`,
        },
      ];
    }
    if (live.length < 2) return [];
    return [
      {
        family: "proposal-integrity",
        code: "competing_live_proposal",
        revisionId: proposal.id,
        revisionNumber: proposal.number,
        supersededByRevisionId: null,
        detail: `Revision ${proposal.number} (${proposal.id}) is one of ${live.length} live proposals on this lineage; nothing has forked past it, so it cannot be dismissed as superseded`,
        // Request Changes, and only it. Sign-off is refused here by definition
        // — this finding exists only where a live sibling does, and the
        // sign-off recheck refuses a target that would fork past one. The
        // agent's `withdraw-proposal` is admitted only for the proposing
        // conversation before a human engages. The human Withdraw act would
        // fit, but Studio ships no control for it, and a remedy pointing at a
        // surface with no button is the same dead end one layer out.
        remedy: `Conclude its review in ${HUMAN_REVIEW_SURFACE}: Request Changes on revision ${proposal.id}, which sends it back to its author as a draft`,
      },
    ];
  });
}
