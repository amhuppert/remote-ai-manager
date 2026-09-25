import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  actorProvenanceSchema,
  specAuthoringStageSchema,
  specElementKindSchema,
  specElementPayloadSchema,
  specGatePolicySchema,
  type ActorProvenance,
  type Spec,
  type SpecElementKind,
  type SpecElementPayload,
  type SpecElementVersion,
  type SpecRevision,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import {
  computeSpecRevisionContentHash,
  SpecElementIdTakenError,
  SpecHistoricalElementError,
  SpecRevisionImmutableError,
  StaleElementConflictError,
  StaleStageConflictError,
  type CreateDraftElementResult,
  type RenameSpecResult,
  type SpecsRepo,
  type SpecsRepoTransaction,
} from "@/lib/state-store/specs-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";

import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import {
  openAuthoringRequestsForRevision,
  prepareApprovalRequestRetirement,
  type SpecApprovalRequestsClosedNotice,
} from "./attention-records";
import { markWaiversStaleAtSignOffInTransaction } from "./waiver-staleness";
import type { ApprovalLedger } from "./approval-ledger";
import {
  authoringReviewProjection,
  isAuthoringGate,
  type AuthoringNextAction,
  type AuthoringPendingBlock,
} from "./authoring-review-projection";
import { draftHealth } from "./draft-health";
import type { ReferenceIssue } from "./element-references";
import {
  danglingReferenceRefusal,
  guardedElements,
  stageRevisionWrite,
  validateStagedWrite,
  type GuardedElement,
  type StagedElementMutation,
} from "./element-write-guard";
import { specSlugSchema } from "./handles";
import { lint, type LintFinding } from "./lint";
import type { SpecMeasureEventPayload } from "./measures";
import { authoringApprovalsCollapseIntoSignOff, resolveDial } from "./policy";
import { oversizedProposalNotesRefusal } from "./proposal-notes";
import {
  LATER_STAGE_RATIONALE,
  PARENT_IMMUTABLE_RATIONALE,
} from "./refusal-rationale";
import { diffRevisions, type RevisionDiffResult } from "./revision-diff";
import {
  elementHandleInSnapshot,
  loadProposalState,
  toCitationDiffContext,
  toDiffRows,
} from "./review-state";
import {
  nearestApprovedAncestor,
  selectOrdinaryContinuation,
  type OrdinaryContinuation,
} from "./revision-lineage";
import {
  admitDraftWrite,
  advanceAuthoringStage as evaluateAdvanceAuthoringStage,
  consultedAuthoringGates,
  nextAuthoringStage,
  openDraftAuthoringStage,
  propose,
  resolveAuthoringDials,
  type AuthoringGate,
  type TransitionRefusal,
} from "./transitions";
import type { ReviewService } from "./review-service";
import type { SpecProposeApprovalRequest } from "./view-schemas";

const logger = createLogger("specs.authoring-service");

export const draftElementWriteInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    /**
     * The element that contains this one. Stated exactly once, at creation: a
     * create must name it (null for a top-level element) because
     * `parent_immutable` makes the choice permanent, and an update may leave
     * it out because an update cannot change it. Optional here rather than in
     * two schemas, so a lone element and a batch item stay one document shape;
     * which of the two rules applies is decided by `baseElementVersion`, and
     * the admission owns both.
     */
    parentElementId: z.string().min(1).nullable().optional(),
    /**
     * One global order per revision, tiebroken by element id. Omit it to
     * append: a create takes the next slot, an update keeps the slot it has.
     * Nesting comes from `parentElementId` alone, never from position.
     */
    position: z.number().int().nonnegative().optional(),
    payload: specElementPayloadSchema,
    baseElementVersion: z.number().int().positive().nullable(),
    /**
     * Brings an element id this spec already owns, but the target revision
     * does not carry, back into the revision — with its number, handle and
     * creation provenance intact. Pairs with `baseElementVersion: null`: there
     * is no version in this revision to compare against. Without it a
     * historical id refuses, because reviving an identity silently is how a
     * reader ends up with two elements answering to the same address.
     */
    reintroduceHistorical: z.boolean().optional(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DraftElementWriteInput = z.infer<
  typeof draftElementWriteInputSchema
>;

/**
 * One element as a caller writes it into a draft: a single write minus the
 * spec, revision, and actor the transport carries. Its `baseElementVersion` is
 * the concurrency boundary whether the element travels alone or in a batch, so
 * two writers touching disjoint elements never conflict (R7.3) — and one
 * document shape serves both forms, which is what keeps a lone element and a
 * one-element array from disagreeing about which fields are legal.
 */
export const draftElementDocumentSchema = draftElementWriteInputSchema.omit({
  specId: true,
  revisionId: true,
  actor: true,
});
export type DraftElementInput = z.infer<typeof draftElementDocumentSchema>;

/**
 * One element the batch takes out of the revision. Removal carries the same
 * per-element compare-and-swap a write does, so a batch that removes an
 * element someone else moved refuses instead of dropping their edit.
 */
export const draftElementBatchRemovalSchema = z
  .object({
    elementId: z.string().min(1),
    baseElementVersion: z.number().int().positive(),
  })
  .strict();
export type DraftElementBatchRemoval = z.infer<
  typeof draftElementBatchRemovalSchema
>;

export const draftElementBatchShapeSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elements: z.array(draftElementDocumentSchema),
    /**
     * Removals travel with the writes because a reference and its target can
     * only be taken out together: removing either alone would leave the other
     * dangling, so two sequential single removals have no legal order.
     */
    removals: z.array(draftElementBatchRemovalSchema).optional(),
    /**
     * Optional stricter mode (R7.4). Supplying it additionally requires the
     * revision to be untouched since the token was read — useful for a writer
     * that reasoned about the whole document. It is never the default: a
     * revision-level compare-and-swap would make disjoint writers conflict.
     */
    expectedRevisionToken: z.string().min(1).optional(),
    actor: actorProvenanceSchema,
  })
  .strict();

export const BATCH_WITHOUT_WORK_MESSAGE =
  "A batch must write or remove at least one element.";

/** Shared by the service input and the transport body, which omits identity. */
export function batchCarriesWork(input: {
  elements: readonly unknown[];
  removals?: readonly unknown[];
}): boolean {
  return input.elements.length > 0 || (input.removals ?? []).length > 0;
}

export const draftElementBatchInputSchema = draftElementBatchShapeSchema.refine(
  batchCarriesWork,
  { message: BATCH_WITHOUT_WORK_MESSAGE, path: ["elements"] },
);

/**
 * The batch as a caller authors it in a file: the same shape minus the
 * identity the transport carries, and minus the revision-level token, which is
 * a read a document cannot hold. Both arrays default to empty so a file may
 * write only, remove only, or do both — the refinement is what rejects a
 * document that does neither. One schema serves the `--file` contract and the
 * published `cctl spec schema` document, so what an author is shown is what
 * the server parses.
 */
export const draftElementBatchDocumentSchema = draftElementBatchShapeSchema
  .omit({
    specId: true,
    revisionId: true,
    actor: true,
    expectedRevisionToken: true,
  })
  .extend({
    elements: z.array(draftElementDocumentSchema).default([]),
    removals: z.array(draftElementBatchRemovalSchema).default([]),
  })
  .strict();
export type DraftElementBatchInput = z.infer<
  typeof draftElementBatchInputSchema
>;

/** One element that landed, addressed by its index in the submitted array. */
export interface DraftElementBatchEntry extends DraftElementWriteResult {
  readonly index: number;
  readonly elementId: string;
}

/** Which submitted array a batch refusal is addressed against. */
export type DraftElementBatchInputKind = "element" | "removal" | "revision";

/**
 * A dangling reference as a batch reports it: the guard's issue plus the
 * handles each end is addressed by. Handles are derived from the revision the
 * batch was judged against rather than stored, so they belong to the report
 * and not to the guard — and an element the batch is only now introducing has
 * no handle yet, which is what null says.
 */
export interface BatchReferenceIssue extends ReferenceIssue {
  readonly sourceHandle: string | null;
  readonly targetHandle: string | null;
}

/**
 * One element that refused, addressed by its index in the submitted array so a
 * caller can see which element refused and why without diffing arrays. The
 * revision-level token, when supplied and stale, refuses at index -1 with a
 * null element: no single element is at fault.
 */
export interface DraftElementBatchRefusal {
  readonly input: DraftElementBatchInputKind;
  readonly index: number;
  readonly elementId: string | null;
  readonly code: TransitionRefusal["code"];
  readonly unmetConditions: string[];
  readonly instruction: string;
  /** The version the element is actually at, for a stale-element refusal. */
  readonly currentElementVersion: number | null;
  /**
   * The references this item's write would have left unresolved, carried
   * structurally so a writer can repair them without parsing prose.
   */
  readonly danglingReferences?: readonly BatchReferenceIssue[];
  /**
   * The sentence saying why the rule exists, on the refusals whose friction is
   * the product rather than a defect. A batch prints one line per index, so
   * without it the reader of a refused batch would be the only one who never
   * learns what the constraint protects.
   */
  readonly rationale?: string;
  /**
   * The refusal's structural facts, for the codes that carry them. Absent on
   * the refusals that state everything in their unmet condition.
   */
  readonly details?: Record<string, unknown>;
}

export type DraftElementBatchResult =
  | {
      readonly ok: true;
      readonly revisionId: string;
      readonly written: DraftElementBatchEntry[];
    }
  | { readonly ok: false; readonly refusals: DraftElementBatchRefusal[] };

/**
 * The first saved element, carried inside the create call: the durable spec
 * object is born from its first successful draft save (R4.1), so creation is
 * never a separate content-less step. The revision this element opens holds
 * no version to compare against, so an explicit `baseElementVersion: null`
 * is tolerated — it states exactly what create means, and refusing it was a
 * guaranteed first-contact stumble for callers trained on the draft document
 * (#60) — while a NUMBER still refuses: a real base version is a draft
 * document sent at the wrong verb, and the strict parse says so.
 */
export const createSpecInitialElementSchema = draftElementDocumentSchema
  .omit({
    baseElementVersion: true,
  })
  // This document is only ever a create, so containment is required here
  // rather than admitted case by case: there is no update form of the first
  // save for an omission to be the ordinary shape of.
  .extend({
    baseElementVersion: z.null().optional(),
    parentElementId: z.string().min(1).nullable(),
  });
export type CreateSpecInitialElement = z.infer<
  typeof createSpecInitialElementSchema
>;

export const createAuthoringSpecInputSchema = z
  .object({
    projectPath: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    gatePolicy: specGatePolicySchema,
    initialElement: createSpecInitialElementSchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type CreateAuthoringSpecInput = z.infer<
  typeof createAuthoringSpecInputSchema
>;

const draftElementCasInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    baseElementVersion: z.number().int().positive(),
    actor: actorProvenanceSchema,
  })
  .strict();

export const reorderDraftElementInputSchema = draftElementCasInputSchema
  .extend({ position: z.number().int().nonnegative() })
  .strict();
export type ReorderDraftElementInput = z.infer<
  typeof reorderDraftElementInputSchema
>;

