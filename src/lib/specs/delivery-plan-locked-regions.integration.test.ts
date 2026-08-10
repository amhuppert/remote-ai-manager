import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";
import { workingDefinitionHash } from "@/lib/workflow-graph/execution-amendment";
import type { GraphWorkflowExecutionAmendedEvent } from "@/lib/workflow-graph/event-schemas";

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
 * Locked regions on a launched delivery-plan definition (design §11), and the
 * escape that makes locking safe.
 *
 * Sequencing is the whole point of the design note: the cohorts run's 15 live
 * acceptance-criteria edits were only possible BECAUSE the compiled context body
 * was unlocked, and they were also that operator's only way out. So this file
 * pins both halves together — the direct edit refuses AND names the act that
 * gets the change made, and the amendment then makes it on the same definition.
 *
 * Legacy compiled runs are deliberately excluded from the lock: their unlocked
 * regions are the only escape they have, so the same direct edit still applies.
 */

const SLUG = "spec-spine";

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
        criterionElementIds: [authored.criterionOneId],
        acceptanceContract: ["The first spine criterion is observable."],
        proofPlan: [],
      },
      {
        contextId: "ctx-verify",
        title: "Verify the spine",
        contextType: "delivery",
        criterionElementIds: [authored.criterionTwoId],
        acceptanceContract: ["The second spine criterion is observable."],
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
      {
        taskId: "task-deliver-proof",
        contextId: "ctx-deliver",
        title: "Prove the delivery",
        instructions: "Prove the first spine criterion.",
        order: 1,
        contributesToCriterionElementIds: [authored.criterionOneId],
      },
      {
        taskId: "task-verify",
        contextId: "ctx-verify",
        title: "Verify the second criterion",
        instructions: "Verify the second spine criterion.",
        order: 0,
        contributesToCriterionElementIds: [authored.criterionTwoId],
      },
    ],
    edges: [
      {
        edgeId: "edge-deliver-plan-verify",
        fromContextId: "ctx-deliver",
        toContextId: "ctx-verify",
      },
    ],
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
          description: "Section 11 owns locked regions.",
          appliesTo: null,
          accessPolicy: "external-readonly",
        },
      ],
      validationCommandNames: ["typecheck"],
    },
  });
}

/** Launch the delivery-plan run whose regions the plan owns. */
async function launchDeliveryPlanRun(world: SpecSpineWorld): Promise<void> {
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
  await planAction(world, "plan-propose", {}, "agent");
  const preview = await proposedPreview(world);
  const candidateId = preview.candidateId;
  if (candidateId === null) throw new Error("the proposal stored no candidate");
  await planAction(
    world,
    "plan-sign-off",
    {
      candidateId,
      planHash: preview.planHash,
      compiledDefinitionHash: preview.compiledDefinitionHash,
    },
    "human",
  );
  const started = await world.postAction(
    SLUG,
    "start-execution",
    {
      revisionId: authored.draftRevisionId,
      sessionName: SPINE_SESSION_NAME,
    },
    "agent",
  );
  expect(started.status, JSON.stringify(await started.clone().json())).toBe(
    200,
  );
}

/** Launch a legacy compiled run — the path whose regions stay unlocked. */
async function launchLegacyRun(world: SpecSpineWorld): Promise<void> {
  const authored = await authorSpineDraft(world, SLUG, "gate");
  await proposeSpineRevision(world, SLUG, authored);
  await approveAndSignOffSpine(world, SLUG, authored);
  const started = await startLegacySpineExecution(world, SLUG, authored);
  await startSpineWorkflowThroughProductionGate(world, started, SLUG);
}

