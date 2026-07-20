import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

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

const PROJECT_PATH = "/repos/native-sdd";
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

  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  const eventRows = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventRows.appendInTransaction,
    publish(event) {
      published.push(event);
      return { delivered: true };
    },
  });

  service = createAuthoringService({
    specs,
    review: createSpecReviewRepo(db),
    links: createSpecLinksRepo(db),
    events,
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      nowSequence += 1;
      return `2026-07-18T12:00:${String(nowSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => {
  db.close();
});

function requirement(statement: string) {
  return {
    kind: "requirement" as const,
    statement,
    priority: "must" as const,
    risk: "high" as const,
  };
}

function firstElement(statement: string, elementId = "requirement-1") {
  return {
    elementId,
    kind: "requirement" as const,
    parentElementId: null,
    position: 0,
    payload: requirement(statement),
  };
}

async function createDraft(
  initialElement = firstElement("Specs have stable identity."),
) {
  return service.createSpec({
    projectPath: PROJECT_PATH,
    slug: "native-sdd",
    name: "Native SDD",
    gatePolicy: { preset: "contract-bearing" },
    initialElement,
    actor: ACTOR,
  });
}

describe("AuthoringService create and draft writes", () => {
  it("creates the spec, draft revision, and first element in one first-save transaction", async () => {
    const created = await createDraft();

    const resolved = await service.getSpec(PROJECT_PATH, "native-sdd");
    const snapshot = await service.getRevisionSnapshot(created.draft.id);

    expect(resolved?.id).toBe(created.spec.id);
    expect(snapshot?.elements).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ id: "requirement-1" }),
        version: expect.objectContaining({
          payload: requirement("Specs have stable identity."),
          elementVersion: 1,
        }),
      }),
    ]);
    expect(created.element.id).toBe("requirement-1");
    expect(created.version.elementVersion).toBe(1);
    // The spec is born from the first draft save: one shared timestamp.
    expect(created.spec.createdAt).toBe(created.version.createdAt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM specs").get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_revisions").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_element_versions").get(),
    ).toEqual({ count: 1 });
    expect(published).toEqual([
      expect.objectContaining({
        type: "spec-changed",
        specSlug: "native-sdd",
        revisionId: created.draft.id,
        elementIds: ["requirement-1"],
      }),
    ]);
  });

  it("refuses a create for a slug that already has an editable draft, writing nothing", async () => {
    const created = await createDraft();

    await expect(
      createDraft(firstElement("Competing content.", "requirement-9")),
    ).rejects.toMatchObject({
      name: "SpecSlugTakenError",
      slug: "native-sdd",
      existingSpecId: created.spec.id,
    });

    expect(db.prepare("SELECT COUNT(*) AS count FROM specs").get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_revisions").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_element_versions").get(),
    ).toEqual({ count: 1 });
  });

  it("opens an amendment carrying the element when the slug names an approved spec with no draft", async () => {
    const created = await createDraft();
    await specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-18T12:10:00.000Z",
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T12:11:00.000Z",
    });

    const amended = await createDraft(
      firstElement("Amendment requirement.", "requirement-2"),
    );
    const snapshot = await service.getRevisionSnapshot(amended.draft.id);

    expect(amended.spec.id).toBe(created.spec.id);
    expect(amended.draft.id).not.toBe(created.draft.id);
    expect(amended.draft.basedOnRevisionId).toBe(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id).sort()).toEqual([
      "requirement-1",
      "requirement-2",
    ]);
    expect(published.at(-1)).toEqual(
      expect.objectContaining({
        type: "spec-changed",
        revisionId: amended.draft.id,
        elementIds: ["requirement-2"],
      }),
    );
  });

  it("lands concurrent writes to different elements and publishes each committed event", async () => {
    const created = await createDraft();

    const [first, second] = await Promise.all([
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "requirement-2",
        kind: "requirement",
        parentElementId: null,
        position: 1,
        payload: requirement("First writer."),
        baseElementVersion: null,
        actor: ACTOR,
      }),
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "requirement-3",
        kind: "requirement",
        parentElementId: null,
        position: 2,
        payload: requirement("Second writer."),
        baseElementVersion: null,
        actor: ACTOR,
      }),
    ]);

    expect(first.version.payload).toEqual(requirement("First writer."));
    expect(second.version.payload).toEqual(requirement("Second writer."));
    expect(
      (await service.getRevisionSnapshot(created.draft.id))?.elements,
    ).toHaveLength(3);

    const contentEvents = published.filter(
      (event) =>
        event.type === "spec-changed" && event.kind === "content-changed",
    );
    expect(contentEvents).toHaveLength(3);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM spec_events WHERE event_type = 'spec-changed'",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("returns the typed stale-element conflict with the current content", async () => {
    const created = await createDraft(firstElement("Original."));
    const inserted = created;

    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: requirement("Winning writer."),
      baseElementVersion: inserted.version.elementVersion,
      actor: ACTOR,
    });

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "requirement-1",
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: requirement("Stale writer."),
        baseElementVersion: inserted.version.elementVersion,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "stale_element",
      current: {
        elementVersion: 2,
        payload: requirement("Winning writer."),
      },
    });
  });

  it("reorders and removes draft elements through the same version CAS", async () => {
    const created = await createDraft(firstElement("Movable."));
    const inserted = created;

    const reordered = await service.reorderDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      position: 4,
      baseElementVersion: inserted.version.elementVersion,
      actor: ACTOR,
    });
    expect(reordered.position).toBe(4);
    expect(reordered.elementVersion).toBe(2);

    await service.removeDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      baseElementVersion: reordered.elementVersion,
      actor: ACTOR,
    });
    expect(
      (await service.getRevisionSnapshot(created.draft.id))?.elements,
    ).toEqual([]);
  });

  it("copies the approved snapshot into one reusable amendment draft", async () => {
    const created = await createDraft(firstElement("Approved requirement."));
    await specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-18T12:10:00.000Z",
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T12:11:00.000Z",
    });

    const amendment = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    const reused = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    const approved = await service.getRevisionSnapshot(created.draft.id);
    const copied = await service.getRevisionSnapshot(amendment.id);

    expect(amendment.basedOnRevisionId).toBe(created.draft.id);
    expect(reused.id).toBe(amendment.id);
    expect(copied?.elements.map(({ version }) => version.payload)).toEqual(
      approved?.elements.map(({ version }) => version.payload),
    );
    expect(
      (await service.getRevisionSnapshot(created.draft.id))?.revision.state,
    ).toBe("approved");
  });
});

describe("AuthoringService rename", () => {
  const HUMAN = { kind: "human" } as const;

  it("renames the spec, writes the prior slug as an alias, and publishes spec-renamed after commit", async () => {
    const created = await createDraft();

    const renamed = await service.renameSpec({
      specId: created.spec.id,
      slug: "native-sdd-v2",
      name: "Native SDD v2",
      actor: HUMAN,
    });

    expect(renamed.spec).toMatchObject({
      id: created.spec.id,
      slug: "native-sdd-v2",
      name: "Native SDD v2",
    });
    expect(renamed.alias).toMatchObject({
      projectPath: PROJECT_PATH,
      slug: "native-sdd",
      specId: created.spec.id,
    });

    // Previously copied references and deep links keep resolving: the OLD
    // slug still reaches the renamed spec through its alias (R1.6).
    const byOldSlug = await service.getSpec(PROJECT_PATH, "native-sdd");
    expect(byOldSlug?.id).toBe(created.spec.id);
    expect(byOldSlug?.slug).toBe("native-sdd-v2");
    const byNewSlug = await service.getSpec(PROJECT_PATH, "native-sdd-v2");
    expect(byNewSlug?.id).toBe(created.spec.id);

    const eventRows = db
      .prepare(
        "SELECT event_type, payload_json FROM spec_events WHERE spec_id = ? ORDER BY id",
      )
      .all(created.spec.id) as Array<{
      event_type: string;
      payload_json: string;
    }>;
    const renameRow = eventRows.at(-1);
    expect(renameRow?.event_type).toBe("spec-changed");
    expect(JSON.parse(renameRow?.payload_json ?? "{}")).toMatchObject({
      kind: "spec-renamed",
      fromSlug: "native-sdd",
      toSlug: "native-sdd-v2",
    });

    expect(published).toContainEqual(
      expect.objectContaining({
        type: "spec-changed",
        kind: "spec-renamed",
        specId: created.spec.id,
        specSlug: "native-sdd-v2",
        projectPath: PROJECT_PATH,
      }),
    );
  });

  it("keeps the current name when the rename carries no name", async () => {
    const created = await createDraft();

    const renamed = await service.renameSpec({
      specId: created.spec.id,
      slug: "native-sdd-v2",
      actor: HUMAN,
    });

    expect(renamed.spec.name).toBe("Native SDD");
  });

  it("refuses a same-slug rename and an alias-shadowing rename", async () => {
    const created = await createDraft();

    await expect(
      service.renameSpec({
        specId: created.spec.id,
        slug: "native-sdd",
        actor: HUMAN,
      }),
    ).rejects.toMatchObject({ failure: { kind: "validation" } });

    // Renaming leaves "native-sdd" behind as an alias of the first spec…
    await service.renameSpec({
      specId: created.spec.id,
      slug: "native-sdd-v2",
      actor: HUMAN,
    });
    const other = await service.createSpec({
      projectPath: PROJECT_PATH,
      slug: "other-spec",
      name: "Other spec",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: firstElement("Another spec.", "requirement-other"),
      actor: ACTOR,
    });

    // …so another spec cannot take that slug and shadow the alias.
    await expect(
      service.renameSpec({
        specId: other.spec.id,
        slug: "native-sdd",
        actor: HUMAN,
      }),
    ).rejects.toMatchObject({ failure: { kind: "constraint" } });
    expect((await service.getSpec(PROJECT_PATH, "other-spec"))?.id).toBe(
      other.spec.id,
    );
  });
});
