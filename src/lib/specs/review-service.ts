import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import { commentAnchorSchema } from "@/lib/document-comments/schemas";
import {
  actorProvenanceSchema,
  specAssumptionCitationsMutatedEventPayloadSchema,
  specAttentionEditPayloadSchema,
  specAttentionMutationReceiptSchema,
  specApprovalRequestScopeSchema,
  specAssumptionDispositionSchema,
  specGateSchema,
  specGatePolicySchema,
  specReviewRecordMutatedEventPayloadSchema,
  specSupersedeAssumptionPayloadSchema,
  type ActorProvenance,
  type AgentActorProvenance,
  type Spec,
  type SpecApprovalRequestScope,
  type SpecAuthoringStage,
  type SpecGate,
  type SpecGatePolicy,
  type SpecApprovalRow,
  type SpecAssumptionCitation,
  type SpecAssumptionRow,
  type SpecAttentionMutationReceipt,
  type SpecCommentRow,
  type SpecQuestionRow,
  type SpecRecordAuditSnapshot,
  type SpecRevision,
  type SpecRevisionSnapshot,
  type SpecRevisionSupersession,
  type SpecSupersedeAssumptionPayload,
} from "@/lib/specs/schemas";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type {
  OpenApprovalRequest,
  SpecEventsRepo,
} from "@/lib/state-store/spec-events-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type {
  SpecsRepo,
  SpecsRepoTransaction,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import { draftAuthoringSequence } from "./authoring-sequence";
import {
  assumptionAuditSnapshot,
  assumptionCitationSnapshot,
  prepareApprovalRequestRetirement,
  questionAuditSnapshot,
  type SpecApprovalRequestsClosedNotice,
} from "./attention-records";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import { formatBareElementHandle } from "./handles";
import { COMBINED_APPROVAL_DIAL, resolveDial } from "./policy";
import { rationaleForCode } from "./refusal-rationale";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import {
  currentExecution,
  latestRevision,
  validateApprovalRequest,
  EXECUTION_SCOPED_GATES,
} from "./gate-projection";
import { emptyApprovalLedger, type ApprovalLedger } from "./approval-ledger";
import {
  authoringReviewProjection,
  type AuthoringReviewProjection,
} from "./authoring-review-projection";
import { lint } from "./lint";
import {
  dismissSupersededHumanActRefusal,
  dismissSupersededIneligibleRefusal,
  proposalsStrandedBySignOff,
  strandedProposalSignOffRefusal,
  supersedingRevision,
} from "./proposal-integrity";
import {
  evaluateProposalWithdrawal,
  proposalAuthor,
} from "./proposal-withdrawal";
import {
  elementHandleInSnapshot,
  loadProposalState,
  type LoadedProposalState,
} from "./review-state";
import { governanceBaseRevisionId } from "./revision-lineage";
import {
  approveElement,
  changePolicy as evaluatePolicyChange,
  consultedAuthoringGates,
  openDraftAuthoringStage,
  resolveAuthoringDials,
  signOffRevision as evaluateSignOffRevision,
  type TransitionRefusal,
} from "./transitions";
import type { SpecPolicyChangeResult } from "./view-schemas";

export type { SpecPolicyChangeResult };
import { markWaiversStaleAtSignOffInTransaction } from "./waiver-staleness";

const logger = createLogger("specs.review-service");

const reviewIdentitySchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    actor: actorProvenanceSchema,
    activeStartedAt: z.string().datetime().optional(),
  })
  .strict();

export const reviewCommentInputSchema = reviewIdentitySchema
  .extend({
    elementId: z.string().min(1),
    threadId: z.string().min(1),
    parentCommentId: z.null(),
    anchor: commentAnchorSchema,
    body: z.string().trim().min(1),
    blocking: z.boolean(),
  })
  .strict();
export type ReviewCommentInput = z.infer<typeof reviewCommentInputSchema>;

export const resolveReviewThreadInputSchema = reviewIdentitySchema
  .extend({
    threadId: z.string().min(1),
    resolution: z.enum(["resolved", "dismissed"]),
  })
  .strict();
export type ResolveReviewThreadInput = z.infer<
  typeof resolveReviewThreadInputSchema
>;

/**
 * A reply names only the thread it answers: the revision, element, and anchor
 * all come from the thread's root row, so the caller cannot mis-anchor an
 * answer, and no revision id means no stale-token refusal on an act that is
 * conversation rather than review.
 */
