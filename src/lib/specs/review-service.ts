import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  actorProvenanceSchema,
  specAssumptionDispositionSchema,
  specGateSchema,
  specGatePolicySchema,
  type ActorProvenance,
  type Spec,
  type SpecGate,
  type SpecApprovalRow,
  type SpecAssumptionRow,
  type SpecCommentRow,
  type SpecQuestionRow,
  type SpecRevision,
} from "@/lib/specs/schemas";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type {
  SpecsRepo,
  SpecsRepoTransaction,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import { COMBINED_APPROVAL_DIAL, resolveDial } from "./policy";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import { loadProposalState } from "./review-state";
import {
  approveElement,
  changePolicy as evaluatePolicyChange,
  signOffRevision as evaluateSignOffRevision,
  type TransitionRefusal,
} from "./transitions";
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
    parentCommentId: z.string().min(1).nullable(),
    anchor: z.unknown(),
    body: z.string(),
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

export const requestChangesInputSchema = reviewIdentitySchema;
export type RequestChangesInput = z.infer<typeof requestChangesInputSchema>;

export const approveItemInputSchema = reviewIdentitySchema
  .extend({
    subjectKind: z.enum(["requirement", "decision"]),
    elementId: z.string().min(1),
    approver: z.string().min(1),
  })
  .strict();
export type ApproveItemInput = z.infer<typeof approveItemInputSchema>;

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
    subject: z.string().min(1),
  })
  .strict();
export type RequestApprovalInput = z.infer<typeof requestApprovalInputSchema>;

export const approvalRequestReceiptSchema = requestApprovalInputSchema
  .omit({ specId: true, actor: true })
  .extend({ attentionId: z.string().min(1) })
  .strict();
export type ApprovalRequestReceipt = z.infer<
  typeof approvalRequestReceiptSchema
>;

