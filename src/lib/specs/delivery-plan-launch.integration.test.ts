import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import type { SessionState } from "@/lib/sessions/schemas";
import { createProductionValidationCallerResolver } from "@/lib/validation/singleton";
import { deliveryPlanCompiledHash } from "./delivery-plan-materializer";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  deliveryPlanMutationViewSchema,
  deliveryPlanPreviewViewSchema,
  deliveryPlanViewSchema,
  type DeliveryPlanMutationView,
  type DeliveryPlanPreviewView,
} from "./delivery-plan-views";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  SPINE_CONVERSATION_ID,
  SPINE_PROJECT_NAME,
  SPINE_PROJECT_PATH,
  SPINE_SESSION_NAME,
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

/**
 * The single-act launch, end to end through the production spec routes: plan
 * open → propose → human sign-off → `spec start`.
 *
 * Everything here traverses `specActionPOST` with a transport actor, because
 * the approval and the launch are exactly the acts `evidence-legality` says a
 * direct service call cannot stand in for — a fixture that called
 * `deliveryPlan.signOff` would prove the service works while leaving the route,
 * the human attribution, and the owner threading untested.
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

function spineSession(): SessionState {
  return {
    sessionName: SPINE_SESSION_NAME,
    worktreePath: `${SPINE_PROJECT_PATH}/.worktrees/${SPINE_SESSION_NAME}`,
    branchName: "cc/spec-spine",
    createdAt: "2026-08-08T10:00:00.000Z",
    lastActivityAt: "2026-08-08T10:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

/**
 * The production caller resolver over this world's live execution store. The
 * owner identity it reads has to be PRODUCED by the launch under test — a
 * seeded `ownerConversationId` would only prove the resolver reads a field.
 */
function callerResolver(world: SpecSpineWorld) {
  return createProductionValidationCallerResolver({
    getSession: async (projectPath, sessionName) =>
      projectPath === SPINE_PROJECT_PATH && sessionName === SPINE_SESSION_NAME
        ? spineSession()
        : null,
    getActiveGraphWorkflowExecution: async () =>
      world.readActiveWorkflowExecution(),
    readRepoValidation: async () => null,
  });
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
  const request = new Request(
    `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/${SLUG}/plan/preview?stage=proposed`,
  );
  const response = await world.writeHandlers.specPlanPreviewGET(request, {
    params: Promise.resolve({ name: SPINE_PROJECT_NAME, slug: SLUG }),
  });
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return deliveryPlanPreviewViewSchema.parse(payload);
}

/** A lint-clean plan over the spine's two criteria, in one delivery context. */
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
        acceptanceContract: [
          "Both spine criteria are observable in production.",
        ],
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
          description: "Section 5 owns the single-act launch.",
          appliesTo: null,
          accessPolicy: "external-readonly",
        },
      ],
      validationCommandNames: ["typecheck"],
    },
  });
}

