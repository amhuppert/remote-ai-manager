import { z } from "zod";

import {
  evidenceKindSchema,
  type EvidenceKind,
  type SpecEventType,
} from "./schemas";

export const MEASURE_DEFINITIONS_VERSION = "native-sdd-measures-v2";

export interface TaskClaimReopenedPayload {
  kind: "task-claim-reopened";
  claimId: string;
  taskId: string;
  changedIntentElementIds: string[];
}

export interface PostApprovalRevisionCreatedPayload {
  kind: "post-approval-revision-created";
  revisionId: string;
  nonTrivial: boolean;
  changedIntentElementIds: string[];
}

export interface ReviewActionPayload {
  kind: "review-action";
  action:
    | "comment"
    | "request_changes"
    | "approve_item"
    | "unapprove_item"
    | "sign_off";
  reviewAttemptId: string;
  activeStartedAt: string;
  subjectId?: string;
  revisionId?: string;
}

export interface ApprovalStaledPayload {
  kind: "approval-staled";
  subjectId: string;
}

export interface CriterionDeliveredInScopePayload {
  kind: "criterion-delivered-in-scope";
  criterionId: string;
  requirementId: string;
  revisionId: string;
  executionId: string;
  taskIds: string[];
}

export interface EvidenceAttachedPayload {
  kind: "evidence-attached";
  evidenceId: string;
  criterionId: string;
  revisionId: string;
  evidenceKind: EvidenceKind;
  source: "execution_ingest" | "manual";
  evaluatedCommitSha?: string;
}

export interface ProofVerdictRecordedPayload {
  kind: "proof-verdict-recorded";
  verdictId: string;
  criterionId: string;
  revisionId: string;
  evidenceIds: string[];
  valid: boolean;
}

export interface DeliveryVerdictRecordedPayload {
  kind: "delivery-verdict-recorded";
  verdictId: string;
  criterionId: string;
  revisionId: string;
  executionId: string;
  workflowExecutionId: string;
  candidateId: string;
  candidateHash: string;
  satisfyingContextId: string;
}

export type SpecMeasureEventPayload =
  | TaskClaimReopenedPayload
  | PostApprovalRevisionCreatedPayload
  | ReviewActionPayload
  | ApprovalStaledPayload
  | CriterionDeliveredInScopePayload
  | EvidenceAttachedPayload
  | ProofVerdictRecordedPayload
  | DeliveryVerdictRecordedPayload;

export const specMeasureEventPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-claim-reopened"),
      claimId: z.string().min(1),
      taskId: z.string().min(1),
      changedIntentElementIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("post-approval-revision-created"),
      revisionId: z.string().min(1),
      nonTrivial: z.boolean(),
      changedIntentElementIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review-action"),
      action: z.enum([
        "comment",
        "request_changes",
        "approve_item",
        "unapprove_item",
        "sign_off",
      ]),
      reviewAttemptId: z.string().min(1),
      activeStartedAt: z.string().min(1),
      subjectId: z.string().min(1).optional(),
      revisionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval-staled"),
      subjectId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("criterion-delivered-in-scope"),
      criterionId: z.string().min(1),
      requirementId: z.string().min(1),
      revisionId: z.string().min(1),
      executionId: z.string().min(1),
      taskIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("evidence-attached"),
      evidenceId: z.string().min(1),
      criterionId: z.string().min(1),
      revisionId: z.string().min(1),
      evidenceKind: evidenceKindSchema,
      source: z.enum(["execution_ingest", "manual"]),
      evaluatedCommitSha: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proof-verdict-recorded"),
      verdictId: z.string().min(1),
      criterionId: z.string().min(1),
      revisionId: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)),
      valid: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delivery-verdict-recorded"),
      verdictId: z.string().min(1),
      criterionId: z.string().min(1),
      revisionId: z.string().min(1),
      executionId: z.string().min(1),
      workflowExecutionId: z.string().min(1),
      candidateId: z.string().min(1),
      candidateHash: z.string().min(1),
      satisfyingContextId: z.string().min(1),
    })
    .strict(),
]);