export const disposeAssumptionInputSchema = z
  .object({
    specId: z.string().min(1),
    assumptionId: z.string().min(1),
    disposition: specAssumptionDispositionSchema.exclude(["proposed"]),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DisposeAssumptionInput = z.infer<
  typeof disposeAssumptionInputSchema
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

export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

export interface ReviewService {
  comment(input: ReviewCommentInput): Promise<ReviewResult<SpecCommentRow>>;
  resolveThread(
    input: ResolveReviewThreadInput,
  ): Promise<ReviewResult<SpecCommentRow[]>>;
  requestChanges(
    input: RequestChangesInput,
  ): Promise<ReviewResult<{ withdrawn: SpecRevision; draft: SpecRevision }>>;
  approveItem(input: ApproveItemInput): Promise<ReviewResult<SpecApprovalRow>>;
  signOffRevision(input: SignOffRevisionInput): Promise<
    ReviewResult<{
      revision: SpecRevision;
      approval: SpecApprovalRow | null;
    }>
  >;
  grantGateApproval(
    input: GrantGateApprovalInput,
  ): Promise<ReviewResult<SpecApprovalRow>>;
  withdraw(input: RequestChangesInput): Promise<ReviewResult<SpecRevision>>;
  bulkApprove(
    input: BulkApproveInput,
  ): Promise<ReviewResult<SpecApprovalRow[]>>;
  openQuestion(
    input: OpenQuestionInput,
  ): Promise<ReviewResult<SpecQuestionRow>>;
  answerQuestion(
    input: AnswerQuestionInput,
  ): Promise<ReviewResult<SpecQuestionRow>>;
  proposeAssumption(
    input: ProposeAssumptionInput,
  ): Promise<ReviewResult<SpecAssumptionRow>>;
  requestApproval(
    input: RequestApprovalInput,
  ): Promise<ReviewResult<ApprovalRequestReceipt>>;
  disposeAssumption(
    input: DisposeAssumptionInput,
  ): Promise<ReviewResult<SpecAssumptionRow>>;
  changePolicy(input: ChangeSpecPolicyInput): Promise<ReviewResult<Spec>>;
}

export interface SpecApprovalRequestNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  gate: SpecGate;
  subject: string;
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
  /** Gates this human act admits; open requests with these gates are satisfied. */
  satisfiedGates: SpecGate[];
  /**
   * Subjects this act approved; open requests whose subject matches exactly
   * are satisfied regardless of gate. Element approvals report BOTH the
   * internal element id and the element's durable display handle (R1, D1):
   * requests are stored under the handle a human or agent typed, and element
   * numbers are append-only per spec, so the handle is a stable correlation
   * identity. Non-element acts report "plan"/"revision".
   */
  approvedSubjects: string[];
  occurredAt: string;
}

/**
 * Outbound port for durable human-facing approval notifications. Called only
 * after the review transaction commits; the composed implementation owns
 * matching grants to open requests and notification dedupe.
 */
export interface SpecReviewNotifier {
  approvalRequested(notice: SpecApprovalRequestNotice): void;
  approvalGranted(notice: SpecApprovalGrantNotice): void;
}

export interface ReviewServiceDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
  delivery: Pick<
    SpecDeliveryRepo,
    "findExecutionById" | "findWaiversBySpecId" | "saveWaiver"
  >;
  links: Pick<SpecLinksRepo, "findBySpecId">;
  events: SpecEventsPublisher;
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
  return { ok: false, refusal: { code, unmetConditions, instruction } };
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

  function grantNoticeFor(
    spec: Spec,
    notice: Pick<
      SpecApprovalGrantNotice,
      "approvalId" | "satisfiedGates" | "approvedSubjects" | "occurredAt"
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

  function appendEvent(
    spec: Spec,
    revisionId: string,
    actor: ActorProvenance,
    occurredAt: string,
    durableEventType:
      | "spec-review-commented"
      | "spec-review-changes-requested"
      | "spec-review-item-approved"
      | "spec-review-revision-signed-off",
    kind: string,
    subjectId?: string,
    activeStartedAt?: string,
  ): PreparedSpecEventPublication {
    const approvalChanged = durableEventType === "spec-review-item-approved";
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

  function appendPolicyEvent(
    spec: Spec,
    actor: ActorProvenance,
    occurredAt: string,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-changed",
      durablePayload: { kind: "policy-changed", policy: spec.gatePolicy },
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

  return {
    async comment(input) {
      const parsed = reviewCommentInputSchema.parse(input);
      const humanRefusal = humanRequired(parsed.actor);
      if (humanRefusal !== null) return humanRefusal;
      const occurredAt = now();
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
            status: "open",
            answer: null,
            answered_at: null,
            created_at: occurredAt,
            updated_at: occurredAt,
          };
          deps.review.saveQuestion(row);
          return {
            result: {
              ok: true,
              value: row,
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
          if (current.status !== "open") {
            return {
              result: refused(
                "gate_blocked",
                ["Only an open question can be answered."],
                "Open a new question if further clarification is needed.",
              ),
              prepared: [],
            };
          }
          const row: SpecQuestionRow = {
            ...current,
            status: "answered",
            answer: parsed.answer,
            answered_at: occurredAt,
            updated_at: occurredAt,
          };
          deps.review.saveQuestion(row);
          return {
            result: {
              ok: true,
              value: row,
            } as ReviewResult<SpecQuestionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "question-answered",
                row.id,
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

    async proposeAssumption(input) {
      const parsed = proposeAssumptionInputSchema.parse(input);
      if (parsed.actor.kind !== "agent") {
        return refused(
          "gate_blocked",
          ["Assumptions are proposed by agents for human disposition."],
          "Record a human decision as intent or ask an agent to propose the assumption.",
        );
      }
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
          if (
            parsed.elementId !== null &&
            !elementBelongsToSpec(repo, spec.id, parsed.elementId)
          ) {
            return {
              result: refused(
                "not_found",
                ["Assumption attachment element not found."],
                "Refresh the spec and choose an existing element.",
              ),
              prepared: [],
            };
          }
          const row: SpecAssumptionRow = {
            id: newId("assumption"),
            spec_id: spec.id,
            number: repo.allocateNumber(spec.id, "A"),
            element_id: parsed.elementId,
            text: parsed.text,
            proposed_by_json: stableStringify(parsed.actor),
            disposition: "proposed",
            disposed_at: null,
            created_at: occurredAt,
            updated_at: occurredAt,
          };
          deps.review.saveAssumption(row);
          return {
            result: {
              ok: true,
              value: row,
            } as ReviewResult<SpecAssumptionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-proposed",
                row.id,
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
          const value: ApprovalRequestReceipt = {
            attentionId: newId("attention"),
            revisionId: target.revision.id,
            gate: parsed.gate,
            subject: parsed.subject,
          };
          requestedNotice = {
            specId: target.spec.id,
            specSlug: target.spec.slug,
            specName: target.spec.name,
            projectPath: target.spec.projectPath,
            gate: parsed.gate,
            subject: parsed.subject,
            gateRequestId: value.attentionId,
            occurredAt,
          };
          return {
            result: { ok: true, value } as ReviewResult<ApprovalRequestReceipt>,
            prepared: [
              deps.events.appendInTransaction({
                actor: parsed.actor,
                durableEventType: "spec-attention-changed",
                durablePayload: {
                  kind: "approval-requested",
                  attentionId: value.attentionId,
                  revisionId: value.revisionId,
                  gate: value.gate,
                  subject: value.subject,
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
      if (transaction.result.ok && requestedNotice !== null) {
        deps.notifier?.approvalRequested(requestedNotice);
      }
      logger.info("specs.review.approval_requested", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        gate: parsed.gate,
        ok: transaction.result.ok,
      });
      return transaction.result;
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
          const citedByApprovedRevision =
            current.element_id !== null &&
            repo
              .listRevisions(spec.id)
              .filter((revision) => revision.state === "approved")
              .some(
                (revision) =>
                  revision.proposedAt !== null &&
                  current.created_at <= revision.proposedAt &&
                  repo
                    .getRevisionSnapshot(revision.id)
                    ?.elements.some(
                      ({ element }) => element.id === current.element_id,
                    ) === true,
              );
          if (
            current.disposition !== parsed.disposition &&
            citedByApprovedRevision
          ) {
            return {
              result: refused(
                "amendment_required",
                [
                  `A${current.number} is cited by approved content and cannot change in place.`,
                ],
                "Open an amendment and update the cited content before changing this disposition.",
              ),
              prepared: [],
            };
          }
          const row: SpecAssumptionRow = {
            ...current,
            disposition: parsed.disposition,
            disposed_at: occurredAt,
            updated_at: occurredAt,
          };
          deps.review.saveAssumption(row);
          return {
            result: {
              ok: true,
              value: row,
            } as ReviewResult<SpecAssumptionRow>,
            prepared: [
              appendAttentionEvent(
                spec,
                parsed.actor,
                occurredAt,
                "assumption-disposed",
                row.id,
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
          const decision = evaluatePolicyChange({
            actor: parsed.actor,
            currentPolicy: current.gatePolicy,
            proposedPolicy: parsed.proposedPolicy,
            hardConfirmed: parsed.hardConfirmed,
          });
          if (!decision.ok) {
            return {
              result: {
                ok: false,
                refusal: decision.refusal,
              } as ReviewResult<Spec>,
              prepared: [],
            };
          }
          const spec = repo.updateGatePolicy({
            specId: current.id,
            gatePolicy: parsed.proposedPolicy,
            updatedAt: occurredAt,
          });
          return {
            result: { ok: true, value: spec } as ReviewResult<Spec>,
            prepared: [appendPolicyEvent(spec, parsed.actor, occurredAt)],
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
          const withdrawn = repo.withdrawRevision({
            revisionId: target.revision.id,
          });
          const draft = repo.createDraftFromBase({
            id: newId("revision"),
            specId: target.spec.id,
            baseRevisionId: withdrawn.id,
            createdAt: occurredAt,
          });
          return {
            result: { ok: true, value: { withdrawn, draft } } as ReviewResult<{
              withdrawn: SpecRevision;
              draft: SpecRevision;
            }>,
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
            ],
          };
        },
      );
      publishAll(transaction.prepared);
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
          grantedNotice = grantNoticeFor(target.spec, {
            approvalId: row.id,
            satisfiedGates: [],
            approvedSubjects: [
              parsed.elementId,
              ...approvedElementHandle(
                repo,
                target.revision.id,
                parsed.elementId,
              ),
            ],
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

    async bulkApprove(input) {
      const parsed = bulkApproveInputSchema.parse(input);
      const occurredAt = now();
      let grantedNotice: SpecApprovalGrantNotice | null = null;
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
            };
          for (const subject of parsed.subjects) {
            const refusal = validateApprovalSubject(
              repo,
              target.revision,
              subject,
              parsed.actor,
            );
            if (refusal !== null)
              return {
                result: { ok: false, refusal } as ReviewResult<
                  SpecApprovalRow[]
                >,
                prepared: [],
              };
          }
          const rows = parsed.subjects.map((subject) =>
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
          grantedNotice = grantNoticeFor(target.spec, {
            approvalId: rows[0]?.id ?? null,
            satisfiedGates: [],
            approvedSubjects: parsed.subjects.flatMap((subject) =>
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
            occurredAt,
          });
          return {
            result: { ok: true, value: rows } as ReviewResult<
              SpecApprovalRow[]
            >,
            prepared: rows.map((row) =>
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
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && grantedNotice !== null) {
        deps.notifier?.approvalGranted(grantedNotice);
      }
      return transaction.result;
    },

    async signOffRevision(input) {
      const parsed = signOffRevisionInputSchema.parse(input);
      let grantedNotice: SpecApprovalGrantNotice | null = null;
      const policyNotices: SpecPolicyAdmissionNotice[] = [];
      const transaction = await deps.specs.transaction(
        "specs.review.sign-off",
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
            };
          }
          const occurredAt = now();
          const snapshot = repo.getRevisionSnapshot(target.revision.id);
          if (snapshot === null)
            return {
              result: refused(
                "not_found",
                ["Revision snapshot not found."],
                "Refresh Spec Studio.",
              ),
              prepared: [],
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
            policy: target.spec.gatePolicy,
            draft: loaded.draft,
            records: loaded.records,
            review: loaded.reviewSnapshot,
          });
          if (!decision.ok)
            return {
              result: { ok: false, refusal: decision.refusal } as ReviewResult<{
                revision: SpecRevision;
                approval: SpecApprovalRow | null;
              }>,
              prepared: [],
            };
          const resolvedGates = (
            ["requirements", "design", "plan"] as const
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
          const allCombined = resolvedGates.every(
            ({ dial }) => dial === COMBINED_APPROVAL_DIAL,
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
                { subjectKind: "plan", elementId: null } as const,
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
            const basis = policyAdmitted
              ? dial === "notify"
                ? ("notify_policy" as const)
                : ("off_policy" as const)
              : ("human_approval" as const);
            if (
              !policyAdmitted &&
              dial !== "gate" &&
              dial !== COMBINED_APPROVAL_DIAL
            )
              continue;
            if (
              existingAdmissions.some(
                (admission) =>
                  admission.gate === gate && admission.basis === basis,
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
          grantedNotice = grantNoticeFor(target.spec, {
            approvalId: approval?.id ?? null,
            satisfiedGates: ["requirements", "design", "plan"],
            approvedSubjects: [
              ...combinedSubjects.map((subject) => subject.elementId ?? "plan"),
              "revision",
            ],
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
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      if (transaction.result.ok && grantedNotice !== null) {
        deps.notifier?.approvalGranted(grantedNotice);
      }
      if (transaction.result.ok) {
        for (const notice of policyNotices) {
          deps.policyNotifier?.policyAdmitted(notice);
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
                satisfiedGates: [parsed.gate],
                approvedSubjects: [],
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
            satisfiedGates: [parsed.gate],
            approvedSubjects: [],
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
            ],
          };
        },
      );
      publishAll(transaction.prepared);
      return transaction.result;
    },
  };
}