export const removeDraftElementInputSchema = draftElementCasInputSchema;
export type RemoveDraftElementInput = z.infer<
  typeof removeDraftElementInputSchema
>;

export const openAmendmentInputSchema = z
  .object({
    specId: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type OpenAmendmentInput = z.infer<typeof openAmendmentInputSchema>;

/** Why a Design ask ends when its revision returns to Requirements. */
const RETURNED_TO_REQUIREMENTS_REASON =
  "the revision it asked about was returned to Requirements";
/**
 * A Notify/Off propose freezes the draft itself, so an ask filed while the
 * policy still wanted a human has nothing left to ask for.
 */
const FROZEN_BY_POLICY_REASON =
  "the revision was frozen under its Notify or Off policy";

export const returnToRequirementsInputSchema = z
  .object({
    specId: z.string().min(1),
    expectedRevisionId: z.string().min(1),
    reason: z.string().trim().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type ReturnToRequirementsInput = z.infer<
  typeof returnToRequirementsInputSchema
>;

/**
 * An amendment answers with what it opened and what it could not carry: a
 * revision withdrawn above the approved base is terminal, so its content is
 * dropped by any continuation. Naming the dropped revisions is the only way
 * the author learns the new revision starts short of the last thing written.
 */
export interface OpenAmendmentResult {
  readonly revision: SpecRevision;
  readonly skippedWithdrawnRevisions: readonly SpecRevision[];
}

export interface ReturnToRequirementsResult {
  readonly revision: SpecRevision;
  readonly withdrawnRevision: SpecRevision;
}

export const renameAuthoringSpecInputSchema = z
  .object({
    specId: z.string().min(1),
    slug: specSlugSchema,
    name: z.string().min(1).optional(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type RenameAuthoringSpecInput = z.infer<
  typeof renameAuthoringSpecInputSchema
>;

/**
 * Entry-path result shape shared with the linked-source flows (promotion and
 * graduation), where an existing spec's draft may legitimately be reused.
 */
export interface AuthoringSpecResult {
  readonly spec: Spec;
  readonly draft: SpecRevision;
  readonly reused: boolean;
}

/**
 * A draft write plus the handle the written element is now addressed by.
 * Handles are the authoring vocabulary, so the writer learns the address it
 * just created instead of having to re-read the spec to discover it. Sections
 * and unnumbered rows have no handle and report null.
 */
export interface DraftElementWriteResult extends CreateDraftElementResult {
  readonly handle: string | null;
}

/** Result of the atomic first draft save that creates the spec. */
export interface AuthoringSpecCreateResult {
  readonly spec: Spec;
  readonly draft: SpecRevision;
  readonly element: CreateDraftElementResult["element"];
  readonly version: SpecElementVersion;
  /** True when the first save of an amendment revived a historical identity. */
  readonly revived: boolean;
  readonly handle: string | null;
}

export interface AuthoringService {
  createSpec(
    input: CreateAuthoringSpecInput,
  ): Promise<AuthoringSpecCreateResult>;
  getSpec(projectPath: string, slug: string): Promise<Spec | null>;
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  upsertDraftElement(
    input: DraftElementWriteInput,
  ): Promise<DraftElementWriteResult>;
  upsertDraftElements(
    input: DraftElementBatchInput,
  ): Promise<DraftElementBatchResult>;
  /** The optional revision-level token a stricter batch may pin. */
  readRevisionToken(revisionId: string): Promise<string | null>;
  reorderDraftElement(
    input: ReorderDraftElementInput,
  ): Promise<SpecElementVersion>;
  removeDraftElement(input: RemoveDraftElementInput): Promise<void>;
  openAmendment(input: OpenAmendmentInput): Promise<OpenAmendmentResult>;
  returnToRequirements(
    input: ReturnToRequirementsInput,
  ): Promise<ReturnToRequirementsResult>;
  advanceAuthoringStage(
    input: AdvanceAuthoringStageInput,
  ): Promise<AdvanceAuthoringStageResult>;
  renameSpec(input: RenameAuthoringSpecInput): Promise<RenameSpecResult>;
  lintDraft(specId: string, revisionId: string): Promise<LintFinding[]>;
  proposeRevision(input: ProposeAuthoringRevisionInput): Promise<ProposeResult>;
}

export interface AuthoringServiceDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
  links: Pick<SpecLinksRepo, "findBySpecId">;
  events: SpecEventsPublisher;
  /**
   * R14.5 at the absorbed sign-off: a propose that auto-approves under
   * Notify/Off dials is a revision approval, so waivers whose criterion
   * changed must go stale in the same transaction.
   */
  waivers?: Pick<SpecDeliveryRepo, "findWaiversBySpecId" | "saveWaiver">;
  /**
   * The open approval requests a revision-ending act must retire with it. A
   * withdrawn revision that keeps its asks open leaves a Needs You entry no
   * later approval can ever answer, so this is not optional.
   */
  attention: Pick<SpecEventsRepo, "listOpenApprovalRequests">;
  /** Post-hoc notices for Notify-dial authoring-gate admissions (R11.2). */
  policyNotifier?: SpecPolicyAdmissionNotifier;
  /** Closes the Needs You entries of asks a revision-ending act retired. */
  notifier?: {
    approvalRequestsClosed(notice: SpecApprovalRequestsClosedNotice): void;
  };
  /**
   * Files the gate-scoped asks a successful proposal owes (R10.13). Optional
   * because the authoring service is composed on its own in narrower entry
   * paths; a proposal made without it reports `not-filed` rather than pretend
   * a durable request exists, which leaves `request-approval` the recovery.
   */
  approvalRequests?: ApprovalRequestPort;
  newId?(prefix: string): string;
  now?(): string;
}

export const proposeAuthoringRevisionInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    actor: actorProvenanceSchema,
    /**
     * The author's disposition/changelog document for this review round. Left
     * uncapped here on purpose: the size limit is a refusal that names the cap
     * and the size sent (`oversizedProposalNotesRefusal`), which a schema bound
     * could only report as an unrecognized validation error.
     */
    notes: z.string().min(1).optional(),
  })
  .strict();
export type ProposeAuthoringRevisionInput = z.infer<
  typeof proposeAuthoringRevisionInputSchema
>;

export interface ProposeSuccess {
  readonly ok: true;
  readonly revision: SpecRevision;
  readonly diff: RevisionDiffResult;
  readonly absorbedSignOff: boolean;
  /**
   * What the revision still owes, read from the server's projection after
   * any policy admissions. Null when nothing is outstanding. A caller renders this; deriving a blocker from
   * the revision's authoring stage names the wrong gate.
   */
  readonly pendingBlock: AuthoringPendingBlock | null;
  readonly nextAction: AuthoringNextAction;
  /**
   * Both sides of what the consulted gates ask for, so a propose that lands
   * with work outstanding reads as a position rather than as a failure: what
   * carried, and what a human still owes.
   */
  readonly approvalLedger: ApprovalLedger;
  /**
   * What the post-commit coordinator did about the ask each consulted
   * authoring gate owes (R10.13). One entry per consulted gate, in authoring
   * order, so a caller can tell an ask that now exists from one it still has
   * to file itself.
   */
  readonly approvalRequests: readonly SpecProposeApprovalRequest[];
}

export interface ProposeRefused {
  readonly ok: false;
  readonly refusal: TransitionRefusal;
}

export type ProposeResult = ProposeSuccess | ProposeRefused;

/**
 * The transaction's answer, before the post-commit coordinator files anything.
 * The asks are deliberately outside the transaction: a durable request is a
 * second act after the review request has committed, and rolling the request
 * back because an ask failed would lose the review round a human is asked to
 * act on.
 */
type ProposeTransitionResult =
  | Omit<ProposeSuccess, "approvalRequests">
  | ProposeRefused;

/**
 * The approval-request verb the propose coordinator files through. Structural
 * so the authoring service composes the review service rather than importing
 * its implementation — the two are built side by side in the service factory.
 */
export type ApprovalRequestPort = Pick<ReviewService, "requestApproval">;

/** What the committed transition leaves for the coordinator to act on. */
interface ProposalGateAsk {
  /** Every authoring gate the proposal consulted, in authoring order. */
  readonly consulted: readonly AuthoringGate[];
  /** The consulted gates the post-transition projection still leaves pending. */
  readonly pending: ReadonlySet<AuthoringGate>;
  /**
   * True when the policy folds every authoring approval into the one sign-off
   * (R11.5). A gate-scoped ask per gate would then open three Needs You rows
   * for a single human act that none of them names.
   */
  readonly collapsed: boolean;
}

export const advanceAuthoringStageInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    expectedStage: specAuthoringStageSchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type AdvanceAuthoringStageInput = z.infer<
  typeof advanceAuthoringStageInputSchema
>;

export type AdvanceAuthoringStageResult =
  | { readonly ok: true; readonly revision: SpecRevision }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

/**
 * A single-element draft write the service refused. The refusal it carries is
 * the answer, so the code is read off it rather than fixed: the same carrier
 * reports a stage that does not admit the element and a write whose references
 * the revision cannot resolve.
 */
export class StageBlockedWriteError extends Error {
  readonly code: TransitionRefusal["code"];

  constructor(readonly refusal: TransitionRefusal) {
    super(refusal.unmetConditions.join(" "));
    this.code = refusal.code;
    this.name = "StageBlockedWriteError";
  }
}

export class SpecDraftUnavailableError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} has no editable draft or approved revision`);
    this.name = "SpecDraftUnavailableError";
  }
}

/** A write into approved or withdrawn content continues in an amendment. */
export function immutableRevisionRefusal(
  error: SpecRevisionImmutableError,
): Pick<TransitionRefusal, "code" | "unmetConditions" | "instruction"> {
  return {
    code: "amendment_required",
    unmetConditions: [error.message],
    instruction: "Open an amendment draft before changing approved content.",
  };
}

/**
 * The one refusal every surface renders for an element id this spec already
 * owns. Only `reintroduction_required` is recoverable by retrying, so it is
 * the only one that states a retry shape; the other two name the identity
 * facts a reintroduction cannot change, which leaves a new id as the way out.
 */
export function historicalElementRefusal(
  error: SpecHistoricalElementError,
): Pick<
  TransitionRefusal,
  "code" | "unmetConditions" | "instruction" | "details"
> {
  const address = error.handle ?? error.elementId;
  const instruction =
    error.reason === "reintroduction_required"
      ? `Nothing was written. Retry the same write with "reintroduceHistorical": true and "baseElementVersion": null to bring ${address} back into this revision with its number, handle and history intact, or author the new content under a different element id.`
      : error.reason === "kind_changed"
        ? `Nothing was written. ${address} is a ${error.kind} and comes back as one, so reintroduce it with kind ${error.kind}, or choose a different element id for the new ${error.attemptedKind}.`
        : `Nothing was written. ${address} is contained by ${error.parentElementId ?? "no parent"} and comes back under it, so reintroduce it with that parentElementId, or choose a different element id to author it elsewhere.`;
  return {
    code: error.code,
    unmetConditions: [error.message],
    instruction,
    details: {
      reason: error.reason,
      elementId: error.elementId,
      revisionId: error.revisionId,
      handle: error.handle,
      kind: error.kind,
      parentElementId: error.parentElementId,
      attemptedKind: error.attemptedKind,
      attemptedParentElementId: error.attemptedParentElementId,
    },
  };
}

/**
 * A refused rehoming. Every field is present because there is no version of
 * this refusal that leaves one out: the reader needs both parents to see which
 * of them it actually meant, and the rule only recruits when the sentence
 * saying why it exists travels with it.
 */
export type ParentImmutableRefusal = Required<
  Pick<
    TransitionRefusal,
    "code" | "unmetConditions" | "instruction" | "details" | "rationale"
  >
>;

/**
 * The one refusal every surface renders for an attempt to move an element the
 * revision carries. There is no retry shape and no override flag: a handle is
 * composed from its parent's number and every frozen revision recorded what
 * contained what, so the way to a different parent is a different element.
 */
export function parentImmutableRefusal(input: {
  elementId: string;
  handle: string | null;
  currentParentElementId: string | null;
  requestedParentElementId: string | null;
}): ParentImmutableRefusal {
  const address = input.handle ?? input.elementId;
  const destination =
    input.requestedParentElementId === null
      ? "at the top level"
      : `under ${input.requestedParentElementId}`;
  return {
    code: "parent_immutable",
    unmetConditions: [
      `${address}'s parent (${input.currentParentElementId ?? "none"}) is part of its stable identity across revisions and cannot change after creation.`,
    ],
    rationale: PARENT_IMMUTABLE_RATIONALE,
    instruction: `Nothing was written. Author the content as a new element ${destination}, then take ${address} out of the draft with \`cctl spec remove\`.`,
    details: {
      elementId: input.elementId,
      handle: input.handle,
      currentParentElementId: input.currentParentElementId,
      requestedParentElementId: input.requestedParentElementId,
    },
  };
}