export interface SpecMeasureEvent {
  id: number;
  specId: string;
  occurredAt: string;
  eventType: SpecEventType;
  payload: SpecMeasureEventPayload;
}

export interface TaskCommitMeasureEvent {
  id: number;
  occurredAt: string;
  eventType: "task-commit-recorded";
  executionId: string;
  taskId: string;
  commitSha: string;
}

export interface MergeCompletedMeasureEvent {
  id: number;
  occurredAt: string;
  eventType: "merge-completed";
  executionId: string;
  mergeId: string;
  mergeCommitSha: string;
}

export type LinkedWorkflowMeasureEvent =
  | TaskCommitMeasureEvent
  | MergeCompletedMeasureEvent;

export interface RequirementCausedReworkMeasure {
  reopenedClaimCount: number;
  postApprovalRevisionCount: number;
  totalReworkEventCount: number;
  claimIds: string[];
  revisionIds: string[];
}

export interface ApprovalFrictionMeasure {
  activeReviewTimeMs: number;
  interventionCount: number;
  reapprovalLoopCount: number;
}

export interface TraceabilityCompletenessMeasure {
  deliveredInScopeCriterionCount: number;
  completeChainCount: number;
  share: number | null;
  completeCriterionIds: string[];
  incompleteCriterionIds: string[];
}

export interface AutomaticEvidenceCaptureMeasure {
  automaticallyIngestedCount: number;
  manuallyAttachedCount: number;
  totalEvidenceCount: number;
  share: number | null;
}

export interface SpecMeasures {
  definitionsVersion: string;
  requirementCausedRework: RequirementCausedReworkMeasure;
  approvalFriction: ApprovalFrictionMeasure;
  traceabilityCompleteness: TraceabilityCompletenessMeasure;
  automaticEvidenceCapture: AutomaticEvidenceCaptureMeasure;
}

export interface ChangedCodeNavigation {
  eventId: number;
  commitSha: string;
}

export interface TaskNavigation {
  taskId: string;
  changedCode: ChangedCodeNavigation[];
}

export interface DeliveryVerdictNavigation {
  verdictId: string;
  workflowExecutionId: string;
  candidateId: string;
  candidateHash: string;
  satisfyingContextId: string;
}

export interface MergeResultNavigation {
  eventId: number;
  mergeId: string;
  mergeCommitSha: string;
}

export interface ReviewerNavigationChain {
  criterionId: string;
  requirementId: string;
  approvedRevisionId: string | null;
  executionId: string;
  deliveryVerdict: DeliveryVerdictNavigation | null;
  mergeResult: MergeResultNavigation | null;
  complete: boolean;
}

export interface SpecMeasuresReport extends SpecMeasures {
  navigationChains: ReviewerNavigationChain[];
}

const shareSchema = z.number().min(0).max(1).nullable();
const countSchema = z.number().int().nonnegative();