async function planTo(
  world: SpecSpineWorld,
  dial: "gate" | "notify" | "off" = "gate",
): Promise<PlannedSpine> {
  const authored = await authorSpineDraft(world, SLUG, dial);
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

describe("delivery-plan sign-off and single-act launch", () => {
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
    expect(payload.instruction).toContain(
      `cctl spec plan open ${SLUG} --seed-from last`,
    );
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
    expect(payload.instruction).toContain(
      `cctl spec plan open ${SLUG} --seed-from last`,
    );
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });

  it("binds the approval and its admission to the candidate identity, through the human route", async () => {
    const planned = await planTo(world);

    const signed = await planAction(
      world,
      "plan-sign-off",
      planned.candidate,
      "human",
    );

    expect(signed.attempt.status).toBe("approved");
    expect(signed.approval).toMatchObject({
      ...planned.candidate,
      approvedBy: { kind: "human" },
    });
    expect(signed.executionStartAdmission).toMatchObject({
      dial: "gate",
      basis: "human_approval",
    });
    const admissions = world.repos.review.findGateAdmissionsBySpecId(
      planned.authored.specId,
    );
    const executionStart = admissions.filter(
      (row) => row.gate === "execution_start",
    );
    expect(executionStart).toHaveLength(1);
    expect(executionStart[0]).toMatchObject({
      basis: "human_approval",
      execution_id: null,
    });
    // The audit record binds the same identity the approval does.
    const transition = world.repos.events
      .findBySpecId(planned.authored.specId)
      .filter((event) => event.event_type === "spec-delivery-plan-transitioned")
      .map(
        (event) => JSON.parse(event.payload_json) as { transition?: unknown },
      )
      .at(-1);
    expect(transition?.transition).toMatchObject({
      kind: "approve",
      ...planned.candidate,
    });
  });

  it("refuses a sign-off that substitutes the compiled hash while holding the plan hash", async () => {
    const planned = await planTo(world);

    const response = await world.postAction(
      SLUG,
      "plan-sign-off",
      {
        candidateId: planned.candidate.candidateId,
        planHash: planned.candidate.planHash,
        compiledDefinitionHash: `sha256:${"e".repeat(64)}`,
      },
      "human",
    );

    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(payload.code).toBe("integrity_mismatch");
    expect(payload.instruction).toContain("cctl spec plan propose");
    expect(payload.instruction).toContain(
      planned.candidate.compiledDefinitionHash,
    );
    // Nothing was written: the attempt is still an unapproved proposal.
    const attempt = world.db
      .prepare(
        "SELECT status, approval_json FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get(planned.attemptId) as {
      status: string;
      approval_json: string | null;
    };
    expect(attempt).toMatchObject({ status: "proposed", approval_json: null });
  });

  it("refuses an agent sign-off while the execution_start dial is gate", async () => {
    const planned = await planTo(world);

    const response = await world.postAction(
      SLUG,
      "plan-sign-off",
      planned.candidate,
      "agent",
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe("human_act_required");
    expect(
      world.repos.review
        .findGateAdmissionsBySpecId(planned.authored.specId)
        .filter((row) => row.gate === "execution_start"),
    ).toHaveLength(0);
  });

  it("launches the approved candidate unchanged, owner-threaded, with no execution row before launch", async () => {
    const planned = await planTo(world);
    await planAction(world, "plan-sign-off", planned.candidate, "human");

    // Before launch: no graph-workflow execution exists at all, and every
    // session conversation resolves normally because nothing owns the slot.
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
    expect(world.readActiveWorkflowExecution()).toBeNull();
    const resolver = callerResolver(world);
    const beforeLaunch = await resolver.resolveCaller({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
      conversationId: "conversation-unrelated",
    });
    expect(beforeLaunch.kind).toBe("session");

    const response = await startExecution(world, {}, planned.authored);
    const payload = (await response.json()) as {
      execution?: { id: string };
      definition?: { id: string; definition: unknown };
      deliveryPlan?: { compiledDefinitionHash: string; attemptId: string };
    };
    expect(response.status, JSON.stringify(payload)).toBe(200);

    // exact-approval: the definition the launch persisted hashes to exactly
    // the candidate the human approved.
    const stored = world.definitions.findById(payload.definition?.id ?? "");
    if (stored === null) throw new Error("the launch persisted no definition");
    expect(deliveryPlanCompiledHash(stored.definition)).toBe(
      planned.candidate.compiledDefinitionHash,
    );
    expect(payload.deliveryPlan?.compiledDefinitionHash).toBe(
      planned.candidate.compiledDefinitionHash,
    );

    // The launch created the workflow execution, and it carries the
    // authenticated conversation that ran `spec start`.
    const active = world.readActiveWorkflowExecution();
    expect(active?.ownerConversationId).toBe(SPINE_CONVERSATION_ID);
    const afterLaunch = await resolver.resolveCaller({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
      conversationId: SPINE_CONVERSATION_ID,
    });
    expect(afterLaunch.kind).toBe("session");
    const strangerAfterLaunch = await resolver.resolveCaller({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
      conversationId: "conversation-unrelated",
    });
    expect(strangerAfterLaunch.kind).toBe("ambiguous");

    // The plan records the run it became, durably.
    const attempt = world.db
      .prepare(
        "SELECT status, launched_execution_id FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get(planned.attemptId) as {
      status: string;
      launched_execution_id: string | null;
    };
    expect(attempt).toMatchObject({
      status: "launched",
      launched_execution_id: payload.execution?.id,
    });
  });

  it("refuses a premature start naming the next act in the open/propose/sign-off chain", async () => {
    const planned = await planTo(world);

    const response = await startExecution(world, {}, planned.authored);

    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(payload.code).toBe("gate_blocked");
    expect(payload.instruction).toContain("cctl spec plan sign-off");
    expect(payload.instruction).toContain(
      planned.candidate.compiledDefinitionHash,
    );
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });

  it("records a policy-basis admission and no human approval under a notify dial", async () => {
    const planned = await planTo(world, "notify");

    const signed = await planAction(
      world,
      "plan-sign-off",
      planned.candidate,
      "agent",
    );

    expect(signed.executionStartAdmission).toMatchObject({
      dial: "notify",
      basis: "notify_policy",
      approvalId: null,
    });
    expect(
      world.reviewNotifications.policyAdmitted.filter(
        (notice) => notice.gate === "execution_start",
      ),
    ).toHaveLength(1);
    // No second gate: the same act that admitted the dial launches.
    const response = await startExecution(world, {}, planned.authored);
    expect(response.status).toBe(200);
  });
});

