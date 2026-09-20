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
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  SpecElementIdTakenError,
  SpecHistoricalElementError,
  StaleElementConflictError,
  createSpecsRepo,
  type SpecsRepo,
} from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { Db } from "@/lib/state-store/schemas";

import {
  StageBlockedWriteError,
  createAuthoringService,
  historicalElementRefusal,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { diffRevisions } from "./revision-diff";
import { loadProposalState, toDiffRows } from "./review-state";
import type {
  CriterionElementPayload,
  RequirementElementPayload,
  SpecEventRow,
} from "./schemas";

const PROJECT_PATH = "/repos/native-sdd-reintroduction";
const SLUG = "native-sdd-reintroduction";
const ACTOR = { kind: "agent", conversationId: "conversation-1" } as const;
const KEPT_ID = "requirement-kept";
const ORPHAN_ID = "requirement-orphaned";

let db: Db;
let specs: SpecsRepo;
let review: SpecReviewRepo;
let links: SpecLinksRepo;
let delivery: SpecDeliveryRepo;
let events: SpecEventsRepo;
let service: AuthoringService;
let idSequence: number;
let nowSequence: number;
let specId: string;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  idSequence = 0;
  nowSequence = 0;

  specs = createSpecsRepo(db, createWriteQueue());
  review = createSpecReviewRepo(db);
  links = createSpecLinksRepo(db);
  delivery = createSpecDeliveryRepo(db);
  events = createSpecEventsRepo(db);
  service = createAuthoringService({
    specs,
    review,
    links,
    events: createSpecEventsPublisher({
      appendInTransaction: events.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    attention: events,
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      nowSequence += 1;
      return `2026-07-31T09:00:${String(nowSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => {
  db.close();
});

function requirement(statement: string): RequirementElementPayload {
  return { kind: "requirement", statement, priority: "must", risk: "high" };
}

function criterion(text: string): CriterionElementPayload {
  return {
    kind: "criterion",
    text,
    validationStrategy: { kinds: ["test_run"] },
  };
}

async function refusalOf(act: Promise<unknown>) {
  try {
    await act;
  } catch (error) {
    if (error instanceof StageBlockedWriteError) return error.refusal;
    throw error;
  }
  throw new Error("expected the write to be refused");
}

async function errorOf(act: Promise<unknown>): Promise<unknown> {
  try {
    await act;
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to be refused");
}

function draftEventPayloads(specId: string): Record<string, unknown>[] {
  return events.findBySpecId(specId).flatMap((row: SpecEventRow) => {
    const payload: unknown = JSON.parse(row.payload_json);
    return typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload)
      ? [payload as Record<string, unknown>]
      : [];
  });
}

function draftEventKinds(specId: string): string[] {
  return draftEventPayloads(specId).flatMap((payload) =>
    typeof payload.kind === "string" ? [payload.kind] : [],
  );
}

/** The element ids each durable authoring event records as revived. */
function revivedElementIdsPerEvent(specId: string): unknown[] {
  return draftEventPayloads(specId).flatMap((payload) =>
    "revivedElementIds" in payload ? [payload.revivedElementIds] : [],
  );
}

/**
 * The reported dead zone, reproduced through the real authoring surface: an
 * element authored on a revision a human then ended by requesting changes. Its
 * identity survives, but every version of it lives outside the revision the
 * author is now writing into.
 */
async function orphanThroughRequestedChanges(
  attemptElements: (revisionId: string) => Promise<void> = async (
    revisionId,
  ) => {
    await service.upsertDraftElement({
      specId,
      revisionId,
      elementId: ORPHAN_ID,
      kind: "requirement",
      parentElementId: null,
      payload: requirement("Authored on the attempt a human ended."),
      baseElementVersion: null,
      actor: ACTOR,
    });
  },
) {
  const created = await service.createSpec({
    projectPath: PROJECT_PATH,
    slug: SLUG,
    name: "Native SDD reintroduction",
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: KEPT_ID,
      kind: "requirement",
      parentElementId: null,
      payload: requirement("Carried by every revision."),
    },
    actor: ACTOR,
  });
  specId = created.spec.id;
  await specs.proposeRevision({
    revisionId: created.draft.id,
    proposedAt: "2026-07-31T10:00:00.000Z",
  });
  await specs.approveRevision({
    revisionId: created.draft.id,
    approvedAt: "2026-07-31T10:01:00.000Z",
  });

  const designCheckpoint = await service.openAmendment({
    specId,
    actor: ACTOR,
  });
  await specs.proposeRevision({
    revisionId: designCheckpoint.revision.id,
    proposedAt: "2026-07-31T10:01:10.000Z",
  });
  await specs.approveRevision({
    revisionId: designCheckpoint.revision.id,
    approvedAt: "2026-07-31T10:01:20.000Z",
  });

  const attempt = await service.openAmendment({ specId, actor: ACTOR });
  await attemptElements(attempt.revision.id);
  await specs.proposeRevision({
    revisionId: attempt.revision.id,
    proposedAt: "2026-07-31T10:02:00.000Z",
  });
  // The human read the proposal and requested changes, which ends the revision.
  await specs.withdrawRevision({ revisionId: attempt.revision.id });

  const followUp = await service.openAmendment({ specId, actor: ACTOR });
  return {
    specId,
    approved: designCheckpoint.revision,
    attempt: attempt.revision,
    followUp: followUp.revision,
  };
}

describe("historical element reintroduction (ticket #42)", () => {
  it("refuses an orphaned element id without the marker and names the retry that revives it", async () => {
    const world = await orphanThroughRequestedChanges();

    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("Re-authored under the same id."),
        baseElementVersion: null,
        actor: ACTOR,
      }),
    );

    expect(error).toBeInstanceOf(SpecHistoricalElementError);
    expect(error).toMatchObject({
      code: "historical_element_id",
      reason: "reintroduction_required",
      elementId: ORPHAN_ID,
      handle: "R2",
    });
    const refusal = historicalElementRefusal(
      error as SpecHistoricalElementError,
    );
    expect(refusal.code).toBe("historical_element_id");
    expect(refusal.instruction).toContain('"reintroduceHistorical": true');
    expect(refusal.instruction).toContain('"baseElementVersion": null');
    expect(refusal.instruction).toContain("R2");
    expect(refusal.details).toMatchObject({
      elementId: ORPHAN_ID,
      handle: "R2",
      reason: "reintroduction_required",
      kind: "requirement",
    });
    // Nothing landed: the refused write leaves the revision as it was.
    expect(
      (await specs.getRevisionSnapshot(world.followUp.id))?.elements.map(
        ({ element }) => element.id,
      ),
    ).toEqual([KEPT_ID]);
  });

  it("revives the orphaned element with its number, handle, and the caller's content", async () => {
    const world = await orphanThroughRequestedChanges();
    const restated = requirement("Restored, and rewritten by the author.");

    const written = await service.upsertDraftElement({
      specId: world.specId,
      revisionId: world.followUp.id,
      elementId: ORPHAN_ID,
      kind: "requirement",
      parentElementId: null,
      payload: restated,
      baseElementVersion: null,
      reintroduceHistorical: true,
      actor: ACTOR,
    });

    expect(written.revived).toBe(true);
    // R2 comes back as R2: the identity row, and therefore the address every
    // reader knows the element by, is the one the spec allocated originally.
    expect(written.handle).toBe("R2");
    const reloaded = await specs.getRevisionSnapshot(world.followUp.id);
    const row = reloaded?.elements.find(
      ({ element }) => element.id === ORPHAN_ID,
    );
    expect(row?.element.number).toBe(2);
    expect(row?.version).toMatchObject({
      revisionId: world.followUp.id,
      elementVersion: 1,
      payload: restated,
    });
    // The counter is untouched, so the next new requirement is still R3.
    expect(await specs.findCounter(world.specId, "R")).toMatchObject({
      lastNumber: 2,
    });
    expect(draftEventKinds(world.specId)).toContain(
      "draft-element-reintroduced",
    );
  });

  it("refuses an element id owned by another spec even with the marker", async () => {
    const world = await orphanThroughRequestedChanges();
    const other = await service.createSpec({
      projectPath: PROJECT_PATH,
      slug: "other-spec",
      name: "Other spec",
      gatePolicy: { preset: "fast-path" },
      initialElement: {
        elementId: "requirement-foreign",
        kind: "requirement",
        parentElementId: null,
        payload: requirement("Owned by another spec."),
      },
      actor: ACTOR,
    });

    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: "requirement-foreign",
        kind: "requirement",
        parentElementId: null,
        payload: requirement("Claiming another spec's identity."),
        baseElementVersion: null,
        reintroduceHistorical: true,
        actor: ACTOR,
      }),
    );

    expect(error).toBeInstanceOf(SpecElementIdTakenError);
    expect(error).toMatchObject({
      code: "element_id_taken",
      existingSpecId: other.spec.id,
    });
  });

  it("refuses a reintroduction that would change the element's kind", async () => {
    const world = await orphanThroughRequestedChanges();
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
    ).run(world.followUp.id);

    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: ORPHAN_ID,
        kind: "decision",
        parentElementId: null,
        payload: {
          kind: "decision",
          title: "Returning as something else entirely",
          chosenApproach: "Reuse the historical identity.",
          rejectedAlternatives: [],
          reason: "Exercise the kind-change guard.",
          tracedRequirementElementIds: [],
        },
        baseElementVersion: null,
        reintroduceHistorical: true,
        actor: ACTOR,
      }),
    );

    expect(error).toMatchObject({
      code: "historical_element_id",
      reason: "kind_changed",
      kind: "requirement",
      attemptedKind: "decision",
    });
    expect(
      historicalElementRefusal(error as SpecHistoricalElementError).instruction,
    ).toContain("choose a different element id");
  });

  it("refuses a reintroduction that would change the element's parent", async () => {
    const world = await orphanThroughRequestedChanges(async (revisionId) => {
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement(
          "The requirement the criterion was written under.",
        ),
        baseElementVersion: null,
        actor: ACTOR,
      });
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: "criterion-orphaned",
        kind: "criterion",
        parentElementId: ORPHAN_ID,
        payload: criterion(
          "Contained by the requirement it was written under.",
        ),
        baseElementVersion: null,
        actor: ACTOR,
      });
    });

    // The requested parent IS carried by the follow-up revision, so this is a
    // rehoming attempt rather than a dangling containment link.
    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: "criterion-orphaned",
        kind: "criterion",
        parentElementId: KEPT_ID,
        payload: criterion("Restored under a different requirement."),
        baseElementVersion: null,
        reintroduceHistorical: true,
        actor: ACTOR,
      }),
    );

    expect(error).toMatchObject({
      code: "historical_element_id",
      reason: "parent_changed",
      parentElementId: ORPHAN_ID,
      attemptedParentElementId: KEPT_ID,
    });
  });

  it("reports the ordinary stale-create conflict when the element is live in the draft", async () => {
    const world = await orphanThroughRequestedChanges();

    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: KEPT_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("A create over an element this revision carries."),
        baseElementVersion: null,
        reintroduceHistorical: true,
        actor: ACTOR,
      }),
    );

    expect(error).toBeInstanceOf(StaleElementConflictError);
    expect(error).toMatchObject({
      code: "stale_element",
      expectedElementVersion: 0,
    });
  });

  it("refuses reviving a criterion whose requirement the final revision does not carry", async () => {
    const world = await orphanThroughRequestedChanges(async (revisionId) => {
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("The parent, authored on the ended attempt."),
        baseElementVersion: null,
        actor: ACTOR,
      });
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: "criterion-orphaned",
        kind: "criterion",
        parentElementId: ORPHAN_ID,
        payload: criterion("Contained by an element that also went away."),
        baseElementVersion: null,
        actor: ACTOR,
      });
    });

    const refusal = await refusalOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: "criterion-orphaned",
        kind: "criterion",
        parentElementId: ORPHAN_ID,
        payload: criterion("Restored without its requirement."),
        baseElementVersion: null,
        reintroduceHistorical: true,
        actor: ACTOR,
      }),
    );

    expect(refusal).toMatchObject({
      code: "dangling_reference",
      details: {
        references: [
          {
            code: "missing_target",
            sourceElementId: "criterion-orphaned",
            field: "parentElementId",
            targetId: ORPHAN_ID,
            relation: "is contained by",
          },
        ],
      },
    });
  });

  it("revives a requirement and its criterion together in one batch", async () => {
    const world = await orphanThroughRequestedChanges(async (revisionId) => {
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("The parent, authored on the ended attempt."),
        baseElementVersion: null,
        actor: ACTOR,
      });
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: "criterion-orphaned",
        kind: "criterion",
        parentElementId: ORPHAN_ID,
        payload: criterion("Contained by an element that also went away."),
        baseElementVersion: null,
        actor: ACTOR,
      });
    });

    const result = await service.upsertDraftElements({
      specId: world.specId,
      revisionId: world.followUp.id,
      // The child travels before the parent: staging judges the batch's final
      // result, so input order cannot decide whether a restore is legal.
      elements: [
        {
          elementId: "criterion-orphaned",
          kind: "criterion",
          parentElementId: ORPHAN_ID,
          payload: criterion("Restored with its requirement."),
          baseElementVersion: null,
          reintroduceHistorical: true,
        },
        {
          elementId: ORPHAN_ID,
          kind: "requirement",
          parentElementId: null,
          payload: requirement("The parent, restored."),
          baseElementVersion: null,
          reintroduceHistorical: true,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    const snapshot = await specs.getRevisionSnapshot(world.followUp.id);
    expect(
      snapshot?.elements.map(({ element }) => ({
        id: element.id,
        number: element.number,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: ORPHAN_ID, number: 2 },
        { id: "criterion-orphaned", number: 1 },
      ]),
    );
    if (result.ok) {
      expect(result.written.map((entry) => entry.revived)).toEqual([
        true,
        true,
      ]);
      expect(result.written.map((entry) => entry.handle).sort()).toEqual([
        "R2",
        "R2.1",
      ]);
    }
    // The batch is the only way to restore a parent and its child together, so
    // the durable log has to record that identities came back through it.
    expect(revivedElementIdsPerEvent(world.specId).at(-1)).toEqual(
      expect.arrayContaining([ORPHAN_ID, "criterion-orphaned"]),
    );
  });

  it("records the revival in the durable log when a create continues the spec as an amendment", async () => {
    const world = await orphanThroughRequestedChanges();
    // The follow-up amendment has to be concluded before a create can continue
    // the spec: a create lands on the amendment path only with no draft open.
    await specs.proposeRevision({
      revisionId: world.followUp.id,
      proposedAt: "2026-07-31T10:04:00.000Z",
    });
    await specs.approveRevision({
      revisionId: world.followUp.id,
      approvedAt: "2026-07-31T10:05:00.000Z",
    });

    const designCheckpoint = await service.openAmendment({
      specId: world.specId,
      actor: ACTOR,
    });
    await specs.proposeRevision({
      revisionId: designCheckpoint.revision.id,
      proposedAt: "2026-07-31T10:05:10.000Z",
    });
    await specs.approveRevision({
      revisionId: designCheckpoint.revision.id,
      approvedAt: "2026-07-31T10:05:20.000Z",
    });

    const created = await service.createSpec({
      projectPath: PROJECT_PATH,
      slug: SLUG,
      name: "Native SDD reintroduction",
      gatePolicy: { preset: "fast-path" },
      initialElement: {
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("Restored by the first save of the amendment."),
        reintroduceHistorical: true,
      },
      actor: ACTOR,
    });

    expect(created.revived).toBe(true);
    expect(revivedElementIdsPerEvent(world.specId).at(-1)).toEqual([ORPHAN_ID]);
  });

  it("names the reintroduction retry when the write carries a base version for an orphaned identity", async () => {
    const world = await orphanThroughRequestedChanges();

    // The agent replays the version it read on the attempt that ended.
    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("Re-authored from the batch document it kept."),
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );

    expect(error).toBeInstanceOf(SpecHistoricalElementError);
    expect(error).toMatchObject({
      code: "historical_element_id",
      reason: "reintroduction_required",
      elementId: ORPHAN_ID,
      handle: "R2",
    });
  });

  it("refuses the marker paired with a base version instead of ignoring it", async () => {
    const world = await orphanThroughRequestedChanges();

    const error = await errorOf(
      service.upsertDraftElement({
        specId: world.specId,
        revisionId: world.followUp.id,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement("Half-followed the recovery instruction."),
        baseElementVersion: 1,
        reintroduceHistorical: true,
        actor: ACTOR,
      }),
    );

    expect(error).toBeInstanceOf(SpecHistoricalElementError);
    const refusal = historicalElementRefusal(
      error as SpecHistoricalElementError,
    );
    expect(refusal.instruction).toContain('"baseElementVersion": null');
  });

  it("names the reintroduction retry for a batch that replays base versions from the ended attempt", async () => {
    const world = await orphanThroughRequestedChanges();

    const result = await service.upsertDraftElements({
      specId: world.specId,
      revisionId: world.followUp.id,
      elements: [
        {
          elementId: ORPHAN_ID,
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Replayed from the document the agent kept."),
          baseElementVersion: 1,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals).toEqual([
        expect.objectContaining({
          input: "element",
          index: 0,
          elementId: ORPHAN_ID,
          code: "historical_element_id",
        }),
      ]);
      expect(result.refusals[0]?.instruction).toContain(
        '"reintroduceHistorical": true',
      );
    }
  });

  it("names a recovery that clears the refusal when a criterion's requirement left the revision", async () => {
    const created = await service.createSpec({
      projectPath: PROJECT_PATH,
      slug: SLUG,
      name: "Native SDD reintroduction",
      gatePolicy: { preset: "fast-path" },
      initialElement: {
        elementId: KEPT_ID,
        kind: "requirement",
        parentElementId: null,
        payload: requirement(
          "The requirement the criterion was written under.",
        ),
      },
      actor: ACTOR,
    });
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-contained",
      kind: "criterion",
      parentElementId: KEPT_ID,
      payload: criterion("Contained by the requirement."),
      baseElementVersion: null,
      actor: ACTOR,
    });
    // Damage the revision the way content authored before the write guard
    // could be damaged: the repository removes only the version row, so the
    // criterion survives with a parent the revision no longer carries.
    await specs.removeDraftElement({
      revisionId: created.draft.id,
      elementId: KEPT_ID,
      expectedElementVersion: 1,
    });

    const refusal = await refusalOf(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-contained",
        kind: "criterion",
        parentElementId: KEPT_ID,
        payload: criterion("Reworded while its requirement is gone."),
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );
    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.instruction).toContain('"reintroduceHistorical": true');

    // The named recovery, taken literally, clears the refusal.
    const repaired = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: KEPT_ID,
          kind: "requirement",
          parentElementId: null,
          payload: requirement("The requirement, brought back."),
          baseElementVersion: null,
          reintroduceHistorical: true,
        },
        {
          elementId: "criterion-contained",
          kind: "criterion",
          parentElementId: KEPT_ID,
          payload: criterion("Reworded once its requirement is back."),
          baseElementVersion: 1,
        },
      ],
      actor: ACTOR,
    });

    expect(repaired.ok).toBe(true);
    const reloaded = await specs.getRevisionSnapshot(created.draft.id);
    expect(reloaded?.elements.map(({ element }) => element.id).sort()).toEqual(
      [KEPT_ID, "criterion-contained"].sort(),
    );
  });

  it("does not let an approval recorded on the ended attempt satisfy the revived element", async () => {
    const restated = requirement("Identical content, on a forked branch.");
    const world = await orphanThroughRequestedChanges(async (revisionId) => {
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: ORPHAN_ID,
        kind: "requirement",
        parentElementId: null,
        payload: restated,
        baseElementVersion: null,
        actor: ACTOR,
      });
    });
    // A human approved the requirement while reading the attempt, then ended
    // the attempt anyway.
    review.saveApproval({
      id: "approval-on-attempt",
      spec_id: world.specId,
      subject_kind: "requirement",
      element_id: ORPHAN_ID,
      revision_id: world.attempt.id,
      approver: "alex",
      granted_at: "2026-07-31T10:03:00.000Z",
      validity: "valid",
    });
    review.saveApproval({
      id: "approval-on-approved-base",
      spec_id: world.specId,
      subject_kind: "requirement",
      element_id: KEPT_ID,
      revision_id: world.approved.id,
      approver: "alex",
      granted_at: "2026-07-31T10:00:30.000Z",
      validity: "valid",
    });

    await service.upsertDraftElement({
      specId: world.specId,
      revisionId: world.followUp.id,
      elementId: ORPHAN_ID,
      kind: "requirement",
      parentElementId: null,
      payload: restated,
      baseElementVersion: null,
      reintroduceHistorical: true,
      actor: ACTOR,
    });

    const applies = await specs.transaction(
      "test.load-proposal-state",
      (repo) => {
        const spec = repo.findById(world.specId);
        const snapshot = repo.getRevisionSnapshot(world.followUp.id);
        if (spec === null || snapshot === null) {
          throw new Error("the follow-up revision must be readable");
        }
        const loaded = loadProposalState(repo, review, links, spec, snapshot);
        return {
          orphanBranch: loaded.approvalApplies({
            subjectKind: "requirement",
            elementId: ORPHAN_ID,
            revisionId: world.attempt.id,
            validity: "valid",
          }),
          approvedAncestor: loaded.approvalApplies({
            subjectKind: "requirement",
            elementId: KEPT_ID,
            revisionId: world.approved.id,
            validity: "valid",
          }),
          changeList: diffRevisions(
            loaded.governanceBaseSnapshot === null
              ? []
              : toDiffRows(loaded.governanceBaseSnapshot),
            toDiffRows(snapshot),
          ).changeList,
        };
      },
    );

    // The revived subject reads as a change against the last content a human
    // admitted, so the review is asked for it again.
    expect(applies.changeList).toEqual([
      expect.objectContaining({ elementId: ORPHAN_ID, change: "added" }),
    ]);

    // The ended attempt is not an ancestor of the follow-up revision, so its
    // approval never becomes current — even though the content is identical.
    expect(applies.orphanBranch).toBe(false);
    // The same machinery still carries an approval down the approved line.
    expect(applies.approvedAncestor).toBe(true);
  });

  it("leaves evidence and waivers pinned to the revision they were recorded against", async () => {
    const world = await orphanThroughRequestedChanges(async (revisionId) => {
      await service.upsertDraftElement({
        specId,
        revisionId,
        elementId: "criterion-orphaned",
        kind: "criterion",
        parentElementId: KEPT_ID,
        payload: criterion("Proven once, on a revision that ended."),
        baseElementVersion: null,
        actor: ACTOR,
      });
    });
    delivery.insertEvidence({
      id: "evidence-on-attempt",
      spec_id: world.specId,
      criterion_element_id: "criterion-orphaned",
      revision_id: world.attempt.id,
      kind: "test_run",
      ref_json: JSON.stringify({ type: "git_object", objectId: "sha" }),
      evaluated_state_json: JSON.stringify({ outcome: "pass" }),
      producer_json: JSON.stringify(ACTOR),
      execution_id: null,
      source_event_id: null,
      created_at: "2026-07-31T10:02:30.000Z",
    });
    delivery.saveWaiver({
      id: "waiver-on-attempt",
      spec_id: world.specId,
      criterion_element_id: "criterion-orphaned",
      revision_id: world.attempt.id,
      reason: "Human accepted the residual risk on the attempt.",
      waived_at: "2026-07-31T10:02:40.000Z",
      stale: 0,
    });

    await service.upsertDraftElement({
      specId: world.specId,
      revisionId: world.followUp.id,
      elementId: "criterion-orphaned",
      kind: "criterion",
      parentElementId: KEPT_ID,
      payload: criterion("Restored, and unproven on this revision."),
      baseElementVersion: null,
      reintroduceHistorical: true,
      actor: ACTOR,
    });

    expect(
      delivery.findEvidenceByCriterionRevision(
        "criterion-orphaned",
        world.attempt.id,
      ),
    ).toHaveLength(1);
    expect(
      delivery.findEvidenceByCriterionRevision(
        "criterion-orphaned",
        world.followUp.id,
      ),
    ).toEqual([]);
    expect(
      delivery.findWaiverForCriterionRevision(
        "criterion-orphaned",
        world.attempt.id,
      ),
    ).toMatchObject({ id: "waiver-on-attempt" });
    expect(
      delivery.findWaiverForCriterionRevision(
        "criterion-orphaned",
        world.followUp.id,
      ),
    ).toBeNull();
  });
});
