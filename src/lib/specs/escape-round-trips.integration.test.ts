import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import { deliveryPlanReviewViewSchema } from "./delivery-plan-review";
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
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

/**
 * The two escapes design §11 requires a locked plan to have, exercised through
 * the production routes rather than the services beneath them.
 *
 * Prelaunch, the escape is reopen → edit → re-propose: the candidate identity
 * moves, so the approval that bound the old one no longer admits a launch. The
 * Studio review anchors ride along, because a reopen that silently stranded a
 * reviewer's comments would be an escape that loses the review.
 *
 * Post-launch, the escape is the blocking capture: the abandon coordinator
 * retires the run and the same act opens the seeded replacement. Both traverse
 * `specActionPOST` with a transport actor — `evidence-legality` says the human
 * sign-off and the audited capture cannot be stood in for by a service call.
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

async function reviewView(world: SpecSpineWorld) {
  const response = await world.writeHandlers.specPlanReviewGET(
    new Request(
      `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/${SLUG}/plan/review`,
    ),
    { params: Promise.resolve({ name: SPINE_PROJECT_NAME, slug: SLUG }) },
  );
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return deliveryPlanReviewViewSchema.parse(payload);
}

/** `plan-comment` answers with the review projection, not the mutation view. */
async function commentAction(
  world: SpecSpineWorld,
  contextId: string,
  body: string,
) {
  const response = await world.postAction(
    SLUG,
    "plan-comment",
    { contextId, body },
    "human",
  );
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return deliveryPlanReviewViewSchema.parse(payload);
}

function governance() {
  return {
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
        description: "Section 11 owns the escapes.",
        appliesTo: null,
        accessPolicy: "external-readonly",
      },
    ],
    validationCommandNames: ["typecheck"],
  };
}

/** Two contexts, so a reopen can remove one and strand an anchor on it. */
function twoContextDocument(
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
        title: "Deliver the first criterion",
        instructions: "Implement the spine feature and prove criterion one.",
        order: 0,
        contributesToCriterionElementIds: [authored.criterionOneId],
      },
      {
        taskId: "task-verify",
        contextId: "ctx-verify",
        title: "Verify the second criterion",
        instructions: "Prove criterion two against the delivered spine.",
        order: 0,
        contributesToCriterionElementIds: [authored.criterionTwoId],
      },
    ],
    edges: [
      {
        edgeId: "edge-deliver-verify",
        fromContextId: "ctx-deliver",
        toContextId: "ctx-verify",
      },
    ],
    wiring: [],
    policyOverrides: [],
    touchedSurfaces: ["src/lib/specs/"],
    governance: governance(),
  });
}

/** The same plan after the reopen removes `ctx-verify` and absorbs its work. */
function oneContextDocument(
  seeded: DeliveryPlanDocument,
  authored: AuthoredSpineSpec,
): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...seeded,
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
  });
}