/**
 * A create that leaves its containment to a default. Refused rather than
 * defaulted, because `parent_immutable` makes the parent an element is born
 * under permanent: a silently chosen one is a permanent mistake, repairable
 * only by removing the element and writing it again.
 */
function creationParentRequiredRefusal(
  elementId: string,
): Pick<TransitionRefusal, "code" | "unmetConditions" | "instruction"> {
  return {
    code: "validation",
    unmetConditions: [
      `${elementId} is being created and states no parentElementId, which is the one write that can state it.`,
    ],
    instruction: `Nothing was written. Give ${elementId} a "parentElementId": the element id of the element that contains it, or null for a top-level element. Later updates may leave it out, because an element's parent never changes.`,
  };
}

/**
 * The containment rule for one element write, or null when the write obeys it.
 * Containment is stated exactly once, at creation, which is why both halves
 * live here: a create must choose, and an update has nothing left to say.
 *
 * An update that omits the field states no move, and one that echoes the
 * stored parent is the ordinary read-modify-write shape, so neither is an
 * attempt at anything; naming a different parent is the move `parent_immutable`
 * refuses. Only an update can rehome — a create over an element the revision
 * already carries is a stale-version conflict whatever parent it names, and a
 * create over one it does not carry has no stored parent to contradict, the
 * reintroduction among those judging its own parent under
 * `historical_element_id`.
 */
export function elementContainmentRefusal(input: {
  current: readonly GuardedElement[];
  elementId: string;
  requestedParentElementId: string | null | undefined;
  baseElementVersion: number | null;
  handleOf: (elementId: string) => string | null;
}): Pick<
  TransitionRefusal,
  "code" | "unmetConditions" | "instruction" | "details" | "rationale"
> | null {
  if (input.baseElementVersion === null) {
    return input.requestedParentElementId === undefined
      ? creationParentRequiredRefusal(input.elementId)
      : null;
  }
  if (input.requestedParentElementId === undefined) return null;
  const existing = input.current.find(
    (element) => element.id === input.elementId,
  );
  if (
    existing === undefined ||
    existing.parentElementId === input.requestedParentElementId
  ) {
    return null;
  }
  return parentImmutableRefusal({
    elementId: input.elementId,
    handle: input.handleOf(input.elementId),
    currentParentElementId: existing.parentElementId,
    requestedParentElementId: input.requestedParentElementId,
  });
}

/**
 * Slugs are unique per project; a create for a slug whose spec already has an
 * editable draft is refused rather than silently reused, so the collision
 * surfaces on the very first save (R4.1) instead of merging two intents.
 */
export class SpecSlugTakenError extends Error {
  constructor(
    readonly projectPath: string,
    readonly slug: string,
    readonly existingSpecId: string,
    readonly existingName: string,
  ) {
    super(
      `spec slug "${slug}" already names "${existingName}" (${existingSpecId}) in this project`,
    );
    this.name = "SpecSlugTakenError";
  }
}

/** Every ordinary authoring continuation resolves its base here. */
export function continueOrdinaryAuthoring(
  repo: SpecsRepoTransaction,
  specId: string,
): OrdinaryContinuation {
  return selectOrdinaryContinuation(repo.listRevisions(specId));
}

function requireSpec(
  repo: Pick<SpecsRepoTransaction, "findById">,
  specId: string,
): Spec {
  const spec = repo.findById(specId);
  if (spec === null) {
    throw new SpecDraftUnavailableError(specId);
  }
  return spec;
}

function requireOwnedRevision(
  repo: Pick<SpecsRepoTransaction, "findRevision">,
  specId: string,
  revisionId: string,
): SpecRevision {
  const revision = repo.findRevision(revisionId);
  if (revision === null || revision.specId !== specId) {
    throw new SpecDraftUnavailableError(specId);
  }
  return revision;
}

function currentGuardedElements(
  repo: SpecsRepoTransaction,
  revisionId: string | null,
): GuardedElement[] {
  return guardedElements(
    revisionId === null ? null : repo.getRevisionSnapshot(revisionId),
  );
}

/**
 * The parent a written element ends up with. Containment is fixed at creation
 * — an update carries no parent — so an upsert over an existing element keeps
 * the row's parent rather than whatever the caller happened to send. A create
 * that states none never reaches here: the containment admission refuses it
 * ahead of every staging read, and the null is the total function's answer
 * rather than a default anything can land under.
 */
function stagedParentElementId(
  current: readonly GuardedElement[],
  elementId: string,
  requestedParentElementId: string | null | undefined,
): string | null {
  const existing = current.find((element) => element.id === elementId);
  return existing === undefined
    ? (requestedParentElementId ?? null)
    : existing.parentElementId;
}

/**
 * The parent a create writes. Every create that states none is refused by the
 * containment admission before any write path reaches here, so the null branch
 * is what makes the function total rather than a default an author can land
 * under by omission.
 */
function admittedCreationParentElementId(
  requestedParentElementId: string | null | undefined,
): string | null {
  return requestedParentElementId ?? null;
}

/**
 * The one reference verdict every mutation owner takes: the complete result of
 * the transaction, judged before any of it is allowed to stand.
 */
function stagedReferenceIssues(
  current: readonly GuardedElement[],
  mutations: readonly StagedElementMutation[],
): ReferenceIssue[] {
  return validateStagedWrite(stageRevisionWrite(current, mutations));
}

/**
 * Rolls the batch transaction back while carrying the indexed refusals out:
 * SQLite unwinds on a throw, and the refusals are the answer the caller needs,
 * so they travel on the error rather than in a return value that would commit.
 */
class BatchRefusedError extends Error {
  constructor(readonly refusals: DraftElementBatchRefusal[]) {
    super(`spec batch write refused ${refusals.length} element(s)`);
    this.name = "BatchRefusedError";
  }
}

function batchRefusalFor(
  input: DraftElementBatchInputKind,
  index: number,
  elementId: string,
  error: unknown,
): DraftElementBatchRefusal {
  if (error instanceof StaleElementConflictError) {
    return {
      input,
      index,
      elementId,
      code: "stale_element",
      unmetConditions: [error.message],
      instruction: `Re-read ${elementId} and resubmit the batch with its current element version.`,
      currentElementVersion: error.current.elementVersion,
    };
  }
  if (error instanceof SpecElementIdTakenError) {
    return {
      input,
      index,
      elementId,
      code: "element_id_taken",
      unmetConditions: [error.message],
      instruction:
        'Choose a globally unique element ID, preferably prefixed with the spec slug (for example, "<spec-slug>-<id>"), then resubmit the batch.',
      currentElementVersion: null,
    };
  }
  if (error instanceof SpecHistoricalElementError) {
    const refusal = historicalElementRefusal(error);
    return {
      input,
      index,
      elementId,
      code: refusal.code,
      unmetConditions: refusal.unmetConditions,
      instruction: `${refusal.instruction} Then resubmit the batch.`,
      currentElementVersion: null,
    };
  }
  if (error instanceof SpecRevisionImmutableError) {
    return {
      input,
      index,
      elementId,
      ...immutableRevisionRefusal(error),
      currentElementVersion: null,
    };
  }
  return {
    input,
    index,
    elementId,
    code: "validation",
    unmetConditions: [
      error instanceof Error ? error.message : `Batch element ${index} failed.`,
    ],
    instruction: `Correct element ${index} (${elementId}) and resubmit the batch.`,
    currentElementVersion: null,
  };
}

/**
 * Attributes each dangling reference to the batch entry that caused it: the
 * item that wrote the offending source, or — when the source is an untouched
 * survivor — the removal that took its target away. Grouping by entry keeps
 * the batch contract intact, where every refusal names the input the caller
 * has to change.
 */
function batchDanglingRefusals(
  issues: readonly ReferenceIssue[],
  sourceEntryById: ReadonlyMap<
    string,
    { input: DraftElementBatchInputKind; index: number }
  >,
  removalIndexById: ReadonlyMap<string, number>,
  handleOf: (elementId: string) => string | null,
): DraftElementBatchRefusal[] {
  const grouped = new Map<string, ReferenceIssue[]>();
  const entries = new Map<
    string,
    { input: DraftElementBatchInputKind; index: number; elementId: string }
  >();
  for (const issue of issues) {
    const written = sourceEntryById.get(issue.sourceElementId);
    const removalIndex = removalIndexById.get(issue.targetId);
    const entry =
      written !== undefined
        ? { ...written, elementId: issue.sourceElementId }
        : removalIndex !== undefined
          ? {
              input: "removal" as const,
              index: removalIndex,
              elementId: issue.targetId,
            }
          : {
              input: "element" as const,
              index: -1,
              elementId: issue.sourceElementId,
            };
    const key = `${entry.input}:${entry.index}:${entry.elementId}`;
    entries.set(key, entry);
    grouped.set(key, [...(grouped.get(key) ?? []), issue]);
  }

  return [...grouped].map(([key, groupIssues]) => {
    const entry = entries.get(key);
    const refusal = danglingReferenceRefusal(groupIssues);
    return {
      input: entry?.input ?? "element",
      index: entry?.index ?? -1,
      elementId: entry?.elementId ?? null,
      code: refusal.code,
      unmetConditions: refusal.unmetConditions,
      instruction: refusal.instruction,
      currentElementVersion: null,
      danglingReferences: groupIssues.map((issue) => ({
        ...issue,
        sourceHandle: handleOf(issue.sourceElementId),
        targetHandle: handleOf(issue.targetId),
      })),
    };
  });
}

