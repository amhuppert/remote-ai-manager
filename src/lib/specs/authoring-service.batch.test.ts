import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { z } from "zod";

import type { SSEEvent } from "@/lib/api/sse-events";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";

const PROJECT_PATH = "/repos/native-sdd-batch";
const ACTOR = { kind: "agent", conversationId: "conversation-1" } as const;

let db: Db;
let service: AuthoringService;
let specs: SpecsRepo;
let published: SSEEvent[];
let idSequence: number;
let nowSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  published = [];
  idSequence = 0;
  nowSequence = 0;

  specs = createSpecsRepo(db, createWriteQueue());
  const eventRows = createSpecEventsRepo(db);
  service = createAuthoringService({
    specs,
    review: createSpecReviewRepo(db),
    links: createSpecLinksRepo(db),
    events: createSpecEventsPublisher({
      appendInTransaction: eventRows.appendInTransaction,
      publish(event) {
        published.push(event);
        return { delivered: true };
      },
    }),
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      nowSequence += 1;
      return `2026-07-25T12:00:${String(nowSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => {
  db.close();
});

const interventionPayloadSchema = z.object({
  kind: z.literal("draft-write-refused"),
  revisionId: z.string().min(1),
  elementId: z.string().min(1),
  refusal: z.object({ code: z.string().min(1) }).loose(),
});

function requirement(statement: string) {
  return {
    kind: "requirement" as const,
    statement,
    priority: "must" as const,
    risk: "high" as const,
  };
}

function criterion(text: string) {
  return {
    kind: "criterion" as const,
    text,
    validationStrategy: { kinds: ["test_run" as const] },
  };
}

async function createDraft() {
  return service.createSpec({
    projectPath: PROJECT_PATH,
    slug: "native-sdd-batch",
    name: "Native SDD batch",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: requirement("The batch write is atomic."),
    },
    actor: ACTOR,
  });
}

describe("AuthoringService.upsertDraftElements", () => {
  it("writes every element in one transaction and returns indexed results with handles", async () => {
    const created = await createDraft();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-2",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Batches carry per-element versions."),
          baseElementVersion: null,
        },
        {
          elementId: "criterion-1",
          kind: "criterion",
          parentElementId: "requirement-1",
          payload: criterion("A refused element names its index."),
          baseElementVersion: null,
        },
        {
          elementId: "requirement-1",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("The batch write is atomic, restated."),
          baseElementVersion: 1,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("batch was refused");
    expect(
      result.written.map(({ index, elementId, handle }) => ({
        index,
        elementId,
        handle,
      })),
    ).toEqual([
      { index: 0, elementId: "requirement-2", handle: "R2" },
      { index: 1, elementId: "criterion-1", handle: "R1.1" },
      { index: 2, elementId: "requirement-1", handle: "R1" },
    ]);

    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "requirement-2",
      "criterion-1",
    ]);
    expect(
      snapshot?.elements.find(({ element }) => element.id === "requirement-1")
        ?.version.elementVersion,
    ).toBe(2);
    // One content-changed event names every element the batch touched.
    const batchEvents = published.filter(
      (event) =>
        event.type === "spec-changed" && event.kind === "content-changed",
    );
    expect(batchEvents).toHaveLength(2);
    expect(batchEvents[1]).toMatchObject({
      elementIds: ["requirement-2", "criterion-1", "requirement-1"],
    });
  });

  it("refuses the whole batch when one element's baseElementVersion is stale, persisting nothing", async () => {
    const created = await createDraft();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-2",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("This element is fine."),
          baseElementVersion: null,
        },
        {
          elementId: "requirement-1",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("This element is stale."),
          baseElementVersion: 7,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("batch should have been refused");
    expect(result.refusals).toEqual([
      {
        index: 1,
        elementId: "requirement-1",
        code: "stale_element",
        unmetConditions: [expect.stringContaining("requirement-1")],
        instruction: expect.stringContaining("Re-read"),
        currentElementVersion: 1,
      },
    ]);

    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
    ]);
    expect(snapshot?.elements[0]?.version.payload).toEqual(
      requirement("The batch write is atomic."),
    );
  });

  it("reports every refusing element, not just the first", async () => {
    const created = await createDraft();
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      payload: requirement("A second requirement."),
      baseElementVersion: null,
      actor: ACTOR,
    });

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-1",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Stale one."),
          baseElementVersion: 9,
        },
        {
          elementId: "requirement-2",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Stale two."),
          baseElementVersion: 9,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("batch should have been refused");
    expect(
      result.refusals.map(({ index, elementId }) => ({ index, elementId })),
    ).toEqual([
      { index: 0, elementId: "requirement-1" },
      { index: 1, elementId: "requirement-2" },
    ]);
  });

  it("keeps the element-granular concurrency boundary: disjoint batches never conflict", async () => {
    const created = await createDraft();
    const second = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      payload: requirement("A second requirement."),
      baseElementVersion: null,
      actor: ACTOR,
    });

    // Writer A takes requirement-1 at version 1.
    const writerA = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-1",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Writer A's edit."),
          baseElementVersion: 1,
        },
      ],
      actor: ACTOR,
    });
    // Writer B holds a base version read BEFORE A's write and touches a
    // different element: the revision moved, but B's element did not.
    const writerB = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-2",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Writer B's edit."),
          baseElementVersion: second.version.elementVersion,
        },
      ],
      actor: ACTOR,
    });

    expect(writerA.ok).toBe(true);
    expect(writerB.ok).toBe(true);
  });

  it("refuses the batch under the optional revision-level token when the revision moved", async () => {
    const created = await createDraft();
    const before = await service.readRevisionToken(created.draft.id);
    if (before === null) throw new Error("the draft has no revision token");

    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      payload: requirement("Someone else wrote first."),
      baseElementVersion: null,
      actor: ACTOR,
    });

    const stale = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedRevisionToken: before,
      elements: [
        {
          elementId: "requirement-3",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Refused by the stricter mode."),
          baseElementVersion: null,
        },
      ],
      actor: ACTOR,
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("batch should have been refused");
    expect(stale.refusals).toEqual([
      {
        index: -1,
        elementId: null,
        code: "stale_revision",
        unmetConditions: [expect.stringContaining("revision")],
        instruction: expect.stringContaining("Re-read"),
        currentElementVersion: null,
      },
    ]);

    const current = await service.readRevisionToken(created.draft.id);
    if (current === null) throw new Error("the draft has no revision token");
    const accepted = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedRevisionToken: current,
      elements: [
        {
          elementId: "requirement-3",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("Accepted under the current token."),
          baseElementVersion: null,
        },
      ],
      actor: ACTOR,
    });
    expect(accepted.ok).toBe(true);
  });

  it("is not a create path: a batch against an unknown spec refuses without creating one", async () => {
    await expect(
      service.upsertDraftElements({
        specId: "spec-does-not-exist",
        revisionId: "revision-does-not-exist",
        elements: [
          {
            elementId: "requirement-1",
            kind: "requirement",
            parentElementId: null,
            payload: requirement("No spec should appear."),
            baseElementVersion: null,
          },
        ],
        actor: ACTOR,
      }),
    ).rejects.toThrow();

    expect(db.prepare("SELECT COUNT(*) AS count FROM specs").get()).toEqual({
      count: 0,
    });
  });

  it("refuses content the current authoring stage does not admit and writes nothing", async () => {
    const created = await createDraft();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-2",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("A legal requirement."),
          baseElementVersion: null,
        },
        {
          elementId: "task-1",
          kind: "task",
          parentElementId: null,
          payload: {
            kind: "task",
            title: "Plan content during the requirements stage",
            instructions: "Refused.",
            tracedRequirementElementIds: [],
            tracedDecisionElementIds: [],
            coveredCriterionElementIds: [],
            dependsOnTaskElementIds: [],
          },
          baseElementVersion: null,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("batch should have been refused");
    expect(result.refusals).toEqual([
      expect.objectContaining({
        index: 1,
        elementId: "task-1",
        code: "stage_blocked",
      }),
    ]);
    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements).toHaveLength(1);
  });

  it("keeps the refusal audit trail durable after the refused batch rolls back", async () => {
    const created = await createDraft();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-2",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("A legal requirement."),
          baseElementVersion: null,
        },
        {
          elementId: "task-1",
          kind: "task",
          parentElementId: null,
          payload: {
            kind: "task",
            title: "Plan content during the requirements stage",
            instructions: "Refused.",
            tracedRequirementElementIds: [],
            tracedDecisionElementIds: [],
            coveredCriterionElementIds: [],
            dependsOnTaskElementIds: [],
          },
          baseElementVersion: null,
        },
        {
          elementId: "task-2",
          kind: "task",
          parentElementId: null,
          payload: {
            kind: "task",
            title: "A second premature plan task",
            instructions: "Also refused.",
            tracedRequirementElementIds: [],
            tracedDecisionElementIds: [],
            coveredCriterionElementIds: [],
            dependsOnTaskElementIds: [],
          },
          baseElementVersion: null,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    const reloaded = createSpecEventsRepo(db)
      .findBySpecId(created.spec.id)
      .filter((row) => row.event_type === "spec-intervention-recorded")
      .map((row) =>
        interventionPayloadSchema.parse(JSON.parse(row.payload_json)),
      );
    expect(reloaded).toEqual([
      {
        kind: "draft-write-refused",
        revisionId: created.draft.id,
        elementId: "task-1",
        refusal: expect.objectContaining({ code: "stage_blocked" }),
      },
      {
        kind: "draft-write-refused",
        revisionId: created.draft.id,
        elementId: "task-2",
        refusal: expect.objectContaining({ code: "stage_blocked" }),
      },
    ]);
    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements).toHaveLength(1);
  });
});
