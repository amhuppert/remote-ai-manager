import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecGateAdmissionRow } from "@/lib/specs/schemas";

export const SPEC_CONTROLS_FIXTURE_NOW = "2026-07-18T12:00:00.000Z";

/**
 * A policy-basis gate admission (Notify/Off dial) as the authoring path
 * records it: no approval, no execution, nullable revision (R11.2 post-hoc
 * review rows must tolerate both).
 */
export function policyAdmissionRowFixture(
  overrides: Partial<SpecGateAdmissionRow> = {},
): SpecGateAdmissionRow {
  return {
    id: "admission-notify-1",
    spec_id: "spec-1",
    gate: "requirements",
    basis: "notify_policy",
    approval_id: null,
    revision_id: "revision-1",
    execution_id: null,
    actor_json: '{"kind":"agent","conversationId":"conversation-1"}',
    created_at: SPEC_CONTROLS_FIXTURE_NOW,
    ...overrides,
  };
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
          {
            id: "execution-1",
            spec_id: "spec-1",
            revision_id: revision.id,
            scope_json: JSON.stringify({
              selectedTaskIds: ["task-1"],
              selectedCriterionIds: ["criterion-1"],
              exclusionDispositions: [],
            }),
            state: executionState,
            workflow_definition_id: "workflow-definition-1",
            workflow_execution_id: null,
            session_name: "native-sdd-run",
            delivered_at: null,
            abandoned_reason: null,
            created_at: SPEC_CONTROLS_FIXTURE_NOW,
            updated_at: SPEC_CONTROLS_FIXTURE_NOW,
          },
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
      gates: [],
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
  execution.scope_json = JSON.stringify({
    selectedTaskIds: ["task-1", "task-2"],
    selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-4"],
    exclusionDispositions: [
      { criterionId: "criterion-3", disposition: "deferred" },
    ],
  });
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
  detail.executions.push({
    ...execution,
    id: "execution-prior",
    state: "delivered",
    scope_json: JSON.stringify({
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-4"],
      exclusionDispositions: [],
    }),
    delivered_at: SPEC_CONTROLS_FIXTURE_NOW,
  });
  detail.status.delivery = {
    allWaived: false,
    provenCount: 1,
    totalInScope: 3,
  };
  return detail;
}
