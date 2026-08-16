import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";
import { workingDefinitionHash } from "@/lib/workflow-graph/working-definition-hash";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  type DeliveryPlanCandidateRecord,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import { finalizeDeliveryPlanLaunch } from "./delivery-plan-finalization";
import { deliveryPlanCandidateHash } from "./delivery-plan-hash";

import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  SPINE_CONVERSATION_ID,
  SPINE_SESSION_NAME,
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";

function graphWorkflowExecutionRowCount(world: SpecSpineWorld): number {
  const row = world.db
    .prepare("SELECT COUNT(*) AS total FROM graph_workflow_executions")
    .get() as { total: number };
  return row.total;
}

async function startExecution(
  world: SpecSpineWorld,
  body: Record<string, unknown>,
  authored: AuthoredSpineSpec,
): Promise<Response> {
  return world.postAction(
    SLUG,
    "start-execution",
    {
      revisionId: authored.draftRevisionId,
      sessionName: SPINE_SESSION_NAME,
      ...body,
    },
    "agent",
  );
}

function seedApprovedCandidate(
  world: SpecSpineWorld,
  authored: AuthoredSpineSpec,
  options: {
    parameters?: ParameterDeclaration[];
  } = {},
): { attemptId: string; candidateId: string; candidateHash: string } {
  const attemptId = "attempt-direct-start";
  const candidateId = "candidate-direct-start";
  const snapshotId = "snapshot-direct-start";
  const actor = {
    kind: "agent" as const,
    conversationId: "conversation-direct-start",
  };
  const workflow = createWorkflowDefinitionRecord();
  const definition = {
    ...workflow.definition,
    parameters: options.parameters ?? workflow.definition.parameters,
  };
  const document: DeliveryPlanDocument = {
    schemaVersion: 2,
    launch: {
      name: "Direct spec launch",
      description: "Launch the signed candidate without a saved definition.",
      definition,
      layout: {
        ...workflow.layout,
        viewport: { x: 19, y: -7, zoom: 1.25 },
      },
    },
    binding: {
      dispositions: [authored.criterionOneId, authored.criterionTwoId].map(
        (criterionElementId) => ({
          criterionElementId,
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        }),
      ),
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: [
            authored.criterionOneId,
            authored.criterionTwoId,
          ],
        },
      ],
    },
  };
  const candidate: DeliveryPlanCandidateRecord = {
    protocol: "native-sdd-delivery-candidate/v2",
    schemaVersion: 2,
    specId: authored.specId,
    attemptId,
    candidateId,
    pinnedRevisionId: authored.draftRevisionId,
    draftRevision: 1,
    document: {
      schemaVersion: 2,
      launch: finalizeDeliveryPlanLaunch({
        specId: authored.specId,
        specSlug: SLUG,
        attemptId,
        candidateId,
        launch: document.launch,
      }),
      binding: document.binding,
    },
  };
  const candidateHash = deliveryPlanCandidateHash(candidate);

  world.repos.deliveryPlans.open({
    attempt: {
      id: attemptId,
      spec_id: authored.specId,
      pinned_revision_id: authored.draftRevisionId,
      delta_basis_execution_id: null,
      status: "draft",
      draft_revision: 1,
      content_json: canonicalDeliveryPlanEnvelopeBytes(document),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      created_at: world.now(),
      updated_at: world.now(),
    },
    occurredAt: world.now(),
    actor,
  });
  world.repos.deliveryPlans.propose({
    attemptId,
    expectedDraftRevision: 1,
    snapshotId,
    candidate: { record: candidate, candidateHash },
    proposedAt: world.now(),
    actor,
  });
  world.repos.deliveryPlans.recordTransition({
    attemptId,
    transition: { kind: "approve", candidateId, candidateHash },
    occurredAt: world.now(),
    actor: { kind: "human" },
  });
  return { attemptId, candidateId, candidateHash };
}

