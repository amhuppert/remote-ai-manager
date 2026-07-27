import { remainingAuthoringSequence } from "@/lib/specs/authoring-sequence";
import type { SpecDetailView } from "@/lib/specs/queries";
import { toDiffRows } from "@/lib/specs/review-state";
import type { SpecAuthoringStage } from "@/lib/specs/schemas";
import {
  specDetailViewSchema,
  specExecutionViewSchema,
  specGateAdmissionViewSchema,
  type SpecExecutionView,
  type SpecGateAdmissionView,
} from "@/lib/specs/view-schemas";

import type { PolicyImpactDraft } from "./SpecPolicyImpact";

export const SPEC_CONTROLS_FIXTURE_NOW = "2026-07-18T12:00:00.000Z";

/** The dense fixture's prior delivered run predates the current run. */
const PRIOR_RUN_CREATED_AT = "2026-07-17T09:00:00.000Z";
const PRIOR_RUN_DELIVERED_AT = "2026-07-17T18:00:00.000Z";

/**
 * An open draft pinned at `pinnedStage` that added one requirements-stage
 * element against an empty base, so the stage-scoped consultation of R10.11
 * reaches back past the pinned stage whenever the next transition is a
 * propose.
 */
export function policyImpactDraftFixture(
  pinnedStage: SpecAuthoringStage,
): PolicyImpactDraft {
  return {
    revisionId: "revision-4",
    revisionNumber: 4,
    pinnedStage,
    baseRevisionRows: [],
    revisionRows: [
      {
        elementId: "requirement-1",
        parentElementId: null,
        payloadHash: "requirement-hash",
        payload: {
          kind: "requirement",
          statement: "Every execution pins scope.",
          priority: "must",
          risk: "high",
        },
      },
    ],
  };
}

/**
 * A policy-basis gate admission (Notify/Off dial) as the detail response
 * carries it: no approval, no execution, nullable revision (R11.2 post-hoc
 * review rows must tolerate both). Parsed through the response schema so a
 * fixture that drifts from the payload Studio actually receives fails here
 * rather than agreeing with a stale consumer.
 */
export function policyAdmissionViewFixture(
  overrides: Partial<SpecGateAdmissionView> = {},
): SpecGateAdmissionView {
  return specGateAdmissionViewSchema.parse({
    id: "admission-notify-1",
    specId: "spec-1",
    gate: "requirements",
    basis: "notify_policy",
    approvalId: null,
    revisionId: "revision-1",
    revisionNumber: 1,
    executionId: null,
    actor: { kind: "agent", conversationId: "conversation-1" },
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    ...overrides,
  });
}

/**
 * A run in the shape the detail response carries it — scope already parsed,
 * revision number alongside the revision id. Parsed through the response
 * schema for the same reason `policyAdmissionViewFixture` is.
 */
export function executionViewFixture(
  overrides: Partial<SpecExecutionView> = {},
): SpecExecutionView {
  return specExecutionViewSchema.parse({
    id: "execution-1",
    specId: "spec-1",
    revisionId: "revision-1",
    revisionNumber: 1,
    state: "running",
    workflowDefinitionId: "workflow-definition-1",
    workflowExecutionId: null,
    scope: {
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [],
    },
    sessionName: "native-sdd-run",
    deliveredAt: null,
    abandonedReason: null,
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    deliveryProjection: [
      {
        criterionElementId: "criterion-1",
        handle: "R1.1",
        strategyKinds: ["test_run"],
        proofState: "awaiting_proof",
      },
    ],
    ...overrides,
  });
}