async function liveEdit(
  world: SpecSpineWorld,
  operations: unknown[],
): Promise<Response> {
  const execution = world.readActiveWorkflowExecution();
  if (execution === null) throw new Error("no active execution to edit");
  return world.postWorkflowLiveEdit({
    executionId: execution.id,
    baseLiveRevision: execution.liveRevision,
    source: "cli",
    operations,
  });
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

describe("delivery-plan locked regions", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
    world = createSpecSpineWorld();
    world.registerMergeComposition();
  });

  afterEach(() => {
    _resetPublicationForTesting();
    resetJobQueue();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetDeliveryGateEvaluatorForTesting();
  });

  it.each([
    [
      "a context's acceptance criteria",
      [
        {
          type: "update-context",
          contextId: "ctx-deliver",
          acceptanceCriteria: "Something the plan never agreed to.",
        },
      ],
    ],
    [
      "an existing task's instructions",
      [
        {
          type: "update-task",
          taskId: "task-deliver",
          instructions: "Do something else instead.",
        },
      ],
    ],
    [
      "an existing task's order",
      [
        {
          type: "reorder-tasks",
          contextId: "ctx-deliver",
          orderedTaskIds: ["task-deliver-proof", "task-deliver"],
        },
      ],
    ],
    [
      "an existing edge",
      [
        {
          type: "remove-edge",
          sourceContextId: "ctx-deliver",
          targetContextId: "ctx-verify",
        },
      ],
    ],
    [
      "the charter",
      [
        {
          type: "amend-charter",
          rationale: "the mission drifted",
          mission: "A different mission.",
        },
      ],
    ],
  ])(
    "refuses a direct live edit to %s, naming both escapes",
    async (_label, operations) => {
      await launchDeliveryPlanRun(world);
      const before = world.readActiveWorkflowExecution();

      const response = await liveEdit(world, operations);
      const payload = (await response.json()) as {
        code?: string;
        instruction?: string;
        issues?: string[];
      };

      expect(response.status, JSON.stringify(payload)).toBe(409);
      expect(payload.code).toBe("region_locked");
      // The refusal names the act for each side of the launch boundary, so a
      // reader in either state knows what to run next.
      expect(payload.instruction).toContain(`cctl spec plan reopen ${SLUG}`);
      expect(payload.instruction).toContain(`cctl spec capture ${SLUG}`);
      expect(payload.instruction).toContain("cctl workflow live amend");
      expect(payload.instruction).toContain(SPINE_WORKFLOW_EXECUTION_ID);
      expect(payload.instruction).not.toContain("<slug>");

      // Nothing moved: a refusal that had already mutated would make the lock
      // decorative.
      const after = world.readActiveWorkflowExecution();
      expect(after?.liveRevision).toBe(before?.liveRevision);
      expect(workingDefinitionHash(after!.workingDefinition)).toBe(
        workingDefinitionHash(before!.workingDefinition),
      );
    },
  );

  it("refuses a generic additive edit so only the audited amendment can revise a launched DPA definition", async () => {
    await launchDeliveryPlanRun(world);
    const before = world.readActiveWorkflowExecution();

    const response = await liveEdit(world, [
      {
        type: "add-task",
        id: "task-direct-bypass",
        contextId: "ctx-verify",
        title: "Bypass the audit",
        instructions: "This must not land through the generic route.",
        position: { at: "end" },
      },
    ]);
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };

    expect(response.status, JSON.stringify(payload)).toBe(409);
    expect(payload.code).toBe("region_locked");
    expect(payload.instruction).toContain("cctl workflow live amend");
    const after = world.readActiveWorkflowExecution();
    expect(after?.liveRevision).toBe(before?.liveRevision);
    expect(after?.workingDefinition.tasks.map((task) => task.id)).not.toContain(
      "task-direct-bypass",
    );
    expect(amendmentEvents(world)).toHaveLength(0);
  });

  it("accepts the amendment on the very definition the direct edit was refused on", async () => {
    await launchDeliveryPlanRun(world);

    const refused = await liveEdit(world, [
      {
        type: "update-context",
        contextId: "ctx-deliver",
        acceptanceCriteria: "Something the plan never agreed to.",
      },
    ]);
    expect(refused.status).toBe(409);

    const before = world.readActiveWorkflowExecution();
    if (before === null) throw new Error("the refusal lost the execution");

    const amended = await world.postWorkflowAmend(
      {
        reason: "the delivery context needs a follow-on verification context",
        operations: [
          {
            type: "add-context",
            id: "ctx-follow-on-verify",
            title: "Verify the spine follow-on",
            acceptanceCriteria: "The delivered spine is proved end to end.",
          },
          {
            type: "add-edge",
            id: "edge-deliver-verify",
            sourceContextId: "ctx-deliver",
            targetContextId: "ctx-follow-on-verify",
          },
        ],
      },
      "human",
    );
    expect(amended.status, JSON.stringify(await amended.clone().json())).toBe(
      200,
    );

    const after = world.readActiveWorkflowExecution();
    if (after === null) throw new Error("the amendment lost the execution");
    expect(
      after.workingDefinition.executionContexts.map((context) => context.id),
    ).toContain("ctx-follow-on-verify");

    const events = amendmentEvents(world);
    expect(events).toHaveLength(1);
    expect(events[0]?.previousWorkingDefinitionHash).toBe(
      workingDefinitionHash(before.workingDefinition),
    );
    expect(events[0]?.workingDefinitionHash).toBe(
      workingDefinitionHash(after.workingDefinition),
    );
    expect(events[0]?.workingDefinitionHash).not.toBe(
      events[0]?.previousWorkingDefinitionHash,
    );
  });

  it("leaves a legacy compiled run's acceptance criteria editable", async () => {
    await launchLegacyRun(world);
    const before = world.readActiveWorkflowExecution();
    const contextId = before?.workingDefinition.executionContexts[0]?.id ?? "";
    expect(contextId).not.toBe("");

    const response = await liveEdit(world, [
      {
        type: "update-context",
        contextId,
        acceptanceCriteria: "The operator's own words, mid-run.",
      },
    ]);
    const payload = (await response.json()) as { applied?: number };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.applied).toBe(1);

    const after = world.readActiveWorkflowExecution();
    expect(
      after?.workingDefinition.executionContexts.find(
        (context) => context.id === contextId,
      )?.acceptanceCriteria,
    ).toBe("The operator's own words, mid-run.");
  });
});
