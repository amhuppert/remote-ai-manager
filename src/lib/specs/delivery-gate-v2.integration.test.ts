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
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import type { SpecExecutionBindingSnapshotV2 } from "@/lib/specs/execution-binding";
import { createSpecExecutionBindingPorts } from "@/lib/specs/execution-binding-service";
import type {
  Spec,
  SpecExecutionRow,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { createAuthoredContextOutcomeService } from "@/lib/workflow-graph/authored-context-outcome";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createDeliveryGate, type DeliveryGateDeps } from "./delivery-gate-v2";

type Db = InstanceType<typeof Database>;

const NOW = "2026-08-15T12:00:00.000Z";
const PROJECT_PATH = "/repo/delivery-gate-v2-integration";
const SPEC_ID = "spec-delivery-v2-integration";
const REVISION_ID = "revision-delivery-v2-integration";
const CRITERION_ID = "criterion-delivery-v2-integration";
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

function currentBinding(): SpecExecutionBindingSnapshotV2 {
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
    ],
    claims: [
      {
        contextId: STABLE_SPAWNER_ID,
        criterionElementIds: [CRITERION_ID],
      },
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

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedParents();
});

afterEach(() => {
  db.close();
});

describe("delivery gate v2 integrated execution identity", () => {
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
});
