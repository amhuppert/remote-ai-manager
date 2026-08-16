import { describe, expect, it } from "vitest";
import {
  MEASURE_DEFINITIONS_VERSION,
  computeApprovalFriction,
  computeAutomaticEvidenceCapture,
  computeRequirementCausedRework,
  computeSpecMeasures,
  computeTraceabilityCompleteness,
  type LinkedWorkflowMeasureEvent,
  type SpecMeasureEvent,
} from "./measures";

const specId = "spec-1";

const specEvents: SpecMeasureEvent[] = [
  {
    id: 1,
    specId,
    occurredAt: "2026-07-18T09:00:00.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "task-claim-reopened",
      claimId: "claim-1",
      taskId: "task-1",
      changedIntentElementIds: ["requirement-1"],
    },
  },
  {
    id: 2,
    specId,
    occurredAt: "2026-07-18T09:01:00.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "task-claim-reopened",
      claimId: "claim-2",
      taskId: "task-2",
      changedIntentElementIds: [],
    },
  },
  {
    id: 3,
    specId,
    occurredAt: "2026-07-18T09:02:00.000Z",
    eventType: "spec-revision-changed",
    payload: {
      kind: "post-approval-revision-created",
      revisionId: "revision-2",
      nonTrivial: true,
      changedIntentElementIds: ["requirement-1"],
    },
  },
  {
    id: 4,
    specId,
    occurredAt: "2026-07-18T09:03:00.000Z",
    eventType: "spec-revision-changed",
    payload: {
      kind: "post-approval-revision-created",
      revisionId: "revision-3",
      nonTrivial: false,
      changedIntentElementIds: ["requirement-2"],
    },
  },
  {
    id: 5,
    specId,
    occurredAt: "2026-07-18T10:05:00.000Z",
    eventType: "spec-review-commented",
    payload: {
      kind: "review-action",
      action: "comment",
      reviewAttemptId: "attempt-1",
      activeStartedAt: "2026-07-18T10:00:00.000Z",
    },
  },
  {
    id: 6,
    specId,
    occurredAt: "2026-07-18T10:07:00.000Z",
    eventType: "spec-review-changes-requested",
    payload: {
      kind: "review-action",
      action: "request_changes",
      reviewAttemptId: "attempt-1",
      activeStartedAt: "2026-07-18T10:06:00.000Z",
    },
  },
  {
    id: 7,
    specId,
    occurredAt: "2026-07-18T11:59:00.000Z",
    eventType: "spec-approval-changed",
    payload: {
      kind: "approval-staled",
      subjectId: "requirement-1",
    },
  },
  {
    id: 8,
    specId,
    occurredAt: "2026-07-18T12:02:00.000Z",
    eventType: "spec-review-item-approved",
    payload: {
      kind: "review-action",
      action: "approve_item",
      reviewAttemptId: "attempt-2",
      activeStartedAt: "2026-07-18T12:00:00.000Z",
      subjectId: "requirement-1",
    },
  },
  {
    id: 9,
    specId,
    occurredAt: "2026-07-18T12:03:00.000Z",
    eventType: "spec-review-revision-signed-off",
    payload: {
      kind: "review-action",
      action: "sign_off",
      reviewAttemptId: "attempt-2",
      activeStartedAt: "2026-07-18T12:02:00.000Z",
      revisionId: "revision-1",
    },
  },
  {
    id: 10,
    specId,
    occurredAt: "2026-07-18T12:04:00.000Z",
    eventType: "spec-approval-changed",
    payload: {
      kind: "approval-staled",
      subjectId: "requirement-1",
    },
  },
  {
    id: 11,
    specId,
    occurredAt: "2026-07-18T13:00:00.000Z",
    eventType: "spec-execution-changed",
    payload: {
      kind: "criterion-delivered-in-scope",
      criterionId: "criterion-1",
      requirementId: "requirement-1",
      revisionId: "revision-1",
      executionId: "execution-1",
      taskIds: ["task-1"],
    },
  },
  {
    id: 12,
    specId,
    occurredAt: "2026-07-18T13:00:01.000Z",
    eventType: "spec-execution-changed",
    payload: {
      kind: "criterion-delivered-in-scope",
      criterionId: "criterion-2",
      requirementId: "requirement-1",
      revisionId: "revision-1",
      executionId: "execution-1",
      taskIds: ["task-2"],
    },
  },
  {
    id: 13,
    specId,
    occurredAt: "2026-07-18T13:01:00.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "evidence-attached",
      evidenceId: "evidence-1",
      criterionId: "criterion-1",
      revisionId: "revision-1",
      evidenceKind: "commit",
      source: "execution_ingest",
      evaluatedCommitSha: "task-1-sha",
    },
  },
  {
    id: 14,
    specId,
    occurredAt: "2026-07-18T13:01:01.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "proof-verdict-recorded",
      verdictId: "verdict-1",
      criterionId: "criterion-1",
      revisionId: "revision-1",
      evidenceIds: ["evidence-1"],
      valid: true,
    },
  },
  {
    id: 15,
    specId,
    occurredAt: "2026-07-18T13:02:00.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "evidence-attached",
      evidenceId: "evidence-2",
      criterionId: "criterion-2",
      revisionId: "revision-1",
      evidenceKind: "validator_verdict",
      source: "manual",
      evaluatedCommitSha: "task-2-sha",
    },
  },
  {
    id: 16,
    specId,
    occurredAt: "2026-07-18T13:02:01.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "proof-verdict-recorded",
      verdictId: "verdict-2",
      criterionId: "criterion-2",
      revisionId: "revision-1",
      evidenceIds: ["evidence-2"],
      valid: true,
    },
  },
  {
    id: 17,
    specId,
    occurredAt: "2026-07-18T13:03:00.000Z",
    eventType: "spec-evidence-changed",
    payload: {
      kind: "evidence-attached",
      evidenceId: "evidence-3",
      criterionId: "criterion-3",
      revisionId: "revision-1",
      evidenceKind: "test_run",
      source: "execution_ingest",
    },
  },
  {
    id: 18,
    specId,
    occurredAt: "2026-07-18T13:04:00.000Z",
    eventType: "spec-execution-changed",
    payload: {
      kind: "delivery-verdict-recorded",
      verdictId: "delivery-verdict-1",
      criterionId: "criterion-1",
      revisionId: "revision-1",
      executionId: "execution-1",
      workflowExecutionId: "workflow-execution-1",
      candidateId: "candidate-1",
      candidateHash: `sha256:${"a".repeat(64)}`,
      satisfyingContextId: "stable-spawner",
    },
  },
];

