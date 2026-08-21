import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import { finalizeDeliveryPlanLaunch } from "@/lib/specs/delivery-plan-finalization";
import type { DeliveryPlanPreviewView } from "@/lib/specs/delivery-plan-views";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

type ReviewOverrides = {
  attempt?: Partial<DeliveryPlanReviewView["attempt"]>;
  approval?: DeliveryPlanReviewView["approval"];
  document?: DeliveryPlanReviewView["document"];
  snapshots?: DeliveryPlanReviewView["snapshots"];
  criteria?: DeliveryPlanReviewView["criteria"];
  comments?: DeliveryPlanReviewView["comments"];
  nextAct?: DeliveryPlanReviewView["nextAct"];
};

export function reviewView(
  overrides: ReviewOverrides = {},
): DeliveryPlanReviewView {
  const record = createWorkflowDefinitionRecord();
  const base: DeliveryPlanReviewView = {
    attempt: {
      id: "attempt-2",
      specSlug: "native-sdd",
      status: "proposed",
      draftRevision: 2,
      pinnedRevisionId: "revision-2",
      deltaBasisExecutionId: null,
      proposedSnapshotId: "snapshot-2",
      candidateId: "candidate-2",
      candidateHash: "sha256:candidate-2",
      launchedExecutionId: null,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    approval: null,
    prelaunch: null,
    document: {
      schemaVersion: 2,
      launch: {
        name: record.name,
        description: record.description,
        definition: record.definition,
        layout: record.layout,
      },
      binding: { dispositions: [], claims: [] },
    },
    health: { total: 0, blocking: 0, counts: [], findings: [] },
    dispositionCounts: [],
    unresolved: [],
    snapshots: [],
    nextAct: {
      actor: "agent",
      command: "cctl spec plan sign-off native-sdd",
      reason: "Sign the finalized envelope.",
    },
    criteria: [],
    comments: [],
  };
  return {
    ...base,
    ...overrides,
    attempt: { ...base.attempt, ...overrides.attempt },
  };
}

/**
 * The finalized launch preview `reviewView`'s default attempt describes. The
 * review surface refuses a preview whose identity differs from the attempt on
 * screen, so the two fixtures are kept in one place rather than re-derived per
 * test.
 */
export function previewView(): DeliveryPlanPreviewView {
  return {
    stage: "proposed",
    attemptId: "attempt-2",
    specSlug: "native-sdd",
    draftRevision: 2,
    pinnedRevisionId: "revision-2",
    candidateId: "candidate-2",
    candidateHash: "sha256:candidate-2",
    snapshotId: "snapshot-2",
    approvable: true,
    approvability: "Finalized candidate is ready for sign-off.",
    launch: finalizeDeliveryPlanLaunch({
      specId: "spec-native-sdd",
      specSlug: "native-sdd",
      attemptId: "attempt-2",
      candidateId: "candidate-2",
      launch: createMaximalAuthoredWorkflowLaunchFixture(),
    }),
    binding: {
      dispositions: [],
      claims: [
        {
          contextId: "context-integrate",
          criterionElementIds: ["criterion-1"],
        },
      ],
    },
  };
}
