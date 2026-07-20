import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import {
  createSpecReviewRepo,
  type SpecReviewRepo,
} from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { createReviewService, type ReviewService } from "./review-service";
import { shouldMarkWaiverStale } from "./waiver-staleness";

const PROJECT_PATH = "/repos/native-sdd-waiver-staleness";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

describe("shouldMarkWaiverStale (pure decision)", () => {
  it("stales only a valid waiver whose criterion exists in both revisions with differing hashes", () => {
    expect(
      shouldMarkWaiverStale({ stale: 0, waivedHash: "a", laterHash: "b" }),
    ).toBe(true);
  });

  it("keeps an unchanged criterion's waiver valid", () => {
    expect(
      shouldMarkWaiverStale({ stale: 0, waivedHash: "a", laterHash: "a" }),
    ).toBe(false);
  });

  it("ignores a criterion removed from either revision", () => {
    expect(
      shouldMarkWaiverStale({ stale: 0, waivedHash: null, laterHash: "b" }),
    ).toBe(false);
    expect(
      shouldMarkWaiverStale({ stale: 0, waivedHash: "a", laterHash: null }),
    ).toBe(false);
  });

  it("never re-stales an already stale waiver", () => {
    expect(
      shouldMarkWaiverStale({ stale: 1, waivedHash: "a", laterHash: "b" }),
    ).toBe(false);
  });
});

