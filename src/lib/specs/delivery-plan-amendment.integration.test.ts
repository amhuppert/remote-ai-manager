import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";
import { workingDefinitionHash } from "@/lib/workflow-graph/execution-amendment";
import type {
  GraphWorkflowExecutionAmendedEvent,
  GraphWorkflowLiveEditAppliedEvent,
} from "@/lib/workflow-graph/event-schemas";

import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  deliveryPlanMutationViewSchema,
  deliveryPlanPreviewViewSchema,
  type DeliveryPlanMutationView,
  type DeliveryPlanPreviewView,
} from "./delivery-plan-views";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  SPINE_PROJECT_NAME,
  SPINE_SESSION_NAME,
  SPINE_WORKFLOW_EXECUTION_ID,
  startLegacySpineExecution,
  startSpineWorkflowThroughProductionGate,
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

/**
 * `cctl workflow live amend` end to end: the one authorized way to change a
 * launched delivery-plan definition (design §11), driven through the real
 * `graph-workflow/amend` route over a run this world actually launched from an
 * approved candidate.
 *
 * The success case has to prove BOTH halves of the bargain — that the additions
 * landed AND that the stored approved candidate is byte-identical afterwards.
 * A test that only compared hashes would pass over an implementation that
 * amended nothing, and one that only checked the additions would pass over an
 * implementation that rewrote the approved bytes (`exact-approval`).
 */

const SLUG = "spec-spine";

interface PlannedSpine {
  authored: AuthoredSpineSpec;
  attemptId: string;
  candidate: {
    candidateId: string;
    planHash: string;
    compiledDefinitionHash: string;
  };
}

async function planAction(
  world: SpecSpineWorld,
  action: string,
  body: unknown,
  transport: "agent" | "human",
): Promise<DeliveryPlanMutationView> {
  const response = await world.postAction(SLUG, action, body, transport);
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return deliveryPlanMutationViewSchema.parse(payload);
}

async function proposedPreview(
  world: SpecSpineWorld,
): Promise<DeliveryPlanPreviewView> {
  const response = await world.writeHandlers.specPlanPreviewGET(
    new Request(
      `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/${SLUG}/plan/preview?stage=proposed`,
    ),
    { params: Promise.resolve({ name: SPINE_PROJECT_NAME, slug: SLUG }) },
  );
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return deliveryPlanPreviewViewSchema.parse(payload);
}

function proposableDocument(
  seeded: DeliveryPlanDocument,
  authored: AuthoredSpineSpec,
): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...seeded,
    dispositions: [
      {
        criterionElementId: authored.criterionOneId,
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: authored.criterionTwoId,
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-deliver",
        title: "Deliver the spine",
        contextType: "delivery",
        criterionElementIds: [authored.criterionOneId, authored.criterionTwoId],
        acceptanceContract: ["Both spine criteria are observable."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-deliver",
        contextId: "ctx-deliver",
        title: "Deliver both criteria",
        instructions: "Implement the spine feature and prove both criteria.",
        order: 0,
        contributesToCriterionElementIds: [authored.criterionOneId],
      },
    ],
    edges: [],
    wiring: [],
    policyOverrides: [],
    touchedSurfaces: ["src/lib/specs/"],
    governance: {
      mission: "Deliver the spine feature from its approved plan.",
      charterInvariants: [
        {
          id: "exact-approval",
          statement: "The launched definition is the approved candidate.",
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "final-design",
          label: "Final agreed design",
          type: "document",
          locator: "command-center#47 attachment f7b542c4",
          description: "Section 11 owns the amendment.",
          appliesTo: null,
          accessPolicy: "external-readonly",
        },
      ],
      validationCommandNames: ["typecheck"],
    },
  });
}

async function planTo(world: SpecSpineWorld): Promise<PlannedSpine> {
  const authored = await authorSpineDraft(world, SLUG, "gate");
  await proposeSpineRevision(world, SLUG, authored);
  await approveAndSignOffSpine(world, SLUG, authored);

  const opened = await planAction(
    world,
    "plan-open",
    { seedFromLast: false },
    "agent",
  );
  await planAction(
    world,
    "plan-edit",
    {
      expectedDraftRevision: opened.attempt.draftRevision,
      document: proposableDocument(opened.document, authored),
    },
    "agent",
  );
  const proposed = await planAction(world, "plan-propose", {}, "agent");
  const preview = await proposedPreview(world);
  const candidateId = preview.candidateId;
  if (candidateId === null) throw new Error("the proposal stored no candidate");
  return {
    authored,
    attemptId: proposed.attempt.id,
    candidate: {
      candidateId,
      planHash: preview.planHash,
      compiledDefinitionHash: preview.compiledDefinitionHash,
    },
  };
}

async function launch(world: SpecSpineWorld): Promise<PlannedSpine> {
  const planned = await planTo(world);
  await planAction(world, "plan-sign-off", planned.candidate, "human");
  const started = await world.postAction(
    SLUG,
    "start-execution",
    {
      revisionId: planned.authored.draftRevisionId,
      sessionName: SPINE_SESSION_NAME,
    },
    "agent",
  );
  expect(started.status, JSON.stringify(await started.clone().json())).toBe(
    200,
  );
  return planned;
}

