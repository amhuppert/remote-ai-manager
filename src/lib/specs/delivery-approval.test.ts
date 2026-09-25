import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createDeliveryApprovalService } from "./delivery-approval";
import { createDeliveryContinuationService } from "./delivery-continuation";
import { createReviewService } from "./review-service";
import { createDeliveryGate } from "./delivery-gate-v2";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
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

describe("approve delivery review", () => {
  it("waives every unresolved criterion in one attributed batch and approves the same execution", async () => {
    let sequence = 0;
    const nextId = () => `approval-test-${++sequence}`;
    const delivery = createSpecDeliveryRepo(fixture.db);
    const reviews = createSpecReviewRepo(fixture.db);
    const links = createSpecLinksRepo(fixture.db);
    const eventRows = createSpecEventsRepo(fixture.db);
    const events = createSpecEventsPublisher({
      appendInTransaction: eventRows.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
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
      links,
      events,
      execution: {
        async retireDelivery() {
          throw new Error("No active execution");
        },
      },
      sessionExists: async () => true,
      workflowExists: async () => true,
      nextId,
      now: () => NOW,
    });
    const continued = await continuation.continue({
      specId: SPEC,
      revisionId: REVISION,
      expectedExecutionId: null,
      mode: "session",
      sessionName: "work",
      commitRefs: [],
      note: "",
      actor: { kind: "human" },
    });
    if (!continued.ok) throw new Error("Fixture continuation failed");
    const gate = createDeliveryGate({
      specsRepo: fixture.specs,
      deliveryRepo: delivery,
      reviewRepo: reviews,
      bindingPort: { resolveByWorkflowExecutionId: () => null },
      outcomePort: {
        async getAuthoredContextOutcome() {
          throw new Error("No workflow");
        },
        async getIntegrationReadyFinalCandidate() {
          throw new Error("No workflow");
        },
      },
      attention: eventRows,
      events,
      writeQueue: createWriteQueue(),
      runInImmediateTransaction: (operation) =>
        fixture.db.transaction(operation).immediate(),
      newVerdictId: nextId,
      newAdmissionId: nextId,
      now: () => NOW,
      recordIntervention: () => undefined,
      requestDeliveryApproval: async () => undefined,
      getProjectDisplayName: () => "Review",
    });
    const spec = await fixture.specs.findById(SPEC);
    if (!spec) throw new Error("Missing fixture spec");
    const approval = createDeliveryApprovalService({
      read: (target, executionId) =>
        readDeliveryReview(
          {
            bindings: createSpecExecutionBindingRepo(fixture.db),
            specs: fixture.specs,
            delivery,
            review: reviews,
            gate,
          },
          target,
          executionId,
        ),
      acceptance: service,
      review: createReviewService({
        specs: fixture.specs,
        review: reviews,
        delivery,
        links,
        events,
        attention: eventRows,
      }),
    });
    const result = await approval.approve({
      spec,
      actor: { kind: "human" },
      revisionId: REVISION,
      executionId: continued.value.id,
      expectedContentHash: request.expectedContentHash,
      expectedReviewId: null,
      waiveRemaining: true,
      note: "Accepted by direct review",
    });
    expect(result.ok).toBe(true);
    expect(delivery.findAcceptanceReviewsBySpecId(SPEC)).toHaveLength(1);
    expect(delivery.findAcceptanceReviewsBySpecId(SPEC)[0]).toMatchObject({
      decision: "waived",
      note: "Accepted by direct review",
      criteria: [
        { criterionId: "criterion-a" },
        { criterionId: "criterion-b" },
      ],
    });
    expect(
      reviews.hasValidHumanGateApproval({
        specId: SPEC,
        revisionId: REVISION,
        executionId: continued.value.id,
        gate: "delivery",
      }),
    ).toBe(true);
    expect(
      (
        await readDeliveryReview(
          {
            bindings: createSpecExecutionBindingRepo(fixture.db),
            specs: fixture.specs,
            delivery,
            review: reviews,
            gate,
          },
          spec,
        )
      )?.blockers,
    ).toEqual([]);
  });
});