describe("R14.5 waiver staleness at revision approval (runtime wiring)", () => {
  let db: Db;
  let specs: SpecsRepo;
  let reviewRepo: SpecReviewRepo;
  let deliveryRepo: ReturnType<typeof createSpecDeliveryRepo>;
  let specEvents: ReturnType<typeof createSpecEventsRepo>;
  let authoring: AuthoringService;
  let reviewing: ReviewService;
  let idSequence: number;
  let timeSequence: number;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    const writeQueue = createWriteQueue();
    specs = createSpecsRepo(db, writeQueue);
    reviewRepo = createSpecReviewRepo(db);
    deliveryRepo = createSpecDeliveryRepo(db);
    specEvents = createSpecEventsRepo(db);
    const events = createSpecEventsPublisher({
      appendInTransaction: specEvents.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
    idSequence = 0;
    timeSequence = 0;
    const deps = {
      specs,
      review: reviewRepo,
      links: createSpecLinksRepo(db),
      events,
      newId(prefix: string) {
        idSequence += 1;
        return `${prefix}-${idSequence}`;
      },
      now() {
        timeSequence += 1;
        return `2026-07-19T10:00:${String(timeSequence).padStart(2, "0")}.000Z`;
      },
    };
    authoring = createAuthoringService({ ...deps, waivers: deliveryRepo });
    reviewing = createReviewService({ ...deps, delivery: deliveryRepo });
  });

  afterEach(() => db.close());

  async function createSpecWithContent(
    preset: "exploratory" | "fast-path",
    slug: string,
  ) {
    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug,
      name: `Waiver staleness ${slug}`,
      gatePolicy: { preset },
      initialElement: {
        elementId: "requirement-1",
        kind: "requirement" as const,
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement" as const,
          statement: "Waivers stale when the criterion changes.",
          priority: "must" as const,
          risk: "high" as const,
        },
      },
      actor: AGENT,
    });
    for (const element of [
      {
        elementId: "criterion-1",
        kind: "criterion" as const,
        parentElementId: "requirement-1",
        position: 1,
        payload: {
          kind: "criterion" as const,
          text: "The waived behavior holds.",
          validationStrategy: { kinds: ["test_run" as const] },
        },
      },
      {
        elementId: "criterion-2",
        kind: "criterion" as const,
        parentElementId: "requirement-1",
        position: 2,
        payload: {
          kind: "criterion" as const,
          text: "The untouched behavior holds.",
          validationStrategy: { kinds: ["test_run" as const] },
        },
      },
      {
        elementId: "task-1",
        kind: "task" as const,
        parentElementId: null,
        position: 3,
        payload: {
          kind: "task" as const,
          title: "Implement the waived behavior",
          instructions: "Implement and test.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1", "criterion-2"],
          dependsOnTaskElementIds: [],
        },
      },
    ]) {
      await authoring.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        ...element,
        baseElementVersion: null,
        actor: AGENT,
      });
    }
    return created;
  }

  function grantWaiverRow(
    waiverId: string,
    specId: string,
    criterionElementId: string,
    revisionId: string,
  ): void {
    deliveryRepo.saveWaiver({
      id: waiverId,
      spec_id: specId,
      criterion_element_id: criterionElementId,
      revision_id: revisionId,
      reason: "Human accepted the residual risk.",
      waived_at: "2026-07-19T09:00:00.000Z",
      stale: 0,
    });
  }

  async function amendCriterion(
    specId: string,
    changedText: string,
  ): Promise<string> {
    const amendment = await authoring.openAmendment({
      specId,
      actor: AGENT,
    });
    const snapshot = await specs.getRevisionSnapshot(amendment.id);
    const criterion = snapshot?.elements.find(
      ({ element }) => element.id === "criterion-1",
    );
    if (criterion === undefined) throw new Error("criterion-1 missing");
    await authoring.upsertDraftElement({
      specId,
      revisionId: amendment.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      position: criterion.version.position,
      payload: {
        kind: "criterion",
        text: changedText,
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: criterion.version.elementVersion,
      actor: AGENT,
    });
    return amendment.id;
  }

  function reloadWaiver(waiverId: string) {
    // A fresh repo instance proves the flip survives serialization, not just
    // an in-memory object mutation.
    return createSpecDeliveryRepo(db).findWaiverById(waiverId);
  }

  function waiverStaledEvents(specId: string) {
    return specEvents
      .findBySpecId(specId)
      .filter((event) => event.event_type === "spec-evidence-changed")
      .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
      .filter((payload) => payload.kind === "waiver-staled");
  }

  it("authoring propose with absorbed sign-off stales the changed criterion's waiver in the same transaction", async () => {
    const created = await createSpecWithContent("exploratory", "absorbed");
    const proposed = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    expect(proposed).toMatchObject({ ok: true, absorbedSignOff: true });

    grantWaiverRow(
      "waiver-changed",
      created.spec.id,
      "criterion-1",
      created.draft.id,
    );
    grantWaiverRow(
      "waiver-untouched",
      created.spec.id,
      "criterion-2",
      created.draft.id,
    );

    const revision2 = await amendCriterion(
      created.spec.id,
      "The waived behavior changed materially.",
    );
    const approved = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: revision2,
      actor: AGENT,
    });
    expect(approved).toMatchObject({
      ok: true,
      revision: { state: "approved" },
    });

    expect(reloadWaiver("waiver-changed")).toMatchObject({ stale: 1 });
    expect(reloadWaiver("waiver-untouched")).toMatchObject({ stale: 0 });

    // Byte-compatible with the evidence-service waiver-staled payload shape.
    expect(waiverStaledEvents(created.spec.id)).toEqual([
      {
        kind: "waiver-staled",
        waiverId: "waiver-changed",
        criterionElementId: "criterion-1",
        waivedRevisionId: created.draft.id,
        laterRevisionId: revision2,
      },
    ]);
  });

  it("signOffRevision stales waivers when the dials were loosened to Notify after propose", async () => {
    const created = await createSpecWithContent("exploratory", "signoff");
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    grantWaiverRow(
      "waiver-signoff",
      created.spec.id,
      "criterion-1",
      created.draft.id,
    );

    // Tighten so propose leaves revision 2 in review, then loosen back so the
    // human sign-off proceeds under the Notify policy.
    const tightened = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "contract-bearing" },
      hardConfirmed: true,
      actor: HUMAN,
    });
    expect(tightened.ok).toBe(true);
    const revision2 = await amendCriterion(
      created.spec.id,
      "The waived behavior changed under review.",
    );
    const proposed = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: revision2,
      actor: AGENT,
    });
    expect(proposed).toMatchObject({ ok: true, absorbedSignOff: false });
    const loosened = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
      actor: HUMAN,
    });
    expect(loosened.ok).toBe(true);

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: revision2,
      approver: "operator",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    expect(reloadWaiver("waiver-signoff")).toMatchObject({ stale: 1 });
    expect(waiverStaledEvents(created.spec.id)).toEqual([
      {
        kind: "waiver-staled",
        waiverId: "waiver-signoff",
        criterionElementId: "criterion-1",
        waivedRevisionId: created.draft.id,
        laterRevisionId: revision2,
      },
    ]);
  });

  it("fastPathCombinedApproval stales waivers for the changed criterion", async () => {
    const created = await createSpecWithContent("fast-path", "fast-path");
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    const first = await reviewing.fastPathCombinedApproval({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "operator",
      actor: HUMAN,
    });
    expect(first.ok).toBe(true);

    grantWaiverRow(
      "waiver-fast",
      created.spec.id,
      "criterion-1",
      created.draft.id,
    );

    const revision2 = await amendCriterion(
      created.spec.id,
      "The waived behavior changed on the fast path.",
    );
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: revision2,
      actor: AGENT,
    });
    const second = await reviewing.fastPathCombinedApproval({
      specId: created.spec.id,
      revisionId: revision2,
      approver: "operator",
      actor: HUMAN,
    });
    expect(second).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    expect(reloadWaiver("waiver-fast")).toMatchObject({ stale: 1 });
    expect(waiverStaledEvents(created.spec.id)).toEqual([
      {
        kind: "waiver-staled",
        waiverId: "waiver-fast",
        criterionElementId: "criterion-1",
        waivedRevisionId: created.draft.id,
        laterRevisionId: revision2,
      },
    ]);
  });
});