export const specMeasuresReportSchema = z
  .object({
    definitionsVersion: z.string().min(1),
    requirementCausedRework: z
      .object({
        reopenedClaimCount: countSchema,
        postApprovalRevisionCount: countSchema,
        totalReworkEventCount: countSchema,
        claimIds: z.array(z.string().min(1)),
        revisionIds: z.array(z.string().min(1)),
      })
      .strict(),
    approvalFriction: z
      .object({
        activeReviewTimeMs: z.number().nonnegative(),
        interventionCount: countSchema,
        reapprovalLoopCount: countSchema,
      })
      .strict(),
    traceabilityCompleteness: z
      .object({
        deliveredInScopeCriterionCount: countSchema,
        completeChainCount: countSchema,
        share: shareSchema,
        completeCriterionIds: z.array(z.string().min(1)),
        incompleteCriterionIds: z.array(z.string().min(1)),
      })
      .strict(),
    automaticEvidenceCapture: z
      .object({
        automaticallyIngestedCount: countSchema,
        manuallyAttachedCount: countSchema,
        totalEvidenceCount: countSchema,
        share: shareSchema,
      })
      .strict(),
    navigationChains: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          requirementId: z.string().min(1),
          approvedRevisionId: z.string().min(1).nullable(),
          executionId: z.string().min(1),
          deliveryVerdict: z
            .object({
              verdictId: z.string().min(1),
              workflowExecutionId: z.string().min(1),
              candidateId: z.string().min(1),
              candidateHash: z.string().min(1),
              satisfyingContextId: z.string().min(1),
            })
            .strict()
            .nullable(),
          mergeResult: z
            .object({
              eventId: z.number().int().positive(),
              mergeId: z.string().min(1),
              mergeCommitSha: z.string().min(1),
            })
            .strict()
            .nullable(),
          complete: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

interface ActiveInterval {
  start: number;
  end: number;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function orderedSpecEvents(
  events: readonly SpecMeasureEvent[],
): SpecMeasureEvent[] {
  return [...events].sort(
    (left, right) =>
      left.id - right.id || compareText(left.occurredAt, right.occurredAt),
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid measure event timestamp: ${value}`);
  }
  return parsed;
}

function totalMergedIntervalTime(intervals: ActiveInterval[]): number {
  if (intervals.length === 0) {
    return 0;
  }

  const ordered = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let current = { ...ordered[0]! };
  let total = 0;

  for (const interval of ordered.slice(1)) {
    if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end);
      continue;
    }
    total += current.end - current.start;
    current = { ...interval };
  }

  return total + current.end - current.start;
}

export function computeRequirementCausedRework(
  events: readonly SpecMeasureEvent[],
): RequirementCausedReworkMeasure {
  const claimIds: string[] = [];
  const revisionIds: string[] = [];

  for (const event of events) {
    if (
      event.payload.kind === "task-claim-reopened" &&
      event.payload.changedIntentElementIds.length > 0
    ) {
      claimIds.push(event.payload.claimId);
    }
    if (
      event.payload.kind === "post-approval-revision-created" &&
      event.payload.nonTrivial &&
      event.payload.changedIntentElementIds.length > 0
    ) {
      revisionIds.push(event.payload.revisionId);
    }
  }

  claimIds.sort(compareText);
  revisionIds.sort(compareText);
  return {
    reopenedClaimCount: claimIds.length,
    postApprovalRevisionCount: revisionIds.length,
    totalReworkEventCount: claimIds.length + revisionIds.length,
    claimIds,
    revisionIds,
  };
}

export function computeApprovalFriction(
  events: readonly SpecMeasureEvent[],
): ApprovalFrictionMeasure {
  const intervalsByAttempt = new Map<string, ActiveInterval[]>();
  const staleSubjects = new Set<string>();
  let interventionCount = 0;
  let reapprovalLoopCount = 0;

  for (const event of orderedSpecEvents(events)) {
    if (event.payload.kind === "approval-staled") {
      staleSubjects.add(event.payload.subjectId);
      continue;
    }
    if (event.payload.kind !== "review-action") {
      continue;
    }

    const start = timestamp(event.payload.activeStartedAt);
    const end = timestamp(event.occurredAt);
    if (end < start) {
      throw new Error(
        `Review action ${event.id} ends before its active span starts`,
      );
    }
    const intervals =
      intervalsByAttempt.get(event.payload.reviewAttemptId) ?? [];
    intervals.push({ start, end });
    intervalsByAttempt.set(event.payload.reviewAttemptId, intervals);

    if (
      event.payload.action === "comment" ||
      event.payload.action === "request_changes"
    ) {
      interventionCount += 1;
    }
    if (
      event.payload.action === "approve_item" &&
      event.payload.subjectId &&
      staleSubjects.delete(event.payload.subjectId)
    ) {
      reapprovalLoopCount += 1;
    }
  }

  let activeReviewTimeMs = 0;
  for (const intervals of intervalsByAttempt.values()) {
    activeReviewTimeMs += totalMergedIntervalTime(intervals);
  }

  return {
    activeReviewTimeMs,
    interventionCount,
    reapprovalLoopCount,
  };
}

function traceabilityChainIsComplete(
  delivery: CriterionDeliveredInScopePayload,
  approvedRevisionIds: ReadonlySet<string>,
  verdicts: readonly DeliveryVerdictRecordedPayload[],
  mergedExecutionIds: ReadonlySet<string>,
): boolean {
  if (
    delivery.requirementId.length === 0 ||
    !approvedRevisionIds.has(delivery.revisionId) ||
    !mergedExecutionIds.has(delivery.executionId)
  ) {
    return false;
  }
  return verdicts.some(
    (verdict) =>
      verdict.executionId === delivery.executionId &&
      verdict.criterionId === delivery.criterionId &&
      verdict.revisionId === delivery.revisionId,
  );
}

export function buildReviewerNavigationChains(
  events: readonly SpecMeasureEvent[],
  workflowEvents: readonly LinkedWorkflowMeasureEvent[],
): ReviewerNavigationChain[] {
  const approvedRevisionIds = new Set<string>();
  const deliveriesByCriterionId = new Map<
    string,
    CriterionDeliveredInScopePayload
  >();
  const verdicts: DeliveryVerdictRecordedPayload[] = [];

  for (const event of orderedSpecEvents(events)) {
    if (
      event.payload.kind === "review-action" &&
      event.payload.action === "sign_off" &&
      event.payload.revisionId
    ) {
      approvedRevisionIds.add(event.payload.revisionId);
      continue;
    }
    if (event.payload.kind === "criterion-delivered-in-scope") {
      deliveriesByCriterionId.set(event.payload.criterionId, event.payload);
      continue;
    }
    if (event.payload.kind === "delivery-verdict-recorded") {
      verdicts.push(event.payload);
    }
  }

  const merges = new Map<string, MergeResultNavigation>();
  const orderedWorkflowEvents = [...workflowEvents].sort(
    (left, right) =>
      left.id - right.id || compareText(left.occurredAt, right.occurredAt),
  );
  for (const event of orderedWorkflowEvents) {
    if (event.eventType === "merge-completed") {
      merges.set(event.executionId, {
        eventId: event.id,
        mergeId: event.mergeId,
        mergeCommitSha: event.mergeCommitSha,
      });
    }
  }

  return [...deliveriesByCriterionId.values()]
    .sort((left, right) => compareText(left.criterionId, right.criterionId))
    .map((delivery) => {
      const verdict = verdicts.find(
        (candidate) =>
          candidate.executionId === delivery.executionId &&
          candidate.criterionId === delivery.criterionId &&
          candidate.revisionId === delivery.revisionId,
      );
      const deliveryVerdict =
        verdict === undefined
          ? null
          : {
              verdictId: verdict.verdictId,
              workflowExecutionId: verdict.workflowExecutionId,
              candidateId: verdict.candidateId,
              candidateHash: verdict.candidateHash,
              satisfyingContextId: verdict.satisfyingContextId,
            };
      const approvedRevisionId = approvedRevisionIds.has(delivery.revisionId)
        ? delivery.revisionId
        : null;
      const mergeResult = merges.get(delivery.executionId) ?? null;
      return {
        criterionId: delivery.criterionId,
        requirementId: delivery.requirementId,
        approvedRevisionId,
        executionId: delivery.executionId,
        deliveryVerdict,
        mergeResult,
        complete:
          delivery.requirementId.length > 0 &&
          approvedRevisionId !== null &&
          deliveryVerdict !== null &&
          mergeResult !== null,
      };
    });
}

export function computeTraceabilityCompleteness(
  events: readonly SpecMeasureEvent[],
  workflowEvents: readonly LinkedWorkflowMeasureEvent[],
): TraceabilityCompletenessMeasure {
  const approvedRevisionIds = new Set<string>();
  const deliveriesByCriterionId = new Map<
    string,
    CriterionDeliveredInScopePayload
  >();
  const verdicts: DeliveryVerdictRecordedPayload[] = [];

  for (const event of orderedSpecEvents(events)) {
    if (
      event.payload.kind === "review-action" &&
      event.payload.action === "sign_off" &&
      event.payload.revisionId
    ) {
      approvedRevisionIds.add(event.payload.revisionId);
    } else if (event.payload.kind === "criterion-delivered-in-scope") {
      deliveriesByCriterionId.set(event.payload.criterionId, event.payload);
    } else if (event.payload.kind === "delivery-verdict-recorded") {
      verdicts.push(event.payload);
    }
  }

  const mergedExecutionIds = new Set<string>();
  for (const event of workflowEvents) {
    if (event.eventType === "merge-completed") {
      mergedExecutionIds.add(event.executionId);
    }
  }

  const completeCriterionIds: string[] = [];
  const incompleteCriterionIds: string[] = [];
  const deliveries = [...deliveriesByCriterionId.values()].sort((left, right) =>
    compareText(left.criterionId, right.criterionId),
  );
  for (const delivery of deliveries) {
    if (
      traceabilityChainIsComplete(
        delivery,
        approvedRevisionIds,
        verdicts,
        mergedExecutionIds,
      )
    ) {
      completeCriterionIds.push(delivery.criterionId);
    } else {
      incompleteCriterionIds.push(delivery.criterionId);
    }
  }

  return {
    deliveredInScopeCriterionCount: deliveries.length,
    completeChainCount: completeCriterionIds.length,
    share:
      deliveries.length === 0
        ? null
        : completeCriterionIds.length / deliveries.length,
    completeCriterionIds,
    incompleteCriterionIds,
  };
}

export function computeAutomaticEvidenceCapture(
  events: readonly SpecMeasureEvent[],
): AutomaticEvidenceCaptureMeasure {
  let automaticallyIngestedCount = 0;
  let manuallyAttachedCount = 0;

  for (const event of events) {
    if (event.payload.kind !== "evidence-attached") {
      continue;
    }
    if (event.payload.source === "execution_ingest") {
      automaticallyIngestedCount += 1;
    } else {
      manuallyAttachedCount += 1;
    }
  }

  const totalEvidenceCount = automaticallyIngestedCount + manuallyAttachedCount;
  return {
    automaticallyIngestedCount,
    manuallyAttachedCount,
    totalEvidenceCount,
    share:
      totalEvidenceCount === 0
        ? null
        : automaticallyIngestedCount / totalEvidenceCount,
  };
}

export function computeSpecMeasures(
  events: readonly SpecMeasureEvent[],
  workflowEvents: readonly LinkedWorkflowMeasureEvent[],
): SpecMeasures {
  return {
    definitionsVersion: MEASURE_DEFINITIONS_VERSION,
    requirementCausedRework: computeRequirementCausedRework(events),
    approvalFriction: computeApprovalFriction(events),
    traceabilityCompleteness: computeTraceabilityCompleteness(
      events,
      workflowEvents,
    ),
    automaticEvidenceCapture: computeAutomaticEvidenceCapture(events),
  };
}

export function computeSpecMeasuresReport(
  events: readonly SpecMeasureEvent[],
  workflowEvents: readonly LinkedWorkflowMeasureEvent[],
): SpecMeasuresReport {
  return {
    ...computeSpecMeasures(events, workflowEvents),
    navigationChains: buildReviewerNavigationChains(events, workflowEvents),
  };
}