export const replyToReviewThreadInputSchema = z
  .object({
    specId: z.string().min(1),
    actor: actorProvenanceSchema,
    activeStartedAt: z.string().datetime().optional(),
    threadId: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();
export type ReplyToReviewThreadInput = z.infer<
  typeof replyToReviewThreadInputSchema
>;

export const requestChangesInputSchema = reviewIdentitySchema;
export type RequestChangesInput = z.infer<typeof requestChangesInputSchema>;

/**
 * The revision id is the compare-and-swap token the propose response returned,
 * and the proposer always holds it. Inferring "the one current proposal" server
 * side is atomically safe but not intent-safe: a replacement proposal can land
 * between the agent observing the state and the withdrawal running.
 */
export const withdrawProposalInputSchema = reviewIdentitySchema;
export type WithdrawProposalInput = z.infer<typeof withdrawProposalInputSchema>;

export const approveItemInputSchema = reviewIdentitySchema
  .extend({
    subjectKind: z.enum(["requirement", "decision"]),
    elementId: z.string().min(1),
    approver: z.string().min(1),
  })
  .strict();
export type ApproveItemInput = z.infer<typeof approveItemInputSchema>;

export const unapproveItemInputSchema = reviewIdentitySchema
  .extend({
    subjectKind: z.enum(["requirement", "decision"]),
    elementId: z.string().min(1),
  })
  .strict();
export type UnapproveItemInput = z.infer<typeof unapproveItemInputSchema>;

const bulkApprovalSubjectSchema = z.discriminatedUnion("subjectKind", [
  z
    .object({
      subjectKind: z.enum(["requirement", "decision"]),
      elementId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      subjectKind: z.literal("plan"),
      elementId: z.null(),
    })
    .strict(),
]);

export const bulkApproveInputSchema = reviewIdentitySchema
  .extend({
    subjects: z.array(bulkApprovalSubjectSchema).min(1),
    approver: z.string().min(1),
  })
  .strict();
export type BulkApproveInput = z.infer<typeof bulkApproveInputSchema>;

export const signOffRevisionInputSchema = reviewIdentitySchema
  .extend({ approver: z.string().min(1) })
  .strict();
export type SignOffRevisionInput = z.infer<typeof signOffRevisionInputSchema>;

/**
 * The combined act takes no subject list. Which subjects are still outstanding
 * is a server projection, and accepting the caller's answer would give the
 * question two owners — the surface that renders the confirmation and the
 * transaction that writes the rows.
 */
export const approveRemainingAndSignOffInputSchema = signOffRevisionInputSchema;
export type ApproveRemainingAndSignOffInput = z.infer<
  typeof approveRemainingAndSignOffInputSchema
>;

export interface CombinedSignOffOutcome {
  revision: SpecRevision;
  /** The revision sign-off row; null when policy dials admitted the gates. */
  approval: SpecApprovalRow | null;
  /**
   * Every granular per-subject approval standing on the revision after the
   * act — the rows a collapsed sign-off would have erased.
   */
  subjectApprovals: SpecApprovalRow[];
}

export const grantGateApprovalInputSchema = reviewIdentitySchema
  .extend({
    executionId: z.string().min(1),
    gate: z.enum(["delivery", "execution_start"]),
    approver: z.string().min(1),
  })
  .strict();
export type GrantGateApprovalInput = z.infer<
  typeof grantGateApprovalInputSchema
>;

export const openQuestionInputSchema = z
  .object({
    specId: z.string().min(1),
    elementId: z.string().min(1).nullable(),
    text: z.string(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type OpenQuestionInput = z.infer<typeof openQuestionInputSchema>;

export const answerQuestionInputSchema = z
  .object({
    specId: z.string().min(1),
    questionId: z.string().min(1),
    recordVersion: z.number().int().positive(),
    answer: z.string(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type AnswerQuestionInput = z.infer<typeof answerQuestionInputSchema>;

export const proposeAssumptionInputSchema = z
  .object({
    specId: z.string().min(1),
    elementId: z.string().min(1).nullable(),
    text: z.string(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type ProposeAssumptionInput = z.infer<
  typeof proposeAssumptionInputSchema
>;

export const requestApprovalInputSchema = reviewIdentitySchema
  .extend({
    gate: specGateSchema,
    /**
     * Omitted, the request is for the gate as a whole — the ask a gate with a
     * dozen outstanding subjects has to be able to make, and the only ask that
     * still means the same thing once they are all approved. Naming a subject
     * asks for that item alone.
     */
    subject: z.string().min(1).optional(),
  })
  .strict();
export type RequestApprovalInput = z.infer<typeof requestApprovalInputSchema>;

/**
 * Whether the human-facing Needs You notice for a durably committed request
 * reached the notification layer. It is never a verdict on the request itself:
 * `delivery-uncertain` means the ask exists and only its notice may be
 * missing, which repeating `request-approval` re-fires against the same
 * attention id.
 */
const approvalRequestDeliveryOutcomeSchema = z.enum([
  "delivered",
  "delivery-uncertain",
]);
type ApprovalRequestDeliveryOutcome = z.infer<
  typeof approvalRequestDeliveryOutcomeSchema
>;

export const approvalRequestReceiptSchema = requestApprovalInputSchema
  .omit({ specId: true, actor: true })
  .extend({
    /** The gate name for a gate-scoped ask; the named handle for an item. */
    subject: z.string().min(1),
    scope: specApprovalRequestScopeSchema,
    attentionId: z.string().min(1),
    /**
     * True when this ask was already open: the receipt names the request that
     * exists rather than issuing a second Needs You entry for the same
     * approval (R10.9). The caller learns its request landed either way.
     */
    alreadyRequested: z.boolean(),
    /** The element the approval is for, or null for plan and gate subjects. */
    elementId: z.string().min(1).nullable(),
    /**
     * What the gate was still waiting on when the ask was made. A display
     * snapshot: it is never part of the request's identity, so it may differ
     * from the entry a human is reading.
     */
    outstandingSubjects: z.array(z.string().min(1)),
    /** Whether a human sign-off is still owed, which no item approval gives. */
    signOffOutstanding: z.boolean(),
    /** Whether the Needs You notice for this request reached the human. */
    deliveryOutcome: approvalRequestDeliveryOutcomeSchema,
  })
  .strict();
export type ApprovalRequestReceipt = z.infer<
  typeof approvalRequestReceiptSchema
>;

/**
 * The request as the transaction committed it. Delivery is attempted only
 * after the commit, so the outcome cannot be known inside it — the two are
 * kept apart rather than defaulted to a value the commit never observed.
 */
type CommittedApprovalRequest = Omit<ApprovalRequestReceipt, "deliveryOutcome">;

export const disposeAssumptionInputSchema = z
  .object({
    specId: z.string().min(1),
    assumptionId: z.string().min(1),
    recordVersion: z.number().int().positive(),
    citationVersion: z.number().int().positive().optional(),
    disposition: specAssumptionDispositionSchema.exclude([
      "proposed",
      "withdrawn",
    ]),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DisposeAssumptionInput = z.infer<
  typeof disposeAssumptionInputSchema
>;

export const editAttentionRecordInputSchema = z
  .object({
    specId: z.string().min(1),
    recordId: z.string().min(1),
    expectedRecordVersion: z.number().int().positive(),
    expectedCitationVersion: z.number().int().positive().optional(),
    payload: specAttentionEditPayloadSchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type EditAttentionRecordInput = z.infer<
  typeof editAttentionRecordInputSchema
>;

export const withdrawAttentionRecordInputSchema = z
  .object({
    specId: z.string().min(1),
    recordId: z.string().min(1),
    expectedRecordVersion: z.number().int().positive(),
    expectedCitationVersion: z.number().int().positive().optional(),
    reason: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type WithdrawAttentionRecordInput = z.infer<
  typeof withdrawAttentionRecordInputSchema
>;

export const supersedeAssumptionInputSchema = z
  .object({
    specId: z.string().min(1),
    assumptionId: z.string().min(1),
    draftRevisionId: z.string().min(1).optional(),
    expectedRecordVersion: z.number().int().positive(),
    expectedCitationVersion: z.number().int().positive(),
    payload: specSupersedeAssumptionPayloadSchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type SupersedeAssumptionInput = z.infer<
  typeof supersedeAssumptionInputSchema
>;

function supersessionRequestHash(input: {
  specId: string;
  predecessorAssumptionId: string;
  draftRevisionId: string;
  payload: SpecSupersedeAssumptionPayload;
}): string {
  return createHash("sha256")
    .update(stableStringify({ schemaVersion: 1, ...input }))
    .digest("hex");
}

function supersessionReplayCandidates(
  repo: SpecsRepoTransaction,
  specId: string,
  requestedRevisionId: string | undefined,
): SpecRevision[] {
  if (requestedRevisionId === undefined) return repo.listRevisions(specId);
  const revision = repo.findRevision(requestedRevisionId);
  if (revision === null || revision.specId !== specId) return [];
  return [revision];
}

export const mutateAssumptionCitationInputSchema = z
  .object({
    specId: z.string().min(1),
    assumptionId: z.string().min(1),
    revisionId: z.string().min(1),
    elementHandle: z.string().min(1),
    expectedCitationVersion: z.number().int().positive(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type MutateAssumptionCitationInput = z.infer<
  typeof mutateAssumptionCitationInputSchema
>;

export const changeSpecPolicyInputSchema = z
  .object({
    specId: z.string().min(1),
    proposedPolicy: specGatePolicySchema,
    hardConfirmed: z.boolean(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type ChangeSpecPolicyInput = z.infer<typeof changeSpecPolicyInputSchema>;

export const dismissSupersededProposalInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    reason: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DismissSupersededProposalInput = z.infer<
  typeof dismissSupersededProposalInputSchema
>;

export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

type ApprovalSubject = z.infer<typeof bulkApprovalSubjectSchema>;

interface SignOffTransactionOutcome {
  result: ReviewResult<{
    revision: SpecRevision;
    approval: SpecApprovalRow | null;
  }>;
  prepared: PreparedSpecEventPublication[];
  grantedNotice: SpecApprovalGrantNotice | null;
  policyNotices: SpecPolicyAdmissionNotice[];
  /**
   * Set only when this pass actually signed the revision off. The idempotent
   * repeat on an approved revision reports nothing, so the proposer feedback
   * notice cannot re-fire on a replay.
   */
  signedOff: { spec: Spec; occurredAt: string } | null;
}

interface CombinedSignOffTransactionOutcome {
  result: ReviewResult<CombinedSignOffOutcome>;
  prepared: PreparedSpecEventPublication[];
  grantedNotices: SpecApprovalGrantNotice[];
  policyNotices: SpecPolicyAdmissionNotice[];
  signedOff: { spec: Spec; occurredAt: string } | null;
}

/**
 * Carries a refusal out of the combined act's transaction. A refusal reached
 * after the subject approvals are written can only unwind them by throwing —
 * `specs.transaction` commits whatever the callback returns.
 */
class CombinedSignOffRefusedError extends Error {
  constructor(readonly refusal: TransitionRefusal) {
    super(`spec combined sign-off refused: ${refusal.code}`);
    this.name = "CombinedSignOffRefusedError";
  }
}

/**
 * What ending a review attempt leaves behind: the revision it withdrew, the
 * draft it reopened, and the approval account of that draft. The ledger rides
 * the act because the receipt is exactly where a reopen is misread as losing
 * every approval the attempt collected.
 */
export interface ReopenedProposal {
  withdrawn: SpecRevision;
  draft: SpecRevision;
  approvalLedger: ApprovalLedger;
}

export interface ReviewService {
  comment(input: ReviewCommentInput): Promise<ReviewResult<SpecCommentRow>>;
  replyToThread(
    input: ReplyToReviewThreadInput,
  ): Promise<ReviewResult<SpecCommentRow>>;
  resolveThread(
    input: ResolveReviewThreadInput,
  ): Promise<ReviewResult<SpecCommentRow[]>>;
  requestChanges(
    input: RequestChangesInput,
  ): Promise<ReviewResult<ReopenedProposal>>;
  approveItem(input: ApproveItemInput): Promise<ReviewResult<SpecApprovalRow>>;
  unapproveItem(
    input: UnapproveItemInput,
  ): Promise<ReviewResult<SpecApprovalRow>>;
  signOffRevision(input: SignOffRevisionInput): Promise<
    ReviewResult<{
      revision: SpecRevision;
      approval: SpecApprovalRow | null;
    }>
  >;
  /**
   * Approve everything the revision still owes and sign it off, atomically.
   * The two-step flow it replaces could come to rest between the steps, which
   * is how a proposal ends up approved-but-unsigned with no surface saying so.
   */
  approveRemainingAndSignOff(
    input: ApproveRemainingAndSignOffInput,
  ): Promise<ReviewResult<CombinedSignOffOutcome>>;
  grantGateApproval(
    input: GrantGateApprovalInput,
  ): Promise<ReviewResult<SpecApprovalRow>>;
  withdraw(input: RequestChangesInput): Promise<ReviewResult<SpecRevision>>;
  /**
   * The agent-side exit from a frozen proposal. Distinct from `withdraw`,
   * which is the human's terminal end of a review: this one is guarded by
   * authorship, refuses once a human has engaged, and reopens the withdrawn
   * content as a draft so the author can fix and re-propose without a
   * ceremony click.
   */
  withdrawProposal(
    input: WithdrawProposalInput,
  ): Promise<ReviewResult<ReopenedProposal>>;
  /**
   * The human exit from a proposal an approved revision forked past (#50).
   * Deliberately not `requestChanges`: reopening the stranded content as a
   * draft would make stale content the spec's only editable revision and block
   * amending the newer approved content.
   */
  dismissSupersededProposal(input: DismissSupersededProposalInput): Promise<
    ReviewResult<{
      withdrawn: SpecRevision;
      supersession: SpecRevisionSupersession;
    }>
  >;
  bulkApprove(
    input: BulkApproveInput,
  ): Promise<ReviewResult<SpecApprovalRow[]>>;
  openQuestion(
    input: OpenQuestionInput,
  ): Promise<ReviewResult<SpecQuestionRow>>;
  answerQuestion(
    input: AnswerQuestionInput,
  ): Promise<ReviewResult<SpecQuestionRow>>;
  editAttentionRecord(
    input: EditAttentionRecordInput,
  ): Promise<ReviewResult<SpecAttentionMutationReceipt>>;
  withdrawAttentionRecord(
    input: WithdrawAttentionRecordInput,
  ): Promise<ReviewResult<SpecAttentionMutationReceipt>>;
  supersedeAssumption(
    input: SupersedeAssumptionInput,
  ): Promise<ReviewResult<SpecAttentionMutationReceipt>>;
  citeAssumption(
    input: MutateAssumptionCitationInput,
  ): Promise<ReviewResult<SpecAttentionMutationReceipt>>;
  unciteAssumption(
    input: MutateAssumptionCitationInput,
  ): Promise<ReviewResult<SpecAttentionMutationReceipt>>;
  proposeAssumption(
    input: ProposeAssumptionInput,
  ): Promise<ReviewResult<SpecAssumptionRow>>;
  requestApproval(
    input: RequestApprovalInput,
  ): Promise<ReviewResult<ApprovalRequestReceipt>>;
  disposeAssumption(
    input: DisposeAssumptionInput,
  ): Promise<ReviewResult<SpecAssumptionRow>>;
  changePolicy(
    input: ChangeSpecPolicyInput,
  ): Promise<ReviewResult<SpecPolicyChangeResult>>;
}

export interface SpecApprovalRequestNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  gate: SpecGate;
  subject: string;
  scope: SpecApprovalRequestScope;
  /** What the gate owed when the ask was made, for the entry's body. */
  outstandingSubjects: string[];
  signOffOutstanding: boolean;
  /** The attention id issued for the request — the durable correlation key. */
  gateRequestId: string;
  occurredAt: string;
}

export interface SpecApprovalGrantNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  approvalId: string | null;
  /**
   * The exact open requests this human act satisfies, resolved here against
   * the durable request log. Which act answers which ask is a review decision
   * — an item approval never answers a whole-gate ask — so notification
   * storage must not re-derive it from a request's subject or deep link.
   */
  satisfiedAttentionIds: string[];
  occurredAt: string;
}

export type { SpecApprovalRequestsClosedNotice };

/**
 * Review feedback landing on a proposal, addressed to the conversation that
 * proposed it (#60). The service resolves `proposer` from the durable propose
 * event — the same read the withdrawal guard uses — so the notifier never
 * needs the event log; null means no agent conversation owns the proposal
 * (a human propose or unreadable provenance) and there is nobody to notify.
 */
export interface SpecReviewFeedbackNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  revisionId: string;
  kind: "commented" | "changes_requested" | "signed_off";
  /** The commented element id; null for revision-level acts. */
  subject: string | null;
  threadId: string | null;
  /**
   * The reopened draft's approval account, on the acts that reopen one; null
   * on every other kind, which changes no approval and would be asserting a
   * position it did not create.
   */
  approvalLedger: ApprovalLedger | null;
  proposer: AgentActorProvenance | null;
  occurredAt: string;
}

/**
 * Outbound port for durable human-facing approval notifications. Called only
 * after the review transaction commits; the composed implementation renders
 * the notices and owns notification dedupe, never the decision of which
 * request an act answers.
 */
export interface SpecReviewNotifier {
  approvalRequested(notice: SpecApprovalRequestNotice): void;
  approvalGranted(notice: SpecApprovalGrantNotice): void;
  approvalRequestsClosed(notice: SpecApprovalRequestsClosedNotice): void;
  /**
   * Passive, durable feedback to the PROPOSING conversation — never an
   * auto-wake (#60). Optional so approval-only compositions stay valid.
   */
  reviewFeedback?(notice: SpecReviewFeedbackNotice): void;
}

export interface ReviewServiceDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
  delivery: Pick<
    SpecDeliveryRepo,
    | "findExecutionById"
    | "findExecutionsBySpecId"
    | "findWaiversBySpecId"
    | "saveWaiver"
  >;
  links: Pick<SpecLinksRepo, "findBySpecId">;
  events: SpecEventsPublisher;
  /**
   * Read side of the durable event log. An approval request is recorded as an
   * event, so recognising a repeat of the same ask — and deciding which open
   * asks an act answers — means reading it back; so is who proposed a revision
   * and whether a human has acted on it, which no live row can prove.
   */
  attention: Pick<
    SpecEventsRepo,
    "findApprovalRequest" | "listOpenApprovalRequests" | "findBySpecId"
  >;
  notifier?: SpecReviewNotifier;
  /** Post-hoc notices for Notify-dial policy-admitted sign-offs (R11.2). */
  policyNotifier?: SpecPolicyAdmissionNotifier;
  newId?(prefix: string): string;
  now?(): string;
}

function refused(
  code: TransitionRefusal["code"],
  unmetConditions: string[],
  instruction: string,
): ReviewResult<never> {
  // The reason belongs to the code, so this service states it on the same
  // terms as the transition predicates that raise it elsewhere.
  const rationale = rationaleForCode(code);
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions,
      ...(rationale === undefined ? {} : { rationale }),
      instruction,
    },
  };
}

/**
 * Announces an act that has already committed. A notifier throw here is a
 * delivery gap, never a failure of the act: propagating it would convert a
 * durable review act into a 5xx and invite a retry of work that already
 * happened. Callers report the returned outcome rather than re-deriving it.
 */
function notifyAfterCommit(
  event: string,
  fields: Record<string, unknown>,
  notify: () => void,
): ApprovalRequestDeliveryOutcome {
  try {
    notify();
    return "delivered";
  } catch (error) {
    logger.warn(event, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
    return "delivery-uncertain";
  }
}

function requireReviewTarget(
  repo: SpecsRepoTransaction,
  specId: string,
  revisionId: string,
): { spec: Spec; revision: SpecRevision } | null {
  const spec = repo.findById(specId);
  const revision = repo.findRevision(revisionId);
  if (spec === null || revision === null || revision.specId !== spec.id) {
    return null;
  }
  return { spec, revision };
}

function snapshotOrNull(
  repo: SpecsRepoTransaction,
  revisionId: string | null,
): SpecRevisionSnapshot | null {
  return revisionId === null ? null : repo.getRevisionSnapshot(revisionId);
}

// The durable display handle (R1, D1) for an approved element, so grant
// notices can satisfy requests that were filed under the handle.
function approvedElementHandle(
  repo: SpecsRepoTransaction,
  revisionId: string,
  elementId: string | null,
): string[] {
  if (elementId === null) return [];
  const element = repo
    .getRevisionSnapshot(revisionId)
    ?.elements.find(({ element: row }) => row.id === elementId)?.element;
  if (element === undefined || element.number === null) return [];
  const prefix =
    element.kind === "requirement"
      ? "R"
      : element.kind === "decision"
        ? "D"
        : null;
  return prefix === null ? [] : [`${prefix}${element.number}`];
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());

  function humanRequired(actor: ActorProvenance): ReviewResult<never> | null {
    return actor.kind === "human"
      ? null
      : refused(
          "human_act_required",
          ["Review approval actions are human-only acts."],
          "Complete the review action in Spec Studio.",
        );
  }

  function authoringAgentRequired(
    actor: ActorProvenance,
  ): ReviewResult<never> | null {
    return actor.kind === "agent"
      ? null
      : refused(
          "authoring_agent_required",
          ["Attention record correction is an authoring-agent act."],
          "Run this correction from an authenticated authoring conversation.",
        );
  }

  function abandonedSpecRefusal(spec: Spec): ReviewResult<never> | null {
    return spec.abandonedAt === null
      ? null
      : refused(
          "attention_state_conflict",
          ["The spec is abandoned and its attention register is read-only."],
          "Read the retained attention history; no further mutation is admitted.",
        );
  }

  function staleAttentionRefusal(): ReviewResult<never> {
    return refused(
      "stale_attention_record",
      ["The attention record changed after the supplied record version."],
      "Re-read the Q/A record and reconsider the mutation.",
    );
  }

  function staleCitationRefusal(): ReviewResult<never> {
    return refused(
      "stale_citation_set",
      ["The draft citation set changed after the supplied citation version."],
      "Re-read the current draft citation set and reconsider the mutation.",
    );
  }

  function attentionStateRefusal(instruction: string): ReviewResult<never> {
    return refused(
      "attention_state_conflict",
      ["The attention record lifecycle no longer admits this act."],
      instruction,
    );
  }

  function resolveElementId(
    snapshot: SpecRevisionSnapshot,
    handle: string,
  ): string | null {
    return (
      snapshot.elements.find(
        ({ element }) =>
          elementHandleInSnapshot(snapshot, element.id) === handle,
      )?.element.id ?? null
    );
  }

  function appendRecordMutation(input: {
    spec: Spec;
    actor: ActorProvenance;
    occurredAt: string;
    operation:
      | "opened"
      | "proposed"
      | "edited"
      | "answered"
      | "disposed"
      | "withdrawn"
      | "superseded";
    before: SpecRecordAuditSnapshot | null;
    after: SpecRecordAuditSnapshot;
    reason?: string;
    successorAssumptionId?: string;
    active: boolean;
  }): void {
    const payload = specReviewRecordMutatedEventPayloadSchema.parse({
      schemaVersion: 1,
      recordKind: input.after.kind,
      recordId: input.after.recordId,
      recordNumber: input.after.number,
      attentionId: input.after.recordId,
      operation: input.operation,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.successorAssumptionId === undefined
        ? {}
        : { successorAssumptionId: input.successorAssumptionId }),
      active: input.active,
      before: input.before,
      after: input.after,
    });
    deps.events.appendDurableInTransaction({
      specId: input.spec.id,
      occurredAt: input.occurredAt,
      actor: input.actor,
      durableEventType: "spec-review-record-mutated",
      durablePayload: payload,
    });
  }

  function appendCitationMutation(input: {
    spec: Spec;
    actor: ActorProvenance;
    occurredAt: string;
    beforeRevision: SpecRevision;
    beforeCitations: SpecRevisionSnapshot["assumptionCitations"];
    outcome: Extract<
      ReturnType<SpecsRepoTransaction["replaceAssumptionDraftCitations"]>,
      { kind: "success" }
    >;
  }): void {
    const beforeByKey = new Map(
      input.beforeCitations.map((citation) => [
        `${citation.elementId}\u0000${citation.assumptionId}`,
        citation,
      ]),
    );
    const afterByKey = new Map(
      input.outcome.citations.map((citation) => [
        `${citation.elementId}\u0000${citation.assumptionId}`,
        citation,
      ]),
    );
    const payload = specAssumptionCitationsMutatedEventPayloadSchema.parse({
      schemaVersion: 1,
      revisionId: input.beforeRevision.id,
      beforeCitationVersion: input.beforeRevision.citationVersion,
      afterCitationVersion: input.outcome.revision.citationVersion,
      beforeCitationHash: input.beforeRevision.citationHash,
      afterCitationHash: input.outcome.revision.citationHash,
      added: input.outcome.added.map(({ elementId, assumptionId }) => {
        const citation = afterByKey.get(`${elementId}\u0000${assumptionId}`);
        if (citation === undefined) throw new Error("added citation missing");
        return { elementId, assumptionId, snapshot: citation.snapshot };
      }),
      removed: input.outcome.removed.map(({ elementId, assumptionId }) => {
        const citation = beforeByKey.get(`${elementId}\u0000${assumptionId}`);
        if (citation === undefined) throw new Error("removed citation missing");
        return { elementId, assumptionId, snapshot: citation.snapshot };
      }),
      refreshed: input.outcome.refreshed.map(({ elementId, assumptionId }) => {
        const key = `${elementId}\u0000${assumptionId}`;
        const before = beforeByKey.get(key);
        const after = afterByKey.get(key);
        if (before === undefined || after === undefined) {
          throw new Error("refreshed citation snapshot missing");
        }
        return {
          elementId,
          assumptionId,
          beforeSnapshot: before.snapshot,
          afterSnapshot: after.snapshot,
        };
      }),
    });
    deps.events.appendDurableInTransaction({
      specId: input.spec.id,
      occurredAt: input.occurredAt,
      actor: input.actor,
      durableEventType: "spec-assumption-citations-mutated",
      durablePayload: payload,
    });
  }

  function citationsForAssumption(
    repo: SpecsRepoTransaction,
    revisionId: string,
    assumptionId: string,
  ): SpecAssumptionCitation[] {
    return repo
      .readRevisionCitations(revisionId)
      .filter((citation) => citation.assumptionId === assumptionId);
  }

  function assumptionSuccessorId(
    specId: string,
    assumptionId: string,
  ): string | null {
    return (
      deps.review
        .findAssumptionsBySpecId(specId)
        .find(
          (assumption) => assumption.supersedes_assumption_id === assumptionId,
        )?.id ?? null
    );
  }

  function citationHandles(
    snapshot: SpecRevisionSnapshot,
    references: readonly { elementId: string }[],
  ): string[] {
    return references
      .map(({ elementId }) => elementHandleInSnapshot(snapshot, elementId))
      .filter((handle): handle is string => handle !== null)
      .sort();
  }

  function frozenRevisionCites(
    repo: SpecsRepoTransaction,
    specId: string,
    assumptionId: string,
  ): boolean {
    return repo
      .listRevisions(specId)
      .filter((revision) => revision.state !== "draft")
      .some((revision) =>
        repo
          .readRevisionCitations(revision.id)
          .some((citation) => citation.assumptionId === assumptionId),
      );
  }

  function currentContentSnapshot(
    repo: SpecsRepoTransaction,
    specId: string,
  ): SpecRevisionSnapshot | null {
    const draft = repo.findDraft(specId);
    if (draft !== null) return repo.getRevisionSnapshot(draft.id);
    const latest = latestRevision(repo.listRevisions(specId));
    return latest === null ? null : repo.getRevisionSnapshot(latest.id);
  }

  function citationOutcomeRefusal(
    outcome: Exclude<
      ReturnType<SpecsRepoTransaction["replaceAssumptionDraftCitations"]>,
      { kind: "success" }
    >,
  ): ReviewResult<never> {
    if (outcome.kind === "stale_version") return staleCitationRefusal();
    if (outcome.kind === "illegal_lifecycle") {
      return refused(
        "amendment_required",
        ["Citation truth is frozen outside a writable draft."],
        "Open an amendment and retry against its citation version.",
      );
    }
    return refused(
      "not_found",
      ["The draft, assumption, or cited element was not found."],
      "Re-read the current draft and attention register.",
    );
  }

  function recordOutcomeRefusal(
    outcome:
      | Exclude<
          ReturnType<SpecReviewRepo["updateOpenQuestion"]>,
          { kind: "success" }
        >
      | Exclude<
          ReturnType<SpecReviewRepo["updateProposedAssumption"]>,
          { kind: "success" }
        >,
  ): ReviewResult<never> {
    if (outcome.kind === "stale_version") return staleAttentionRefusal();
    if (outcome.kind === "illegal_lifecycle") {
      return attentionStateRefusal(
        "Read the terminal record; correct a disposed assumption by superseding it.",
      );
    }
    return refused(
      "not_found",
      ["Attention record not found."],
      "Re-read the attention register.",
    );
  }

  function attentionReceipt(input: {
    operation: SpecAttentionMutationReceipt["operation"];
    before: SpecQuestionRow | SpecAssumptionRow;
    after: SpecQuestionRow | SpecAssumptionRow;
    draftRevisionId: string | null;
    beforeCitationVersion: number | null;
    afterCitationVersion: number | null;
    added?: string[];
    removed?: string[];
    refreshed?: string[];
    successor?: SpecAssumptionRow;
    idempotentReplay?: boolean;
  }): SpecAttentionMutationReceipt {
    const recordKind = "status" in input.after ? "question" : "assumption";
    return specAttentionMutationReceiptSchema.parse({
      operation: input.operation,
      recordKind,
      recordId: input.after.id,
      recordHandle: formatBareElementHandle({
        kind: recordKind,
        number: input.after.number,
      }),
      previousRecordVersion: input.before.record_version,
      newRecordVersion: input.after.record_version,
      lifecycle:
        recordKind === "question"
          ? (input.after as SpecQuestionRow).status
          : (input.after as SpecAssumptionRow).disposition,
      draftRevisionId: input.draftRevisionId,
      previousCitationVersion: input.beforeCitationVersion,
      newCitationVersion: input.afterCitationVersion,
      citationChanges: {
        added: input.added ?? [],
        removed: input.removed ?? [],
        refreshed: input.refreshed ?? [],
      },
      ...(input.successor === undefined
        ? {}
        : {
            successor: {
              id: input.successor.id,
              handle: formatBareElementHandle({
                kind: "assumption",
                number: input.successor.number,
              }),
            },
          }),
      idempotentReplay: input.idempotentReplay ?? false,
    });
  }

  function grantNoticeFor(
    spec: Spec,
    notice: Pick<
      SpecApprovalGrantNotice,
      "approvalId" | "satisfiedAttentionIds" | "occurredAt"
    >,
  ): SpecApprovalGrantNotice {
    return {
      specId: spec.id,
      specSlug: spec.slug,
      specName: spec.name,
      projectPath: spec.projectPath,
      ...notice,
    };
  }

  /**
   * Post-commit only, like every notifier call: tell the PROPOSING
   * conversation that review feedback landed (#60). The proposer is resolved
   * here, from the durable propose event, so the notifier needs no event-log
   * access; when no agent conversation owns the proposal there is nobody to
   * notify and the act stays silent.
   */
  function emitReviewFeedback(
    spec: Spec,
    revisionId: string,
    kind: SpecReviewFeedbackNotice["kind"],
    subject: string | null,
    threadId: string | null,
    occurredAt: string,
    approvalLedger: ApprovalLedger | null,
  ): void {
    const proposer = proposalAuthor(
      deps.attention.findBySpecId(spec.id),
      revisionId,
    );
    if (proposer === null) return;
    deps.notifier?.reviewFeedback?.({
      specId: spec.id,
      specSlug: spec.slug,
      specName: spec.name,
      projectPath: spec.projectPath,
      revisionId,
      kind,
      subject,
      threadId,
      proposer,
      approvalLedger,
      occurredAt,
    });
  }

  /** The requests a revision-scoped authoring act can answer or end. */
  function authoringRequestsForRevision(
    specId: string,
    revisionId: string,
  ): OpenApprovalRequest[] {
    return deps.attention
      .listOpenApprovalRequests(specId)
      .filter(
        (request) =>
          request.executionId === null &&
          request.revisionId === revisionId &&
          !EXECUTION_SCOPED_GATES.has(request.gate),
      );
  }

  /**
   * Approving an item answers only the asks that named that item. A whole-gate
   * ask survives it: the gate is admitted by the revision sign-off, and
   * closing its entry here would retire the very notice that asks for the
   * sign-off (Requirement 24.13 — an item approval is not a gate admission).
   *
   * A request recorded before requests carried a scope named exactly one
   * subject, because that is the only form that existed, so the approval of
   * that subject answers it as it always did.
   */
  function requestsSatisfiedByItems(
    specId: string,
    revisionId: string,
    approvedSubjects: readonly string[],
  ): string[] {
    const subjects = new Set(approvedSubjects);
    return authoringRequestsForRevision(specId, revisionId)
      .filter(
        (request) => request.scope !== "gate" && subjects.has(request.subject),
      )
      .map((request) => request.attentionId);
  }

  /**
   * A per-run gate admits the run as a whole, so its grant answers every ask
   * filed at that gate for that run — including one filed under an element
   * handle, which is a pointer at what blocked the run rather than a separate
   * approval. Requests written before runs entered request identity carry no
   * execution id and belong to the only run that could have opened them.
   */
  function requestsSatisfiedByRunGate(
    specId: string,
    gate: SpecGate,
    executionId: string,
  ): string[] {
    return deps.attention
      .listOpenApprovalRequests(specId)
      .filter(
        (request) =>
          request.gate === gate &&
          (request.executionId === executionId || request.executionId === null),
      )
      .map((request) => request.attentionId);
  }

  function appendEvent(
    spec: Spec,
    revisionId: string,
    actor: ActorProvenance,
    occurredAt: string,
    durableEventType:
      | "spec-review-commented"
      | "spec-review-changes-requested"
      | "spec-review-item-approved"
      | "spec-review-item-unapproved"
      | "spec-review-revision-signed-off",
    kind: string,
    subjectId?: string,
    activeStartedAt?: string,
  ): PreparedSpecEventPublication {
    const approvalChanged =
      durableEventType === "spec-review-item-approved" ||
      durableEventType === "spec-review-item-unapproved";
    const revisionChanged =
      durableEventType === "spec-review-changes-requested" ||
      durableEventType === "spec-review-revision-signed-off";
    const action =
      durableEventType === "spec-review-commented"
        ? ("comment" as const)
        : durableEventType === "spec-review-changes-requested"
          ? ("request_changes" as const)
          : durableEventType === "spec-review-item-approved"
            ? ("approve_item" as const)
            : durableEventType === "spec-review-item-unapproved"
              ? ("unapprove_item" as const)
              : ("sign_off" as const);
    const measuredActiveStartedAt =
      activeStartedAt !== undefined &&
      Date.parse(activeStartedAt) <= Date.parse(occurredAt)
        ? activeStartedAt
        : occurredAt;
    if (
      activeStartedAt !== undefined &&
      measuredActiveStartedAt !== activeStartedAt
    ) {
      logger.warn("specs.review.active_span_invalid", {
        revisionId,
        activeStartedAt,
        occurredAt,
      });
    }
    return deps.events.appendInTransaction({
      actor,
      durableEventType,
      durablePayload: {
        kind,
        revisionId,
        ...(subjectId === undefined ? {} : { subjectId }),
        measureEvents: [
          {
            kind: "review-action",
            action,
            reviewAttemptId: revisionId,
            activeStartedAt: measuredActiveStartedAt,
            ...(subjectId === undefined ? {} : { subjectId }),
            revisionId,
          },
        ],
      },
      sseEvent: approvalChanged
        ? {
            type: "spec-approval-changed",
            kind,
            projectPath: spec.projectPath,
            specId: spec.id,
            specSlug: spec.slug,
            occurredAt,
            revisionId,
            ...(subjectId === undefined ? {} : { subjectId }),
          }
        : revisionChanged
          ? {
              type: "spec-revision-changed",
              kind,
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt,
              revisionId,
            }
          : {
              type: "spec-attention-changed",
              kind,
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt,
              attentionId: subjectId ?? revisionId,
              active: true,
            },
    });
  }

  function appendAttentionEvent(
    spec: Spec,
    actor: ActorProvenance,
    occurredAt: string,
    kind: string,
    attentionId: string,
    active: boolean,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-attention-changed",
      durablePayload: { kind, attentionId, active },
      sseEvent: {
        type: "spec-attention-changed",
        kind,
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        attentionId,
        active,
      },
    });
  }

  /**
   * Ends the requests a grant just answered. An answered ask has to leave
   * request identity too: leaving it open makes the next ask for the same
   * subject dedupe onto an id the queue already resolved, so a human who
   * withdraws their approval gets a subject that is outstanding again with
   * nothing in their queue and no way to put it back.
   */
  function retireAnsweredRequests(
    spec: Spec,
    actor: ActorProvenance,
    occurredAt: string,
    attentionIds: readonly string[],
  ): PreparedSpecEventPublication[] {
    return attentionIds.map((attentionId) =>
      appendRequestRetirement(
        spec,
        actor,
        occurredAt,
        attentionId,
        "the approval it asked for was recorded",
      ),
    );
  }

  function appendRequestRetirement(
    spec: Spec,
    actor: ActorProvenance,
    occurredAt: string,
    attentionId: string,
    reason: string,
  ): PreparedSpecEventPublication {
    return prepareApprovalRequestRetirement(deps.events, {
      spec,
      actor,
      occurredAt,
      attentionId,
      reason,
    });
  }

  /**
   * Records the proposing agent ending its own attempt. Both provenances ride
   * the payload because the event's actor column can only carry one, and the
   * audit question here is a pair: who proposed, and who took it back.
   */
  function appendProposalWithdrawnEvent(
    spec: Spec,
    revisionId: string,
    proposer: AgentActorProvenance,
    withdrawnBy: AgentActorProvenance,
    followUpDraftRevisionId: string,
    occurredAt: string,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor: withdrawnBy,
      durableEventType: "spec-revision-changed",
      durablePayload: {
        kind: "proposal-withdrawn-by-author",
        revisionId,
        proposer,
        withdrawnBy,
        followUpDraftRevisionId,
      },
      sseEvent: {
        type: "spec-revision-changed",
        kind: "proposal-withdrawn-by-author",
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
      },
    });
  }

  /**
   * Records a human ending a proposal an approved revision forked past. The
   * superseding revision and the stated reason ride the payload: #50's manual
   * repair left a `withdrawn` row no reader could explain, and this is the
   * record that makes the disposal explainable without one.
   */
  function appendProposalDismissedEvent(
    spec: Spec,
    revisionId: string,
    supersededByRevisionId: string,
    reason: string,
    actor: ActorProvenance,
    occurredAt: string,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-revision-changed",
      durablePayload: {
        kind: "proposal-dismissed-superseded",
        revisionId,
        supersededByRevisionId,
        reason,
      },
      sseEvent: {
        type: "spec-revision-changed",
        kind: "proposal-dismissed-superseded",
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
      },
    });
  }

  /**
   * The one way a proposed revision becomes an editable draft again. Request
   * Changes and the proposing agent's own withdrawal both land here, so
   * neither can open a second editable revision beside a draft an execution
   * capture already left open — the spec carries exactly one at a time.
   */
  function withdrawAndOpenDraft(
    repo: SpecsRepoTransaction,
    spec: Spec,
    revision: SpecRevision,
    occurredAt: string,
  ):
    | {
        readonly ok: true;
        readonly withdrawn: SpecRevision;
        readonly draft: SpecRevision;
      }
    | { readonly ok: false; readonly refusal: TransitionRefusal } {
    const openDraft = repo.findDraft(spec.id);
    if (openDraft !== null) {
      return {
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: [
            `Revision ${openDraft.number} is already open as a draft, so ending revision ${revision.number} would leave the spec with two editable revisions.`,
          ],
          instruction: `Propose draft revision ${openDraft.number} before ending the review of revision ${revision.number}.`,
        },
      };
    }
    const withdrawn = repo.withdrawRevision({ revisionId: revision.id });
    const draft = repo.createDraftFromBase({
      id: newId("revision"),
      specId: spec.id,
      baseRevisionId: withdrawn.id,
      authoringStage: openDraftAuthoringStage({
        policy: spec.gatePolicy,
        baseRevision: {
          state: "withdrawn",
          authoringStage: withdrawn.authoringStage,
        },
      }),
      createdAt: occurredAt,
    });
    return { ok: true, withdrawn, draft };
  }

  /** Threads on a review attempt a human resolved or dismissed. */
  function humanEndedThreadIds(revisionId: string): string[] {
    return [
      ...new Set(
        deps.review
          .findCommentsByRevision(revisionId)
          .filter((comment) => comment.resolution !== "open")
          .map((comment) => comment.thread_id),
      ),
    ];
  }

  /**
   * R25.10: the audit question "which dials governed this transition?" is
   * answerable only if the change records both sides plus the stage the open
   * draft stayed pinned at. The acting human rides the event's actor column.
   */
  function appendPolicyEvent(
    spec: Spec,
    previousPolicy: SpecGatePolicy,
    pinnedAuthoringStage: SpecAuthoringStage | null,
    actor: ActorProvenance,
    occurredAt: string,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-changed",
      durablePayload: {
        kind: "policy-changed",
        previousPolicy,
        policy: spec.gatePolicy,
        pinnedAuthoringStage,
      },
      sseEvent: {
        type: "spec-changed",
        kind: "policy-changed",
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
      },
    });
  }

  function publishAll(prepared: PreparedSpecEventPublication[]): void {
    for (const event of prepared) deps.events.publishAfterCommit(event);
  }

  /**
   * Retires the Needs You rows for asks that ended without an answer. The act
   * that ended them is already durable, so this is announcement work: a
   * notifier failure leaves a stale queue row behind and is logged, never
   * charged back to the caller whose withdrawal or retirement did land.
   */
  function notifyRequestsClosed(
    specId: string,
    attentionIds: string[],
    reason: string,
    occurredAt: string,
  ): void {
    notifyAfterCommit(
      "specs.review.approval_requests_closed_notify_failed",
      { specId, attentionIds },
      () =>
        deps.notifier?.approvalRequestsClosed({
          specId,
          attentionIds,
          reason,
          occurredAt,
        }),
    );
  }

  function approvalForSubject(
    specId: string,
    revisionId: string,
    subjectKind: "requirement" | "decision" | "plan" | "revision",
    elementId: string | null,
    approver: string,
    grantedAt: string,
  ): SpecApprovalRow {
    const existing = deps.review
      .findApprovalsBySpecId(specId)
      .find(
        (approval) =>
          approval.subject_kind === subjectKind &&
          approval.element_id === elementId &&
          (subjectKind !== "revision" || approval.revision_id === revisionId),
      );
    return {
      id: existing?.id ?? newId("approval"),
      spec_id: specId,
      subject_kind: subjectKind,
      element_id: elementId,
      revision_id: revisionId,
      approver,
      granted_at: grantedAt,
      validity: "valid",
    };
  }

  function elementBelongsToSpec(
    repo: SpecsRepoTransaction,
    specId: string,
    elementId: string,
  ): boolean {
    return repo
      .listRevisions(specId)
      .some(
        (revision) =>
          repo
            .getRevisionSnapshot(revision.id)
            ?.elements.some(({ element }) => element.id === elementId) === true,
      );
  }

  function validateApprovalSubject(
    repo: SpecsRepoTransaction,
    revision: SpecRevision,
    subject: z.infer<typeof bulkApprovalSubjectSchema>,
    actor: ActorProvenance,
  ): TransitionRefusal | null {
    if (subject.subjectKind === "plan") {
      if (revision.authoringStage !== "plan") {
        return {
          code: "stage_blocked",
          unmetConditions: [
            "The execution plan can be approved only on a plan-stage revision.",
          ],
          instruction:
            "Complete requirements and design authoring before approving the execution plan.",
        };
      }
      if (revision.state !== "proposed") {
        return {
          code: "gate_blocked",
          unmetConditions: [
            "The execution plan can be approved only on a proposed revision.",
          ],
          instruction:
            "Propose the draft revision before approving its execution plan.",
        };
      }
      const decision = humanRequired(actor);
      return decision !== null && !decision.ok ? decision.refusal : null;
    }
    const decision = approveElement({
      actor,
      revisionState: revision.state,
      subjectKind: subject.subjectKind,
    });
    if (!decision.ok) return decision.refusal;
    const element = repo
      .getRevisionSnapshot(revision.id)
      ?.elements.find(
        ({ element: row }) => row.id === subject.elementId,
      )?.element;
    if (element?.kind !== subject.subjectKind) {
      return {
        code: "not_found",
        unmetConditions: [
          `${subject.elementId} is not a ${subject.subjectKind}.`,
        ],
        instruction: "Refresh the revision and select a reviewable element.",
      };
    }
    return null;
  }

  interface ApproveSubjectsOutcome {
    result: ReviewResult<SpecApprovalRow[]>;
    prepared: PreparedSpecEventPublication[];
    grantedNotice: SpecApprovalGrantNotice | null;
  }

  /**
   * The one per-subject approval body. Bulk approval and the combined
   * approve-remaining act both run it, so the granular rows, their audit
   * events, and the requests they retire cannot drift between the callers.
   */
  function approveSubjectsInTransaction(
    repo: SpecsRepoTransaction,
    target: { spec: Spec; revision: SpecRevision },
    subjects: readonly ApprovalSubject[],
    parsed: {
      specId: string;
      revisionId: string;
      approver: string;
      actor: ActorProvenance;
      activeStartedAt?: string;
    },
    occurredAt: string,
  ): ApproveSubjectsOutcome {
    for (const subject of subjects) {
      const refusal = validateApprovalSubject(
        repo,
        target.revision,
        subject,
        parsed.actor,
      );
      if (refusal !== null)
        return {
          result: { ok: false, refusal },
          prepared: [],
          grantedNotice: null,
        };
    }
    const rows = subjects.map((subject) =>
      approvalForSubject(
        parsed.specId,
        parsed.revisionId,
        subject.subjectKind,
        subject.elementId,
        parsed.approver,
        occurredAt,
      ),
    );
    for (const row of rows) deps.review.saveApproval(row);
    const answered = requestsSatisfiedByItems(
      target.spec.id,
      target.revision.id,
      subjects.flatMap((subject) =>
        subject.elementId === null
          ? ["plan"]
          : [
              subject.elementId,
              ...approvedElementHandle(
                repo,
                target.revision.id,
                subject.elementId,
              ),
            ],
      ),
    );
    return {
      result: { ok: true, value: rows },
      prepared: [
        ...rows.map((row) =>
          appendEvent(
            target.spec,
            target.revision.id,
            parsed.actor,
            occurredAt,
            "spec-review-item-approved",
            "item-approved",
            row.element_id ?? "plan",
            parsed.activeStartedAt,
          ),
        ),
        ...retireAnsweredRequests(
          target.spec,
          parsed.actor,
          occurredAt,
          answered,
        ),
      ],
      grantedNotice: grantNoticeFor(target.spec, {
        approvalId: rows[0]?.id ?? null,
        satisfiedAttentionIds: answered,
        occurredAt,
      }),
    };
  }

  /**
   * The one sign-off body. The combined approve-remaining act runs it rather
   * than re-deriving the transition, so the live-sibling recheck, the gate
   * admissions, the waiver sweep, and the audit event keep a single owner. The
   * caller may pin `occurredAt` when the sign-off shares a transaction with
   * writes that must carry the same instant.
   */
  function signOffInTransaction(
    repo: SpecsRepoTransaction,
    parsed: SignOffRevisionInput,
    occurredAtOverride?: string,
  ): SignOffTransactionOutcome {
    let grantedNotice: SpecApprovalGrantNotice | null = null;
    const policyNotices: SpecPolicyAdmissionNotice[] = [];
    const target = requireReviewTarget(repo, parsed.specId, parsed.revisionId);
    if (target === null)
      return {
        result: refused(
          "not_found",
          ["Review target not found."],
          "Refresh Spec Studio.",
        ),
        prepared: [],
        grantedNotice,
        policyNotices,
        signedOff: null,
      };
    if (target.revision.state === "approved") {
      const approval =
        deps.review
          .findApprovalsBySpecId(parsed.specId)
          .find(
            (candidate) =>
              candidate.subject_kind === "revision" &&
              candidate.revision_id === parsed.revisionId,
          ) ?? null;
      return {
        result: {
          ok: true,
          value: { revision: target.revision, approval },
        } as ReviewResult<{
          revision: SpecRevision;
          approval: SpecApprovalRow | null;
        }>,
        prepared: [],
        grantedNotice,
        policyNotices,
        signedOff: null,
      };
    }
    // Ticket #50: the propose guard should make this impossible, but a
    // lineage that already carries a second live proposal (written
    // before the guard, or by a path that bypassed it) must not have it
    // silently forked past here. Read inside the transaction, refuse —
    // never dispose — and name the act that ends the sibling.
    const stranded = proposalsStrandedBySignOff(
      repo.listRevisions(parsed.specId),
      parsed.revisionId,
    )[0];
    if (stranded !== undefined)
      return {
        result: {
          ok: false,
          refusal: strandedProposalSignOffRefusal(target.revision, stranded),
        } as ReviewResult<{
          revision: SpecRevision;
          approval: SpecApprovalRow | null;
        }>,
        prepared: [],
        grantedNotice,
        policyNotices,
        signedOff: null,
      };
    const occurredAt = occurredAtOverride ?? now();
    const snapshot = repo.getRevisionSnapshot(target.revision.id);
    if (snapshot === null)
      return {
        result: refused(
          "not_found",
          ["Revision snapshot not found."],
          "Refresh Spec Studio.",
        ),
        prepared: [],
        grantedNotice,
        policyNotices,
        signedOff: null,
      };
    const loaded = loadProposalState(
      repo,
      deps.review,
      deps.links,
      target.spec,
      snapshot,
    );
    const decision = evaluateSignOffRevision({
      actor: parsed.actor,
      revisionState: target.revision.state,
      authoringStage: target.revision.authoringStage,
      policy: target.spec.gatePolicy,
      draft: loaded.draft,
      records: loaded.records,
      review: loaded.reviewSnapshot,
      approvalApplies: loaded.approvalApplies,
    });
    if (!decision.ok)
      return {
        result: { ok: false, refusal: decision.refusal } as ReviewResult<{
          revision: SpecRevision;
          approval: SpecApprovalRow | null;
        }>,
        prepared: [],
        grantedNotice,
        policyNotices,
        signedOff: null,
      };
    const resolvedGates = consultedAuthoringGates(
      target.revision.authoringStage,
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
    ).map((gate) => ({
      gate,
      dial: resolveDial(target.spec.gatePolicy, gate),
    }));
    const policyAdmitted = resolvedGates.every(
      ({ dial }) => dial === "notify" || dial === "off",
    );
    const approval = policyAdmitted
      ? null
      : approvalForSubject(
          parsed.specId,
          parsed.revisionId,
          "revision",
          null,
          parsed.approver,
          occurredAt,
        );
    if (approval !== null) deps.review.saveApproval(approval);
    const globalAuthoringDials = resolveAuthoringDials(target.spec.gatePolicy);
    const allCombined = Object.values(globalAuthoringDials).every(
      (dial) => dial === COMBINED_APPROVAL_DIAL,
    );
    // R11.5: under the fast-path policy this human sign-off IS the
    // combined approval — every per-element approval is recorded with
    // the revision sign-off in the same transaction, all or none.
    const combinedSubjects = allCombined
      ? [
          ...snapshot.elements.flatMap(({ element }) =>
            element.kind === "requirement" || element.kind === "decision"
              ? [
                  {
                    subjectKind: element.kind,
                    elementId: element.id,
                  } as const,
                ]
              : [],
          ),
          ...(target.revision.authoringStage === "plan"
            ? [{ subjectKind: "plan", elementId: null } as const]
            : []),
        ]
      : [];
    for (const subject of combinedSubjects) {
      deps.review.saveApproval(
        approvalForSubject(
          parsed.specId,
          parsed.revisionId,
          subject.subjectKind,
          subject.elementId,
          parsed.approver,
          occurredAt,
        ),
      );
    }
    const revision = repo.approveRevision({
      revisionId: parsed.revisionId,
      approvedAt: occurredAt,
    });
    const stalePrepared = markWaiversStaleAtSignOffInTransaction({
      spec: target.spec,
      approvedRevisionId: parsed.revisionId,
      getSnapshot: (targetRevisionId) =>
        repo.getRevisionSnapshot(targetRevisionId),
      waivers: deps.delivery,
      events: deps.events,
      actor: parsed.actor,
      occurredAt,
    });
    const existingAdmissions = deps.review.findGateAdmissionsByRevision(
      parsed.revisionId,
    );
    for (const { gate, dial } of resolvedGates) {
      const basis =
        dial === "notify"
          ? ("notify_policy" as const)
          : dial === "off"
            ? ("off_policy" as const)
            : ("human_approval" as const);
      if (
        existingAdmissions.some(
          (admission) => admission.gate === gate && admission.basis === basis,
        )
      )
        continue;
      const admissionId = newId("admission");
      deps.review.insertGateAdmission({
        id: admissionId,
        spec_id: parsed.specId,
        gate,
        basis,
        approval_id: approval?.id ?? null,
        revision_id: parsed.revisionId,
        execution_id: null,
        actor_json: stableStringify(parsed.actor),
        created_at: occurredAt,
      });
      if (basis === "notify_policy") {
        // R11.2: the transition proceeded under the Notify dial — the
        // human gets a post-hoc review notice for the admission.
        policyNotices.push({
          specId: target.spec.id,
          specSlug: target.spec.slug,
          specName: target.spec.name,
          projectPath: target.spec.projectPath,
          gate,
          basis,
          admissionId,
          revisionId: parsed.revisionId,
          executionId: null,
          occurredAt,
        });
      }
    }
    // Sign-off is the act that admits the revision's gates, so it
    // answers every authoring ask filed against it — the whole-gate
    // entries no item approval could clear, and any item entry still
    // open under a policy that collapsed the per-item approvals.
    const admittedGates = new Set<string>(
      resolvedGates.map(({ gate }) => gate),
    );
    const answered = authoringRequestsForRevision(
      target.spec.id,
      parsed.revisionId,
    )
      .filter((request) => admittedGates.has(request.gate))
      .map((request) => request.attentionId);
    grantedNotice = grantNoticeFor(target.spec, {
      approvalId: approval?.id ?? null,
      satisfiedAttentionIds: answered,
      occurredAt,
    });
    return {
      result: {
        ok: true,
        value: { revision, approval },
      } as ReviewResult<{
        revision: SpecRevision;
        approval: SpecApprovalRow | null;
      }>,
      prepared: [
        appendEvent(
          target.spec,
          revision.id,
          parsed.actor,
          occurredAt,
          "spec-review-revision-signed-off",
          policyAdmitted
            ? "policy-signed-off"
            : allCombined
              ? "combined-signed-off"
              : "signed-off",
          approval?.id,
          parsed.activeStartedAt,
        ),
        ...stalePrepared,
        ...retireAnsweredRequests(
          target.spec,
          parsed.actor,
          occurredAt,
          answered,
        ),
      ],
      grantedNotice,
      policyNotices,
      signedOff: { spec: target.spec, occurredAt },
    };
  }

  /**
   * The one authoring projection this service reads, inside the transaction
   * that is about to change what it describes. Both the subjects an act still
   * owes and the ledger a receipt reports come from this single read, so the
   * two can never disagree about the same revision.
   */
  function authoringProjection(
    repo: SpecsRepoTransaction,
    spec: Spec,
    snapshot: SpecRevisionSnapshot,
    loaded: LoadedProposalState,
  ): AuthoringReviewProjection {
    const revisions = repo.listRevisions(spec.id);
    return authoringReviewProjection({
      policy: spec.gatePolicy,
      snapshot,
      governanceBaseSnapshot: loaded.governanceBaseSnapshot,
      importBaselineRows: loaded.importBaselineRows,
      importBaselineCitationState: loaded.importBaselineCitationState,
      approvals: deps.review.findApprovalsBySpecId(spec.id),
      admissions: deps.review.findGateAdmissionsBySpecId(spec.id),
      currentExecution: currentExecution(
        deps.delivery.findExecutionsBySpecId(spec.id),
      ),
      revisionNumberById: new Map(
        revisions.map((revision) => [revision.id, revision.number]),
      ),
      applies: loaded.approvalApplies,
      blockingThreads: loaded.reviewSnapshot.blockingThreads,
      signOffFindings: lint(loaded.draft, loaded.records).filter(
        (finding) => finding.severity === "blocks_signoff",
      ),
    });
  }

  /**
   * The approval account of the draft a reopen just opened — never of the
   * revision it withdrew. Read after the reopen commits its rows so it
   * describes the position the author is actually in: what carried across the
   * reopen, and what only editing changed.
   *
   * An unreadable draft asserts nothing rather than reporting an empty account
   * as "everything is outstanding".
   */
  function reopenedApprovalLedger(
    repo: SpecsRepoTransaction,
    spec: Spec,
    draft: SpecRevision,
  ): ApprovalLedger {
    const snapshot = repo.getRevisionSnapshot(draft.id);
    if (snapshot === null) return emptyApprovalLedger();
    return authoringProjection(
      repo,
      spec,
      snapshot,
      loadProposalState(repo, deps.review, deps.links, spec, snapshot),
    ).approvalLedger;
  }

  /**
   * The subjects the projection still owes on this revision, in gate order.
   * Derived here rather than taken from the caller: "what is still outstanding"
   * has exactly one answer, and a list the client assembled a moment earlier
   * can name a subject the policy collapsed or miss one a concurrent write
   * opened. Under the combined dial the projection owes none — sign-off itself
   * records them — so this act adds no second copy.
   */
  function outstandingAuthoringSubjects(
    repo: SpecsRepoTransaction,
    spec: Spec,
    snapshot: SpecRevisionSnapshot,
    loaded: LoadedProposalState,
  ): ApprovalSubject[] {
    const projection = authoringProjection(repo, spec, snapshot, loaded);
    return projection.pendingApprovals.flatMap((pending): ApprovalSubject[] => {
      if (pending.elementId !== null && pending.gate === "requirements")
        return [{ subjectKind: "requirement", elementId: pending.elementId }];
      if (pending.elementId !== null && pending.gate === "design")
        return [{ subjectKind: "decision", elementId: pending.elementId }];
      return pending.gate === "plan"
        ? [{ subjectKind: "plan", elementId: null }]
        : [];
    });
  }

  function combinedSignOffInTransaction(
    repo: SpecsRepoTransaction,
    parsed: ApproveRemainingAndSignOffInput,
  ): CombinedSignOffTransactionOutcome {
    const target = requireReviewTarget(repo, parsed.specId, parsed.revisionId);
    if (target === null)
      return {
        result: refused(
          "not_found",
          ["Review target not found."],
          "Refresh Spec Studio.",
        ),
        prepared: [],
        grantedNotices: [],
        policyNotices: [],
        signedOff: null,
      };
    const approvals: PreparedSpecEventPublication[] = [];
    const grantedNotices: SpecApprovalGrantNotice[] = [];
    let occurredAt: string | undefined;
    // An already-approved revision owes nothing: the sign-off body answers it
    // idempotently, and deriving subjects for it would re-approve a frozen
    // revision. Ordered ahead of the sibling guard so a re-run of the act that
    // committed cannot start refusing.
    if (target.revision.state !== "approved") {
      // Inherited from the sign-off recheck (ticket #50): a lineage carrying a
      // live sibling is refused BEFORE any approval is written, so the caller
      // gets the named remedy over an untouched spec rather than a rollback.
      const stranded = proposalsStrandedBySignOff(
        repo.listRevisions(parsed.specId),
        parsed.revisionId,
      )[0];
      if (stranded !== undefined)
        return {
          result: {
            ok: false,
            refusal: strandedProposalSignOffRefusal(target.revision, stranded),
          },
          prepared: [],
          grantedNotices: [],
          policyNotices: [],
          signedOff: null,
        };
      const snapshot = repo.getRevisionSnapshot(target.revision.id);
      if (snapshot === null)
        return {
          result: refused(
            "not_found",
            ["Revision snapshot not found."],
            "Refresh Spec Studio.",
          ),
          prepared: [],
          grantedNotices: [],
          policyNotices: [],
          signedOff: null,
        };
      const subjects = outstandingAuthoringSubjects(
        repo,
        target.spec,
        snapshot,
        loadProposalState(repo, deps.review, deps.links, target.spec, snapshot),
      );
      if (subjects.length > 0) {
        occurredAt = now();
        const approved = approveSubjectsInTransaction(
          repo,
          target,
          subjects,
          parsed,
          occurredAt,
        );
        // Every subject is validated before the first row is written, so a
        // refusal here has applied nothing and needs no unwind.
        if (!approved.result.ok)
          return {
            result: approved.result,
            prepared: [],
            grantedNotices: [],
            policyNotices: [],
            signedOff: null,
          };
        approvals.push(...approved.prepared);
        if (approved.grantedNotice !== null)
          grantedNotices.push(approved.grantedNotice);
      }
    }
    const signOff = signOffInTransaction(repo, parsed, occurredAt);
    // The approvals are already written, and `specs.transaction` unwinds only
    // on a throw: a sign-off refusal has to leave by throwing or the act would
    // commit half of itself.
    if (!signOff.result.ok)
      throw new CombinedSignOffRefusedError(signOff.result.refusal);
    if (signOff.grantedNotice !== null)
      grantedNotices.push(signOff.grantedNotice);
    return {
      result: {
        ok: true,
        value: {
          revision: signOff.result.value.revision,
          approval: signOff.result.value.approval,
          // Read back rather than echoed: under the combined dial sign-off
          // wrote the subject rows itself, and the caller is owed what the act
          // durably left, not what this pass happened to write.
          subjectApprovals: deps.review
            .findApprovalsBySpecId(parsed.specId)
            .filter(
              (row) =>
                row.revision_id === parsed.revisionId &&
                row.subject_kind !== "revision",
            ),
        },
      },
      prepared: [...approvals, ...signOff.prepared],
      grantedNotices,
      policyNotices: signOff.policyNotices,
      signedOff: signOff.signedOff,
    };
  }

  async function mutateAssumptionCitation(
    input: MutateAssumptionCitationInput,
    operation: "cite" | "uncite",
  ): Promise<ReviewResult<SpecAttentionMutationReceipt>> {
    const parsed = mutateAssumptionCitationInputSchema.parse(input);
    const actorRefusal = authoringAgentRequired(parsed.actor);
    if (actorRefusal !== null) return actorRefusal;
    const occurredAt = now();
    const transaction = await deps.specs.transaction(
      `specs.review.${operation}-assumption`,
      (repo) => {
        const spec = repo.findById(parsed.specId);
        const assumption = deps.review.findAssumptionById(parsed.assumptionId);
        if (
          spec === null ||
          assumption === null ||
          assumption.spec_id !== parsed.specId
        ) {
          return {
            result: refused(
              "not_found",
              ["Assumption not found."],
              "Re-read the attention register.",
            ),
            prepared: [],
          };
        }
        const abandonedRefusal = abandonedSpecRefusal(spec);
        if (abandonedRefusal !== null) {
          return { result: abandonedRefusal, prepared: [] };
        }
        const draft = repo.findDraft(spec.id);
        const snapshot =
          draft === null ? null : repo.getRevisionSnapshot(draft.id);
        if (
          draft === null ||
          snapshot === null ||
          draft.id !== parsed.revisionId
        ) {
          return {
            result: refused(
              "amendment_required",
              ["Citation mutations must target the current writable draft."],
              "Open or re-read the amendment and retry against its revision id.",
            ),
            prepared: [],
          };
        }
        if (draft.citationVersion !== parsed.expectedCitationVersion) {
          return { result: staleCitationRefusal(), prepared: [] };
        }
        if (
          operation === "cite" &&
          (!["proposed", "confirmed", "deferred"].includes(
            assumption.disposition,
          ) ||
            assumptionSuccessorId(spec.id, assumption.id) !== null)
        ) {
          return {
            result: attentionStateRefusal(
              "Rejected, withdrawn, and superseded assumptions cannot gain citations.",
            ),
            prepared: [],
          };
        }
        const elementId = resolveElementId(snapshot, parsed.elementHandle);
        if (elementId === null) {
          return {
            result: refused(
              "not_found",
              ["Citation element handle not found in the current draft."],
              "Re-read the draft and choose an existing element handle.",
            ),
            prepared: [],
          };
        }
        const outcome = repo.mutateDraftCitation(
          operation === "cite"
            ? {
                operation,
                revisionId: draft.id,
                specId: spec.id,
                assumptionId: assumption.id,
                elementId,
                expectedCitationVersion: parsed.expectedCitationVersion,
                snapshot: assumptionCitationSnapshot(assumption, occurredAt),
                updatedAt: occurredAt,
              }
            : {
                operation,
                revisionId: draft.id,
                specId: spec.id,
                assumptionId: assumption.id,
                elementId,
                expectedCitationVersion: parsed.expectedCitationVersion,
                updatedAt: occurredAt,
              },
        );
        if (outcome.kind !== "success") {
          return {
            result: citationOutcomeRefusal(outcome),
            prepared: [],
          };
        }
        if (outcome.changed) {
          appendCitationMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            beforeRevision: draft,
            beforeCitations: snapshot.assumptionCitations,
            outcome,
          });
        }
        return {
          result: {
            ok: true,
            value: attentionReceipt({
              operation: operation === "cite" ? "cited" : "uncited",
              before: assumption,
              after: assumption,
              draftRevisionId: draft.id,
              beforeCitationVersion: draft.citationVersion,
              afterCitationVersion: outcome.revision.citationVersion,
              added: citationHandles(snapshot, outcome.added),
              removed: citationHandles(snapshot, outcome.removed),
              refreshed: citationHandles(snapshot, outcome.refreshed),
              idempotentReplay: !outcome.changed,
            }),
          } as ReviewResult<SpecAttentionMutationReceipt>,
          prepared: outcome.changed
            ? [
                appendAttentionEvent(
                  spec,
                  parsed.actor,
                  occurredAt,
                  `assumption-${operation}d`,
                  assumption.id,
                  assumption.disposition === "proposed",
                ),
              ]
            : [],
        };
      },
    );
    publishAll(transaction.prepared);
    logger.info(`specs.review.${operation}_assumption.complete`, {
      specId: parsed.specId,
      assumptionId: parsed.assumptionId,
      revisionId: parsed.revisionId,
      ok: transaction.result.ok,
      ...(transaction.result.ok
        ? {
            citationVersion: transaction.result.value.newCitationVersion,
            idempotentReplay: transaction.result.value.idempotentReplay,
          }
        : { refusalCode: transaction.result.refusal.code }),
    });
    return transaction.result;
  }

  return {
    async comment(input) {
      const parsed = reviewCommentInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      let commentedSpec: Spec | null = null;
      const transaction = await deps.specs.transaction(
        "specs.review.comment",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null) {
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          if (target.spec.abandonedAt !== null) {
            return {
              result: refused(
                "gate_blocked",
                ["Comments cannot be added to an abandoned spec."],
                "Restore or replace the spec before reviewing it.",
              ),
              prepared: [],
            };
          }
          if (target.revision.state !== "proposed") {
            return {
              result: refused(
                "gate_blocked",
                ["Comments are review actions on proposed revisions."],
                "Propose a revision before reviewing it.",
              ),
              prepared: [],
            };
          }
          const snapshot = repo.getRevisionSnapshot(parsed.revisionId);
          const carriesElement = snapshot?.elements.some(
            ({ element }) => element.id === parsed.elementId,
          );
          if (carriesElement !== true) {
            return {
              result: refused(
                "not_found",
                [
                  `Element ${parsed.elementId} is not carried by the proposed revision.`,
                ],
                "Refresh Spec Studio and comment on an element in the current proposal.",
              ),
              prepared: [],
            };
          }
          const row: SpecCommentRow = {
            id: newId("comment"),
            spec_id: parsed.specId,
            thread_id: parsed.threadId,
            parent_comment_id: parsed.parentCommentId,
            element_id: parsed.elementId,
            anchor_json: stableStringify(parsed.anchor),
            revision_id: parsed.revisionId,
            body: parsed.body,
            author_json: stableStringify(parsed.actor),
            blocking: parsed.blocking ? 1 : 0,
            resolution: "open",
            created_at: occurredAt,
            updated_at: occurredAt,
          };
          deps.review.saveComment(row);
          commentedSpec = target.spec;
          return {
            result: { ok: true, value: row } as ReviewResult<SpecCommentRow>,
            prepared: [
              appendEvent(
                target.spec,
                target.revision.id,
                parsed.actor,
                occurredAt,
                "spec-review-commented",
                "commented",
                row.thread_id,
                parsed.activeStartedAt,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && commentedSpec !== null) {
        emitReviewFeedback(
          commentedSpec,
          parsed.revisionId,
          "commented",
          parsed.elementId,
          parsed.threadId,
          occurredAt,
          null,
        );
      }
      return transaction.result;
    },

    /**
     * The one agent-capable comment write. Top-level comments are human review
     * acts on a proposed revision; a reply answers a thread that already
     * exists, so it carries no anchor of its own, never blocks, and is not
     * gated on the revision's state — after Request Changes reopens the draft,
     * answering the reviewer is exactly what the repair loop needs (#60).
     */
    async replyToThread(input) {
      const parsed = replyToReviewThreadInputSchema.parse(input);
      const occurredAt = now();
      let repliedSpec: Spec | null = null;
      const transaction = await deps.specs.transaction(
        "specs.review.reply",
        (repo) => {
          const thread = deps.review
            .findCommentsByThread(parsed.threadId)
            .filter((comment) => comment.spec_id === parsed.specId);
          const root =
            thread.find((comment) => comment.parent_comment_id === null) ??
            thread[0];
          if (root === undefined) {
            return {
              result: refused(
                "not_found",
                [`Review thread ${parsed.threadId} was not found.`],
                "List this spec's threads with cctl spec comments, then reply with a threadId it names.",
              ),
              prepared: [],
            };
          }
          if (thread.every((comment) => comment.resolution !== "open")) {
            return {
              result: refused(
                "already_satisfied",
                [`Review thread ${parsed.threadId} has ended.`],
                "An ended thread stays ended; answer in the next proposal's notes or ask the reviewer to comment again.",
              ),
              prepared: [],
            };
          }
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            root.revision_id,
          );
          if (target === null) {
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          const row: SpecCommentRow = {
            id: newId("comment"),
            spec_id: parsed.specId,
            thread_id: root.thread_id,
            parent_comment_id: root.id,
            element_id: root.element_id,
            // The reply answers the root's anchored text; copying the anchor
            // keeps every row in the thread self-describing.
            anchor_json: root.anchor_json,
            revision_id: root.revision_id,
            body: parsed.body,
            author_json: stableStringify(parsed.actor),
            blocking: 0,
            resolution: "open",
            created_at: occurredAt,
            updated_at: occurredAt,
          };
          deps.review.saveComment(row);
          repliedSpec = target.spec;
          return {
            result: { ok: true, value: row } as ReviewResult<SpecCommentRow>,
            prepared: [
              appendEvent(
                target.spec,
                target.revision.id,
                parsed.actor,
                occurredAt,
                "spec-review-commented",
                "commented",
                row.thread_id,
                parsed.activeStartedAt,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      // Only a HUMAN reply is feedback to the proposer; an agent answering a
      // thread must not be woken up to read its own words.
      if (
        transaction.result.ok &&
        parsed.actor.kind === "human" &&
        repliedSpec !== null
      ) {
        emitReviewFeedback(
          repliedSpec,
          transaction.result.value.revision_id,
          "commented",
          transaction.result.value.element_id,
          transaction.result.value.thread_id,
          occurredAt,
          null,
        );
      }
      logger.info("specs.review.reply.complete", {
        specId: parsed.specId,
        threadId: parsed.threadId,
        actorKind: parsed.actor.kind,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async resolveThread(input) {
      const parsed = resolveReviewThreadInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.resolve-thread",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null) {
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          if (target.revision.state !== "proposed") {
            return {
              result: refused(
                "gate_blocked",
                [
                  "Threads can be resolved only while their revision is proposed.",
                ],
                "Open the proposed revision before resolving its review threads.",
              ),
              prepared: [],
            };
          }
          const comments = deps.review
            .findCommentsByRevision(parsed.revisionId)
            .filter((comment) => comment.thread_id === parsed.threadId);
          if (comments.length === 0) {
            return {
              result: refused(
                "not_found",
                ["Review thread not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          const updated = comments.map((comment) => ({
            ...comment,
            resolution: parsed.resolution,
            updated_at: occurredAt,
          }));
          for (const comment of updated) deps.review.saveComment(comment);
          return {
            result: {
              ok: true,
              value: updated,
            } as ReviewResult<SpecCommentRow[]>,
            prepared: [
              appendAttentionEvent(
                target.spec,
                parsed.actor,
                occurredAt,
                `thread-${parsed.resolution}`,
                parsed.threadId,
                false,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.resolve_thread.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        threadId: parsed.threadId,
        resolution: parsed.resolution,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async openQuestion(input) {
      const parsed = openQuestionInputSchema.parse(input);
      const actorRefusal = authoringAgentRequired(parsed.actor);
      if (actorRefusal !== null) return actorRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.open-question",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          if (spec === null) {
            return {
              result: refused(
                "not_found",
                ["Spec not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }
          if (
            parsed.elementId !== null &&
            !elementBelongsToSpec(repo, spec.id, parsed.elementId)
          ) {
            return {
              result: refused(
                "not_found",
                ["Question attachment element not found."],
                "Refresh the spec and choose an existing element.",
              ),
              prepared: [],
            };
          }
          const row: SpecQuestionRow = {
            id: newId("question"),
            spec_id: spec.id,
            number: repo.allocateNumber(spec.id, "Q"),
            element_id: parsed.elementId,
            text: parsed.text,
            provenance_json: stableStringify(parsed.actor),
            record_version: 1,
            status: "open",
            answer: null,
            answered_at: null,
            withdrawn_at: null,
            created_at: occurredAt,
            updated_at: occurredAt,
          };
          const inserted = deps.review.insertQuestion(row);
          if (inserted.kind !== "success") {
            return {
              result: attentionStateRefusal(
                "Retry after re-reading the attention register.",
              ),
              prepared: [],
            };
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "opened",
            before: null,
            after: questionAuditSnapshot(inserted.row),
            active: true,
          });
          return {
            result: {
              ok: true,
              value: inserted.row,
            } as ReviewResult<SpecQuestionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "question-opened",
                row.id,
                true,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.open_question.complete", {
        specId: parsed.specId,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async answerQuestion(input) {
      const parsed = answerQuestionInputSchema.parse(input);
      const actorRefusal = humanRequired(parsed.actor);
      if (actorRefusal !== null) return actorRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.answer-question",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          const current = deps.review.findQuestionById(parsed.questionId);
          if (
            spec === null ||
            current === null ||
            current.spec_id !== parsed.specId
          ) {
            return {
              result: refused(
                "not_found",
                ["Question not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }
          if (current.record_version !== parsed.recordVersion) {
            return { result: staleAttentionRefusal(), prepared: [] };
          }
          if (current.status !== "open") {
            return {
              result: attentionStateRefusal(
                "Open a new question if further clarification is needed.",
              ),
              prepared: [],
            };
          }
          const updated = deps.review.answerOpenQuestion({
            id: current.id,
            expectedRecordVersion: parsed.recordVersion,
            answer: parsed.answer,
            answeredAt: occurredAt,
            updatedAt: occurredAt,
          });
          if (updated.kind !== "success") {
            return {
              result: recordOutcomeRefusal(updated),
              prepared: [],
            };
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "answered",
            before: questionAuditSnapshot(current),
            after: questionAuditSnapshot(updated.row),
            active: false,
          });
          return {
            result: {
              ok: true,
              value: updated.row,
            } as ReviewResult<SpecQuestionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "question-answered",
                updated.row.id,
                false,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.answer_question.complete", {
        specId: parsed.specId,
        questionId: parsed.questionId,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async editAttentionRecord(input) {
      const parsed = editAttentionRecordInputSchema.parse(input);
      const actorRefusal = authoringAgentRequired(parsed.actor);
      if (actorRefusal !== null) return actorRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.edit-attention-record",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          if (spec === null) {
            return {
              result: refused(
                "not_found",
                ["Spec not found."],
                "Re-read the attention register.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }

          if (parsed.payload.kind === "question") {
            const current = deps.review.findQuestionById(parsed.recordId);
            if (current === null || current.spec_id !== spec.id) {
              return {
                result: refused(
                  "not_found",
                  ["Question not found."],
                  "Re-read the attention register.",
                ),
                prepared: [],
              };
            }
            if (current.record_version !== parsed.expectedRecordVersion) {
              return { result: staleAttentionRefusal(), prepared: [] };
            }
            if (current.status !== "open") {
              return {
                result: attentionStateRefusal(
                  "Answered and withdrawn questions are immutable history.",
                ),
                prepared: [],
              };
            }
            const snapshot = currentContentSnapshot(repo, spec.id);
            const elementId =
              parsed.payload.attachment === undefined
                ? current.element_id
                : parsed.payload.attachment.kind === "spec"
                  ? null
                  : snapshot === null
                    ? null
                    : resolveElementId(
                        snapshot,
                        parsed.payload.attachment.handle,
                      );
            if (
              parsed.payload.attachment?.kind === "element" &&
              elementId === null
            ) {
              return {
                result: refused(
                  "not_found",
                  ["Question attachment handle not found in current content."],
                  "Re-read the spec and choose an existing element handle.",
                ),
                prepared: [],
              };
            }
            const updated = deps.review.updateOpenQuestion({
              id: current.id,
              expectedRecordVersion: parsed.expectedRecordVersion,
              text: parsed.payload.text ?? current.text,
              elementId,
              updatedAt: occurredAt,
            });
            if (updated.kind !== "success") {
              return {
                result: recordOutcomeRefusal(updated),
                prepared: [],
              };
            }
            appendRecordMutation({
              spec,
              actor: parsed.actor,
              occurredAt,
              operation: "edited",
              before: questionAuditSnapshot(current),
              after: questionAuditSnapshot(updated.row),
              active: true,
            });
            return {
              result: {
                ok: true,
                value: attentionReceipt({
                  operation: "edited",
                  before: current,
                  after: updated.row,
                  draftRevisionId: null,
                  beforeCitationVersion: null,
                  afterCitationVersion: null,
                }),
              } as ReviewResult<SpecAttentionMutationReceipt>,
              prepared: [
                appendAttentionEvent(
                  spec,
                  parsed.actor,
                  occurredAt,
                  "question-edited",
                  current.id,
                  true,
                ),
              ],
            };
          }

          const current = deps.review.findAssumptionById(parsed.recordId);
          if (current === null || current.spec_id !== spec.id) {
            return {
              result: refused(
                "not_found",
                ["Assumption not found."],
                "Re-read the attention register.",
              ),
              prepared: [],
            };
          }
          if (current.record_version !== parsed.expectedRecordVersion) {
            return { result: staleAttentionRefusal(), prepared: [] };
          }
          if (current.disposition !== "proposed") {
            return {
              result: attentionStateRefusal(
                "Disposed assumptions are corrected by supersession.",
              ),
              prepared: [],
            };
          }
          const draft = repo.findDraft(spec.id);
          const draftSnapshot =
            draft === null ? null : repo.getRevisionSnapshot(draft.id);
          if (
            frozenRevisionCites(repo, spec.id, current.id) &&
            draft === null
          ) {
            return {
              result: refused(
                "amendment_required",
                ["The proposed assumption is cited by frozen revision truth."],
                "Open an amendment before correcting the assumption.",
              ),
              prepared: [],
            };
          }
          const contentSnapshot = currentContentSnapshot(repo, spec.id);
          const elementId =
            parsed.payload.attachment === undefined
              ? current.element_id
              : parsed.payload.attachment.kind === "spec"
                ? null
                : contentSnapshot === null
                  ? null
                  : resolveElementId(
                      contentSnapshot,
                      parsed.payload.attachment.handle,
                    );
          if (
            parsed.payload.attachment?.kind === "element" &&
            elementId === null
          ) {
            return {
              result: refused(
                "not_found",
                ["Assumption attachment handle not found in current content."],
                "Re-read the spec and choose an existing element handle.",
              ),
              prepared: [],
            };
          }
          const currentCitations =
            draft === null
              ? []
              : citationsForAssumption(repo, draft.id, current.id);
          let replacementElementIds: string[] | null = null;
          if (parsed.payload.citationIntent?.kind === "replace") {
            if (
              draft === null ||
              draftSnapshot === null ||
              parsed.payload.citationIntent.revisionId !== draft.id
            ) {
              return {
                result: refused(
                  "amendment_required",
                  [
                    "Citation replacement must name the current writable draft.",
                  ],
                  "Open or re-read the amendment and retry against its revision id.",
                ),
                prepared: [],
              };
            }
            replacementElementIds =
              parsed.payload.citationIntent.elementHandles.map((handle) =>
                resolveElementId(draftSnapshot, handle),
              ) as Array<string | null> as string[];
            if (replacementElementIds.some((id) => id === null)) {
              return {
                result: refused(
                  "not_found",
                  [
                    "One or more citation handles are not in the current draft.",
                  ],
                  "Re-read the current draft and choose existing element handles.",
                ),
                prepared: [],
              };
            }
          } else if (
            (parsed.payload.text !== undefined ||
              parsed.payload.attachment !== undefined) &&
            currentCitations.length > 0
          ) {
            replacementElementIds = currentCitations.map(
              (citation) => citation.elementId,
            );
          }
          if (
            replacementElementIds !== null &&
            (draft === null ||
              draftSnapshot === null ||
              parsed.expectedCitationVersion === undefined ||
              parsed.expectedCitationVersion !== draft.citationVersion)
          ) {
            return { result: staleCitationRefusal(), prepared: [] };
          }
          const updated = deps.review.updateProposedAssumption({
            id: current.id,
            expectedRecordVersion: parsed.expectedRecordVersion,
            text: parsed.payload.text ?? current.text,
            elementId,
            updatedAt: occurredAt,
          });
          if (updated.kind !== "success") {
            return {
              result: recordOutcomeRefusal(updated),
              prepared: [],
            };
          }
          let citationOutcome: Extract<
            ReturnType<SpecsRepoTransaction["replaceAssumptionDraftCitations"]>,
            { kind: "success" }
          > | null = null;
          if (
            replacementElementIds !== null &&
            draft !== null &&
            draftSnapshot !== null
          ) {
            const outcome = repo.replaceAssumptionDraftCitations({
              revisionId: draft.id,
              specId: spec.id,
              expectedCitationVersion: draft.citationVersion,
              replacements: [
                {
                  assumptionId: current.id,
                  elementIds: replacementElementIds,
                  snapshot: assumptionCitationSnapshot(updated.row, occurredAt),
                },
              ],
              updatedAt: occurredAt,
            });
            if (outcome.kind !== "success") {
              throw new Error(
                `assumption edit citation mutation failed: ${outcome.kind}`,
              );
            }
            citationOutcome = outcome;
            if (outcome.changed) {
              appendCitationMutation({
                spec,
                actor: parsed.actor,
                occurredAt,
                beforeRevision: draft,
                beforeCitations: draftSnapshot.assumptionCitations,
                outcome,
              });
            }
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "edited",
            before: assumptionAuditSnapshot(current, null),
            after: assumptionAuditSnapshot(updated.row, null),
            active: true,
          });
          const changedCitations =
            citationOutcome?.changed === true && draftSnapshot !== null;
          return {
            result: {
              ok: true,
              value: attentionReceipt({
                operation: "edited",
                before: current,
                after: updated.row,
                draftRevisionId: changedCitations ? (draft?.id ?? null) : null,
                beforeCitationVersion: changedCitations
                  ? (draft?.citationVersion ?? null)
                  : null,
                afterCitationVersion: changedCitations
                  ? (citationOutcome?.revision.citationVersion ?? null)
                  : null,
                added:
                  changedCitations && citationOutcome !== null
                    ? citationHandles(draftSnapshot, citationOutcome.added)
                    : [],
                removed:
                  changedCitations && citationOutcome !== null
                    ? citationHandles(draftSnapshot, citationOutcome.removed)
                    : [],
                refreshed:
                  changedCitations && citationOutcome !== null
                    ? citationHandles(draftSnapshot, citationOutcome.refreshed)
                    : [],
              }),
            } as ReviewResult<SpecAttentionMutationReceipt>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-edited",
                current.id,
                true,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.edit_attention_record.complete", {
        specId: parsed.specId,
        recordId: parsed.recordId,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? {
              recordVersion: transaction.result.value.newRecordVersion,
              citationVersion:
                transaction.result.value.newCitationVersion ?? undefined,
            }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },

    async withdrawAttentionRecord(input) {
      const parsed = withdrawAttentionRecordInputSchema.parse(input);
      const actorRefusal = authoringAgentRequired(parsed.actor);
      if (actorRefusal !== null) return actorRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.withdraw-attention-record",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          if (spec === null) {
            return {
              result: refused(
                "not_found",
                ["Spec not found."],
                "Re-read the attention register.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }
          const question = deps.review.findQuestionById(parsed.recordId);
          if (question !== null && question.spec_id === spec.id) {
            if (question.record_version !== parsed.expectedRecordVersion) {
              return { result: staleAttentionRefusal(), prepared: [] };
            }
            if (question.status !== "open") {
              return {
                result: attentionStateRefusal(
                  "Only an open question can be withdrawn.",
                ),
                prepared: [],
              };
            }
            const updated = deps.review.withdrawOpenQuestion({
              id: question.id,
              expectedRecordVersion: parsed.expectedRecordVersion,
              withdrawnAt: occurredAt,
              updatedAt: occurredAt,
            });
            if (updated.kind !== "success") {
              return {
                result: recordOutcomeRefusal(updated),
                prepared: [],
              };
            }
            appendRecordMutation({
              spec,
              actor: parsed.actor,
              occurredAt,
              operation: "withdrawn",
              before: questionAuditSnapshot(question),
              after: questionAuditSnapshot(updated.row),
              reason: parsed.reason,
              active: false,
            });
            return {
              result: {
                ok: true,
                value: attentionReceipt({
                  operation: "withdrawn",
                  before: question,
                  after: updated.row,
                  draftRevisionId: null,
                  beforeCitationVersion: null,
                  afterCitationVersion: null,
                }),
              } as ReviewResult<SpecAttentionMutationReceipt>,
              prepared: [
                appendAttentionEvent(
                  spec,
                  parsed.actor,
                  occurredAt,
                  "question-withdrawn",
                  question.id,
                  false,
                ),
              ],
            };
          }

          const current = deps.review.findAssumptionById(parsed.recordId);
          if (current === null || current.spec_id !== spec.id) {
            return {
              result: refused(
                "not_found",
                ["Attention record not found."],
                "Re-read the attention register.",
              ),
              prepared: [],
            };
          }
          if (current.record_version !== parsed.expectedRecordVersion) {
            return { result: staleAttentionRefusal(), prepared: [] };
          }
          if (current.disposition !== "proposed") {
            return {
              result: attentionStateRefusal(
                "Only a proposed assumption can be withdrawn.",
              ),
              prepared: [],
            };
          }
          const draft = repo.findDraft(spec.id);
          const draftSnapshot =
            draft === null ? null : repo.getRevisionSnapshot(draft.id);
          if (
            frozenRevisionCites(repo, spec.id, current.id) &&
            draft === null
          ) {
            return {
              result: refused(
                "amendment_required",
                ["The assumption is cited by frozen revision truth."],
                "Open an amendment before withdrawing the assumption.",
              ),
              prepared: [],
            };
          }
          const currentCitations =
            draft === null
              ? []
              : citationsForAssumption(repo, draft.id, current.id);
          if (
            currentCitations.length > 0 &&
            (draft === null ||
              parsed.expectedCitationVersion === undefined ||
              parsed.expectedCitationVersion !== draft.citationVersion)
          ) {
            return { result: staleCitationRefusal(), prepared: [] };
          }
          const updated = deps.review.withdrawProposedAssumption({
            id: current.id,
            expectedRecordVersion: parsed.expectedRecordVersion,
            withdrawnAt: occurredAt,
            updatedAt: occurredAt,
          });
          if (updated.kind !== "success") {
            return {
              result: recordOutcomeRefusal(updated),
              prepared: [],
            };
          }
          let citationOutcome: Extract<
            ReturnType<SpecsRepoTransaction["replaceAssumptionDraftCitations"]>,
            { kind: "success" }
          > | null = null;
          if (
            currentCitations.length > 0 &&
            draft !== null &&
            draftSnapshot !== null
          ) {
            const outcome = repo.replaceAssumptionDraftCitations({
              revisionId: draft.id,
              specId: spec.id,
              expectedCitationVersion: draft.citationVersion,
              replacements: [
                {
                  assumptionId: current.id,
                  elementIds: [],
                  snapshot: assumptionCitationSnapshot(updated.row, occurredAt),
                },
              ],
              updatedAt: occurredAt,
            });
            if (outcome.kind !== "success") {
              throw new Error(
                `assumption withdrawal citation mutation failed: ${outcome.kind}`,
              );
            }
            citationOutcome = outcome;
            if (outcome.changed) {
              appendCitationMutation({
                spec,
                actor: parsed.actor,
                occurredAt,
                beforeRevision: draft,
                beforeCitations: draftSnapshot.assumptionCitations,
                outcome,
              });
            }
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "withdrawn",
            before: assumptionAuditSnapshot(current, null),
            after: assumptionAuditSnapshot(updated.row, null),
            reason: parsed.reason,
            active: false,
          });
          const changedCitations =
            citationOutcome?.changed === true && draftSnapshot !== null;
          return {
            result: {
              ok: true,
              value: attentionReceipt({
                operation: "withdrawn",
                before: current,
                after: updated.row,
                draftRevisionId: draft?.id ?? null,
                beforeCitationVersion: changedCitations
                  ? (draft?.citationVersion ?? null)
                  : null,
                afterCitationVersion: changedCitations
                  ? (citationOutcome?.revision.citationVersion ?? null)
                  : null,
                removed:
                  changedCitations && citationOutcome !== null
                    ? citationHandles(draftSnapshot, citationOutcome.removed)
                    : [],
              }),
            } as ReviewResult<SpecAttentionMutationReceipt>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-withdrawn",
                current.id,
                false,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.withdraw_attention_record.complete", {
        specId: parsed.specId,
        recordId: parsed.recordId,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? {
              recordVersion: transaction.result.value.newRecordVersion,
              citationVersion:
                transaction.result.value.newCitationVersion ?? undefined,
            }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },

    async citeAssumption(input) {
      return mutateAssumptionCitation(input, "cite");
    },

    async unciteAssumption(input) {
      return mutateAssumptionCitation(input, "uncite");
    },

    async supersedeAssumption(input) {
      const parsed = supersedeAssumptionInputSchema.parse(input);
      const actorRefusal = authoringAgentRequired(parsed.actor);
      if (actorRefusal !== null) return actorRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.supersede-assumption",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          if (spec === null) {
            return {
              result: refused(
                "not_found",
                ["Assumption not found."],
                "Re-read the attention register.",
              ),
              prepared: [],
            };
          }
          const existingOperation = deps.review
            .findAssumptionsBySpecId(spec.id)
            .find(
              (assumption) =>
                assumption.supersession_operation_id ===
                parsed.payload.operationId,
            );
          if (existingOperation !== undefined) {
            if (
              existingOperation.supersedes_assumption_id !== parsed.assumptionId
            ) {
              return {
                result: refused(
                  "idempotency_conflict",
                  [
                    "The supersession operation id was already used for different input.",
                  ],
                  "Generate a new operation id after re-reading the existing successor.",
                ),
                prepared: [],
              };
            }
            const operationRevision = supersessionReplayCandidates(
              repo,
              spec.id,
              parsed.draftRevisionId,
            ).find(
              (revision) =>
                supersessionRequestHash({
                  specId: parsed.specId,
                  predecessorAssumptionId: parsed.assumptionId,
                  draftRevisionId: revision.id,
                  payload: parsed.payload,
                }) === existingOperation.supersession_request_hash,
            );
            if (operationRevision === undefined) {
              return {
                result: refused(
                  "idempotency_conflict",
                  [
                    "The supersession operation id was already used for different input.",
                  ],
                  "Generate a new operation id after re-reading the existing successor.",
                ),
                prepared: [],
              };
            }
            const predecessor = deps.review.findAssumptionById(
              parsed.assumptionId,
            );
            if (predecessor === null || predecessor.spec_id !== spec.id) {
              return {
                result: refused(
                  "not_found",
                  ["Supersession replay state was not found."],
                  "Verify the spec's durable attention and revision state.",
                ),
                prepared: [],
              };
            }
            return {
              result: {
                ok: true,
                value: attentionReceipt({
                  operation: "superseded",
                  before: predecessor,
                  after: predecessor,
                  draftRevisionId: operationRevision.id,
                  beforeCitationVersion: operationRevision.citationVersion,
                  afterCitationVersion: operationRevision.citationVersion,
                  successor: existingOperation,
                  idempotentReplay: true,
                }),
              } as ReviewResult<SpecAttentionMutationReceipt>,
              prepared: [],
            };
          }
          const current = deps.review.findAssumptionById(parsed.assumptionId);
          if (current === null || current.spec_id !== parsed.specId) {
            return {
              result: refused(
                "not_found",
                ["Assumption not found."],
                "Re-read the attention register.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }
          const existingSuccessorId = assumptionSuccessorId(
            spec.id,
            current.id,
          );
          if (existingSuccessorId !== null) {
            return {
              result: refused(
                "attention_state_conflict",
                [
                  `${formatBareElementHandle({ kind: "assumption", number: current.number })} is already superseded by ${existingSuccessorId}.`,
                ],
                "Read the existing successor before deciding whether it needs correction.",
              ),
              prepared: [],
            };
          }
          const draft = repo.findDraft(spec.id);
          const draftSnapshot =
            draft === null ? null : repo.getRevisionSnapshot(draft.id);
          if (
            draft === null ||
            draftSnapshot === null ||
            draft.id !== parsed.draftRevisionId
          ) {
            return {
              result: refused(
                "amendment_required",
                ["Supersession requires the current writable amendment draft."],
                "Open or re-read the amendment and retry against its revision id.",
              ),
              prepared: [],
            };
          }
          const requestHash = supersessionRequestHash({
            specId: parsed.specId,
            predecessorAssumptionId: parsed.assumptionId,
            draftRevisionId: draft.id,
            payload: parsed.payload,
          });
          if (current.record_version !== parsed.expectedRecordVersion) {
            return { result: staleAttentionRefusal(), prepared: [] };
          }
          if (
            !["confirmed", "rejected", "deferred"].includes(current.disposition)
          ) {
            return {
              result: attentionStateRefusal(
                "Only a disposed assumption can be corrected by supersession.",
              ),
              prepared: [],
            };
          }
          if (draft.citationVersion !== parsed.expectedCitationVersion) {
            return { result: staleCitationRefusal(), prepared: [] };
          }
          const elementId =
            parsed.payload.attachment.kind === "spec"
              ? null
              : resolveElementId(
                  draftSnapshot,
                  parsed.payload.attachment.handle,
                );
          if (
            parsed.payload.attachment.kind === "element" &&
            elementId === null
          ) {
            return {
              result: refused(
                "not_found",
                ["Successor attachment handle not found in the current draft."],
                "Re-read the draft and choose an existing element handle.",
              ),
              prepared: [],
            };
          }
          const targetElementIds =
            parsed.payload.citations.kind === "clear"
              ? []
              : parsed.payload.citations.elementHandles.map((handle) =>
                  resolveElementId(draftSnapshot, handle),
                );
          if (targetElementIds.some((id) => id === null)) {
            return {
              result: refused(
                "not_found",
                [
                  "One or more successor citation handles are not in the current draft.",
                ],
                "Re-read the draft and choose existing element handles.",
              ),
              prepared: [],
            };
          }
          const successorId = newId("assumption");
          const inserted = deps.review.insertAssumptionSuccessor({
            predecessorId: current.id,
            specId: spec.id,
            expectedRecordVersion: parsed.expectedRecordVersion,
            operationId: parsed.payload.operationId,
            requestHash,
            successor: {
              id: successorId,
              elementId,
              text: parsed.payload.text,
              proposedByJson: stableStringify(parsed.actor),
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          });
          if (inserted.kind === "stale_version") {
            return { result: staleAttentionRefusal(), prepared: [] };
          }
          if (inserted.kind === "idempotency_conflict") {
            return {
              result: refused(
                "idempotency_conflict",
                [
                  "The supersession operation id was already used for different input.",
                ],
                "Generate a new operation id after re-reading the existing successor.",
              ),
              prepared: [],
            };
          }
          if (inserted.kind !== "success") {
            return {
              result: attentionStateRefusal(
                "Re-read the predecessor and its existing successor before retrying.",
              ),
              prepared: [],
            };
          }
          if (inserted.idempotentReplay) {
            throw new Error("supersession replay bypassed service preflight");
          }
          const citationOutcome = repo.replaceAssumptionDraftCitations({
            revisionId: draft.id,
            specId: spec.id,
            expectedCitationVersion: draft.citationVersion,
            replacements: [
              {
                assumptionId: current.id,
                elementIds: [],
                snapshot: assumptionCitationSnapshot(current, occurredAt),
              },
              {
                assumptionId: inserted.successor.id,
                elementIds: targetElementIds.filter(
                  (id): id is string => id !== null,
                ),
                snapshot: assumptionCitationSnapshot(
                  inserted.successor,
                  occurredAt,
                ),
              },
            ],
            updatedAt: occurredAt,
          });
          if (citationOutcome.kind !== "success") {
            throw new Error(
              `assumption supersession citation mutation failed: ${citationOutcome.kind}`,
            );
          }
          if (citationOutcome.changed) {
            appendCitationMutation({
              spec,
              actor: parsed.actor,
              occurredAt,
              beforeRevision: draft,
              beforeCitations: draftSnapshot.assumptionCitations,
              outcome: citationOutcome,
            });
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "superseded",
            before: assumptionAuditSnapshot(current, null),
            after: assumptionAuditSnapshot(
              inserted.predecessor,
              inserted.successor.id,
            ),
            reason: parsed.payload.reason,
            successorAssumptionId: inserted.successor.id,
            active: false,
          });
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "proposed",
            before: null,
            after: assumptionAuditSnapshot(inserted.successor, null),
            active: true,
          });
          return {
            result: {
              ok: true,
              value: attentionReceipt({
                operation: "superseded",
                before: current,
                after: inserted.predecessor,
                draftRevisionId: draft.id,
                beforeCitationVersion: citationOutcome.changed
                  ? draft.citationVersion
                  : null,
                afterCitationVersion: citationOutcome.changed
                  ? citationOutcome.revision.citationVersion
                  : null,
                added: citationHandles(draftSnapshot, citationOutcome.added),
                removed: citationHandles(
                  draftSnapshot,
                  citationOutcome.removed,
                ),
                refreshed: citationHandles(
                  draftSnapshot,
                  citationOutcome.refreshed,
                ),
                successor: inserted.successor,
              }),
            } as ReviewResult<SpecAttentionMutationReceipt>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-superseded",
                current.id,
                false,
              ),
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-proposed",
                inserted.successor.id,
                true,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.supersede_assumption.complete", {
        specId: parsed.specId,
        assumptionId: parsed.assumptionId,
        draftRevisionId: parsed.draftRevisionId,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? {
              recordVersion: transaction.result.value.newRecordVersion,
              citationVersion:
                transaction.result.value.newCitationVersion ?? undefined,
              successorId: transaction.result.value.successor?.id,
              idempotentReplay: transaction.result.value.idempotentReplay,
            }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },

    async proposeAssumption(input) {
      const parsed = proposeAssumptionInputSchema.parse(input);
      const actorRefusal = authoringAgentRequired(parsed.actor);
      if (actorRefusal !== null) return actorRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.propose-assumption",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          if (spec === null) {
            return {
              result: refused(
                "not_found",
                ["Spec not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }
          const draft = repo.findDraft(spec.id);
          const draftSnapshot =
            draft === null ? null : repo.getRevisionSnapshot(draft.id);
          if (parsed.elementId !== null) {
            if (draft === null || draftSnapshot === null) {
              return {
                result: refused(
                  "amendment_required",
                  [
                    "An attached assumption must become revision-owned truth in a writable draft.",
                  ],
                  "Open an amendment, then propose the attached assumption again.",
                ),
                prepared: [],
              };
            }
            if (
              !draftSnapshot.elements.some(
                ({ element }) => element.id === parsed.elementId,
              )
            ) {
              return {
                result: refused(
                  "not_found",
                  [
                    "Assumption attachment element not found in the current draft.",
                  ],
                  "Refresh the draft and choose an existing element.",
                ),
                prepared: [],
              };
            }
          }
          const row: SpecAssumptionRow = {
            id: newId("assumption"),
            spec_id: spec.id,
            number: repo.allocateNumber(spec.id, "A"),
            element_id: parsed.elementId,
            text: parsed.text,
            proposed_by_json: stableStringify(parsed.actor),
            record_version: 1,
            disposition: "proposed",
            disposed_at: null,
            withdrawn_at: null,
            supersedes_assumption_id: null,
            supersession_operation_id: null,
            supersession_request_hash: null,
            created_at: occurredAt,
            updated_at: occurredAt,
          };
          const inserted = deps.review.insertAssumption(row);
          if (inserted.kind !== "success") {
            return {
              result: attentionStateRefusal(
                "Retry after re-reading the attention register.",
              ),
              prepared: [],
            };
          }
          if (
            parsed.elementId !== null &&
            draft !== null &&
            draftSnapshot !== null
          ) {
            const citationOutcome = repo.mutateDraftCitation({
              operation: "cite",
              revisionId: draft.id,
              specId: spec.id,
              assumptionId: inserted.row.id,
              elementId: parsed.elementId,
              expectedCitationVersion: draft.citationVersion,
              snapshot: assumptionCitationSnapshot(inserted.row, occurredAt),
              updatedAt: occurredAt,
            });
            if (citationOutcome.kind !== "success") {
              throw new Error(
                `attached assumption citation failed: ${citationOutcome.kind}`,
              );
            }
            if (citationOutcome.changed) {
              appendCitationMutation({
                spec,
                actor: parsed.actor,
                occurredAt,
                beforeRevision: draft,
                beforeCitations: draftSnapshot.assumptionCitations,
                outcome: citationOutcome,
              });
            }
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "proposed",
            before: null,
            after: assumptionAuditSnapshot(inserted.row, null),
            active: true,
          });
          return {
            result: {
              ok: true,
              value: inserted.row,
            } as ReviewResult<SpecAssumptionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-proposed",
                inserted.row.id,
                true,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.propose_assumption.complete", {
        specId: parsed.specId,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async requestApproval(input) {
      const parsed = requestApprovalInputSchema.parse(input);
      const occurredAt = now();
      let requestedNotice: SpecApprovalRequestNotice | null = null;
      let retiredAttentionIds: string[] = [];
      const transaction = await deps.specs.transaction(
        "specs.review.request-approval",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null) {
            return {
              result: refused(
                "not_found",
                ["Spec revision not found."],
                "Refresh the spec and request approval for an existing revision.",
              ),
              prepared: [],
            };
          }

          // A request is a durable claim on a human's attention, so it is
          // validated against the same gate projection the status read
          // reports rather than against the caller's word (R10.9, R24.1).
          const revisions = repo.listRevisions(target.spec.id);
          const current = latestRevision(revisions);
          const snapshot =
            current === null ? null : repo.getRevisionSnapshot(current.id);
          const run = currentExecution(
            deps.delivery.findExecutionsBySpecId(target.spec.id),
          );
          const approvals = deps.review.findApprovalsBySpecId(target.spec.id);
          const loaded =
            snapshot === null
              ? null
              : loadProposalState(
                  repo,
                  deps.review,
                  deps.links,
                  target.spec,
                  snapshot,
                );
          const applies = loaded?.approvalApplies ?? (() => false);
          const validation = validateApprovalRequest({
            projection: authoringReviewProjection({
              policy: target.spec.gatePolicy,
              snapshot,
              governanceBaseSnapshot: loaded?.governanceBaseSnapshot ?? null,
              importBaselineRows: loaded?.importBaselineRows ?? null,
              importBaselineCitationState:
                loaded?.importBaselineCitationState ?? null,
              approvals,
              admissions: deps.review.findGateAdmissionsBySpecId(
                target.spec.id,
              ),
              currentExecution: run,
              revisionNumberById: new Map(
                revisions.map((revision) => [revision.id, revision.number]),
              ),
              applies,
              blockingThreads: loaded?.reviewSnapshot.blockingThreads ?? [],
              signOffFindings:
                loaded === null
                  ? []
                  : lint(loaded.draft, loaded.records).filter(
                      (finding) => finding.severity === "blocks_signoff",
                    ),
            }),
            requestedRevisionId: target.revision.id,
            currentRevisionId: current?.id ?? null,
            snapshot,
            executionSnapshot:
              run === null
                ? null
                : run.revision_id === snapshot?.revision.id
                  ? snapshot
                  : repo.getRevisionSnapshot(run.revision_id),
            approvals,
            applies,
            gate: parsed.gate,
            subject: parsed.subject ?? null,
          });
          if (!validation.ok) {
            return {
              result: {
                ok: false,
                refusal: validation.refusal,
              } satisfies ReviewResult<CommittedApprovalRequest>,
              prepared: [],
            };
          }
          const request = validation.request;

          // A per-run gate is asked once per run, not once per revision: the
          // run the request covers belongs to its identity (R24.1). Its
          // identity revision is canonicalized to the run's pinned revision —
          // the only revision that run can ever be approved against — so the
          // gate auto-fire (which names the pin) and the CLI (which names the
          // latest revision) converge on one durable ask under an open
          // amendment instead of opening two Needs You entries.
          const executionScoped =
            EXECUTION_SCOPED_GATES.has(parsed.gate) && run !== null;
          const requestExecutionId = executionScoped ? run.id : null;
          const identityRevisionId = executionScoped
            ? run.revision_id
            : target.revision.id;
          const existing = deps.attention.findApprovalRequest(
            executionScoped
              ? {
                  kind: "execution",
                  specId: target.spec.id,
                  revisionId: identityRevisionId,
                  gate: parsed.gate,
                  subject: request.subject,
                  executionId: run.id,
                }
              : {
                  kind: "authoring",
                  specId: target.spec.id,
                  revisionId: identityRevisionId,
                  gate: parsed.gate,
                  scope: request.scope,
                  // A gate ask is one ask however its subject list moves.
                  subject: request.scope === "gate" ? null : request.subject,
                },
          );
          const noticeFor = (
            attentionId: string,
          ): SpecApprovalRequestNotice => ({
            specId: target.spec.id,
            specSlug: target.spec.slug,
            specName: target.spec.name,
            projectPath: target.spec.projectPath,
            gate: parsed.gate,
            subject: request.subject,
            scope: request.scope,
            outstandingSubjects: request.outstandingSubjects,
            signOffOutstanding: request.signOffOutstanding,
            gateRequestId: attentionId,
            occurredAt,
          });
          if (existing !== null) {
            // Rebuild the notice so the notifier runs on every repeat: it
            // dedupes on the stable attention id, so re-invocation is an
            // idempotent ensure — and the only way a Needs You row lost to a
            // notifier crash after the first commit can ever be recovered.
            requestedNotice = noticeFor(existing.attentionId);
            return {
              result: {
                ok: true,
                value: {
                  attentionId: existing.attentionId,
                  revisionId: identityRevisionId,
                  gate: parsed.gate,
                  subject: request.subject,
                  scope: request.scope,
                  elementId: request.elementId,
                  outstandingSubjects: request.outstandingSubjects,
                  signOffOutstanding: request.signOffOutstanding,
                  alreadyRequested: true,
                },
              } satisfies ReviewResult<CommittedApprovalRequest>,
              prepared: [],
            };
          }

          // Requests recorded before scope existed cannot be told apart from a
          // gate ask, so the same ask would open a second entry beside them.
          // They are retired here rather than decoded: the events stay as
          // history, and the scoped request replaces what they were asking.
          // Only the asks this one actually subsumes are retired — a gate ask
          // covers every subject at its gate, an item ask covers its own
          // subject alone — because a legacy ask about another subject is work
          // a human still owes and would otherwise vanish unanswered.
          const retired = executionScoped
            ? []
            : deps.attention
                .listOpenApprovalRequests(target.spec.id)
                .filter(
                  (candidate) =>
                    candidate.scope === null &&
                    candidate.executionId === null &&
                    candidate.gate === parsed.gate &&
                    candidate.revisionId === identityRevisionId &&
                    (request.scope === "gate" ||
                      candidate.subject === request.subject),
                );
          retiredAttentionIds = retired.map(
            (candidate) => candidate.attentionId,
          );

          const value: CommittedApprovalRequest = {
            attentionId: newId("attention"),
            revisionId: identityRevisionId,
            gate: parsed.gate,
            subject: request.subject,
            scope: request.scope,
            elementId: request.elementId,
            outstandingSubjects: request.outstandingSubjects,
            signOffOutstanding: request.signOffOutstanding,
            alreadyRequested: false,
          };
          requestedNotice = noticeFor(value.attentionId);
          return {
            result: {
              ok: true,
              value,
            } as ReviewResult<CommittedApprovalRequest>,
            prepared: [
              ...retired.map((candidate) =>
                appendRequestRetirement(
                  target.spec,
                  parsed.actor,
                  occurredAt,
                  candidate.attentionId,
                  "recorded before approval requests carried a scope",
                ),
              ),
              deps.events.appendInTransaction({
                actor: parsed.actor,
                durableEventType: "spec-attention-changed",
                durablePayload: {
                  kind: "approval-requested",
                  attentionId: value.attentionId,
                  revisionId: value.revisionId,
                  gate: value.gate,
                  scope: value.scope,
                  subject: value.subject,
                  executionId: requestExecutionId,
                  active: true,
                },
                sseEvent: {
                  type: "spec-attention-changed",
                  kind: "approval-requested",
                  projectPath: target.spec.projectPath,
                  specId: target.spec.id,
                  specSlug: target.spec.slug,
                  occurredAt,
                  attentionId: value.attentionId,
                  active: true,
                },
              }),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && retiredAttentionIds.length > 0) {
        notifyRequestsClosed(
          parsed.specId,
          retiredAttentionIds,
          "this request predates approval request scope and was replaced",
          occurredAt,
        );
      }
      // The outcome names the delivery of THIS request's notice alone, because
      // that is the one a repeat of this command re-fires. A retirement notice
      // that failed is logged above and no repeat reaches it, so reporting the
      // request as uncertain would point at a recovery that does not recover.
      let deliveryOutcome: ApprovalRequestDeliveryOutcome = "delivered";
      if (transaction.result.ok && requestedNotice !== null) {
        const notice = requestedNotice;
        deliveryOutcome = notifyAfterCommit(
          "specs.review.approval_request_notify_failed",
          {
            specId: parsed.specId,
            attentionId: transaction.result.value.attentionId,
            gate: parsed.gate,
          },
          () => deps.notifier?.approvalRequested(notice),
        );
      }
      logger.info("specs.review.approval_requested", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        gate: parsed.gate,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? {
              alreadyRequested: transaction.result.value.alreadyRequested,
              deliveryOutcome,
            }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result.ok
        ? {
            ok: true,
            value: { ...transaction.result.value, deliveryOutcome },
          }
        : transaction.result;
    },

    async disposeAssumption(input) {
      const parsed = disposeAssumptionInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.dispose-assumption",
        (repo) => {
          const spec = repo.findById(parsed.specId);
          const current = deps.review.findAssumptionById(parsed.assumptionId);
          if (
            spec === null ||
            current === null ||
            current.spec_id !== parsed.specId
          ) {
            return {
              result: refused(
                "not_found",
                ["Assumption not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          const abandonedRefusal = abandonedSpecRefusal(spec);
          if (abandonedRefusal !== null) {
            return { result: abandonedRefusal, prepared: [] };
          }
          if (current.record_version !== parsed.recordVersion) {
            return { result: staleAttentionRefusal(), prepared: [] };
          }
          if (current.disposition !== "proposed") {
            return {
              result: attentionStateRefusal(
                "Correct a disposed assumption by superseding it from an amendment draft.",
              ),
              prepared: [],
            };
          }
          const draft = repo.findDraft(spec.id);
          const draftSnapshot =
            draft === null ? null : repo.getRevisionSnapshot(draft.id);
          const draftCitations =
            draft === null
              ? []
              : citationsForAssumption(repo, draft.id, current.id);
          if (
            frozenRevisionCites(repo, spec.id, current.id) &&
            draft === null
          ) {
            return {
              result: refused(
                "amendment_required",
                [
                  `${formatBareElementHandle({
                    kind: "assumption",
                    number: current.number,
                  })} is cited by frozen revision truth and has no writable amendment.`,
                ],
                "Open an amendment before recording the disposition.",
              ),
              prepared: [],
            };
          }
          if (
            draftCitations.length > 0 &&
            (draft === null ||
              parsed.citationVersion === undefined ||
              parsed.citationVersion !== draft.citationVersion)
          ) {
            return { result: staleCitationRefusal(), prepared: [] };
          }
          const updated = deps.review.disposeProposedAssumption({
            id: current.id,
            expectedRecordVersion: parsed.recordVersion,
            disposition: parsed.disposition,
            disposedAt: occurredAt,
            updatedAt: occurredAt,
          });
          if (updated.kind !== "success") {
            return {
              result: recordOutcomeRefusal(updated),
              prepared: [],
            };
          }
          if (
            draftCitations.length > 0 &&
            draft !== null &&
            draftSnapshot !== null
          ) {
            const citationOutcome = repo.replaceAssumptionDraftCitations({
              revisionId: draft.id,
              specId: spec.id,
              expectedCitationVersion: draft.citationVersion,
              replacements: [
                {
                  assumptionId: updated.row.id,
                  elementIds: draftCitations.map(
                    (citation) => citation.elementId,
                  ),
                  snapshot: assumptionCitationSnapshot(updated.row, occurredAt),
                },
              ],
              updatedAt: occurredAt,
            });
            if (citationOutcome.kind !== "success") {
              throw new Error(
                `assumption disposition citation refresh failed: ${citationOutcome.kind}`,
              );
            }
            if (citationOutcome.changed) {
              appendCitationMutation({
                spec,
                actor: parsed.actor,
                occurredAt,
                beforeRevision: draft,
                beforeCitations: draftSnapshot.assumptionCitations,
                outcome: citationOutcome,
              });
            }
          }
          appendRecordMutation({
            spec,
            actor: parsed.actor,
            occurredAt,
            operation: "disposed",
            before: assumptionAuditSnapshot(current, null),
            after: assumptionAuditSnapshot(updated.row, null),
            active: false,
          });
          return {
            result: {
              ok: true,
              value: updated.row,
            } as ReviewResult<SpecAssumptionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-disposed",
                updated.row.id,
                false,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.dispose_assumption.complete", {
        specId: parsed.specId,
        assumptionId: parsed.assumptionId,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async changePolicy(input) {
      const parsed = changeSpecPolicyInputSchema.parse(input);
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.change-policy",
        (repo) => {
          const current = repo.findById(parsed.specId);
          if (current === null) {
            return {
              result: refused(
                "not_found",
                ["Spec not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          }
          // R25.1/R25.4: only an open draft is a subject of staging, and even
          // it keeps the stage it opened at — the draft is read here to report
          // what it still owes, never to restage it.
          const openDraft = repo.findDraft(current.id);
          const decision = evaluatePolicyChange({
            actor: parsed.actor,
            currentPolicy: current.gatePolicy,
            proposedPolicy: parsed.proposedPolicy,
            hardConfirmed: parsed.hardConfirmed,
            ...(openDraft === null
              ? {}
              : {
                  openDraft: {
                    revisionNumber: openDraft.number,
                    authoringStage: openDraft.authoringStage,
                  },
                }),
          });
          if (!decision.ok) {
            return {
              result: {
                ok: false,
                refusal: decision.refusal,
              } as ReviewResult<SpecPolicyChangeResult>,
              prepared: [],
            };
          }
          const spec = repo.updateGatePolicy({
            specId: current.id,
            gatePolicy: parsed.proposedPolicy,
            updatedAt: occurredAt,
          });
          const draftSnapshot =
            openDraft === null ? null : repo.getRevisionSnapshot(openDraft.id);
          const authoringSequence =
            draftSnapshot === null
              ? null
              : draftAuthoringSequence({
                  policy: spec.gatePolicy,
                  snapshot: draftSnapshot,
                  governanceBaseSnapshot: snapshotOrNull(
                    repo,
                    governanceBaseRevisionId(
                      repo.listRevisions(spec.id),
                      draftSnapshot.revision,
                    ),
                  ),
                });
          return {
            result: {
              ok: true,
              value: { spec, authoringSequence },
            } as ReviewResult<SpecPolicyChangeResult>,
            prepared: [
              appendPolicyEvent(
                spec,
                current.gatePolicy,
                openDraft?.authoringStage ?? null,
                parsed.actor,
                occurredAt,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.change_policy.complete", {
        specId: parsed.specId,
        preset: parsed.proposedPolicy.preset,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async requestChanges(input) {
      const parsed = requestChangesInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      let endedRequests: OpenApprovalRequest[] = [];
      let reopenedSpec: Spec | null = null;
      const transaction = await deps.specs.transaction(
        "specs.review.request-changes",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          if (target.revision.state !== "proposed")
            return {
              result: refused(
                "gate_blocked",
                ["Only a proposed revision can receive requested changes."],
                "Propose the revision before requesting changes.",
              ),
              prepared: [],
            };
          const reopened = withdrawAndOpenDraft(
            repo,
            target.spec,
            target.revision,
            occurredAt,
          );
          if (!reopened.ok)
            return {
              result: {
                ok: false,
                refusal: reopened.refusal,
              } as ReviewResult<ReopenedProposal>,
              prepared: [],
            };
          const { withdrawn, draft } = reopened;
          reopenedSpec = target.spec;
          endedRequests = authoringRequestsForRevision(
            target.spec.id,
            target.revision.id,
          );
          return {
            result: {
              ok: true,
              value: {
                withdrawn,
                draft,
                approvalLedger: reopenedApprovalLedger(
                  repo,
                  target.spec,
                  draft,
                ),
              },
            } as ReviewResult<ReopenedProposal>,
            prepared: [
              appendEvent(
                target.spec,
                withdrawn.id,
                parsed.actor,
                occurredAt,
                "spec-review-changes-requested",
                "changes-requested",
                undefined,
                parsed.activeStartedAt,
              ),
              ...endedRequests.map((request) =>
                appendRequestRetirement(
                  target.spec,
                  parsed.actor,
                  occurredAt,
                  request.attentionId,
                  "the revision it asked about was sent back for changes",
                ),
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      // The run's own gates outlive the revision: a delivery or
      // execution-start ask belongs to the execution, which an ended review
      // attempt does not touch (R3.6).
      if (transaction.result.ok && endedRequests.length > 0) {
        notifyRequestsClosed(
          parsed.specId,
          endedRequests.map((request) => request.attentionId),
          "the revision it asked about was sent back for changes",
          occurredAt,
        );
      }
      // The moment the draft reopens is the moment the proposer can act — the
      // feedback notice is what tells it to read the comments and repair.
      if (transaction.result.ok && reopenedSpec !== null) {
        emitReviewFeedback(
          reopenedSpec,
          parsed.revisionId,
          "changes_requested",
          null,
          null,
          occurredAt,
          transaction.result.value.approvalLedger,
        );
      }
      return transaction.result;
    },

    async approveItem(input) {
      const parsed = approveItemInputSchema.parse(input);
      const occurredAt = now();
      let grantedNotice: SpecApprovalGrantNotice | null = null;
      const transaction = await deps.specs.transaction(
        "specs.review.approve-item",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          const refusal = validateApprovalSubject(
            repo,
            target.revision,
            parsed,
            parsed.actor,
          );
          if (refusal !== null)
            return {
              result: { ok: false, refusal } as ReviewResult<SpecApprovalRow>,
              prepared: [],
            };
          const row = approvalForSubject(
            parsed.specId,
            parsed.revisionId,
            parsed.subjectKind,
            parsed.elementId,
            parsed.approver,
            occurredAt,
          );
          deps.review.saveApproval(row);
          const answered = requestsSatisfiedByItems(
            target.spec.id,
            target.revision.id,
            [
              parsed.elementId,
              ...approvedElementHandle(
                repo,
                target.revision.id,
                parsed.elementId,
              ),
            ],
          );
          grantedNotice = grantNoticeFor(target.spec, {
            approvalId: row.id,
            satisfiedAttentionIds: answered,
            occurredAt,
          });
          return {
            result: { ok: true, value: row } as ReviewResult<SpecApprovalRow>,
            prepared: [
              appendEvent(
                target.spec,
                target.revision.id,
                parsed.actor,
                occurredAt,
                "spec-review-item-approved",
                "item-approved",
                parsed.elementId,
                parsed.activeStartedAt,
              ),
              ...retireAnsweredRequests(
                target.spec,
                parsed.actor,
                occurredAt,
                answered,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && grantedNotice !== null) {
        deps.notifier?.approvalGranted(grantedNotice);
      }
      return transaction.result;
    },

    async unapproveItem(input) {
      const parsed = unapproveItemInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.unapprove-item",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          if (target.revision.state !== "proposed")
            return {
              result: refused(
                "gate_blocked",
                [
                  "Approvals can be withdrawn only while their revision is proposed.",
                ],
                "Open an amendment to change approved content.",
              ),
              prepared: [],
            };
          const existing = deps.review
            .findApprovalsBySpecId(parsed.specId)
            .find(
              (approval) =>
                approval.subject_kind === parsed.subjectKind &&
                approval.element_id === parsed.elementId,
            );
          if (existing === undefined)
            return {
              result: refused(
                "not_found",
                [`No approval is recorded for ${parsed.elementId}.`],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          deps.review.deleteApproval(existing.id);
          return {
            result: {
              ok: true,
              value: existing,
            } as ReviewResult<SpecApprovalRow>,
            prepared: [
              appendEvent(
                target.spec,
                target.revision.id,
                parsed.actor,
                occurredAt,
                "spec-review-item-unapproved",
                "item-unapproved",
                parsed.elementId,
                parsed.activeStartedAt,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      logger.info("specs.review.unapprove_item.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async bulkApprove(input) {
      const parsed = bulkApproveInputSchema.parse(input);
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.review.bulk-approve",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
              grantedNotice: null,
            };
          return approveSubjectsInTransaction(
            repo,
            target,
            parsed.subjects,
            parsed,
            occurredAt,
          );
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && transaction.grantedNotice !== null) {
        deps.notifier?.approvalGranted(transaction.grantedNotice);
      }
      return transaction.result;
    },

    async signOffRevision(input) {
      const parsed = signOffRevisionInputSchema.parse(input);
      const transaction = await deps.specs.transaction(
        "specs.review.sign-off",
        (repo) => signOffInTransaction(repo, parsed),
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && transaction.grantedNotice !== null) {
        deps.notifier?.approvalGranted(transaction.grantedNotice);
      }
      if (transaction.result.ok) {
        for (const notice of transaction.policyNotices) {
          deps.policyNotifier?.policyAdmitted(notice);
        }
        if (transaction.signedOff !== null) {
          emitReviewFeedback(
            transaction.signedOff.spec,
            parsed.revisionId,
            "signed_off",
            null,
            null,
            transaction.signedOff.occurredAt,
            null,
          );
        }
      }
      return transaction.result;
    },

    /**
     * R#50/#47: the human's convergence act. Every subject the projection still
     * owes plus the revision sign-off land in one transaction, so a review can
     * never come to rest half-approved — the two-step Studio flow it replaces
     * could, and a stranded proposal is exactly what the gap between the steps
     * let through.
     */
    async approveRemainingAndSignOff(input) {
      const parsed = approveRemainingAndSignOffInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      let transaction: CombinedSignOffTransactionOutcome;
      try {
        transaction = await deps.specs.transaction(
          "specs.review.approve-remaining-and-sign-off",
          (repo) => combinedSignOffInTransaction(repo, parsed),
        );
      } catch (error) {
        // The refusal was discovered after the subject approvals were written,
        // and `specs.transaction` unwinds only on a throw. Nothing is applied.
        if (!(error instanceof CombinedSignOffRefusedError)) throw error;
        return { ok: false, refusal: error.refusal };
      }
      publishAll(transaction.prepared);
      if (transaction.result.ok) {
        for (const notice of transaction.grantedNotices) {
          deps.notifier?.approvalGranted(notice);
        }
        for (const notice of transaction.policyNotices) {
          deps.policyNotifier?.policyAdmitted(notice);
        }
        if (transaction.signedOff !== null) {
          emitReviewFeedback(
            transaction.signedOff.spec,
            parsed.revisionId,
            "signed_off",
            null,
            null,
            transaction.signedOff.occurredAt,
            null,
          );
        }
      }
      return transaction.result;
    },

    async grantGateApproval(input) {
      const parsed = grantGateApprovalInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      let grantedNotice: SpecApprovalGrantNotice | null = null;
      const transaction = await deps.specs.transaction(
        "specs.review.grant_gate_approval",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null) {
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ) as ReviewResult<SpecApprovalRow>,
              prepared: [],
            };
          }
          if (target.revision.state !== "approved") {
            return {
              result: refused(
                "gate_blocked",
                [
                  `The ${parsed.gate === "delivery" ? "delivery" : "execution-start"} gate admits only executions pinned to an approved revision.`,
                ],
                "Sign off the revision before approving this gate.",
              ) as ReviewResult<SpecApprovalRow>,
              prepared: [],
            };
          }
          const execution = deps.delivery.findExecutionById(parsed.executionId);
          if (execution === null) {
            return {
              result: refused(
                "not_found",
                [`Execution ${parsed.executionId} was not found.`],
                "Refresh Spec Studio and select an existing execution.",
              ) as ReviewResult<SpecApprovalRow>,
              prepared: [],
            };
          }
          if (
            execution.spec_id !== parsed.specId ||
            execution.revision_id !== parsed.revisionId
          ) {
            return {
              result: refused(
                "validation",
                [
                  "The execution does not belong to this spec's pinned revision.",
                ],
                "Select the execution pinned to this approved revision.",
              ) as ReviewResult<SpecApprovalRow>,
              prepared: [],
            };
          }
          const existingAdmission = deps.review
            .findGateAdmissionsByRevision(parsed.revisionId)
            .find(
              (admission) =>
                admission.gate === parsed.gate &&
                admission.execution_id === parsed.executionId &&
                admission.basis === "human_approval",
            );
          if (existingAdmission !== undefined) {
            const existingApproval = deps.review
              .findApprovalsBySpecId(parsed.specId)
              .find(
                (approval) => approval.id === existingAdmission.approval_id,
              );
            if (existingApproval !== undefined) {
              // Re-fire the grant notice so any approval request re-opened
              // after the original grant still clears; the notifier dedupes
              // per request, so already-cleared requests stay single-row.
              grantedNotice = grantNoticeFor(target.spec, {
                approvalId: existingApproval.id,
                satisfiedAttentionIds: requestsSatisfiedByRunGate(
                  parsed.specId,
                  parsed.gate,
                  parsed.executionId,
                ),
                occurredAt,
              });
              return {
                result: {
                  ok: true,
                  value: existingApproval,
                } as ReviewResult<SpecApprovalRow>,
                prepared: [],
              };
            }
          }
          const approval: SpecApprovalRow = {
            id: newId("approval"),
            spec_id: parsed.specId,
            subject_kind: "revision",
            element_id: null,
            revision_id: parsed.revisionId,
            approver: parsed.approver,
            granted_at: occurredAt,
            validity: "valid",
          };
          deps.review.saveApproval(approval);
          deps.review.insertGateAdmission({
            id: newId("admission"),
            spec_id: parsed.specId,
            gate: parsed.gate,
            basis: "human_approval",
            approval_id: approval.id,
            revision_id: parsed.revisionId,
            execution_id: parsed.executionId,
            actor_json: stableStringify(parsed.actor),
            created_at: occurredAt,
          });
          grantedNotice = grantNoticeFor(target.spec, {
            approvalId: approval.id,
            satisfiedAttentionIds: requestsSatisfiedByRunGate(
              parsed.specId,
              parsed.gate,
              parsed.executionId,
            ),
            occurredAt,
          });
          return {
            result: {
              ok: true,
              value: approval,
            } as ReviewResult<SpecApprovalRow>,
            prepared: [
              appendEvent(
                target.spec,
                parsed.revisionId,
                parsed.actor,
                occurredAt,
                "spec-review-item-approved",
                parsed.gate === "delivery"
                  ? "delivery-approval-granted"
                  : "execution-start-approval-granted",
                parsed.executionId,
                parsed.activeStartedAt,
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && grantedNotice !== null) {
        deps.notifier?.approvalGranted(grantedNotice);
      }
      logger.info("specs.review.gate_approval.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        executionId: parsed.executionId,
        gate: parsed.gate,
        ok: transaction.result.ok,
      });
      return transaction.result;
    },

    async withdraw(input) {
      const parsed = requestChangesInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
      let endedRequests: OpenApprovalRequest[] = [];
      const transaction = await deps.specs.transaction(
        "specs.review.withdraw",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                ["Review target not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
            };
          if (target.revision.state !== "proposed")
            return {
              result: refused(
                "gate_blocked",
                ["Only a proposed revision can be withdrawn."],
                "Propose the revision before withdrawing it.",
              ),
              prepared: [],
            };
          const revision = repo.withdrawRevision({
            revisionId: parsed.revisionId,
          });
          endedRequests = authoringRequestsForRevision(
            target.spec.id,
            parsed.revisionId,
          );
          return {
            result: { ok: true, value: revision } as ReviewResult<SpecRevision>,
            prepared: [
              appendEvent(
                target.spec,
                revision.id,
                parsed.actor,
                occurredAt,
                "spec-review-changes-requested",
                "withdrawn",
                undefined,
                parsed.activeStartedAt,
              ),
              ...endedRequests.map((request) =>
                appendRequestRetirement(
                  target.spec,
                  parsed.actor,
                  occurredAt,
                  request.attentionId,
                  "the revision it asked about was withdrawn",
                ),
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && endedRequests.length > 0) {
        notifyRequestsClosed(
          parsed.specId,
          endedRequests.map((request) => request.attentionId),
          "the revision it asked about was withdrawn",
          occurredAt,
        );
      }
      return transaction.result;
    },

    async dismissSupersededProposal(input) {
      const parsed = dismissSupersededProposalInputSchema.parse(input);
      type DismissResult = ReviewResult<{
        withdrawn: SpecRevision;
        supersession: SpecRevisionSupersession;
      }>;
      if (parsed.actor.kind !== "human") {
        return {
          ok: false,
          refusal: dismissSupersededHumanActRefusal(parsed.revisionId),
        } satisfies DismissResult;
      }
      const occurredAt = now();
      let endedRequests: OpenApprovalRequest[] = [];
      const closedReason = "the revision it asked about was superseded";
      const transaction = await deps.specs.transaction(
        "specs.review.dismiss-superseded-proposal",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                [
                  `Revision ${parsed.revisionId} is not a revision of this spec.`,
                ],
                "Reopen the spec in Spec Studio and dismiss the proposal the Review tab lists.",
              ),
              prepared: [],
            };
          // The eligibility question is asked inside the transaction, over the
          // same predicate the Studio surfaces and verification read, so a
          // dismissal cannot commit against a lineage that changed since the
          // human saw the button.
          const superseding = supersedingRevision(
            repo.listRevisions(parsed.specId),
            parsed.revisionId,
          );
          if (superseding === null)
            return {
              result: {
                ok: false,
                refusal: dismissSupersededIneligibleRefusal(target.revision),
              } as DismissResult,
              prepared: [],
            };
          const { revision: withdrawn, supersession } = repo.supersedeRevision({
            revisionId: parsed.revisionId,
            supersededByRevisionId: superseding.id,
            reason: parsed.reason,
            actor: parsed.actor,
            dismissedAt: occurredAt,
          });
          endedRequests = authoringRequestsForRevision(
            target.spec.id,
            target.revision.id,
          );
          return {
            result: {
              ok: true,
              value: { withdrawn, supersession },
            } as DismissResult,
            prepared: [
              appendProposalDismissedEvent(
                target.spec,
                withdrawn.id,
                superseding.id,
                parsed.reason,
                parsed.actor,
                occurredAt,
              ),
              ...endedRequests.map((request) =>
                appendRequestRetirement(
                  target.spec,
                  parsed.actor,
                  occurredAt,
                  request.attentionId,
                  closedReason,
                ),
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && endedRequests.length > 0) {
        notifyRequestsClosed(
          parsed.specId,
          endedRequests.map((request) => request.attentionId),
          closedReason,
          occurredAt,
        );
      }
      logger.info("specs.review.dismiss_superseded_proposal.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? {
              supersededByRevisionId:
                transaction.result.value.supersession.supersededByRevisionId,
            }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },

    async withdrawProposal(input) {
      const parsed = withdrawProposalInputSchema.parse(input);
      const occurredAt = now();
      const closedReason = "its author withdrew the proposal";
      let endedRequests: OpenApprovalRequest[] = [];
      const transaction = await deps.specs.transaction(
        "specs.review.withdraw-proposal",
        (repo) => {
          const target = requireReviewTarget(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          if (target === null)
            return {
              result: refused(
                "not_found",
                [
                  `Revision ${parsed.revisionId} is not a revision of this spec.`,
                ],
                "Quote the revision id the propose returned; it is the compare-and-swap token for this withdrawal.",
              ),
              prepared: [],
            };
          // Read the durable log inside the transaction: a human approval
          // committing between the check and the withdrawal is exactly the
          // race this verb must lose.
          const decision = evaluateProposalWithdrawal({
            revision: target.revision,
            caller: parsed.actor,
            events: deps.attention.findBySpecId(target.spec.id),
            endedThreadIds: humanEndedThreadIds(target.revision.id),
          });
          if (!decision.ok)
            return {
              result: {
                ok: false,
                refusal: decision.refusal,
              } as ReviewResult<ReopenedProposal>,
              prepared: [],
            };
          const reopened = withdrawAndOpenDraft(
            repo,
            target.spec,
            target.revision,
            occurredAt,
          );
          if (!reopened.ok)
            return {
              result: {
                ok: false,
                refusal: reopened.refusal,
              } as ReviewResult<ReopenedProposal>,
              prepared: [],
            };
          const { withdrawn, draft } = reopened;
          endedRequests = authoringRequestsForRevision(
            target.spec.id,
            target.revision.id,
          );
          return {
            result: {
              ok: true,
              value: {
                withdrawn,
                draft,
                approvalLedger: reopenedApprovalLedger(
                  repo,
                  target.spec,
                  draft,
                ),
              },
            } as ReviewResult<ReopenedProposal>,
            prepared: [
              appendProposalWithdrawnEvent(
                target.spec,
                withdrawn.id,
                decision.proposer,
                decision.withdrawnBy,
                draft.id,
                occurredAt,
              ),
              ...endedRequests.map((request) =>
                appendRequestRetirement(
                  target.spec,
                  parsed.actor,
                  occurredAt,
                  request.attentionId,
                  closedReason,
                ),
              ),
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && endedRequests.length > 0) {
        notifyRequestsClosed(
          parsed.specId,
          endedRequests.map((request) => request.attentionId),
          closedReason,
          occurredAt,
        );
      }
      logger.info("specs.review.withdraw_proposal.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? {}
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },
  };
}