/** The approved candidate's stored bytes — what `exact-approval` protects. */
function storedCandidateJson(world: SpecSpineWorld, candidateId: string) {
  return (
    world.db
      .prepare(
        "SELECT definition_json FROM spec_delivery_plan_candidates WHERE id = ?",
      )
      .get(candidateId) as { definition_json: string }
  ).definition_json;
}

function amendmentEvents(
  world: SpecSpineWorld,
): GraphWorkflowExecutionAmendedEvent[] {
  return world.repos.workflowEvents
    .findByExecution(SPINE_WORKFLOW_EXECUTION_ID)
    .map((entry) => entry.event)
    .filter(
      (event): event is GraphWorkflowExecutionAmendedEvent =>
        event.type === "graph-workflow-execution-amended",
    );
}

function liveEditEvents(
  world: SpecSpineWorld,
): GraphWorkflowLiveEditAppliedEvent[] {
  return world.repos.workflowEvents
    .findByExecution(SPINE_WORKFLOW_EXECUTION_ID)
    .map((entry) => entry.event)
    .filter(
      (event): event is GraphWorkflowLiveEditAppliedEvent =>
        event.type === "graph-workflow-live-edit-applied",
    );
}

const ADDITIVE_OPERATIONS = [
  {
    type: "add-context",
    id: "ctx-verify-migration",
    title: "Verify the migration",
    acceptanceCriteria: "The migration round-trips through the repository.",
  },
  {
    type: "add-task",
    id: "task-verify-migration",
    contextId: "ctx-verify-migration",
    title: "Prove the round trip",
    instructions: "Write the round-trip contract test and run it.",
  },
  {
    type: "add-edge",
    id: "edge-deliver-verify",
    sourceContextId: "ctx-deliver",
    targetContextId: "ctx-verify-migration",
  },
];