/**
 * The revision-level token the optional stricter batch mode pins: the
 * revision's canonical content hash, so any committed element change moves it.
 */
function revisionToken(snapshot: SpecRevisionSnapshot): string {
  return computeSpecRevisionContentHash(
    snapshot.revision.authoringStage,
    snapshot.elements,
  );
}

/**
 * Writes one element and returns only its version: handles depend on numbers
 * assigned across the whole batch, and resolving them here would reload and
 * re-parse the entire revision snapshot per element, making an N-element batch
 * quadratic inside the write transaction. The caller resolves them once.
 */
function writeOneElement(
  repo: SpecsRepoTransaction,
  batch: DraftElementBatchInput,
  item: DraftElementInput,
  occurredAt: string,
): { version: SpecElementVersion; revived: boolean } {
  if (item.baseElementVersion === null) {
    const current = repo.findElementVersion(batch.revisionId, item.elementId);
    if (current !== null) {
      throw new StaleElementConflictError(
        batch.revisionId,
        item.elementId,
        0,
        current,
      );
    }
    const created = repo.createDraftElement({
      id: item.elementId,
      specId: batch.specId,
      revisionId: batch.revisionId,
      kind: item.kind,
      parentElementId: admittedCreationParentElementId(item.parentElementId),
      position: item.position,
      payload: item.payload,
      ...(item.reintroduceHistorical === undefined
        ? {}
        : { reintroduceHistorical: item.reintroduceHistorical }),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    return { version: created.version, revived: created.revived };
  }
  return {
    version: repo.updateDraftElement({
      revisionId: batch.revisionId,
      elementId: item.elementId,
      expectedElementVersion: item.baseElementVersion,
      payload: item.payload,
      position: item.position,
      updatedAt: occurredAt,
    }),
    revived: false,
  };
}

/**
 * Handle of an element that was just written, read back from the same
 * in-transaction snapshot so a criterion resolves its parent requirement's
 * number without a second derivation of the grammar.
 */
function writtenElementHandle(
  repo: SpecsRepoTransaction,
  revisionId: string,
  elementId: string,
): string | null {
  const snapshot = repo.getRevisionSnapshot(revisionId);
  return snapshot === null
    ? null
    : elementHandleInSnapshot(snapshot, elementId);
}

/**
 * Files the gate-scoped ask each consulted authoring gate owes after a
 * review request commits (R10.13), and reports what happened per gate.
 *
 * The ask carries no subject on purpose: it is the request a gate with a dozen
 * outstanding subjects can make and the only one that still means the same
 * thing once they are all approved. Its durable identity
 * (`specId, revisionId, gate, scope: "gate"`) dedupes a second ask onto the
 * one still open under that identity rather than opening a second row, so an
 * author who asks again for review of the same draft lands on the open ask.
 *
 * Nothing here can fail the review request. A filing failure and a delivery
 * failure are reported apart because only the second leaves a durable request
 * behind, and `request-approval` repairs one but files the other.
 */
async function fileProposalApprovalRequests(
  port: ApprovalRequestPort | undefined,
  input: {
    specId: string;
    revisionId: string;
    actor: ActorProvenance;
    gateAsk: ProposalGateAsk;
  },
): Promise<SpecProposeApprovalRequest[]> {
  const notNeeded = (gate: AuthoringGate): SpecProposeApprovalRequest => ({
    gate,
    outcome: "not-needed",
    attentionId: null,
  });
  const outcomes: SpecProposeApprovalRequest[] = [];
  for (const gate of input.gateAsk.consulted) {
    if (input.gateAsk.collapsed || !input.gateAsk.pending.has(gate)) {
      outcomes.push(notNeeded(gate));
      continue;
    }
    if (port === undefined) {
      outcomes.push({ gate, outcome: "not-filed", attentionId: null });
      continue;
    }
    try {
      const filed = await port.requestApproval({
        specId: input.specId,
        revisionId: input.revisionId,
        gate,
        actor: input.actor,
      });
      if (!filed.ok) {
        // A gate the request validator calls satisfied owes no ask; every
        // other refusal leaves the gate blocking with nothing filed for it.
        outcomes.push(
          filed.refusal.code === "already_satisfied"
            ? notNeeded(gate)
            : { gate, outcome: "not-filed", attentionId: null },
        );
        logger.warn("specs.authoring.propose_approval_request_refused", {
          specId: input.specId,
          revisionId: input.revisionId,
          gate,
          refusalCode: filed.refusal.code,
        });
        continue;
      }
      outcomes.push({
        gate,
        outcome:
          filed.value.deliveryOutcome === "delivery-uncertain"
            ? "delivery-uncertain"
            : filed.value.alreadyRequested
              ? "already-filed"
              : "filed",
        attentionId: filed.value.attentionId,
      });
    } catch (error) {
      logger.warn("specs.authoring.propose_approval_request_failed", {
        specId: input.specId,
        revisionId: input.revisionId,
        gate,
        error: error instanceof Error ? error.message : String(error),
      });
      outcomes.push({ gate, outcome: "not-filed", attentionId: null });
    }
  }
  return outcomes;
}

export function createAuthoringService(
  deps: AuthoringServiceDeps,
): AuthoringService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());

  /**
   * `revivedElementIds` travels on every write that brought a historical
   * identity back, whatever act carried it: a batch is still a batch and a
   * first save still opens an amendment, so the revival cannot be read off the
   * event kind alone. Without it the durable log cannot tell a later reader
   * that content a review had ended was re-opened.
   */
  function appendDraftEvent(
    spec: Spec,
    revisionId: string,
    elementIds: string[] | undefined,
    actor: CreateAuthoringSpecInput["actor"],
    occurredAt: string,
    kind: string,
    revivedElementIds: readonly string[] = [],
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-changed",
      durablePayload: {
        kind,
        revisionId,
        ...(elementIds === undefined ? {} : { elementIds }),
        ...(revivedElementIds.length === 0
          ? {}
          : { revivedElementIds: [...revivedElementIds] }),
      },
      sseEvent: {
        type: "spec-changed",
        kind: elementIds === undefined ? "draft-opened" : "content-changed",
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
        ...(elementIds === undefined ? {} : { elementIds }),
      },
    });
  }

  function appendRevisionEvent(
    spec: Spec,
    revisionId: string,
    actor: ActorProvenance,
    occurredAt: string,
    kind: string,
    measureEvents: SpecMeasureEventPayload[] = [],
    /**
     * The proposal's disposition document, on the propose event alone. Omitted
     * rather than written as null when there is none, so a payload written
     * before notes existed and one written without them are the same bytes
     * (`proposal-notes.ts`).
     */
    notes?: string,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-revision-changed",
      durablePayload: {
        kind,
        revisionId,
        ...(notes === undefined ? {} : { notes }),
        ...(measureEvents.length === 0 ? {} : { measureEvents }),
      },
      sseEvent: {
        type: "spec-revision-changed",
        kind,
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
      },
    });
  }

  function publish(prepared: PreparedSpecEventPublication | null): void {
    if (prepared !== null) deps.events.publishAfterCommit(prepared);
  }

  function writeDecision(
    spec: Spec,
    revision: SpecRevision,
    elementKind: SpecElementKind,
    payload: SpecElementPayload,
  ) {
    return admitDraftWrite(
      revision.authoringStage,
      elementKind,
      payload.kind === "section" ? payload.role : undefined,
      resolveAuthoringDials(spec.gatePolicy),
    );
  }

  function requireDraftRevision(revision: SpecRevision): void {
    if (revision.state === "draft") return;
    throw new SpecRevisionImmutableError(
      revision.id,
      revision.number,
      revision.state,
    );
  }

  function appendWriteIntervention(
    specId: string,
    revisionId: string,
    elementId: string,
    actor: ActorProvenance,
    occurredAt: string,
    refusal: TransitionRefusal,
  ): void {
    deps.events.appendDurableInTransaction({
      specId,
      occurredAt,
      actor,
      durableEventType: "spec-intervention-recorded",
      durablePayload: {
        kind: "draft-write-refused",
        revisionId,
        elementId,
        refusal,
      },
    });
  }

  return {
    async createSpec(input) {
      const parsed = createAuthoringSpecInputSchema.parse(input);
      const occurredAt = now();
      const initialStage = openDraftAuthoringStage({
        policy: parsed.gatePolicy,
      });
      const initialDecision = admitDraftWrite(
        initialStage,
        parsed.initialElement.kind,
        parsed.initialElement.payload.kind === "section"
          ? parsed.initialElement.payload.role
          : undefined,
        resolveAuthoringDials(parsed.gatePolicy),
      );

      function writeInitialElement(
        repo: SpecsRepoTransaction,
        specId: string,
        revisionId: string,
      ): DraftElementWriteResult {
        const current = repo.findElementVersion(
          revisionId,
          parsed.initialElement.elementId,
        );
        if (current !== null) {
          throw new StaleElementConflictError(
            revisionId,
            parsed.initialElement.elementId,
            0,
            current,
          );
        }
        const written = repo.createDraftElement({
          id: parsed.initialElement.elementId,
          specId,
          revisionId,
          kind: parsed.initialElement.kind,
          parentElementId: parsed.initialElement.parentElementId,
          position: parsed.initialElement.position,
          payload: parsed.initialElement.payload,
          ...(parsed.initialElement.reintroduceHistorical === undefined
            ? {}
            : {
                reintroduceHistorical:
                  parsed.initialElement.reintroduceHistorical,
              }),
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        return {
          ...written,
          handle: writtenElementHandle(repo, revisionId, written.element.id),
        };
      }

      /**
       * The first save is one transaction like any other: spec, revision and
       * element stand or fall together, so a reference the revision could not
       * resolve refuses before any of the three exists.
       */
      function guardInitialElement(
        repo: SpecsRepoTransaction,
        baseRevisionId: string | null,
      ): void {
        const current = currentGuardedElements(repo, baseRevisionId);
        const issues = stagedReferenceIssues(current, [
          {
            op: "write",
            elementId: parsed.initialElement.elementId,
            payload: parsed.initialElement.payload,
            parentElementId: stagedParentElementId(
              current,
              parsed.initialElement.elementId,
              parsed.initialElement.parentElementId,
            ),
          },
        ]);
        if (issues.length > 0) {
          throw new StageBlockedWriteError(danglingReferenceRefusal(issues));
        }
      }

      const result = await deps.specs.transaction(
        "specs.authoring.create",
        (repo) => {
          const existing = repo.resolve(parsed.projectPath, parsed.slug);
          if (existing !== null) {
            // A create that lands on a spec with an editable draft is a slug
            // collision, diagnosed before any continuation decision: the
            // caller asked for a new spec, so it needs the colliding spec's
            // identity and the option of another slug rather than the recovery
            // for continuing this spec's authoring line.
            if (repo.findDraft(existing.id) !== null) {
              throw new SpecSlugTakenError(
                parsed.projectPath,
                parsed.slug,
                existing.id,
                existing.name,
              );
            }
            // With no draft to collide with, the create continues the spec as
            // an amendment of its approved revision.
            const continuation = continueOrdinaryAuthoring(repo, existing.id);
            if (continuation.kind !== "clone_approved") {
              throw new SpecDraftUnavailableError(existing.id);
            }

            const approved = continuation.approved;
            const amendmentStage = openDraftAuthoringStage({
              policy: existing.gatePolicy,
              baseRevision: {
                state: "approved",
                authoringStage: approved.authoringStage,
              },
            });
            const amendmentDecision = admitDraftWrite(
              amendmentStage,
              parsed.initialElement.kind,
              parsed.initialElement.payload.kind === "section"
                ? parsed.initialElement.payload.role
                : undefined,
              resolveAuthoringDials(existing.gatePolicy),
            );
            if (!amendmentDecision.ok) {
              appendWriteIntervention(
                existing.id,
                approved.id,
                parsed.initialElement.elementId,
                parsed.actor,
                occurredAt,
                amendmentDecision.refusal,
              );
              return {
                ok: false as const,
                refusal: amendmentDecision.refusal,
              };
            }
            // The amendment inherits the approved revision's content, so that
            // is the snapshot the first element of the amendment is judged in.
            guardInitialElement(repo, approved.id);
            const amendment = repo.createDraftFromBase({
              id: newId("revision"),
              specId: existing.id,
              baseRevisionId: approved.id,
              authoringStage: amendmentStage,
              createdAt: occurredAt,
            });
            const written = writeInitialElement(
              repo,
              existing.id,
              amendment.id,
            );
            return {
              ok: true as const,
              value: {
                spec: existing,
                draft: amendment,
                element: written.element,
                version: written.version,
                revived: written.revived,
                handle: written.handle,
              },
              prepared: appendDraftEvent(
                existing,
                amendment.id,
                [parsed.initialElement.elementId],
                parsed.actor,
                occurredAt,
                "amendment-opened",
                written.revived ? [parsed.initialElement.elementId] : [],
              ),
            };
          }

          if (!initialDecision.ok) {
            throw new StageBlockedWriteError(initialDecision.refusal);
          }
          guardInitialElement(repo, null);

          // Spec, draft revision, and first element share one transaction and
          // one timestamp: the durable object is born from this first save.
          const created = repo.create({
            spec: {
              id: newId("spec"),
              projectPath: parsed.projectPath,
              slug: parsed.slug,
              name: parsed.name,
              gatePolicy: parsed.gatePolicy,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
            initialRevision: {
              id: newId("revision"),
              authoringStage: initialStage,
              createdAt: occurredAt,
            },
          });
          const written = writeInitialElement(
            repo,
            created.spec.id,
            created.revision.id,
          );
          return {
            ok: true as const,
            value: {
              spec: created.spec,
              draft: created.revision,
              element: written.element,
              version: written.version,
              revived: written.revived,
              handle: written.handle,
            },
            prepared: appendDraftEvent(
              created.spec,
              created.revision.id,
              [parsed.initialElement.elementId],
              parsed.actor,
              occurredAt,
              "spec-created",
            ),
          };
        },
      );
      if (!result.ok) {
        logger.warn("specs.authoring.create.stage_refused", {
          projectPath: parsed.projectPath,
          slug: parsed.slug,
          refusalCode: result.refusal.code,
        });
        throw new StageBlockedWriteError(result.refusal);
      }
      publish(result.prepared);
      logger.info("specs.authoring.create.complete", {
        specId: result.value.spec.id,
        revisionId: result.value.draft.id,
        elementId: result.value.element.id,
      });
      return result.value;
    },

    getSpec(projectPath, slug) {
      return deps.specs.resolve(projectPath, slug);
    },

    getRevisionSnapshot(revisionId) {
      return deps.specs.getRevisionSnapshot(revisionId);
    },

    async lintDraft(specId, revisionId) {
      // Reads only, so it takes the read seam: two GET paths call this (the
      // status projection and the lint endpoint), and a write-queue admission
      // would make them queue behind — and hold up — real writers.
      return deps.specs.readOutsideWriteQueue(
        "specs.authoring.lint-draft",
        (repo) => {
          const spec = requireSpec(repo, specId);
          requireOwnedRevision(repo, specId, revisionId);
          const snapshot = repo.getRevisionSnapshot(revisionId);
          if (snapshot === null) throw new SpecDraftUnavailableError(specId);
          const loaded = loadProposalState(
            repo,
            deps.review,
            deps.links,
            spec,
            snapshot,
          );
          return lint(loaded.draft, loaded.records);
        },
      );
    },

    async proposeRevision(input) {
      const parsed = proposeAuthoringRevisionInputSchema.parse(input);
      const occurredAt = now();
      const transactionResult = await deps.specs.transaction(
        "specs.authoring.propose-revision",
        (repo) => {
          // Before every other check, and before any write: an over-cap
          // disposition document must leave no propose event behind, and the
          // cheapest way to guarantee that is to answer it from the input.
          const oversized =
            parsed.notes === undefined
              ? null
              : oversizedProposalNotesRefusal(parsed.notes);
          if (oversized !== null) {
            return {
              result: {
                ok: false,
                refusal: oversized,
              } satisfies ProposeTransitionResult,
              prepared: [] as PreparedSpecEventPublication[],
              policyNotices: [] as SpecPolicyAdmissionNotice[],
              gateAsk: null,
              endedAttentionIds: [] as string[],
            };
          }
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          const snapshot = repo.getRevisionSnapshot(revision.id);
          if (snapshot === null) {
            throw new SpecDraftUnavailableError(parsed.specId);
          }
          const loaded = loadProposalState(
            repo,
            deps.review,
            deps.links,
            spec,
            snapshot,
          );
          const panelFindings = lint(loaded.draft, loaded.records);
          const decision = propose({
            revisionState: revision.state,
            authoringStage: revision.authoringStage,
            policy: spec.gatePolicy,
            draft: loaded.draft,
            records: loaded.records,
            review: loaded.reviewSnapshot,
            approvalApplies: loaded.approvalApplies,
          });
          const blocksPropose =
            !decision.ok &&
            draftHealth(decision.refusal.findings ?? []).blocking > 0;
          if (revision.state !== "draft" || blocksPropose) {
            const refusal = decision.ok
              ? {
                  code: "gate_blocked" as const,
                  unmetConditions: ["Only a draft revision can be proposed."],
                  instruction:
                    "Open or reuse a draft revision before proposing it.",
                }
              : decision.refusal;
            return {
              result: { ok: false, refusal } satisfies ProposeTransitionResult,
              prepared: [] as PreparedSpecEventPublication[],
              policyNotices: [] as SpecPolicyAdmissionNotice[],
              gateAsk: null,
              endedAttentionIds: [] as string[],
            };
          }

          const baseRows =
            loaded.reviewBaseSnapshot === null
              ? []
              : toDiffRows(loaded.reviewBaseSnapshot);
          const diff = diffRevisions(
            baseRows,
            toDiffRows(snapshot),
            toCitationDiffContext(loaded.reviewBaseSnapshot, snapshot),
          );
          const changedIntentElementIds = diff.classifications
            .filter(
              ({ kind, classification }) =>
                (kind === "requirement" || kind === "criterion") &&
                classification !== "unchanged",
            )
            .map(({ elementId }) => elementId)
            .sort();
          const revisionMeasureEvents: SpecMeasureEventPayload[] =
            loaded.reviewBaseSnapshot?.revision.state === "approved"
              ? [
                  {
                    kind: "post-approval-revision-created",
                    revisionId: revision.id,
                    nonTrivial: diff.changeList.length > 0,
                    changedIntentElementIds,
                  },
                ]
              : [];

          const proposeGates = consultedAuthoringGates(
            revision.authoringStage,
            loaded.reviewSnapshot.governanceBaseRevisionRows,
            loaded.reviewSnapshot.revisionRows,
            {
              baseCitationContractVersion:
                loaded.reviewSnapshot.governanceBaseCitationState
                  .citationContractVersion,
              draftCitationContractVersion:
                loaded.reviewSnapshot.citationContractVersion,
              baseCitations:
                loaded.reviewSnapshot.governanceBaseCitationState.citations,
              draftCitations: loaded.reviewSnapshot.citations,
            },
          );
          const resolvedGates = proposeGates.map((gate) => ({
            gate,
            dial: resolveDial(spec.gatePolicy, gate),
          }));
          // Every consulted gate is Notify or Off, so no human act follows and
          // the review request freezes the draft itself. Its preconditions are
          // the sign-off's, which `propose` already refused on; nothing is
          // written unless they hold.
          const absorbsSignOff = resolvedGates.every(
            ({ dial }) => dial === "notify" || dial === "off",
          );
          if (!decision.ok) {
            // The refusal carries the sign-off's conditions, but here the
            // author froze nothing and its next act is another propose.
            return {
              result: {
                ok: false,
                refusal: {
                  ...decision.refusal,
                  instruction: `Nothing was frozen. Resolve the conditions above in the draft, then run \`cctl spec propose ${spec.slug}\` again.`,
                },
              } satisfies ProposeTransitionResult,
              prepared: [] as PreparedSpecEventPublication[],
              policyNotices: [] as SpecPolicyAdmissionNotice[],
              gateAsk: null,
              endedAttentionIds: [] as string[],
            };
          }
          let current = revision;
          const policyNotices: SpecPolicyAdmissionNotice[] = [];
          const stalePrepared: PreparedSpecEventPublication[] = [];
          const endedRequests = absorbsSignOff
            ? openAuthoringRequestsForRevision(
                deps.attention.listOpenApprovalRequests(spec.id),
                revision.id,
              )
            : [];
          if (absorbsSignOff) {
            current = repo.approveRevision({
              revisionId: revision.id,
              approvedAt: occurredAt,
            });
            stalePrepared.push(
              ...endedRequests.map((request) =>
                prepareApprovalRequestRetirement(deps.events, {
                  spec,
                  actor: parsed.actor,
                  occurredAt,
                  attentionId: request.attentionId,
                  reason: FROZEN_BY_POLICY_REASON,
                }),
              ),
            );
            for (const { gate, dial } of resolvedGates) {
              const admissionId = newId("admission");
              deps.review.insertGateAdmission({
                id: admissionId,
                spec_id: spec.id,
                gate,
                basis: dial === "notify" ? "notify_policy" : "off_policy",
                approval_id: null,
                revision_id: revision.id,
                execution_id: null,
                actor_json: stableStringify(parsed.actor),
                created_at: occurredAt,
              });
              if (dial === "notify") {
                // R11.2: the transition proceeded under Notify — surface the
                // admission to the human post hoc (never a Needs You request).
                policyNotices.push({
                  specId: spec.id,
                  specSlug: spec.slug,
                  specName: spec.name,
                  projectPath: spec.projectPath,
                  gate,
                  basis: "notify_policy",
                  admissionId,
                  revisionId: revision.id,
                  executionId: null,
                  occurredAt,
                });
              }
            }
            if (deps.waivers !== undefined) {
              stalePrepared.push(
                ...markWaiversStaleAtSignOffInTransaction({
                  spec,
                  approvedRevisionId: revision.id,
                  getSnapshot: (targetRevisionId) =>
                    repo.getRevisionSnapshot(targetRevisionId),
                  waivers: deps.waivers,
                  events: deps.events,
                  actor: parsed.actor,
                  occurredAt,
                }),
              );
            }
          }

          // Read after the Notify/Off admissions land, so the receipt states
          // the position the caller is actually in.
          const projection = authoringReviewProjection({
            policy: spec.gatePolicy,
            snapshot: { ...snapshot, revision: current },
            governanceBaseSnapshot: loaded.governanceBaseSnapshot,
            importBaselineRows: loaded.importBaselineRows,
            importBaselineCitationState: loaded.importBaselineCitationState,
            approvals: deps.review.findApprovalsBySpecId(spec.id),
            admissions: deps.review.findGateAdmissionsByRevision(revision.id),
            // A propose speaks for the authoring gates; the execution-scoped
            // ones are per-run and no run exists at this transition.
            currentExecution: null,
            revisionNumberById: new Map(
              repo
                .listRevisions(spec.id)
                .map((candidate) => [candidate.id, candidate.number]),
            ),
            applies: loaded.approvalApplies,
            blockingThreads: loaded.reviewSnapshot.blockingThreads,
            signOffFindings: panelFindings.filter(
              (finding) => finding.severity !== "advisory",
            ),
          });

          const prepared = [
            appendRevisionEvent(
              spec,
              revision.id,
              parsed.actor,
              occurredAt,
              absorbsSignOff ? "approved" : "proposed",
              absorbsSignOff
                ? [
                    ...revisionMeasureEvents,
                    {
                      kind: "review-action",
                      action: "sign_off",
                      reviewAttemptId: revision.id,
                      activeStartedAt: occurredAt,
                      revisionId: revision.id,
                    },
                  ]
                : revisionMeasureEvents,
              parsed.notes,
            ),
            ...stalePrepared,
          ];
          return {
            result: {
              ok: true,
              revision: current,
              diff,
              absorbedSignOff: absorbsSignOff,
              pendingBlock: projection.pendingBlock,
              nextAction: projection.nextAction,
              approvalLedger: projection.approvalLedger,
            } satisfies ProposeTransitionResult,
            prepared,
            policyNotices,
            gateAsk: absorbsSignOff
              ? null
              : ({
                  consulted: proposeGates,
                  pending: new Set(
                    (projection.pendingBlock?.gates ?? [])
                      .filter((entry) => entry.state === "pending")
                      .map((entry) => entry.gate)
                      .filter(isAuthoringGate),
                  ),
                  collapsed: authoringApprovalsCollapseIntoSignOff(
                    spec.gatePolicy,
                    revision.authoringStage,
                  ),
                } satisfies ProposalGateAsk),
            endedAttentionIds: endedRequests.map(
              (request) => request.attentionId,
            ),
          };
        },
      );
      for (const prepared of transactionResult.prepared) publish(prepared);
      // Announcement work: the retirements are durable, so a notifier failure
      // leaves a stale queue row behind and is logged, never charged back to
      // the caller whose propose did land.
      if (transactionResult.endedAttentionIds.length > 0) {
        try {
          deps.notifier?.approvalRequestsClosed({
            specId: parsed.specId,
            attentionIds: transactionResult.endedAttentionIds,
            reason: FROZEN_BY_POLICY_REASON,
            occurredAt,
          });
        } catch (error) {
          logger.warn(
            "specs.authoring.propose_revision.requests_closed_notify_failed",
            {
              specId: parsed.specId,
              revisionId: parsed.revisionId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      for (const notice of transactionResult.policyNotices) {
        try {
          deps.policyNotifier?.policyAdmitted(notice);
        } catch {
          logger.warn(
            "specs.authoring.propose_revision.policy_notification_failed",
            {
              specId: notice.specId,
              revisionId: notice.revisionId,
              gate: notice.gate,
              admissionId: notice.admissionId,
            },
          );
        }
      }
      const transition = transactionResult.result;
      const approvalRequests =
        transition.ok && transactionResult.gateAsk !== null
          ? await fileProposalApprovalRequests(deps.approvalRequests, {
              specId: parsed.specId,
              revisionId: parsed.revisionId,
              actor: parsed.actor,
              gateAsk: transactionResult.gateAsk,
            })
          : [];
      logger.info("specs.authoring.propose_revision.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        ok: transition.ok,
        ...(transition.ok
          ? {
              state: transition.revision.state,
              absorbedSignOff: transition.absorbedSignOff,
              approvalRequests: approvalRequests.map(
                ({ gate, outcome }) => `${gate}:${outcome}`,
              ),
            }
          : { refusalCode: transition.refusal.code }),
      });
      return transition.ok ? { ...transition, approvalRequests } : transition;
    },

    async upsertDraftElement(input) {
      const parsed = draftElementWriteInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.upsert-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          requireDraftRevision(revision);
          const decision = writeDecision(
            spec,
            revision,
            parsed.kind,
            parsed.payload,
          );
          if (!decision.ok) {
            appendWriteIntervention(
              spec.id,
              revision.id,
              parsed.elementId,
              parsed.actor,
              occurredAt,
              decision.refusal,
            );
            return { ok: false as const, refusal: decision.refusal };
          }

          const before = repo.getRevisionSnapshot(parsed.revisionId);
          const staged = guardedElements(before);
          // Judged on the input itself, before the write is staged against
          // anything: `stagedParentElementId` below would quietly substitute
          // the stored parent, which is exactly the silent no-op this refusal
          // replaces.
          const containment = elementContainmentRefusal({
            current: staged,
            elementId: parsed.elementId,
            requestedParentElementId: parsed.parentElementId,
            baseElementVersion: parsed.baseElementVersion,
            handleOf: (elementId) =>
              before === null
                ? null
                : elementHandleInSnapshot(before, elementId),
          });
          if (containment !== null) {
            appendWriteIntervention(
              spec.id,
              revision.id,
              parsed.elementId,
              parsed.actor,
              occurredAt,
              containment,
            );
            return { ok: false as const, refusal: containment };
          }

          const referenceIssues = stagedReferenceIssues(staged, [
            {
              op: "write",
              elementId: parsed.elementId,
              payload: parsed.payload,
              parentElementId: stagedParentElementId(
                staged,
                parsed.elementId,
                parsed.parentElementId,
              ),
            },
          ]);
          if (referenceIssues.length > 0) {
            const refusal = danglingReferenceRefusal(referenceIssues);
            appendWriteIntervention(
              spec.id,
              revision.id,
              parsed.elementId,
              parsed.actor,
              occurredAt,
              refusal,
            );
            return { ok: false as const, refusal };
          }

          const current = repo.findElementVersion(
            parsed.revisionId,
            parsed.elementId,
          );

          let version: SpecElementVersion;
          let revived = false;
          if (parsed.baseElementVersion === null) {
            if (current !== null) {
              throw new StaleElementConflictError(
                parsed.revisionId,
                parsed.elementId,
                0,
                current,
              );
            }
            const created = repo.createDraftElement({
              id: parsed.elementId,
              specId: parsed.specId,
              revisionId: parsed.revisionId,
              kind: parsed.kind,
              parentElementId: admittedCreationParentElementId(
                parsed.parentElementId,
              ),
              position: parsed.position,
              payload: parsed.payload,
              ...(parsed.reintroduceHistorical === undefined
                ? {}
                : { reintroduceHistorical: parsed.reintroduceHistorical }),
              createdAt: occurredAt,
              updatedAt: occurredAt,
            });
            version = created.version;
            revived = created.revived;
          } else {
            version = repo.updateDraftElement({
              revisionId: parsed.revisionId,
              elementId: parsed.elementId,
              expectedElementVersion: parsed.baseElementVersion,
              payload: parsed.payload,
              position: parsed.position,
              updatedAt: occurredAt,
            });
          }
          // One post-write snapshot serves both the written row and its
          // handle, so a criterion resolves its parent requirement's number
          // from the same committed state the write produced.
          const snapshot = repo.getRevisionSnapshot(parsed.revisionId);
          const element = snapshot?.elements.find(
            ({ element: candidate }) => candidate.id === parsed.elementId,
          )?.element;
          if (snapshot === null || element === undefined) {
            throw new SpecDraftUnavailableError(parsed.specId);
          }
          const written: DraftElementWriteResult = {
            element,
            version,
            revived,
            handle: elementHandleInSnapshot(snapshot, parsed.elementId),
          };

          return {
            ok: true as const,
            value: written,
            prepared: appendDraftEvent(
              spec,
              parsed.revisionId,
              [parsed.elementId],
              parsed.actor,
              occurredAt,
              // A revival is its own act in the durable record: the element is
              // new to this revision but not to the spec, so neither "created"
              // nor "updated" describes what a reader is looking at.
              revived
                ? "draft-element-reintroduced"
                : current === null
                  ? "draft-element-created"
                  : "draft-element-updated",
              revived ? [parsed.elementId] : [],
            ),
          };
        },
      );
      if (!result.ok) {
        logger.warn("specs.authoring.upsert_element.stage_refused", {
          specId: parsed.specId,
          revisionId: parsed.revisionId,
          elementId: parsed.elementId,
          elementKind: parsed.kind,
          refusalCode: result.refusal.code,
        });
        throw new StageBlockedWriteError(result.refusal);
      }
      publish(result.prepared);
      logger.info("specs.authoring.upsert_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
        elementVersion: result.value.version.elementVersion,
        revived: result.value.revived,
      });
      return result.value;
    },

    async readRevisionToken(revisionId) {
      const snapshot = await deps.specs.getRevisionSnapshot(revisionId);
      return snapshot === null ? null : revisionToken(snapshot);
    },

    async upsertDraftElements(input) {
      const parsed = draftElementBatchInputSchema.parse(input);
      const occurredAt = now();
      let transaction: {
        result: DraftElementBatchResult;
        prepared: PreparedSpecEventPublication;
      };
      const blockedWrites: Array<{
        elementId: string;
        refusal: TransitionRefusal;
      }> = [];
      try {
        transaction = await deps.specs.transaction(
          "specs.authoring.upsert-elements",
          (repo) => {
            const spec = requireSpec(repo, parsed.specId);
            const revision = requireOwnedRevision(
              repo,
              parsed.specId,
              parsed.revisionId,
            );
            if (revision.state !== "draft") {
              const immutable = new SpecRevisionImmutableError(
                revision.id,
                revision.number,
                revision.state,
              );
              throw new BatchRefusedError([
                ...parsed.elements.map((item, index) =>
                  batchRefusalFor("element", index, item.elementId, immutable),
                ),
                ...(parsed.removals ?? []).map((item, index) =>
                  batchRefusalFor("removal", index, item.elementId, immutable),
                ),
              ]);
            }
            const before = repo.getRevisionSnapshot(revision.id);
            if (parsed.expectedRevisionToken !== undefined) {
              const actual = before === null ? null : revisionToken(before);
              if (actual !== parsed.expectedRevisionToken) {
                throw new BatchRefusedError([
                  {
                    input: "revision",
                    index: -1,
                    elementId: null,
                    code: "stale_revision",
                    unmetConditions: [
                      `Revision ${revision.id} changed since the supplied token was read.`,
                    ],
                    instruction:
                      "Re-read the revision token and resubmit the batch.",
                    currentElementVersion: null,
                  },
                ]);
              }
            }
            const staged = before === null ? [] : guardedElements(before);
            const removals = parsed.removals ?? [];

            const landed: {
              index: number;
              elementId: string;
              version: SpecElementVersion;
              revived: boolean;
            }[] = [];
            const refusals: DraftElementBatchRefusal[] = [];
            // Writing and removing the same id in one batch has no result the
            // caller can be handed: the removal takes the write straight back
            // out, so the batch would have to answer with an element the
            // revision does not carry. Named as the contradiction it is.
            const writtenIds = new Set(
              parsed.elements.map((item) => item.elementId),
            );
            removals.forEach((removal, index) => {
              if (!writtenIds.has(removal.elementId)) return;
              refusals.push({
                input: "removal",
                index,
                elementId: removal.elementId,
                code: "validation",
                unmetConditions: [
                  `${removal.elementId} is both written and removed by this batch.`,
                ],
                instruction: `Drop ${removal.elementId} from either the elements or the removals array and resubmit the batch.`,
                currentElementVersion: null,
              });
            });
            parsed.elements.forEach((item, index) => {
              const decision = writeDecision(
                spec,
                revision,
                item.kind,
                item.payload,
              );
              if (!decision.ok) {
                // Recorded after this transaction unwinds, not here: the
                // intervention is the durable trace of the refusal, and a row
                // written inside the batch dies with the rollback that keeps
                // the element writes atomic.
                blockedWrites.push({
                  elementId: item.elementId,
                  refusal: decision.refusal,
                });
                refusals.push({
                  input: "element",
                  index,
                  elementId: item.elementId,
                  code: decision.refusal.code,
                  unmetConditions: decision.refusal.unmetConditions,
                  instruction: decision.refusal.instruction,
                  currentElementVersion: null,
                  ...(decision.refusal.rationale === undefined
                    ? {}
                    : { rationale: decision.refusal.rationale }),
                  ...(decision.refusal.details === undefined
                    ? {}
                    : { details: decision.refusal.details }),
                });
                return;
              }
              const containment = elementContainmentRefusal({
                current: staged,
                elementId: item.elementId,
                requestedParentElementId: item.parentElementId,
                baseElementVersion: item.baseElementVersion,
                handleOf: (elementId) =>
                  before === null
                    ? null
                    : elementHandleInSnapshot(before, elementId),
              });
              if (containment !== null) {
                blockedWrites.push({
                  elementId: item.elementId,
                  refusal: containment,
                });
                refusals.push({
                  input: "element",
                  index,
                  elementId: item.elementId,
                  code: containment.code,
                  unmetConditions: containment.unmetConditions,
                  instruction: containment.instruction,
                  currentElementVersion: null,
                  rationale: containment.rationale,
                  details: containment.details,
                });
                return;
              }
              try {
                landed.push({
                  index,
                  elementId: item.elementId,
                  ...writeOneElement(repo, parsed, item, occurredAt),
                });
              } catch (error) {
                // Every element is attempted so one bad version does not hide
                // the next; the whole batch is rolled back below regardless.
                refusals.push(
                  batchRefusalFor("element", index, item.elementId, error),
                );
              }
            });

            removals.forEach((removal, index) => {
              const target = before?.elements.find(
                ({ element }) => element.id === removal.elementId,
              );
              if (target !== undefined) {
                const decision = writeDecision(
                  spec,
                  revision,
                  target.element.kind,
                  target.version.payload,
                );
                if (!decision.ok) {
                  blockedWrites.push({
                    elementId: removal.elementId,
                    refusal: decision.refusal,
                  });
                  refusals.push({
                    input: "removal",
                    index,
                    elementId: removal.elementId,
                    code: decision.refusal.code,
                    unmetConditions: decision.refusal.unmetConditions,
                    instruction: decision.refusal.instruction,
                    currentElementVersion: null,
                    ...(decision.refusal.rationale === undefined
                      ? {}
                      : { rationale: decision.refusal.rationale }),
                    ...(decision.refusal.details === undefined
                      ? {}
                      : { details: decision.refusal.details }),
                  });
                  return;
                }
              }
              try {
                repo.removeDraftElement({
                  revisionId: parsed.revisionId,
                  elementId: removal.elementId,
                  expectedElementVersion: removal.baseElementVersion,
                });
              } catch (error) {
                refusals.push(
                  batchRefusalFor("removal", index, removal.elementId, error),
                );
              }
            });

            // Judged against the result of the whole batch rather than each
            // item as it lands, so a task written before the criterion it
            // covers is legal and a target may leave alongside its last
            // referent.
            refusals.push(
              ...batchDanglingRefusals(
                stagedReferenceIssues(staged, [
                  ...parsed.elements.map(
                    (item): StagedElementMutation => ({
                      op: "write",
                      elementId: item.elementId,
                      payload: item.payload,
                      parentElementId: stagedParentElementId(
                        staged,
                        item.elementId,
                        item.parentElementId,
                      ),
                    }),
                  ),
                  ...removals.map(
                    (removal): StagedElementMutation => ({
                      op: "remove",
                      elementId: removal.elementId,
                    }),
                  ),
                ]),
                new Map(
                  parsed.elements.map((item, index) => [
                    item.elementId,
                    { input: "element" as const, index },
                  ]),
                ),
                new Map(
                  removals.map((removal, index) => [removal.elementId, index]),
                ),
                (elementId) =>
                  before === null
                    ? null
                    : elementHandleInSnapshot(before, elementId),
              ),
            );

            if (refusals.length > 0) throw new BatchRefusedError(refusals);

            // One snapshot for the whole batch, read after every write so the
            // numbers each handle derives from are final.
            const snapshot = repo.getRevisionSnapshot(revision.id);
            if (snapshot === null) {
              throw new SpecDraftUnavailableError(parsed.specId);
            }
            const elementsById = new Map(
              snapshot.elements.map(({ element }) => [element.id, element]),
            );
            const written: DraftElementBatchEntry[] = landed.map((entry) => {
              const element = elementsById.get(entry.elementId);
              if (element === undefined) {
                throw new SpecDraftUnavailableError(parsed.specId);
              }
              return {
                index: entry.index,
                elementId: entry.elementId,
                element,
                version: entry.version,
                revived: entry.revived,
                handle: elementHandleInSnapshot(snapshot, entry.elementId),
              };
            });
            return {
              result: {
                ok: true as const,
                revisionId: revision.id,
                written,
              },
              prepared: appendDraftEvent(
                spec,
                revision.id,
                [
                  ...parsed.elements.map((item) => item.elementId),
                  ...removals.map((removal) => removal.elementId),
                ],
                parsed.actor,
                occurredAt,
                "draft-elements-written",
                written
                  .filter((entry) => entry.revived)
                  .map((entry) => entry.elementId),
              ),
            };
          },
        );
      } catch (error) {
        if (!(error instanceof BatchRefusedError)) throw error;
        // Same ordering the single-element path uses: the intervention is
        // committed before the refusal reaches the caller. It takes a second
        // transaction here only because the first one had to unwind.
        if (blockedWrites.length > 0) {
          await deps.specs.transaction(
            "specs.authoring.upsert-elements.interventions",
            () => {
              for (const blocked of blockedWrites) {
                appendWriteIntervention(
                  parsed.specId,
                  parsed.revisionId,
                  blocked.elementId,
                  parsed.actor,
                  occurredAt,
                  blocked.refusal,
                );
              }
            },
          );
        }
        logger.warn("specs.authoring.upsert_elements.refused", {
          specId: parsed.specId,
          revisionId: parsed.revisionId,
          elementCount: parsed.elements.length,
          refusalCodes: error.refusals.map((refusal) => refusal.code),
        });
        return { ok: false, refusals: error.refusals };
      }
      publish(transaction.prepared);
      logger.info("specs.authoring.upsert_elements.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementCount: parsed.elements.length,
      });
      return transaction.result;
    },

    async advanceAuthoringStage(input) {
      const parsed = advanceAuthoringStageInputSchema.parse(input);
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.authoring.advance-stage",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const targetStage = nextAuthoringStage(parsed.expectedStage);
          const current = repo.findDraft(spec.id);
          const requested = repo.findRevision(parsed.revisionId);
          if (
            targetStage !== null &&
            current?.authoringStage === targetStage &&
            current.basedOnRevisionId === parsed.revisionId &&
            requested?.state === "approved" &&
            requested.authoringStage === parsed.expectedStage
          ) {
            return {
              result: {
                ok: true,
                revision: current,
              } satisfies AdvanceAuthoringStageResult,
              prepared: null,
              policyNotice: null,
            };
          }
          if (
            current === null ||
            current.id !== parsed.revisionId ||
            current.authoringStage !== parsed.expectedStage
          ) {
            throw new StaleStageConflictError(
              parsed.specId,
              parsed.revisionId,
              parsed.expectedStage,
              current,
            );
          }

          const decision = evaluateAdvanceAuthoringStage(
            parsed.expectedStage,
            spec.gatePolicy,
          );
          if (!decision.ok || targetStage === null) {
            const refusal = decision.ok
              ? {
                  code: "gate_blocked" as const,
                  unmetConditions: [
                    "Design is the final evergreen authoring stage.",
                  ],
                  instruction:
                    "Propose the design stage when it is ready for review, then run `cctl spec plan open <slug>` after sign-off.",
                }
              : decision.refusal;
            deps.events.appendDurableInTransaction({
              specId: spec.id,
              occurredAt,
              actor: parsed.actor,
              durableEventType: "spec-intervention-recorded",
              durablePayload: {
                kind: "authoring-stage-advance-refused",
                revisionId: parsed.revisionId,
                expectedStage: parsed.expectedStage,
                refusal,
              },
            });
            return {
              result: {
                ok: false,
                refusal,
              } satisfies AdvanceAuthoringStageResult,
              prepared: null,
              policyNotice: null,
            };
          }

          const checkpoint = repo.approveRevision({
            revisionId: current.id,
            approvedAt: occurredAt,
          });
          const dial = resolveDial(spec.gatePolicy, parsed.expectedStage);
          const basis =
            dial === "notify"
              ? ("notify_policy" as const)
              : ("off_policy" as const);
          const admissionId = newId("admission");
          deps.review.insertGateAdmission({
            id: admissionId,
            spec_id: spec.id,
            gate: parsed.expectedStage,
            basis,
            approval_id: null,
            revision_id: checkpoint.id,
            execution_id: null,
            actor_json: stableStringify(parsed.actor),
            created_at: occurredAt,
          });
          const revision = repo.createDraftFromBase({
            id: newId("revision"),
            specId: spec.id,
            baseRevisionId: checkpoint.id,
            authoringStage: targetStage,
            createdAt: occurredAt,
          });
          const prepared = deps.events.appendInTransaction({
            actor: parsed.actor,
            durableEventType: "spec-authoring-returned-to-requirements",
            durablePayload: {
              kind: "authoring-stage-advanced",
              revisionId: revision.id,
              checkpointRevisionId: checkpoint.id,
              fromStage: parsed.expectedStage,
              toStage: targetStage,
              admissionId,
            },
            sseEvent: {
              type: "spec-revision-changed",
              kind: "authoring-stage-advanced",
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt,
              revisionId: revision.id,
            },
          });
          const policyNotice =
            basis === "notify_policy"
              ? ({
                  specId: spec.id,
                  specSlug: spec.slug,
                  specName: spec.name,
                  projectPath: spec.projectPath,
                  gate: parsed.expectedStage,
                  basis,
                  admissionId,
                  revisionId: revision.id,
                  executionId: null,
                  occurredAt,
                } satisfies SpecPolicyAdmissionNotice)
              : null;
          return {
            result: {
              ok: true,
              revision,
            } satisfies AdvanceAuthoringStageResult,
            prepared,
            policyNotice,
          };
        },
      );
      publish(transaction.prepared);
      if (transaction.policyNotice !== null) {
        deps.policyNotifier?.policyAdmitted(transaction.policyNotice);
      }
      logger.info("specs.authoring.advance_stage.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        expectedStage: parsed.expectedStage,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? { authoringStage: transaction.result.revision.authoringStage }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },

    async reorderDraftElement(input) {
      const parsed = reorderDraftElementInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.reorder-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          requireDraftRevision(revision);
          const target = repo
            .getRevisionSnapshot(revision.id)
            ?.elements.find(({ element }) => element.id === parsed.elementId);
          if (target !== undefined) {
            const decision = writeDecision(
              spec,
              revision,
              target.element.kind,
              target.version.payload,
            );
            if (!decision.ok) {
              appendWriteIntervention(
                spec.id,
                revision.id,
                parsed.elementId,
                parsed.actor,
                occurredAt,
                decision.refusal,
              );
              return { ok: false as const, refusal: decision.refusal };
            }
          }
          const version = repo.reorderDraftElement({
            revisionId: parsed.revisionId,
            elementId: parsed.elementId,
            expectedElementVersion: parsed.baseElementVersion,
            position: parsed.position,
            updatedAt: occurredAt,
          });
          return {
            ok: true as const,
            value: version,
            prepared: appendDraftEvent(
              spec,
              parsed.revisionId,
              [parsed.elementId],
              parsed.actor,
              occurredAt,
              "draft-element-reordered",
            ),
          };
        },
      );
      if (!result.ok) throw new StageBlockedWriteError(result.refusal);
      publish(result.prepared);
      logger.info("specs.authoring.reorder_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
        elementVersion: result.value.elementVersion,
        position: result.value.position,
      });
      return result.value;
    },

    async removeDraftElement(input) {
      const parsed = removeDraftElementInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.remove-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          requireDraftRevision(revision);
          const target = repo
            .getRevisionSnapshot(revision.id)
            ?.elements.find(({ element }) => element.id === parsed.elementId);
          if (target !== undefined) {
            const decision = writeDecision(
              spec,
              revision,
              target.element.kind,
              target.version.payload,
            );
            if (!decision.ok) {
              appendWriteIntervention(
                spec.id,
                revision.id,
                parsed.elementId,
                parsed.actor,
                occurredAt,
                decision.refusal,
              );
              return { ok: false as const, refusal: decision.refusal };
            }
          }

          const referenceIssues = stagedReferenceIssues(
            currentGuardedElements(repo, parsed.revisionId),
            [{ op: "remove", elementId: parsed.elementId }],
          );
          if (referenceIssues.length > 0) {
            const refusal = danglingReferenceRefusal(referenceIssues);
            appendWriteIntervention(
              spec.id,
              revision.id,
              parsed.elementId,
              parsed.actor,
              occurredAt,
              refusal,
            );
            return { ok: false as const, refusal };
          }

          repo.removeDraftElement({
            revisionId: parsed.revisionId,
            elementId: parsed.elementId,
            expectedElementVersion: parsed.baseElementVersion,
          });
          return {
            ok: true as const,
            prepared: appendDraftEvent(
              spec,
              parsed.revisionId,
              [parsed.elementId],
              parsed.actor,
              occurredAt,
              "draft-element-removed",
            ),
          };
        },
      );
      if (!result.ok) throw new StageBlockedWriteError(result.refusal);
      publish(result.prepared);
      logger.info("specs.authoring.remove_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
      });
    },

    async renameSpec(input) {
      const parsed = renameAuthoringSpecInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.rename",
        (repo) => {
          const current = requireSpec(repo, parsed.specId);
          const renamed = repo.rename({
            specId: parsed.specId,
            slug: parsed.slug,
            name: parsed.name ?? current.name,
            updatedAt: occurredAt,
            aliasCreatedAt: occurredAt,
          });
          return {
            value: renamed,
            fromSlug: current.slug,
            // The slug pair travels only in the durable payload: the strict
            // SSE spec-changed schema drops events with unknown fields.
            prepared: deps.events.appendInTransaction({
              actor: parsed.actor,
              durableEventType: "spec-changed",
              durablePayload: {
                kind: "spec-renamed",
                fromSlug: current.slug,
                toSlug: renamed.spec.slug,
              },
              sseEvent: {
                type: "spec-changed",
                kind: "spec-renamed",
                projectPath: renamed.spec.projectPath,
                specId: renamed.spec.id,
                specSlug: renamed.spec.slug,
                occurredAt,
              },
            }),
          };
        },
      );
      publish(result.prepared);
      logger.info("specs.authoring.rename.complete", {
        specId: parsed.specId,
        fromSlug: result.fromSlug,
        toSlug: result.value.spec.slug,
      });
      return result.value;
    },

    async openAmendment(input) {
      const parsed = openAmendmentInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.open-amendment",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const continuation = continueOrdinaryAuthoring(repo, spec.id);
          if (continuation.kind === "reuse_draft") {
            return {
              revision: continuation.draft,
              skippedWithdrawnRevisions: [],
              prepared: null,
            };
          }
          if (continuation.kind === "unavailable") {
            throw new SpecDraftUnavailableError(spec.id);
          }

          const approved = continuation.approved;
          const authoringStage = openDraftAuthoringStage({
            policy: spec.gatePolicy,
            baseRevision: {
              state: "approved",
              authoringStage: approved.authoringStage,
            },
          });
          const revision = repo.createDraftFromBase({
            id: newId("revision"),
            specId: spec.id,
            baseRevisionId: approved.id,
            authoringStage,
            createdAt: occurredAt,
          });
          return {
            revision,
            skippedWithdrawnRevisions: continuation.skippedWithdrawn,
            prepared: appendDraftEvent(
              spec,
              revision.id,
              undefined,
              parsed.actor,
              occurredAt,
              "amendment-opened",
            ),
          };
        },
      );
      publish(result.prepared);
      logger.info("specs.authoring.open_amendment.complete", {
        specId: parsed.specId,
        revisionId: result.revision.id,
        reused: result.prepared === null,
        skippedWithdrawnRevisionIds: result.skippedWithdrawnRevisions.map(
          ({ id }) => id,
        ),
      });
      return {
        revision: result.revision,
        skippedWithdrawnRevisions: result.skippedWithdrawnRevisions,
      };
    },

    async returnToRequirements(input) {
      const parsed = returnToRequirementsInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.return-to-requirements",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const target = repo.findRevision(parsed.expectedRevisionId);
          const currentDraft = repo.findDraft(spec.id);
          if (
            target === null ||
            target.specId !== spec.id ||
            target.authoringStage !== "design" ||
            target.state !== "draft" ||
            currentDraft?.id !== target.id
          ) {
            throw new StaleStageConflictError(
              spec.id,
              parsed.expectedRevisionId,
              "design",
              currentDraft,
            );
          }
          // The Design attempt's approved base is the settled content to
          // return to: approved Requirements, and on an amendment the approved
          // Design too, never the unapproved edits being returned from.
          const requirementsCheckpoint = nearestApprovedAncestor(
            repo.listRevisions(spec.id),
            target.id,
          );
          if (requirementsCheckpoint === null) {
            throw new StageBlockedWriteError({
              code: "stage_blocked",
              unmetConditions: [
                "The spec has no approved Requirements checkpoint to return to.",
              ],
              rationale: LATER_STAGE_RATIONALE,
              instruction:
                "Withdraw the Design attempt, then open a Requirements draft with an approved Requirements baseline.",
            });
          }
          const withdrawnRevision = repo.withdrawAuthoringRevision({
            revisionId: target.id,
          });
          // The withdrawn revision's asks end with it: no later sign-off names
          // this revision, so an ask left open here is a Needs You entry
          // nothing can ever answer.
          const endedRequests = openAuthoringRequestsForRevision(
            deps.attention.listOpenApprovalRequests(spec.id),
            target.id,
          );
          const retirements = endedRequests.map((request) =>
            prepareApprovalRequestRetirement(deps.events, {
              spec,
              actor: parsed.actor,
              occurredAt,
              attentionId: request.attentionId,
              reason: RETURNED_TO_REQUIREMENTS_REASON,
            }),
          );
          const revision = repo.createDraftFromBase({
            id: newId("revision"),
            specId: spec.id,
            baseRevisionId: requirementsCheckpoint.id,
            authoringStage: "requirements",
            createdAt: occurredAt,
          });
          const prepared = deps.events.appendInTransaction({
            actor: parsed.actor,
            durableEventType: "spec-revision-changed",
            durablePayload: {
              kind: "returned-to-requirements",
              withdrawnRevisionId: withdrawnRevision.id,
              requirementsCheckpointRevisionId: requirementsCheckpoint.id,
              revisionId: revision.id,
              reason: parsed.reason,
            },
            sseEvent: {
              type: "spec-revision-changed",
              kind: "returned-to-requirements",
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt,
              revisionId: revision.id,
            },
          });
          return {
            revision,
            withdrawnRevision,
            prepared: [...retirements, prepared],
            endedAttentionIds: endedRequests.map(
              (request) => request.attentionId,
            ),
          };
        },
      );
      for (const entry of result.prepared) publish(entry);
      // Announcement work: the retirements are durable, so a notifier failure
      // leaves a stale queue row behind and is logged, never charged back to
      // the caller whose return did land.
      if (result.endedAttentionIds.length > 0) {
        try {
          deps.notifier?.approvalRequestsClosed({
            specId: parsed.specId,
            attentionIds: result.endedAttentionIds,
            reason: RETURNED_TO_REQUIREMENTS_REASON,
            occurredAt,
          });
        } catch (error) {
          logger.warn(
            "specs.authoring.approval_requests_closed_notify_failed",
            {
              specId: parsed.specId,
              attentionIds: result.endedAttentionIds,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      logger.info("specs.authoring.returned-to-requirements", {
        specId: parsed.specId,
        withdrawnRevisionId: result.withdrawnRevision.id,
        revisionId: result.revision.id,
        retiredAttentionIds: result.endedAttentionIds,
        actorKind: parsed.actor.kind,
        reasonLength: parsed.reason.length,
      });
      return {
        revision: result.revision,
        withdrawnRevision: result.withdrawnRevision,
      };
    },
  };
}
