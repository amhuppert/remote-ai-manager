import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecEventsPublisher } from "./events";
import {
  createDeliveryContinuationService,
  type DeliveryContinuationService,
} from "./delivery-continuation";
import { specDeliveryBasisSchema } from "./schemas";
import { createExecutionService } from "./execution-service";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createJobsRepo } from "@/lib/jobs/repo";

const NOW = "2026-09-12T12:00:00Z";
let fixture: PersistenceFixture;
let service: DeliveryContinuationService;
const request = {
  specId: "spec",
  revisionId: "revision",
  expectedExecutionId: null,
  commitRefs: [],
  note: "Delivery continued",
  actor: { kind: "human" as const },
};

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject("/continuation");
  await fixture.specs.transaction("seed", (repo) => {
    repo.create({
      spec: {
        id: "spec",
        projectPath: "/continuation",
        slug: "continuation",
        name: "Continuation",
        gatePolicy: { preset: "contract-bearing" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      initialRevision: {
        id: "revision",
        authoringStage: "design",
        createdAt: NOW,
      },
    });
    repo.createDraftElement({
      id: "requirement",
      specId: "spec",
      revisionId: "revision",
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "Deliver flexibly",
        priority: "must",
        risk: "medium",
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    repo.createDraftElement({
      id: "criterion",
      specId: "spec",
      revisionId: "revision",
      kind: "criterion",
      parentElementId: "requirement",
      payload: {
        kind: "criterion",
        text: "Delivery works",
        validationStrategy: { kinds: ["test_run"] },
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    repo.createDraftElement({
      id: "criterion-second",
      specId: "spec",
      revisionId: "revision",
      kind: "criterion",
      parentElementId: "requirement",
      payload: {
        kind: "criterion",
        text: "The remaining delivery works",
        validationStrategy: { kinds: ["test_run"] },
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    repo.approveRevision({ revisionId: "revision", approvedAt: NOW });
  });
  let sequence = 0;
  const events = createSpecEventsRepo(fixture.db);
  service = createDeliveryContinuationService({
    deliveryPlan: {
      async open() {
        throw new Error("No replacement expected");
      },
      async abandonPrelaunch() {
        return {
          ok: false,
          refusal: {
            code: "not_found",
            unmetConditions: ["No plan"],
            instruction: "Continue delivery",
          },
        };
      },
    },
    specs: fixture.specs,
    delivery: createSpecDeliveryRepo(fixture.db),
    links: createSpecLinksRepo(fixture.db),
    events: createSpecEventsPublisher({
      appendInTransaction: events.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    execution: {
      async retireDelivery() {
        throw new Error("No active graph expected");
      },
    },
    sessionExists: async () => true,
    workflowExists: async () => true,
    nextId: () => `continuation-${++sequence}`,
    now: () => NOW,
  });
});
afterEach(() => fixture.close());

describe("delivery continuation", () => {
  it("keeps session delivery pending through failure and reconciles only a successful publication", async () => {
    const continued = await service.continue({
      ...request,
      mode: "session",
      sessionName: "work",
    });
    if (!continued.ok) throw new Error("Fixture continuation failed");
    const jobs = createJobsRepo(fixture.db);
    const events = createSpecEventsRepo(fixture.db);
    const lifecycle = createExecutionService({
      specsRepo: fixture.specs,
      deliveryRepo: createSpecDeliveryRepo(fixture.db),
      bindingRepo: createSpecExecutionBindingRepo(fixture.db),
      linksRepo: createSpecLinksRepo(fixture.db),
      eventsRepo: events,
      reviewRepo: createSpecReviewRepo(fixture.db),
      plansRepo: createSpecDeliveryPlanRepo(fixture.db, {
        appendEvent: events.appendInTransaction,
      }),
      events: createSpecEventsPublisher({
        appendInTransaction: events.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      writeQueue: createWriteQueue(),
      nextId: (kind) => `published-${kind}`,
      now: () => NOW,
      sessionExists: async () => true,
      getWorkflowExecutionStatus: async () => null,
      getPublishedMerge: async () => null,
      getPublishedMergeBySpecExecutionId: async (id) =>
        jobs.findLatestPublishedMergeBySpecExecutionId(id),
      runInImmediateTransaction: (operation) =>
        fixture.db.transaction(operation).immediate(),
    });
    jobs.createJobRecord({
      jobId: "merge",
      jobType: "merge",
      status: "running",
      projectName: "continuation",
      sessionName: "work",
      branchName: "work",
      startedAt: NOW,
      specExecutionId: continued.value.id,
      finalPublish: true,
    });
    jobs.updateJobRecord("merge", { status: "failed", mergeHash: "failed" });
    expect(
      await lifecycle.markDelivered(continued.value.id, "failed"),
    ).toMatchObject({ ok: false });
    expect(
      createSpecDeliveryRepo(fixture.db).findExecutionById(continued.value.id)
        ?.state,
    ).toBe("running");
    jobs.updateJobRecord("merge", {
      status: "completed",
      mergeHash: "published",
    });
    expect(await lifecycle.getStatus(continued.value.id)).toMatchObject({
      ok: true,
      value: { execution: { state: "delivered" } },
    });
    expect(createSpecLinksRepo(fixture.db).findBySpecId("spec")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object_kind: "merge_job" }),
      ]),
    );
  });
  it("starts pending session delivery for an approved spec that never launched a graph", async () => {
    const result = await service.continue({
      ...request,
      mode: "session",
      sessionName: "work",
    });
    expect(result.ok).toBe(true);
    const execution = createSpecDeliveryRepo(
      fixture.db,
    ).findActiveExecutionBySpecId("spec");
    expect(execution).toMatchObject({
      state: "running",
      session_name: "work",
      revision_id: "revision",
      workflow_execution_id: null,
      delivered_at: null,
    });
    const basis = specDeliveryBasisSchema.parse(
      JSON.parse(execution?.delivery_basis_json ?? "null"),
    );
    expect(basis).toMatchObject({
      kind: "session",
      actor: { kind: "human" },
      sourceSpecExecutionIds: [],
    });
  });

  it("records already delivered work as human external delivery without a CC merge claim", async () => {
    const result = await service.continue({
      ...request,
      mode: "external",
      commitRefs: ["abc123"],
    });
    expect(result.ok).toBe(true);
    const execution = createSpecDeliveryRepo(fixture.db).findExecutionsBySpecId(
      "spec",
    )[0];
    expect(execution).toMatchObject({
      state: "delivered",
      delivered_at: NOW,
      workflow_execution_id: null,
    });
    expect(JSON.parse(execution?.delivery_basis_json ?? "null")).toMatchObject({
      kind: "external",
      commitRefs: ["abc123"],
      actor: { kind: "human" },
    });
    expect(
      createSpecLinksRepo(fixture.db)
        .findBySpecId("spec")
        .some((link) => link.object_kind === "merge_job"),
    ).toBe(false);
  });

  it("does not let an agent record an external human delivery", async () => {
    expect(
      await service.continue({
        ...request,
        mode: "external",
        actor: { kind: "agent", conversationId: "agent" },
      }),
    ).toMatchObject({ ok: false, refusal: { code: "human_act_required" } });
    expect(
      createSpecDeliveryRepo(fixture.db).findExecutionsBySpecId("spec"),
    ).toEqual([]);
  });
});

it("continues the most recent abandoned scope and records another workflow only as a source", async () => {
  const first = await service.continue({ ...request, mode: "external" });
  if (!first.ok) throw new Error("Fixture delivery failed");
  const delivery = createSpecDeliveryRepo(fixture.db);
  delivery.insertExecution({
    ...first.value,
    id: "z-latest-attempt",
    state: "abandoned",
    delivered_at: null,
    scope_json: JSON.stringify({
      selectedTaskIds: [],
      selectedCriterionIds: ["criterion-second"],
      exclusionDispositions: [
        { criterionId: "criterion", disposition: "deferred" },
      ],
    }),
    delivery_basis_json: null,
    workflow_execution_id: "abandoned-source",
    session_name: "work",
    abandoned_reason: "Stopped",
  });
  delivery.saveCriterionDisposition({
    execution_id: "z-latest-attempt",
    criterion_element_id: "criterion",
    disposition: "deferred",
    waiver_id: null,
    delivered_by_execution_id: null,
    created_at: NOW,
    updated_at: NOW,
  });
  const result = await service.continue({
    ...request,
    mode: "workflow",
    sessionName: "work",
    workflowExecutionId: "unrelated-workflow",
  });
  if (!result.ok) throw new Error("Continuation refused");
  expect(JSON.parse(result.value.scope_json)).toMatchObject({
    selectedCriterionIds: ["criterion-second"],
    exclusionDispositions: [
      { criterionId: "criterion", disposition: "deferred" },
    ],
  });
  expect(result.value.state).toBe("running");
  expect(result.value.workflow_execution_id).toBeNull();
  expect(JSON.parse(result.value.delivery_basis_json ?? "null")).toMatchObject({
    sourceSpecExecutionIds: ["z-latest-attempt"],
    sourceWorkflowExecutionIds: ["abandoned-source", "unrelated-workflow"],
  });
  expect(delivery.findExecutionById("z-latest-attempt")).toMatchObject({
    state: "abandoned",
    workflow_execution_id: "abandoned-source",
  });
});