describe("delivery-plan prelaunch park", () => {
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

  it("rejects a retired scope document instead of silently parking it", async () => {
    const planned = await planTo(world);

    const response = await startExecution(
      world,
      {
        park: true,
        scope: {
          selectedTaskIds: ["legacy-task"],
          selectedCriterionIds: [],
          exclusionDispositions: [],
        },
      },
      planned.authored,
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { instruction?: string };
    expect(payload.instruction).toContain(
      `cctl spec plan open ${SLUG} --seed-from last`,
    );
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
  });

  it("parks durably without creating an execution or taking the session slot", async () => {
    const planned = await planTo(world);
    await planAction(world, "plan-sign-off", planned.candidate, "human");

    const response = await startExecution(
      world,
      { park: true },
      planned.authored,
    );
    const payload = (await response.json()) as {
      parked?: {
        attemptId: string;
        compiledDefinitionHash: string;
        nextAct: { actor: string; command: string };
      };
    };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.parked?.compiledDefinitionHash).toBe(
      planned.candidate.compiledDefinitionHash,
    );
    expect(payload.parked?.nextAct).toMatchObject({
      actor: "agent",
      command: `cctl spec start ${SLUG}`,
    });

    // Durable: the prelaunch record survives a reload through the repository.
    const row = world.db
      .prepare(
        "SELECT status, prelaunch_json FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get(planned.attemptId) as {
      status: string;
      prelaunch_json: string | null;
    };
    expect(row.status).toBe("parked");
    expect(JSON.parse(row.prelaunch_json ?? "null")).toMatchObject({
      candidate: planned.candidate,
      approvedAtPark: true,
    });

    // Slot-free: nothing occupies the session's active execution.
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);
    expect(world.readActiveWorkflowExecution()).toBeNull();
    const resolved = await callerResolver(world).resolveCaller({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
      conversationId: "conversation-unrelated",
    });
    expect(resolved.kind).toBe("session");
  });

  it("owes the sign-off, not a start, when an unapproved proposal is parked", async () => {
    const planned = await planTo(world);

    // Parking deliberately accepts an unapproved proposal: prelaunch review is
    // where the missing approval gets decided.
    const response = await startExecution(
      world,
      { park: true },
      planned.authored,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      parked?: { nextAct?: { actor: string; command: string } };
    };
    expect(payload.parked?.nextAct).toMatchObject({
      actor: "human",
      command: `cctl spec plan sign-off ${SLUG}`,
    });

    const read = await world.writeHandlers.specPlanGET(
      new Request(
        `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/${SLUG}/plan`,
      ),
      { params: Promise.resolve({ name: SPINE_PROJECT_NAME, slug: SLUG }) },
    );
    const view = deliveryPlanViewSchema.parse(await read.json());
    expect(view.attempt.status).toBe("parked");
    // Pointing this attempt at `spec start` would walk the caller straight
    // into the premature-start refusal.
    expect(view.nextAct).toMatchObject({
      actor: "human",
      command: `cctl spec plan sign-off ${SLUG}`,
    });

    const premature = await startExecution(world, {}, planned.authored);
    expect(premature.status).toBe(409);
  });

  it("refuses to launch a parked attempt tuned after approval, naming both hashes", async () => {
    const planned = await planTo(world);
    await planAction(world, "plan-sign-off", planned.candidate, "human");
    await startExecution(world, { park: true }, planned.authored);

    await planAction(
      world,
      "plan-reopen",
      { reason: "the closeout context is missing" },
      "agent",
    );
    const reopened = await planAction(world, "plan-propose", {}, "agent");
    const tuned = await proposedPreview(world);
    expect(tuned.compiledDefinitionHash).not.toBe(
      planned.candidate.compiledDefinitionHash,
    );

    const response = await startExecution(world, {}, planned.authored);

    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      unmetConditions?: string[];
      instruction?: string;
    };
    const refusal = [
      ...(payload.unmetConditions ?? []),
      payload.instruction ?? "",
    ].join("\n");
    expect(refusal).toContain(planned.candidate.compiledDefinitionHash);
    expect(refusal).toContain(tuned.compiledDefinitionHash);
    expect(refusal).toContain("cctl spec plan sign-off");
    expect(graphWorkflowExecutionRowCount(world)).toBe(0);

    // The receipt inventory carries the same two hashes side by side.
    expect(reopened.prelaunch).toMatchObject({
      parkedCompiledDefinitionHash: planned.candidate.compiledDefinitionHash,
      currentCompiledDefinitionHash: tuned.compiledDefinitionHash,
      candidateChanged: true,
    });
  });
});