export function specControlsDetailFixture(
  executionState: "none" | "definition_review" | "running" = "none",
): SpecDetailView {
  const revision = {
    id: "revision-1",
    specId: "spec-1",
    number: 1,
    state: "approved" as const,
    authoringStage: "plan" as const,
    basedOnRevisionId: null,
    contentHash: "revision-hash",
    proposedAt: SPEC_CONTROLS_FIXTURE_NOW,
    approvedAt: SPEC_CONTROLS_FIXTURE_NOW,
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
  };
  const elements = [
    {
      element: {
        id: "requirement-1",
        specId: "spec-1",
        kind: "requirement" as const,
        number: 1,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: revision.id,
        elementId: "requirement-1",
        position: 0,
        payload: {
          kind: "requirement" as const,
          statement: "Every execution pins scope.",
          priority: "must" as const,
          risk: "high" as const,
        },
        payloadHash: "requirement-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
    {
      element: {
        id: "criterion-1",
        specId: "spec-1",
        kind: "criterion" as const,
        number: 1,
        parentElementId: "requirement-1",
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: revision.id,
        elementId: "criterion-1",
        position: 1,
        payload: {
          kind: "criterion" as const,
          text: "The selected task and criterion are pinned.",
          validationStrategy: { kinds: ["test_run" as const] },
        },
        payloadHash: "criterion-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
    {
      element: {
        id: "task-1",
        specId: "spec-1",
        kind: "task" as const,
        number: 1,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-1",
        position: 2,
        payload: {
          kind: "task" as const,
          title: "Implement scope pinning",
          instructions: "Persist the exact scope.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
  ];
  const executions =
    executionState === "none"
      ? []
      : [
          executionViewFixture({
            revisionId: revision.id,
            revisionNumber: revision.number,
            state: executionState,
          }),
        ];

  return {
    spec: {
      id: "spec-1",
      projectPath: "/repos/command-center",
      slug: "native-sdd",
      name: "Native SDD",
      gatePolicy: { preset: "contract-bearing" },
      abandonedAt: null,
      abandonedReason: null,
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
    aliases: [],
    revisions: [revision],
    baseRevision: null,
    currentRevision: { revision, elements },
    currentApprovedRevision: { revision, elements },
    executionRevisionSnapshots: [{ revision, elements }],
    approvals: [],
    comments: [],
    linkedTickets: [],
    elementStatuses: { requirements: [], tasks: [] },
    status: {
      specId: "spec-1",
      slug: "native-sdd",
      phase: { primary: executionState === "none" ? "approved" : "executing" },
      executions: executions.map((execution) => ({
        id: execution.id,
        state: execution.state,
        workflowDefinitionId: execution.workflowDefinitionId,
        workflowExecutionId: execution.workflowExecutionId,
        workflowStatus:
          execution.workflowExecutionId === null
            ? null
            : execution.state === "running"
              ? ("running" as const)
              : ("pending" as const),
      })),
      gates: [],
      // The fixture spec's current revision is approved, so no draft is open.
      authoringSequence: null,
      pendingApprovals: [],
      openQuestions: [],
      assumptions: [],
      taskPlan: [],
      coverage: { coveredCriteria: 1, totalCriteria: 1, percentage: 100 },
      delivery: { allWaived: false, provenCount: 0, totalInScope: 1 },
    },
    questions: [],
    assumptions: [],
    executions,
    criterionDispositions:
      executionState === "none"
        ? []
        : [
            {
              execution_id: "execution-1",
              criterion_element_id: "criterion-1",
              disposition: "in_scope",
              waiver_id: null,
              delivered_by_execution_id: null,
              created_at: SPEC_CONTROLS_FIXTURE_NOW,
              updated_at: SPEC_CONTROLS_FIXTURE_NOW,
            },
          ],
    waivers: [],
    gateAdmissions: [],
  };
}

export function denseSpecControlsDetailFixture(
  executionState: "none" | "definition_review" | "running",
): SpecDetailView {
  const detail = specControlsDetailFixture(executionState);
  const snapshot = detail.currentApprovedRevision;
  if (snapshot === null) throw new Error("Approved fixture missing");
  const criterion = snapshot.elements.find(
    (entry) => entry.element.id === "criterion-1",
  );
  const task = snapshot.elements.find((entry) => entry.element.id === "task-1");
  if (
    criterion === undefined ||
    criterion.version.payload.kind !== "criterion" ||
    task === undefined ||
    task.version.payload.kind !== "task"
  ) {
    throw new Error("Dense execution fixture sources missing");
  }

  const criterionNumbers = executionState === "none" ? [2] : [2, 3, 4];
  const additionalCriteria = criterionNumbers.map((number) => ({
    element: {
      ...criterion.element,
      id: `criterion-${number}`,
      number,
    },
    version: {
      ...criterion.version,
      elementId: `criterion-${number}`,
      position: number,
      payload: {
        ...criterion.version.payload,
        text: `Criterion ${number} is satisfied for the scoped delivery.`,
      },
      payloadHash: `criterion-${number}-hash`,
    },
  }));
  const taskTwo = {
    element: { ...task.element, id: "task-2", number: 2 },
    version: {
      ...task.version,
      elementId: "task-2",
      position: 6,
      payload: {
        ...task.version.payload,
        title: "Validate scoped delivery",
        coveredCriterionElementIds: criterionNumbers.map(
          (number) => `criterion-${number}`,
        ),
        dependsOnTaskElementIds: ["task-1"],
      },
      payloadHash: "task-2-hash",
    },
  };
  snapshot.elements.push(...additionalCriteria, taskTwo);
  detail.status.coverage = {
    coveredCriteria: criterionNumbers.length + 1,
    totalCriteria: criterionNumbers.length + 1,
    percentage: 100,
  };

  if (executionState === "none") return detail;
  const execution = detail.executions[0];
  const sourceDisposition = detail.criterionDispositions[0];
  if (execution === undefined || sourceDisposition === undefined) {
    throw new Error("Execution fixture missing");
  }
  execution.scope = {
    selectedTaskIds: ["task-1", "task-2"],
    selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-4"],
    exclusionDispositions: [
      { criterionId: "criterion-3", disposition: "deferred" },
    ],
  };
  // One populated row per proof state the running merge gate can host:
  // recorded machine proof, a human waiver, and a validated external delivery.
  execution.deliveryProjection = [
    {
      criterionElementId: "criterion-1",
      handle: "R1.1",
      strategyKinds: ["test_run"],
      proofState: "proof_recorded",
    },
    {
      criterionElementId: "criterion-2",
      handle: "R1.2",
      strategyKinds: ["test_run"],
      proofState: "waived",
    },
    {
      criterionElementId: "criterion-4",
      handle: "R1.4",
      strategyKinds: ["test_run"],
      proofState: "delivered_elsewhere",
    },
  ];
  detail.criterionDispositions = [
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-1",
      disposition: "in_scope",
    },
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-2",
      disposition: "waived",
      waiver_id: "waiver-2",
    },
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-3",
      disposition: "deferred",
    },
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-4",
      disposition: "delivered_elsewhere",
      delivered_by_execution_id: "execution-prior",
    },
    // The prior run's own self-delivery disposition: the gate's prior-run
    // rule (`isEarlierMergedDelivery`) requires the earlier execution to have
    // marked the criterion delivered by itself, so the current run's
    // delivered_elsewhere row is only production-reachable with this row
    // alongside it.
    {
      ...sourceDisposition,
      execution_id: "execution-prior",
      criterion_element_id: "criterion-4",
      disposition: "in_scope",
      delivered_by_execution_id: "execution-prior",
      created_at: PRIOR_RUN_CREATED_AT,
      updated_at: PRIOR_RUN_DELIVERED_AT,
    },
  ];
  detail.waivers = [
    {
      id: "waiver-2",
      spec_id: detail.spec.id,
      criterion_element_id: "criterion-2",
      revision_id: snapshot.revision.id,
      reason: "Equivalent proof accepted by Alex.",
      waived_at: SPEC_CONTROLS_FIXTURE_NOW,
      stale: 0,
    },
  ];
  detail.executions.push(
    executionViewFixture({
      ...execution,
      id: "execution-prior",
      state: "delivered",
      scope: {
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-4"],
        exclusionDispositions: [],
      },
      // Strictly earlier than the current run: `isEarlierMergedDelivery`
      // rejects a "prior" run created at — or delivered after — the current
      // run's creation, so identical timestamps encode an impossible state.
      createdAt: PRIOR_RUN_CREATED_AT,
      updatedAt: PRIOR_RUN_DELIVERED_AT,
      deliveredAt: PRIOR_RUN_DELIVERED_AT,
      deliveryProjection: [
        {
          criterionElementId: "criterion-4",
          handle: "R1.4",
          strategyKinds: ["test_run"],
          proofState: "proven_merged",
        },
      ],
    }),
  );
  detail.status.delivery = {
    allWaived: false,
    provenCount: 1,
    totalInScope: 3,
  };
  return detail;
}

/**
 * Delivery already approved by a human while proof is still outstanding. The
 * admission is complete — a real approval id and the human actor — because
 * production's human grant always persists both; a basis-only mutation is a
 * state the live route cannot emit. Lives here (not in a story file) and is
 * re-parsed through the full response schema so the fixture tests guard it.
 */
export function approvedAwaitingProofSpecControlsDetailFixture(): SpecDetailView {
  const detail = denseSpecControlsDetailFixture("running");
  const run = detail.executions[0];
  if (run === undefined) throw new Error("Running execution fixture missing");
  run.deliveryProjection = [
    {
      criterionElementId: "criterion-1",
      handle: "R1.1",
      strategyKinds: ["test_run"],
      proofState: "proof_recorded",
    },
    {
      criterionElementId: "criterion-2",
      handle: "R1.2",
      strategyKinds: ["test_run"],
      proofState: "awaiting_proof",
    },
    {
      criterionElementId: "criterion-4",
      handle: "R1.4",
      strategyKinds: ["validator_verdict"],
      proofState: "awaiting_proof",
    },
  ];
  // The human kept every current-run criterion in scope; the prior run's own
  // self-delivery disposition survives untouched, as it would in production.
  detail.criterionDispositions = detail.criterionDispositions.map((row) =>
    row.execution_id === run.id
      ? {
          ...row,
          disposition: "in_scope" as const,
          waiver_id: null,
          delivered_by_execution_id: null,
        }
      : row,
  );
  detail.waivers = [];
  detail.gateAdmissions = [
    policyAdmissionViewFixture({
      id: "admission-delivery-1",
      gate: "delivery",
      basis: "human_approval",
      approvalId: "approval-delivery-1",
      executionId: run.id,
      actor: { kind: "human" },
    }),
  ];
  return specDetailViewSchema.parse(detail);
}

/**
 * The fixture spec with an open draft revision pinned at `pinnedStage`,
 * carrying the remaining-sequence projection the server computes under the
 * spec's *current* policy — so a consumer that echoes the stored sequence
 * instead of resolving the proposed one is visible.
 */
export function draftingSpecControlsDetailFixture(
  pinnedStage: SpecAuthoringStage,
): SpecDetailView {
  const detail = specControlsDetailFixture();
  const approved = detail.currentApprovedRevision;
  if (approved === null) throw new Error("Approved fixture missing");
  const draft = {
    revision: {
      ...approved.revision,
      id: "revision-2",
      number: 2,
      state: "draft" as const,
      authoringStage: pinnedStage,
      basedOnRevisionId: approved.revision.id,
      proposedAt: null,
      approvedAt: null,
    },
    elements: approved.elements,
  };
  detail.revisions = [approved.revision, draft.revision];
  detail.baseRevision = approved;
  detail.currentRevision = draft;
  detail.status.phase = { primary: "draft" };
  detail.status.authoringSequence = remainingAuthoringSequence({
    policy: detail.spec.gatePolicy,
    revisionId: draft.revision.id,
    revisionNumber: draft.revision.number,
    pinnedStage,
    baseRevisionRows: toDiffRows(approved),
    revisionRows: toDiffRows(draft),
  });
  return detail;
}
