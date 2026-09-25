import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createDeliveryContinuationService } from "./delivery-continuation";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { readDeliveryReview } from "./delivery-review-query";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecEventsPublisher } from "./events";
import type { AcceptanceReviewRequest } from "./delivery-review-schemas";
import {
  createDeliveryReviewService,
  type DeliveryReviewService,
} from "./delivery-review-service";

const SPEC = "spec-review";
const REVISION = "revision-review";
const NOW = "2026-09-12T12:00:00Z";
let fixture: PersistenceFixture;
let service: DeliveryReviewService;
let request: AcceptanceReviewRequest;

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject("/review");
  await fixture.specs.transaction("seed-review", (repo) => {
    repo.create({
      spec: {
        id: SPEC,
        projectPath: "/review",
        slug: "review",
        name: "Review",
        gatePolicy: { preset: "contract-bearing" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      initialRevision: {
        id: REVISION,
        authoringStage: "design",
        createdAt: NOW,
      },
    });
    repo.createDraftElement({
      id: "requirement",
      specId: SPEC,
      revisionId: REVISION,
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "Delivery contract",
        priority: "must",
        risk: "medium",
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const id of ["criterion-a", "criterion-b"]) {
      repo.createDraftElement({
        id,
        specId: SPEC,
        revisionId: REVISION,
        kind: "criterion",
        parentElementId: "requirement",
        payload: {
          kind: "criterion",
          text: id,
          validationStrategy: { kinds: ["test_run"] },
        },
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    repo.approveRevision({ revisionId: REVISION, approvedAt: NOW });
  });
  const snapshot = await fixture.specs.getRevisionSnapshot(REVISION);
  if (!snapshot) throw new Error("Missing fixture snapshot");
  request = {
    revisionId: REVISION,
    expectedContentHash: snapshot.revision.contentHash,
    expectedReviewId: null,
    criterionIds: ["criterion-a", "criterion-b"],
    decision: "satisfied",
    note: "",
  };
  let sequence = 0;
  const events = createSpecEventsRepo(fixture.db);
  service = createDeliveryReviewService({
    specs: fixture.specs,
    delivery: createSpecDeliveryRepo(fixture.db),
    events: createSpecEventsPublisher({
      appendInTransaction: events.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    nextId: () => `review-${++sequence}`,
    now: () => NOW,
  });
});
afterEach(() => fixture.close());

describe("delivery review projection", () => {
  it("shows the approved contract and current human decisions before a graph has launched", async () => {
    await service.record({
      ...request,
      specId: SPEC,
      actor: { kind: "human" },
    });
    const spec = await fixture.specs.findById(SPEC);
    if (!spec) throw new Error("Missing fixture spec");
    const view = await readDeliveryReview(
      {
        bindings: createSpecExecutionBindingRepo(fixture.db),
        specs: fixture.specs,
        delivery: createSpecDeliveryRepo(fixture.db),
        review: createSpecReviewRepo(fixture.db),
        gate: {
          async evaluate() {
            throw new Error("No execution to evaluate");
          },
        },
      },
      spec,
    );
    expect(view).toMatchObject({
      revisionId: REVISION,
      execution: null,
      criteria: [
        {
          id: "criterion-a",
          outcome: "satisfied",
          automated: [],
          humanReview: { actor: { kind: "human" } },
        },
        {
          id: "criterion-b",
          outcome: "satisfied",
          automated: [],
          humanReview: { actor: { kind: "human" } },
        },
      ],
    });
    expect(view?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: "execution" }),
      ]),
    );
  });
});

it("shows recorded external delivery as shipped scope without manufacturing proof or pending acceptance", async () => {
  const delivery = createSpecDeliveryRepo(fixture.db);
  const events = createSpecEventsRepo(fixture.db);
  let id = 0;
  const continuation = createDeliveryContinuationService({
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
    delivery,
    links: createSpecLinksRepo(fixture.db),
    events: createSpecEventsPublisher({
      appendInTransaction: events.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    execution: {
      async retireDelivery() {
        throw new Error("No active execution");
      },
    },
    sessionExists: async () => true,
    workflowExists: async () => true,
    nextId: () => `external-${++id}`,
    now: () => NOW,
  });
  const continued = await continuation.continue({
    specId: SPEC,
    revisionId: REVISION,
    expectedExecutionId: null,
    mode: "external",
    note: "Already shipped",
    commitRefs: ["external-commit"],
    actor: { kind: "human" },
  });
  expect(continued.ok).toBe(true);
  const spec = await fixture.specs.findById(SPEC);
  if (!spec) throw new Error("Fixture spec missing");
  const view = await readDeliveryReview(
    {
      bindings: createSpecExecutionBindingRepo(fixture.db),
      specs: fixture.specs,
      delivery,
      review: createSpecReviewRepo(fixture.db),
      gate: {
        async evaluate() {
          throw new Error("Delivered history needs no merge evaluation");
        },
      },
    },
    spec,
  );
  expect(
    view?.criteria.map((criterion) => ({
      outcome: criterion.outcome,
      automated: criterion.automated,
    })),
  ).toEqual([
    { outcome: "delivered_externally", automated: [] },
    { outcome: "delivered_externally", automated: [] },
  ]);
  expect(view?.blockers).toEqual([]);
});