const workflowEvents: LinkedWorkflowMeasureEvent[] = [
  {
    id: 1,
    occurredAt: "2026-07-18T12:55:00.000Z",
    eventType: "task-commit-recorded",
    executionId: "execution-1",
    taskId: "task-1",
    commitSha: "task-1-sha",
  },
  {
    id: 2,
    occurredAt: "2026-07-18T13:05:00.000Z",
    eventType: "merge-completed",
    executionId: "execution-1",
    mergeId: "merge-1",
    mergeCommitSha: "merge-sha",
  },
];

describe("measures", () => {
  it("exposes the frozen measure definitions version", () => {
    expect(MEASURE_DEFINITIONS_VERSION).toBe("native-sdd-measures-v2");
  });

  it("computes requirement-caused rework from attributed events only", () => {
    expect(computeRequirementCausedRework(specEvents)).toEqual({
      reopenedClaimCount: 1,
      postApprovalRevisionCount: 1,
      totalReworkEventCount: 2,
      claimIds: ["claim-1"],
      revisionIds: ["revision-2"],
    });
  });

  it("computes approval friction from active action spans and excludes idle waiting", () => {
    expect(computeApprovalFriction(specEvents)).toEqual({
      activeReviewTimeMs: 540_000,
      interventionCount: 2,
      reapprovalLoopCount: 1,
    });
  });

  it("computes traceability share and names an incomplete delivered chain", () => {
    expect(computeTraceabilityCompleteness(specEvents, workflowEvents)).toEqual(
      {
        deliveredInScopeCriterionCount: 2,
        completeChainCount: 1,
        share: 0.5,
        completeCriterionIds: ["criterion-1"],
        incompleteCriterionIds: ["criterion-2"],
      },
    );
  });

  it("counts a stable authored-context verdict without task-grain proof", () => {
    const events: SpecMeasureEvent[] = [
      ...specEvents,
      {
        id: 19,
        specId,
        occurredAt: "2026-07-18T13:03:01.000Z",
        eventType: "spec-evidence-changed",
        payload: {
          kind: "delivery-verdict-recorded",
          verdictId: "delivery-verdict-3",
          criterionId: "criterion-3",
          revisionId: "revision-1",
          executionId: "execution-1",
          workflowExecutionId: "workflow-execution-1",
          candidateId: "candidate-1",
          candidateHash: `sha256:${"a".repeat(64)}`,
          satisfyingContextId: "stable-orchestrator",
        },
      },
      {
        id: 20,
        specId,
        occurredAt: "2026-07-18T13:03:02.000Z",
        eventType: "spec-execution-changed",
        payload: {
          kind: "criterion-delivered-in-scope",
          criterionId: "criterion-3",
          requirementId: "requirement-1",
          revisionId: "revision-1",
          executionId: "execution-1",
          taskIds: ["task-3"],
        },
      },
    ];
    expect(computeTraceabilityCompleteness(events, workflowEvents)).toEqual({
      deliveredInScopeCriterionCount: 3,
      completeChainCount: 2,
      share: 2 / 3,
      completeCriterionIds: ["criterion-1", "criterion-3"],
      incompleteCriterionIds: ["criterion-2"],
    });
  });

  it("computes the share of automatically ingested evidence", () => {
    expect(computeAutomaticEvidenceCapture(specEvents)).toEqual({
      automaticallyIngestedCount: 2,
      manuallyAttachedCount: 1,
      totalEvidenceCount: 3,
      share: 2 / 3,
    });
  });

  it("computes all four measures from the same retained event fixtures", () => {
    expect(computeSpecMeasures(specEvents, workflowEvents)).toEqual({
      definitionsVersion: "native-sdd-measures-v2",
      requirementCausedRework: computeRequirementCausedRework(specEvents),
      approvalFriction: computeApprovalFriction(specEvents),
      traceabilityCompleteness: computeTraceabilityCompleteness(
        specEvents,
        workflowEvents,
      ),
      automaticEvidenceCapture: computeAutomaticEvidenceCapture(specEvents),
    });
  });
});