async function planTwoContexts(world: SpecSpineWorld): Promise<PlannedSpine> {
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
      document: twoContextDocument(opened.document, authored),
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

describe("prelaunch escape — reopen, re-propose, re-approve", () => {
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

  it("moves the candidate identity and demands a fresh sign-off before launch", async () => {
    const planned = await planTwoContexts(world);
    await planAction(world, "plan-sign-off", planned.candidate, "human");

    // Two reviewer anchors on the approved snapshot: one on a context the
    // reopen keeps, one on the context it removes.
    await commentAction(
      world,
      "ctx-deliver",
      "Name the production wiring here.",
    );
    await commentAction(world, "ctx-verify", "This split looks unnecessary.");

    const reopened = await planAction(
      world,
      "plan-reopen",
      { reason: "the verification context should fold into delivery" },
      "agent",
    );
    expect(reopened.attempt.status).toBe("draft");

    await planAction(
      world,
      "plan-edit",
      {
        expectedDraftRevision: reopened.attempt.draftRevision,
        document: oneContextDocument(reopened.document, planned.authored),
      },
      "agent",
    );
    await planAction(world, "plan-propose", {}, "agent");
    const repropose = await proposedPreview(world);

    // A new candidate: the approval that bound the old identity cannot admit
    // this one, and the launch says so instead of running it.
    expect(repropose.compiledDefinitionHash).not.toBe(
      planned.candidate.compiledDefinitionHash,
    );
    expect(repropose.planHash).not.toBe(planned.candidate.planHash);

    const premature = await startExecution(world, {}, planned.authored);
    const payload = (await premature.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(premature.status, JSON.stringify(payload)).toBe(409);
    expect(payload.code).toBe("gate_blocked");
    expect(payload.instruction).toContain("cctl spec plan sign-off");
    expect(payload.instruction).toContain(repropose.compiledDefinitionHash);

    // The anchors resolve against the NEW snapshot: the surviving context
    // still carries its note, the removed one surfaces its note as orphaned.
    const review = await reviewView(world);
    const byContext = new Map(
      review.comments.map((comment) => [comment.contextId, comment]),
    );
    expect(byContext.get("ctx-deliver")).toMatchObject({ orphaned: false });
    expect(byContext.get("ctx-verify")).toMatchObject({ orphaned: true });

    // Signing off the new candidate is the whole escape: the launch admits it.
    const candidateId = repropose.candidateId;
    if (candidateId === null) throw new Error("the re-proposal stored none");
    await planAction(
      world,
      "plan-sign-off",
      {
        candidateId,
        planHash: repropose.planHash,
        compiledDefinitionHash: repropose.compiledDefinitionHash,
      },
      "human",
    );
    const launched = await startExecution(world, {}, planned.authored);
    expect(launched.status, JSON.stringify(await launched.clone().json())).toBe(
      200,
    );
  });

  it("reopens a proposed attempt that was never signed off and still demands one", async () => {
    const planned = await planTwoContexts(world);

    const reopened = await planAction(
      world,
      "plan-reopen",
      { reason: "the verification context should fold into delivery" },
      "agent",
    );
    expect(reopened.attempt.status).toBe("draft");

    await planAction(
      world,
      "plan-edit",
      {
        expectedDraftRevision: reopened.attempt.draftRevision,
        document: oneContextDocument(reopened.document, planned.authored),
      },
      "agent",
    );
    await planAction(world, "plan-propose", {}, "agent");
    const repropose = await proposedPreview(world);
    expect(repropose.compiledDefinitionHash).not.toBe(
      planned.candidate.compiledDefinitionHash,
    );

    const premature = await startExecution(world, {}, planned.authored);
    const payload = (await premature.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(premature.status, JSON.stringify(payload)).toBe(409);
    expect(payload.code).toBe("gate_blocked");
    expect(payload.instruction).toContain(repropose.compiledDefinitionHash);
  });
});

describe("post-launch escape — blocking replan through the capture route", () => {
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

  it("abandons the launched run and opens the seeded replacement in one act", async () => {
    const planned = await planTwoContexts(world);
    await planAction(world, "plan-sign-off", planned.candidate, "human");
    const started = await startExecution(world, {}, planned.authored);
    const startPayload = (await started.json()) as {
      execution?: { id: string };
    };
    expect(started.status, JSON.stringify(startPayload)).toBe(200);
    const specExecutionId = startPayload.execution?.id ?? "";
    expect(world.readActiveWorkflowExecution()).not.toBeNull();

    const pinnedPlan = world.db
      .prepare(
        "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get(planned.attemptId) as { content_json: string };

    const captured = await world.postAction(
      SLUG,
      "capture-scope-amendment",
      {
        discoveredTask: {
          title: "Implement the discovered prerequisite",
          instructions: "The pinned scope cannot absorb this prerequisite.",
          tracedRequirementElementIds: [],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: [planned.authored.criterionTwoId],
          dependsOnTaskElementIds: [],
          touchedPaths: ["src/lib/specs"],
        },
        blockingReason: "The prerequisite blocks every remaining task.",
      },
      "agent",
    );
    const capturePayload = (await captured.json()) as {
      restartRequired?: boolean;
      replacement?: {
        abandonedExecutionId: string;
        replacementAttemptId: string;
      } | null;
    };
    expect(captured.status, JSON.stringify(capturePayload)).toBe(200);
    expect(capturePayload.restartRequired).toBe(true);
    expect(capturePayload.replacement?.abandonedExecutionId).toBe(
      specExecutionId,
    );

    // The coordinator ran to the end: the workflow no longer owns the slot and
    // the spec execution is durably abandoned with the blocking reason.
    expect(world.readActiveWorkflowExecution()).toBeNull();
    expect(
      world.db
        .prepare(
          "SELECT state, abandoned_reason FROM spec_executions WHERE id = ?",
        )
        .get(specExecutionId),
    ).toEqual({
      state: "abandoned",
      abandoned_reason: "The prerequisite blocks every remaining task.",
    });

    // The retired run keeps its pinned plan byte-for-byte — the replacement is
    // a NEW attempt, which is what keeps `exact-approval` true of the run that
    // was already launched.
    expect(
      (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
          )
          .get(planned.attemptId) as { content_json: string }
      ).content_json,
    ).toBe(pinnedPlan.content_json);

    const replacementAttemptId =
      capturePayload.replacement?.replacementAttemptId ?? "";
    expect(replacementAttemptId).not.toBe(planned.attemptId);
    const seeded = world.db
      .prepare(
        "SELECT status, content_json FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get(replacementAttemptId) as { status: string; content_json: string };
    expect(seeded.status).toBe("draft");
    const seededDocument = JSON.parse(seeded.content_json) as {
      tasks: Array<{ title: string }>;
    };
    expect(seededDocument.tasks.map((task) => task.title)).toContain(
      "Implement the discovered prerequisite",
    );
  });
});
