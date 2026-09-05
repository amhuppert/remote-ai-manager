import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";

import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import type { SpecApprovalRequestsClosedNotice } from "@/lib/specs/attention-records";
import { createSpecEventsPublisher } from "@/lib/specs/events";
import type { SpecExecutionBindingSnapshotV2 } from "@/lib/specs/execution-binding";
import { createSpecExecutionBindingPorts } from "@/lib/specs/execution-binding-service";
import type { SpecPolicyAdmissionNotice } from "@/lib/specs/policy-admissions";
import type {
  Spec,
  SpecExecutionRow,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { createAuthoredContextOutcomeService } from "@/lib/workflow-graph/authored-context-outcome";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createWorkflowExecution,
  createWorkflowLayout,
  createWorkflowDefinition,
} from "@/lib/workflow-graph/test-fixtures";
import { workflowDefinitionMutationSchema } from "@/lib/workflow-graph/definition-schemas";
import { graphWorkflowValidationSpecialistSchema } from "@/lib/workflow-graph/schemas";
import { createDeliveryGate, type DeliveryGateDeps } from "./delivery-gate-v2";

type Db = InstanceType<typeof Database>;

const NOW = "2026-08-15T12:00:00.000Z";
const PROJECT_PATH = "/repo/delivery-gate-v2-integration";
const SPEC_ID = "spec-delivery-v2-integration";
const REVISION_ID = "revision-delivery-v2-integration";
const CRITERION_ID = "criterion-delivery-v2-integration";
const SECONDARY_CRITERION_ID = "criterion-delivery-v2-secondary";
const CURRENT_SPEC_EXECUTION_ID = "spec-execution-current";
const CURRENT_WORKFLOW_EXECUTION_ID = "workflow-execution-current";
const PRIOR_SPEC_EXECUTION_ID = "spec-execution-prior";
const PRIOR_WORKFLOW_EXECUTION_ID = "workflow-execution-prior";
const STABLE_SPAWNER_ID = "context-plan";
const GENERATED_CHILD_ID = "generated-child";
const CURRENT_CANDIDATE_ID = "candidate-current";
const CURRENT_CANDIDATE_HASH = `sha256:${"a".repeat(64)}`;

let db: Db;

