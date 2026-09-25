import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
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
        authoringStage: "requirements",
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

describe("bulk delivery review", () => {
  it("records all selected criteria in one durable attributed review with an optional note", async () => {
    const result = await service.record({
      ...request,
      specId: SPEC,
      actor: { kind: "human" },
    });
    expect(result.ok).toBe(true);
    const reviews = createSpecDeliveryRepo(
      fixture.db,
    ).findAcceptanceReviewsBySpecId(SPEC);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      actor: { kind: "human" },
      decision: "satisfied",
      note: "",
      criteria: [
        { criterionId: "criterion-a" },
        { criterionId: "criterion-b" },
      ],
    });
    expect(createSpecEventsRepo(fixture.db).findBySpecId(SPEC)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "spec-evidence-changed",
          actor_json: '{"kind":"human"}',
        }),
      ]),
    );
  });

  it("refuses agents, an unexplained waiver, and a stale review without partial writes", async () => {
    expect(
      await service.record({
        ...request,
        specId: SPEC,
        actor: { kind: "agent", conversationId: "agent" },
      }),
    ).toMatchObject({ ok: false, refusal: { code: "human_act_required" } });
    expect(
      await service.record({
        ...request,
        specId: SPEC,
        actor: { kind: "human" },
        decision: "waived",
      }),
    ).toMatchObject({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [expect.stringContaining("reason")],
      },
    });
    expect(
      await service.record({
        ...request,
        specId: SPEC,
        actor: { kind: "human" },
        expectedReviewId: "stale",
      }),
    ).toMatchObject({ ok: false, refusal: { code: "stale_revision" } });
    expect(
      createSpecDeliveryRepo(fixture.db).findAcceptanceReviewsBySpecId(SPEC),
    ).toEqual([]);
  });

  it("rejects the whole batch when one criterion is outside the revision", async () => {
    const result = await service.record({
      ...request,
      specId: SPEC,
      actor: { kind: "human" },
      criterionIds: ["criterion-a", "missing"],
    });
    expect(result).toMatchObject({ ok: false, refusal: { code: "not_found" } });
    expect(
      createSpecDeliveryRepo(fixture.db).findAcceptanceReviewsBySpecId(SPEC),
    ).toEqual([]);
  });
});