describe("cctl workflow live amend — the authorized amendment", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
    world = createSpecSpineWorld({
      pinnedAllowAgentTaskAdd: true,
      currentGlobalAllowAgentTaskAdd: false,
    });
    world.registerMergeComposition();
  });

  afterEach(() => {
    _resetPublicationForTesting();
    resetJobQueue();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetDeliveryGateEvaluatorForTesting();
  });

  it("adds the requested context, task, and edge and leaves the approved candidate byte-identical", async () => {
    const planned = await launch(world);
    const before = world.readActiveWorkflowExecution();
    if (before === null) throw new Error("the launch created no execution");
    const approvedBytes = storedCandidateJson(
      world,
      planned.candidate.candidateId,
    );

    const response = await world.postWorkflowAmend(
      {
        reason: "the migration needs its own verification context",
        operations: ADDITIVE_OPERATIONS,
      },
      "agent",
    );
    const payload = (await response.json()) as {
      amended?: number;
      liveRevision?: number;
      policyBasis?: string;
      previousWorkingDefinitionHash?: string;
      workingDefinitionHash?: string;
    };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.amended).toBe(3);
    expect(payload.policyBasis).toBe("pinned_allow_agent_task_add");

    // The additions are really in the working definition, not merely reported.
    const after = world.readActiveWorkflowExecution();
    if (after === null) throw new Error("the amendment lost the execution");
    expect(
      after.workingDefinition.executionContexts.map((context) => context.id),
    ).toContain("ctx-verify-migration");
    expect(after.workingDefinition.tasks.map((task) => task.id)).toContain(
      "task-verify-migration",
    );
    expect(
      after.workingDefinition.edges.find(
        (edge) => edge.id === "edge-deliver-verify",
      ),
    ).toMatchObject({
      sourceContextId: "ctx-deliver",
      targetContextId: "ctx-verify-migration",
    });
    // Runtime state exists for the added context, so the run can actually reach it.
    expect(after.contextStates["ctx-verify-migration"]).toBeDefined();
    expect(
      after.workingDefinition.executionContexts.find(
        (context) => context.id === "ctx-verify-migration",
      )?.mutability,
    ).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: false,
    });
    expect(after.liveRevision).toBe(before.liveRevision + 1);

    // The hashes really moved — a no-op amendment cannot satisfy this.
    const previousHash = workingDefinitionHash(before.workingDefinition);
    const nextHash = workingDefinitionHash(after.workingDefinition);
    expect(nextHash).not.toBe(previousHash);
    expect(payload.previousWorkingDefinitionHash).toBe(previousHash);
    expect(payload.workingDefinitionHash).toBe(nextHash);

    // The durable audit row committed with the change.
    const events = amendmentEvents(world);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      executionId: SPINE_WORKFLOW_EXECUTION_ID,
      reason: "the migration needs its own verification context",
      policyBasis: "pinned_allow_agent_task_add",
      previousWorkingDefinitionHash: previousHash,
      workingDefinitionHash: nextHash,
      addedContextIds: ["ctx-verify-migration"],
      addedTaskIds: ["task-verify-migration"],
      addedEdgeIds: ["edge-deliver-verify"],
    });
    expect(events[0]?.actor).toContain("agent:");
    expect(events[0]?.actor).toContain("codex");
    expect(liveEditEvents(world)[0]?.source).toBe("cli");

    // exact-approval: the stored candidate the human approved is untouched.
    expect(storedCandidateJson(world, planned.candidate.candidateId)).toBe(
      approvedBytes,
    );
  });

  it("records the human operator basis when the Studio control amends", async () => {
    world = createSpecSpineWorld({
      pinnedAllowAgentTaskAdd: false,
      currentGlobalAllowAgentTaskAdd: true,
    });
    world.registerMergeComposition();
    await launch(world);

    const response = await world.postWorkflowAmend(
      {
        reason: "the operator added the verification context",
        operations: ADDITIVE_OPERATIONS,
      },
      "human",
    );
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      200,
    );
    expect(amendmentEvents(world)[0]).toMatchObject({
      policyBasis: "human_operator",
      actor: "human",
    });
    expect(
      world
        .readActiveWorkflowExecution()
        ?.workingDefinition.executionContexts.find(
          (context) => context.id === "ctx-verify-migration",
        )?.mutability,
    ).toEqual({
      allowAgentTaskAdd: false,
      allowAgentContextAdd: false,
    });
    expect(liveEditEvents(world)[0]?.source).toBe("ui");
  });

  it("refuses an agent task addition when the pinned policy denies it despite permissive current globals", async () => {
    world = createSpecSpineWorld({
      pinnedAllowAgentTaskAdd: false,
      currentGlobalAllowAgentTaskAdd: true,
    });
    world.registerMergeComposition();
    await launch(world);
    const before = world.readActiveWorkflowExecution();
    if (before === null) throw new Error("the launch created no execution");

    const response = await world.postWorkflowAmend(
      {
        reason: "the agent wants to append another delivery task",
        operations: [
          {
            type: "add-task",
            id: "task-agent-appended",
            contextId: "ctx-deliver",
            title: "Agent-appended task",
            instructions: "This must follow the pinned mutability policy.",
          },
        ],
      },
      "agent",
    );
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };

    expect(response.status, JSON.stringify(payload)).toBe(409);
    expect(payload.code).toBe("mutability_policy_blocked");
    expect(payload.instruction).toContain(SPINE_WORKFLOW_EXECUTION_ID);
    expect(world.readActiveWorkflowExecution()).toEqual(before);
    expect(amendmentEvents(world)).toHaveLength(0);
  });

  it("refuses a non-additive payload whole, applying nothing", async () => {
    await launch(world);
    const before = world.readActiveWorkflowExecution();

    const response = await world.postWorkflowAmend(
      {
        reason: "drop the delivery context",
        operations: [
          ADDITIVE_OPERATIONS[0],
          { type: "remove-context", contextId: "ctx-deliver" },
        ],
      },
      "agent",
    );
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(response.status).toBe(400);
    expect(payload.code).toBe("non_additive_operation");
    expect(payload.instruction).toContain("cctl spec plan reopen");
    expect(payload.instruction).toContain("cctl spec capture");

    // Whole-batch refusal: the additive entry beside it did not land either.
    const after = world.readActiveWorkflowExecution();
    expect(
      after?.workingDefinition.executionContexts.map((context) => context.id),
    ).not.toContain("ctx-verify-migration");
    expect(after?.liveRevision).toBe(before?.liveRevision);
    expect(amendmentEvents(world)).toHaveLength(0);
  });

  it("refuses an amendment with no rationale", async () => {
    await launch(world);

    const response = await world.postWorkflowAmend(
      { reason: "  ", operations: ADDITIVE_OPERATIONS },
      "agent",
    );
    expect(response.status).toBe(400);
    expect(amendmentEvents(world)).toHaveLength(0);
  });

  it("refuses on a legacy compiled run and points at the direct edit it still has", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startLegacySpineExecution(world, SLUG, authored);
    await startSpineWorkflowThroughProductionGate(world, started, SLUG);
    const before = world.readActiveWorkflowExecution();
    expect(before?.status).toBe("running");

    const response = await world.postWorkflowAmend(
      { reason: "add a context", operations: ADDITIVE_OPERATIONS },
      "agent",
    );
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(response.status).toBe(409);
    expect(payload.code).toBe("not_a_delivery_plan");
    expect(payload.instruction).toContain("cctl workflow live edit");
    expect(amendmentEvents(world)).toHaveLength(0);
    expect(world.readActiveWorkflowExecution()?.liveRevision).toBe(
      before?.liveRevision,
    );
  });

  it("refuses on a non-running execution and names the way back", async () => {
    await launch(world);
    await world.pauseWorkflowExecution();

    const response = await world.postWorkflowAmend(
      { reason: "add it anyway", operations: ADDITIVE_OPERATIONS },
      "agent",
    );
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(response.status).toBe(409);
    expect(payload.code).toBe("not_running");
    expect(payload.instruction).toContain("cctl workflow live resume");
    expect(amendmentEvents(world)).toHaveLength(0);
  });
});