const spec: Spec = {
  id: SPEC_ID,
  projectPath: PROJECT_PATH,
  slug: "delivery-v2-integration",
  name: "Delivery v2 integration",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const snapshot = {
  revision: {
    id: REVISION_ID,
    specId: SPEC_ID,
    number: 1,
    state: "approved",
    authoringStage: "design",
    basedOnRevisionId: null,
    contentHash: "revision-content-hash",
    proposedAt: NOW,
    approvedAt: NOW,
    externalDelivery: null,
    createdAt: NOW,
  },
  elements: [
    {
      element: {
        id: CRITERION_ID,
        specId: SPEC_ID,
        kind: "criterion",
        number: 1,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: REVISION_ID,
        elementId: CRITERION_ID,
        position: 0,
        payload: {
          kind: "criterion",
          text: "The current graph execution delivers the criterion.",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-payload-hash",
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    {
      element: {
        id: SECONDARY_CRITERION_ID,
        specId: SPEC_ID,
        kind: "criterion",
        number: 2,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: REVISION_ID,
        elementId: SECONDARY_CRITERION_ID,
        position: 1,
        payload: {
          kind: "criterion",
          text: "The secondary authored context delivers its criterion.",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-secondary-payload-hash",
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  ],
} as SpecRevisionSnapshot;

function executionRow(
  specExecutionId: string,
  workflowExecutionId: string,
): SpecExecutionRow {
  return {
    id: specExecutionId,
    spec_id: SPEC_ID,
    revision_id: REVISION_ID,
    scope_json: JSON.stringify({
      selectedTaskIds: [],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [],
    }),
    state: "running",
    execution_start_dial: "gate",
    workflow_definition_id: null,
    workflow_definition_revision: null,
    workflow_seed_source_json: null,
    workflow_execution_binding_json: null,
    workflow_execution_id: workflowExecutionId,
    session_name: `session-${specExecutionId}`,
    delivered_at: null,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function currentBinding(
  includeSecondary = false,
): SpecExecutionBindingSnapshotV2 {
  return {
    schemaVersion: 2,
    candidateId: CURRENT_CANDIDATE_ID,
    candidateHash: CURRENT_CANDIDATE_HASH,
    pinnedRevisionId: REVISION_ID,
    dispositions: [
      {
        criterionElementId: CRITERION_ID,
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      ...(includeSecondary
        ? [
            {
              criterionElementId: SECONDARY_CRITERION_ID,
              disposition: "in_scope" as const,
              deliveredByExecutionId: null,
            },
          ]
        : []),
    ],
    claims: [
      {
        contextId: STABLE_SPAWNER_ID,
        criterionElementIds: [CRITERION_ID],
      },
      ...(includeSecondary
        ? [
            {
              contextId: "context-implement",
              criterionElementIds: [SECONDARY_CRITERION_ID],
            },
          ]
        : []),
    ],
  };
}

function seedParents(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    spec.slug,
    spec.name,
    JSON.stringify(spec.gatePolicy),
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, content_hash, proposed_at, approved_at,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    1,
    "approved",
    snapshot.revision.contentHash,
    NOW,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(CRITERION_ID, SPEC_ID, "criterion", 1, null, NOW);
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(SECONDARY_CRITERION_ID, SPEC_ID, "criterion", 2, null, NOW);

  const deliveryRepo = createSpecDeliveryRepo(db);
  deliveryRepo.insertExecution(
    executionRow(PRIOR_SPEC_EXECUTION_ID, PRIOR_WORKFLOW_EXECUTION_ID),
  );
  deliveryRepo.insertExecution(
    executionRow(CURRENT_SPEC_EXECUTION_ID, CURRENT_WORKFLOW_EXECUTION_ID),
  );
  createSpecExecutionBindingRepo(db).insert({
    specExecutionId: CURRENT_SPEC_EXECUTION_ID,
    workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
    binding: currentBinding(),
    createdAt: NOW,
  });
}

function graphExecution(
  status: "pending" | "completed",
  includeCompletedGeneratedChild: boolean,
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    id: CURRENT_WORKFLOW_EXECUTION_ID,
    status,
    completedAt: status === "completed" ? NOW : null,
  });
  const spawner = execution.workingDefinition.executionContexts.find(
    (context) => context.id === STABLE_SPAWNER_ID,
  )!;
  spawner.placement = { lane: "session", mode: "readOnly" };
  execution.workingDefinition.executionContexts = [spawner];
  execution.workingDefinition.tasks = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === STABLE_SPAWNER_ID,
  );
  execution.workingDefinition.edges = [];
  execution.contextStates = {
    [STABLE_SPAWNER_ID]: execution.contextStates[STABLE_SPAWNER_ID]!,
  };
  execution.taskStates = Object.fromEntries(
    Object.entries(execution.taskStates).filter(
      ([, task]) => task.contextId === STABLE_SPAWNER_ID,
    ),
  );

  if (status === "completed") {
    const state = execution.contextStates[STABLE_SPAWNER_ID]!;
    state.status = "completed";
    state.completedTaskCount = state.totalTaskCount;
    for (const task of Object.values(execution.taskStates)) {
      task.status = "completed";
      task.completedAt = NOW;
    }
  }

  if (!includeCompletedGeneratedChild) return execution;

  const generatedChild = {
    ...spawner,
    id: GENERATED_CHILD_ID,
    title: "Generated child",
  };
  execution.workingDefinition.executionContexts.push(generatedChild);
  execution.contextStates[GENERATED_CHILD_ID] = {
    ...execution.contextStates[STABLE_SPAWNER_ID]!,
    contextId: GENERATED_CHILD_ID,
    status: "completed",
    totalTaskCount: 0,
    completedTaskCount: 0,
  };
  execution.expansionReceipts.accepted.push({
    requestId: "dynamic-request",
    payloadHash: "b".repeat(64),
    invokerContextId: STABLE_SPAWNER_ID,
    initiatorConversationId: "conversation-dynamic",
    rationale: "Complete the generated delivery work.",
    addedContextIds: [GENERATED_CHILD_ID],
    addedTaskIds: [],
    rejoinContextIds: [],
    liveRevision: 2,
    acceptedAt: NOW,
  });
  return execution;
}

function graphExecutionWithValidationDebt(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    id: CURRENT_WORKFLOW_EXECUTION_ID,
    status: "completed",
    completedAt: NOW,
  });
  execution.workingDefinition.executionContexts =
    execution.workingDefinition.executionContexts.filter(
      (context) =>
        context.id === STABLE_SPAWNER_ID || context.id === "context-implement",
    );
  execution.workingDefinition.tasks = execution.workingDefinition.tasks.filter(
    (task) =>
      task.contextId === STABLE_SPAWNER_ID ||
      task.contextId === "context-implement",
  );
  execution.workingDefinition.edges = [];
  execution.contextStates = Object.fromEntries(
    Object.entries(execution.contextStates).filter(
      ([contextId]) =>
        contextId === STABLE_SPAWNER_ID || contextId === "context-implement",
    ),
  );
  execution.taskStates = Object.fromEntries(
    Object.entries(execution.taskStates).filter(
      ([, task]) =>
        task.contextId === STABLE_SPAWNER_ID ||
        task.contextId === "context-implement",
    ),
  );
  for (const context of execution.workingDefinition.executionContexts) {
    context.placement = { lane: "session", mode: "readOnly" };
  }
  const secondary = execution.workingDefinition.executionContexts.find(
    (context) => context.id === "context-implement",
  )!;
  secondary.scriptValidator = { commands: ["test"] };
  for (const state of Object.values(execution.contextStates)) {
    state.status = "completed";
    state.completedTaskCount = state.totalTaskCount;
  }
  for (const task of Object.values(execution.taskStates)) {
    task.status = "completed";
    task.completedAt = NOW;
  }
  execution.contextStates["context-implement"]!.validationRound = {
    seq: 1,
    candidate: {
      headSha: "head",
      candidateTreeHash: "tree",
      taskStateHash: "tasks",
      identityScope: "wholeTree",
    },
    roster: [],
    specialists: {},
    phase: "concluded",
    outcome: null,
    startedAt: NOW,
  };
  return execution;
}

function createIntegratedGate(execution: GraphWorkflowExecution) {
  const deliveryRepo = createSpecDeliveryRepo(db);
  const outcomePort = createAuthoredContextOutcomeService({
    async findExecutionById(executionId) {
      return executionId === execution.id
        ? { execution, location: "archived" }
        : null;
    },
  });
  let verdictSequence = 0;
  const deps: DeliveryGateDeps = {
    findWorkflowExecution: () => execution,
    bindingPort: createSpecExecutionBindingPorts(
      createSpecExecutionBindingRepo(db),
    ).delivery,
    outcomePort,
    deliveryRepo,
    reviewRepo: {
      hasValidHumanGateApproval: () => true,
      insertGateAdmission: () => {
        throw new Error("Delivery gate policy admission was not expected.");
      },
      findGateAdmissionsByRevision: () => [],
    },
    attention: {
      listOpenApprovalRequests: () => {
        throw new Error("Delivery gate policy admission was not expected.");
      },
    },
    specsRepo: {
      findById: async (specId) => (specId === SPEC_ID ? spec : null),
      getRevisionSnapshot: async (revisionId) =>
        revisionId === REVISION_ID ? snapshot : null,
    },
    newVerdictId: () => `delivery-verdict-${++verdictSequence}`,
    newAdmissionId: () => "unused-admission",
    events: {
      appendInTransaction: () => {
        throw new Error("Delivery gate event was not expected.");
      },
      appendDurableInTransaction: () => {
        throw new Error("Delivery gate event was not expected.");
      },
      publishAfterCommit: () => undefined,
      publishSseAfterCommit: () => undefined,
    },
    writeQueue: {
      withWriteQueue: (_label, fn) => fn(),
    },
    runInImmediateTransaction: (fn) => db.transaction(fn).immediate(),
    recordIntervention: () => undefined,
    requestDeliveryApproval: async () => undefined,
    getProjectDisplayName: () => "Delivery v2 integration",
    now: () => NOW,
  };
  return {
    deliveryRepo,
    gate: createDeliveryGate(deps),
    outcomePort,
  };
}

/**
 * The gate as production composes it for a Notify delivery dial: real
 * admissions, a real attention register, and the notifier port observed.
 */
function createNotifyAdmissionGate(execution: GraphWorkflowExecution) {
  const eventsRepo = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  const notifyingSpec: Spec = {
    ...spec,
    gatePolicy: {
      preset: "contract-bearing",
      overrides: { delivery: "notify" },
    },
  };
  const policyAdmitted: SpecPolicyAdmissionNotice[] = [];
  const closed: SpecApprovalRequestsClosedNotice[] = [];
  let sequence = 0;
  const deps: DeliveryGateDeps = {
    bindingPort: createSpecExecutionBindingPorts(
      createSpecExecutionBindingRepo(db),
    ).delivery,
    outcomePort: createAuthoredContextOutcomeService({
      async findExecutionById(executionId) {
        return executionId === execution.id
          ? { execution, location: "archived" }
          : null;
      },
    }),
    deliveryRepo: createSpecDeliveryRepo(db),
    reviewRepo: createSpecReviewRepo(db),
    attention: eventsRepo,
    specsRepo: {
      findById: async (specId) => (specId === SPEC_ID ? notifyingSpec : null),
      getRevisionSnapshot: async (revisionId) =>
        revisionId === REVISION_ID ? snapshot : null,
    },
    newVerdictId: () => `delivery-verdict-${++sequence}`,
    newAdmissionId: () => `delivery-admission-${++sequence}`,
    events,
    writeQueue: {
      withWriteQueue: (_label, fn) => fn(),
    },
    runInImmediateTransaction: (fn) => db.transaction(fn).immediate(),
    policyNotifier: {
      policyAdmitted: (notice) => {
        policyAdmitted.push(notice);
      },
      approvalRequestsClosed: (notice) => {
        closed.push(notice);
      },
    },
    recordIntervention: () => undefined,
    requestDeliveryApproval: async () => undefined,
    getProjectDisplayName: () => "Delivery v2 integration",
    now: () => NOW,
  };
  return { eventsRepo, gate: createDeliveryGate(deps), policyAdmitted, closed };
}

function openDeliveryRequest(attentionId: string, executionId: string): void {
  createSpecEventsRepo(db).append({
    spec_id: SPEC_ID,
    occurred_at: NOW,
    event_type: "spec-attention-changed",
    actor_json: JSON.stringify({
      kind: "agent",
      conversationId: `workflow:${executionId}`,
    }),
    payload_json: JSON.stringify({
      kind: "approval-requested",
      attentionId,
      revisionId: REVISION_ID,
      gate: "delivery",
      scope: "gate",
      subject: "delivery",
      executionId,
      active: true,
    }),
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedParents();
});

afterEach(() => {
  db.close();
});

describe("delivery gate v2 integrated execution identity", () => {
  it("attributes a failure only to the cited frozen coverage and credits the whole union only after context GO", async () => {
    db.prepare(
      "DELETE FROM spec_execution_bindings WHERE spec_execution_id = ?",
    ).run(CURRENT_SPEC_EXECUTION_ID);
    const binding = currentBinding(true);
    binding.claims = [
      {
        contextId: STABLE_SPAWNER_ID,
        criterionElementIds: [CRITERION_ID, SECONDARY_CRITERION_ID],
      },
    ];
    createSpecExecutionBindingRepo(db).insert({
      specExecutionId: CURRENT_SPEC_EXECUTION_ID,
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      binding,
      createdAt: NOW,
    });
    const execution = graphExecution("completed", false);
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === STABLE_SPAWNER_ID,
    );
    const state = execution.contextStates[STABLE_SPAWNER_ID];
    if (!context || !state) throw new Error("Missing fixture context");
    context.scriptValidator = { commands: ["test"] };
    context.acceptanceCriteria = [
      { id: "observable-a", statement: "A holds", covers: [CRITERION_ID] },
      {
        id: "observable-b",
        statement: "B holds",
        covers: [SECONDARY_CRITERION_ID],
      },
    ];
    const launchDefinition = createWorkflowDefinition();
    const frozenContext = launchDefinition.executionContexts.find(
      (entry) => entry.id === STABLE_SPAWNER_ID,
    );
    if (!frozenContext) throw new Error("Missing frozen fixture context");
    frozenContext.acceptanceCriteria = structuredClone(
      context.acceptanceCriteria,
    );
    execution.launchDocument = workflowDefinitionMutationSchema.parse({
      name: "Coverage delivery",
      definition: launchDefinition,
      layout: createWorkflowLayout(),
    });
    context.acceptanceCriteria = [
      {
        id: "observable-a",
        statement: "Live edit",
        covers: [SECONDARY_CRITERION_ID],
      },
    ];
    state.validationRound = {
      seq: 1,
      candidate: {
        headSha: "head",
        candidateTreeHash: "tree",
        taskStateHash: "tasks",
        identityScope: "wholeTree",
      },
      roster: [],
      specialists: {
        acceptance: graphWorkflowValidationSpecialistSchema.parse({
          state: "verdict_fail",
          issues: [
            {
              taskId: "task-plan-1",
              criterionId: "observable-a",
              title: "COVERED_FAILURE",
              description: "A is missing",
            },
          ],
        }),
      },
      phase: "concluded",
      outcome: "failed",
      startedAt: NOW,
    };
    const { gate, deliveryRepo } = createIntegratedGate(execution);
    const input = {
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    };
    const refused = await gate.evaluate(input);
    expect(refused.status).toBe("refused");
    expect(refused).toMatchObject({
      unmet: expect.arrayContaining([
        {
          criterionId: CRITERION_ID,
          criterionHandle: expect.any(String),
          outcome: "failed",
          reason: expect.stringContaining("COVERED_FAILURE"),
        },
      ]),
    });
    if (refused.status !== "refused") throw new Error("Expected refusal");
    expect(
      refused.unmet.find(
        (criterion) => criterion.criterionId === SECONDARY_CRITERION_ID,
      )?.reason,
    ).not.toContain("COVERED_FAILURE");
    expect(
      deliveryRepo.findDeliveryVerdictsBySpecExecutionId(
        CURRENT_SPEC_EXECUTION_ID,
      ),
    ).toEqual([]);
    state.validationRound.outcome = "passed";
    state.validationRound.specialists = {};
    await expect(gate.evaluate(input)).resolves.toMatchObject({
      status: "pass",
    });
    expect(
      deliveryRepo
        .findDeliveryVerdictsBySpecExecutionId(CURRENT_SPEC_EXECUTION_ID)
        .map((verdict) => verdict.criterion_element_id)
        .sort(),
    ).toEqual([CRITERION_ID, SECONDARY_CRITERION_ID].sort());
  });
  it("does not let a prior execution verdict satisfy the current attempt", async () => {
    const { deliveryRepo, gate } = createIntegratedGate(
      graphExecution("pending", false),
    );
    deliveryRepo.saveDeliveryVerdict({
      id: "delivery-verdict-prior",
      specExecutionId: PRIOR_SPEC_EXECUTION_ID,
      workflowExecutionId: PRIOR_WORKFLOW_EXECUTION_ID,
      candidateId: "candidate-prior",
      candidateHash: `sha256:${"c".repeat(64)}`,
      criterionElementId: CRITERION_ID,
      satisfyingContextId: STABLE_SPAWNER_ID,
      recordedAt: NOW,
    });

    const result = await gate.evaluate({
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    });

    expect(result).toMatchObject({ status: "refused" });
    expect(
      deliveryRepo.findDeliveryVerdictsBySpecExecutionId(
        CURRENT_SPEC_EXECUTION_ID,
      ),
    ).toEqual([]);
    expect(
      deliveryRepo.findDeliveryVerdictsBySpecExecutionId(
        PRIOR_SPEC_EXECUTION_ID,
      ),
    ).toHaveLength(1);
  });

  it("credits completed dynamic work only through its stable authored claimant", async () => {
    const { deliveryRepo, gate, outcomePort } = createIntegratedGate(
      graphExecution("completed", true),
    );

    await expect(
      outcomePort.getAuthoredContextOutcome(
        CURRENT_WORKFLOW_EXECUTION_ID,
        GENERATED_CHILD_ID,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "generated_context_not_authored",
    });

    const result = await gate.evaluate({
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    });

    expect(result).toMatchObject({ status: "pass" });
    expect(
      deliveryRepo.findDeliveryVerdictsBySpecExecutionId(
        CURRENT_SPEC_EXECUTION_ID,
      ),
    ).toEqual([
      expect.objectContaining({
        workflow_execution_id: CURRENT_WORKFLOW_EXECUTION_ID,
        candidate_id: CURRENT_CANDIDATE_ID,
        candidate_hash: CURRENT_CANDIDATE_HASH,
        criterion_element_id: CRITERION_ID,
        satisfying_context_id: STABLE_SPAWNER_ID,
      }),
    ]);
  });

  it("persists stable partial proof and completes idempotently after the archived claimant is corrected", async () => {
    db.prepare(
      "DELETE FROM spec_execution_bindings WHERE spec_execution_id = ?",
    ).run(CURRENT_SPEC_EXECUTION_ID);
    createSpecExecutionBindingRepo(db).insert({
      specExecutionId: CURRENT_SPEC_EXECUTION_ID,
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      binding: currentBinding(true),
      createdAt: NOW,
    });
    const execution = graphExecutionWithValidationDebt();
    const { deliveryRepo, gate } = createIntegratedGate(execution);

    const refused = await gate.evaluate({
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    });

    expect(refused).toMatchObject({
      status: "refused",
      unmet: [
        expect.objectContaining({
          criterionId: SECONDARY_CRITERION_ID,
          reason: expect.stringContaining(
            "context-implement failed validation_gate_failed (validation round 1 is concluded with outcome null)",
          ),
        }),
      ],
    });
    expect(
      deliveryRepo.findDeliveryVerdictsBySpecExecutionId(
        CURRENT_SPEC_EXECUTION_ID,
      ),
    ).toEqual([
      expect.objectContaining({
        criterion_element_id: CRITERION_ID,
        satisfying_context_id: STABLE_SPAWNER_ID,
      }),
    ]);

    execution.contextStates["context-implement"]!.validationRound!.outcome =
      "passed";
    await expect(
      gate.evaluate({
        workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
        preparedSha: "prepared-current",
        expectedTargetSha: "target-current",
        projectPath: PROJECT_PATH,
      }),
    ).resolves.toMatchObject({ status: "pass" });
    await gate.evaluate({
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    });

    expect(
      deliveryRepo.findDeliveryVerdictsBySpecExecutionId(
        CURRENT_SPEC_EXECUTION_ID,
      ),
    ).toEqual([
      expect.objectContaining({ criterion_element_id: CRITERION_ID }),
      expect.objectContaining({
        criterion_element_id: SECONDARY_CRITERION_ID,
      }),
    ]);
  });
});

describe("delivery gate policy admission answers the open approval request (#108)", () => {
  it("retires this run's delivery request and closes its Needs You entry when Notify admits the run", async () => {
    // The run was refused under the Gate dial and asked for a human approval;
    // the human then relaxed the delivery dial to Notify instead of granting.
    openDeliveryRequest(
      "attention-delivery-current",
      CURRENT_SPEC_EXECUTION_ID,
    );
    openDeliveryRequest("attention-delivery-prior", PRIOR_SPEC_EXECUTION_ID);
    const { eventsRepo, gate, policyAdmitted, closed } =
      createNotifyAdmissionGate(graphExecution("completed", false));

    const result = await gate.evaluate({
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    });

    expect(result).toMatchObject({ status: "pass" });
    expect(policyAdmitted).toEqual([
      expect.objectContaining({
        gate: "delivery",
        basis: "notify_policy",
        executionId: CURRENT_SPEC_EXECUTION_ID,
      }),
    ]);
    // The admission answers the ask for THIS run alone: the register keeps
    // the other run's request, and the queue entry closes rather than asking
    // for an approval nothing still needs.
    expect(eventsRepo.listOpenApprovalRequests(SPEC_ID)).toEqual([
      expect.objectContaining({
        attentionId: "attention-delivery-prior",
        executionId: PRIOR_SPEC_EXECUTION_ID,
      }),
    ]);
    expect(closed).toEqual([
      expect.objectContaining({
        specId: SPEC_ID,
        attentionIds: ["attention-delivery-current"],
      }),
    ]);
  });

  it("re-reporting an already admitted run neither re-admits nor re-closes anything", async () => {
    openDeliveryRequest(
      "attention-delivery-current",
      CURRENT_SPEC_EXECUTION_ID,
    );
    const { gate, policyAdmitted, closed } = createNotifyAdmissionGate(
      graphExecution("completed", false),
    );
    const input = {
      workflowExecutionId: CURRENT_WORKFLOW_EXECUTION_ID,
      preparedSha: "prepared-current",
      expectedTargetSha: "target-current",
      projectPath: PROJECT_PATH,
    };

    await gate.evaluate(input);
    await gate.evaluate(input);

    expect(policyAdmitted).toHaveLength(1);
    expect(closed).toHaveLength(1);
  });
});