describe("delivery-plan start boundary", () => {
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

  it("rejects a retired scope document through the authenticated start route", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);

    const response = await startExecution(
      world,
      {
        scope: {
          selectedTaskIds: ["legacy-task"],
          selectedCriterionIds: [],
          exclusionDispositions: [],
        },
      },
      authored,
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(payload.code).toBe("validation");
    expect(payload.instruction).toContain(`cctl spec plan open ${SLUG}`);
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });

  it("requires an approved delivery-plan attempt through the authenticated start route", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);

    const response = await startExecution(world, {}, authored);

    expect(response.status).toBe(404);
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(payload.code).toBe("not_found");
    expect(payload.instruction).toContain(`cctl spec plan open ${SLUG}`);
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });

  it("launches the exact signed one-off candidate and commits its typed binding without a saved definition", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const candidate = seedApprovedCandidate(world, authored);

    const response = await startExecution(world, {}, authored);
    const payload = (await response.json()) as {
      execution?: { id: string; workflowExecutionId: string | null };
      deliveryPlan?: {
        attemptId: string;
        candidateId: string;
        candidateHash: string;
        workflowExecutionId: string;
        resolvedDefinitionHash: string;
      };
    };

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.execution, JSON.stringify(payload)).toBeDefined();
    expect(world.readActiveWorkflowExecution()).not.toBeNull();
    const execution = world.repos.delivery.findExecutionById(
      payload.execution!.id,
    );
    expect(execution).toMatchObject({
      revision_id: authored.draftRevisionId,
      workflow_definition_id: null,
      workflow_definition_revision: null,
      workflow_execution_binding_json: null,
      workflow_execution_id: payload.execution!.workflowExecutionId,
      state: "running",
    });
    expect(
      world.repos.executionBindings.requireByWorkflowExecutionId(
        payload.execution!.workflowExecutionId!,
        {
          specExecutionId: payload.execution!.id,
          candidateId: candidate.candidateId,
          candidateHash: candidate.candidateHash,
          pinnedRevisionId: authored.draftRevisionId,
        },
      ).binding,
    ).toMatchObject({
      schemaVersion: 2,
      dispositions: [
        { criterionElementId: authored.criterionOneId },
        { criterionElementId: authored.criterionTwoId },
      ],
      claims: [{ contextId: "context-implement" }],
    });
    expect(
      world.repos.deliveryPlans.findAttemptById(candidate.attemptId),
    ).toMatchObject({
      status: "launched",
      launched_execution_id: payload.execution!.id,
    });
    const active = world.readActiveWorkflowExecution();
    expect(active?.origin).toEqual({
      kind: "spec_delivery",
      specSlug: SLUG,
      candidateId: candidate.candidateId,
    });
    expect(active?.launchDocument).toMatchObject({
      layout: { viewport: { x: 19, y: -7, zoom: 1.25 } },
    });
    const resolvedHash = workingDefinitionHash(active!.workingDefinition);
    expect(resolvedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(active?.ownerConversationId).toBe(SPINE_CONVERSATION_ID);
    expect(payload.deliveryPlan).toEqual({
      ...candidate,
      workflowExecutionId: payload.execution!.workflowExecutionId,
      resolvedDefinitionHash: resolvedHash,
    });
    expect(await world.definitions.list()).toEqual([]);
  });

  it("forwards required, defaulted, enum, and text inputs to ordinary graph validation", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    seedApprovedCandidate(world, authored, {
      parameters: [
        {
          type: "string",
          name: "ticket",
          label: "Ticket",
          required: true,
        },
        {
          type: "string",
          name: "owner",
          label: "Owner",
          required: false,
          default: "graph-default",
        },
        {
          type: "enum",
          name: "mode",
          label: "Mode",
          required: true,
          options: ["careful", "fast"],
        },
        {
          type: "text",
          name: "brief",
          label: "Brief",
          required: true,
        },
      ],
    });
    const parameters = {
      ticket: "command-center#66",
      mode: "careful",
      brief: "Preserve this text exactly.\nIncluding its newline.",
    };

    const response = await startExecution(world, { parameters }, authored);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(world.readActiveWorkflowExecution()?.boundInputs).toEqual({
      ...parameters,
      owner: "graph-default",
    });
  });

  it.each([
    ["missing required", {}, 'Required parameter "ticket" was not supplied'],
    [
      "invalid enum",
      { ticket: "66", mode: "reckless", brief: "detail" },
      'Parameter "mode" is invalid',
    ],
    [
      "invalid text",
      { ticket: "66", mode: "careful", brief: 42 },
      'Parameter "brief" is invalid',
    ],
    [
      "extra input",
      { ticket: "66", mode: "careful", brief: "detail", extra: "no" },
      'Unknown parameter "extra"',
    ],
  ])(
    "returns the ordinary graph refusal for %s",
    async (_label, parameters, message) => {
      const authored = await authorSpineDraft(world, SLUG, "gate");
      await proposeSpineRevision(world, SLUG, authored);
      await approveAndSignOffSpine(world, SLUG, authored);
      seedApprovedCandidate(world, authored, {
        parameters: [
          {
            type: "string",
            name: "ticket",
            label: "Ticket",
            required: true,
          },
          {
            type: "enum",
            name: "mode",
            label: "Mode",
            required: true,
            options: ["careful", "fast"],
          },
          {
            type: "text",
            name: "brief",
            label: "Brief",
            required: true,
          },
        ],
      });

      const response = await startExecution(world, { parameters }, authored);
      const payload = (await response.json()) as {
        code?: string;
        unmetConditions?: string[];
      };

      expect(response.status).toBe(400);
      expect(payload.code).toBe("validation");
      expect(payload.unmetConditions?.join(" ")).toContain(message);
      expect(graphWorkflowExecutionRowCount(world)).toBe(0);
    },
  );

  it("rejects a non-object route input payload before launch", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    seedApprovedCandidate(world, authored);

    const response = await startExecution(
      world,
      { parameters: ["not", "an", "object"] },
      authored,
    );

    expect(response.status).toBe(400);
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });

  it("rechecks session readiness when another graph occupies the session after sign-off", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const candidate = seedApprovedCandidate(world, authored);
    const saved = createWorkflowDefinitionRecord();
    await world.definitions.create({
      name: saved.name,
      description: saved.description,
      definition: saved.definition,
      layout: saved.layout,
    });
    const occupied = await world.postWorkflowRoute("START", {
      definitionId: "workflow-definition-1",
    });
    expect(occupied.status).toBe(202);

    const response = await startExecution(world, {}, authored);
    const payload = (await response.json()) as {
      code?: string;
      unmetConditions?: string[];
    };

    expect(response.status).toBe(409);
    expect(payload.code).toBe("workflow_unavailable");
    expect(payload.unmetConditions?.join(" ")).toContain(
      "already has an active graph workflow execution",
    );
    expect(
      world.repos.deliveryPlans.findAttemptById(candidate.attemptId),
    ).toMatchObject({
      status: "approved",
      launched_execution_id: null,
    });
    expect(
      world.repos.delivery.findActiveExecutionBySpecId(authored.specId),
    ).toBeNull();
    expect(world.readActiveWorkflowExecution()?.origin).toMatchObject({
      kind: "template",
      definitionId: "workflow-definition-1",
    });
  });

  it("fails closed when approved candidate bytes name a different spec", async () => {
    const authored = await authorSpineDraft(world, SLUG, "gate");
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const candidate = seedApprovedCandidate(world, authored);
    const snapshot = world.repos.deliveryPlans.findSnapshotsByAttemptId(
      candidate.attemptId,
    )[0]!;
    const mismatched = JSON.parse(snapshot.content_json) as {
      specId: string;
    };
    mismatched.specId = "spec-from-another-attempt";
    world.db
      .prepare(
        "UPDATE spec_delivery_plan_snapshots SET content_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(mismatched), snapshot.id);

    const response = await startExecution(world, {}, authored);
    const payload = (await response.json()) as {
      code?: string;
      unmetConditions?: string[];
    };

    expect(response.status).toBe(409);
    expect(payload.code).toBe("integrity_mismatch");
    expect(payload.unmetConditions?.join(" ")).toContain(
      "spec-from-another-attempt",
    );
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });
});
