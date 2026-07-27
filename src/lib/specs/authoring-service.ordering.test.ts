import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

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

const PROJECT_PATH = "/repos/native-sdd-ordering";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;

let db: Db;
let specs: SpecsRepo;
let authoring: AuthoringService;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  let idSequence = 0;
  let timeSequence = 0;
  authoring = createAuthoringService({
    specs,
    review: createSpecReviewRepo(db),
    links: createSpecLinksRepo(db),
    events: createSpecEventsPublisher({
      appendInTransaction: createSpecEventsRepo(db).appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    newId(prefix: string) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-07-25T10:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => db.close());

async function createdSpec() {
  return authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "ordering",
    name: "Ordering",
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "Element ordering is one global order per revision.",
        priority: "must",
        risk: "medium",
      },
    },
    actor: AGENT,
  });
}

describe("R24.12 element position ordering", () => {
  it("appends when a draft write omits position, in write order", async () => {
    const created = await createdSpec();
    expect(created.version.position).toBe(0);

    const criterion = await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: {
        kind: "criterion",
        text: "An omitted position appends.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    const decision = await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      payload: {
        kind: "decision",
        title: "Append is server-assigned",
        chosenApproach: "The repository assigns the next position.",
        rejectedAlternatives: [],
        reason: "An author cannot know the revision's high-water mark.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      baseElementVersion: null,
      actor: AGENT,
    });

    expect(criterion.version.position).toBe(1);
    expect(decision.version.position).toBe(2);
  });

  it("keeps nesting on the parent element, never on position", async () => {
    const created = await createdSpec();
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: {
        kind: "requirement",
        statement: "A second requirement sits between a parent and its child.",
        priority: "must",
        risk: "low",
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      position: 2,
      payload: {
        kind: "criterion",
        text: "A child ordered after another parent still nests on its own.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });

    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(
      snapshot?.elements.map(({ element, version }) => [
        element.id,
        version.position,
        element.parentElementId,
      ]),
    ).toEqual([
      ["requirement-1", 0, null],
      ["requirement-2", 1, null],
      ["criterion-1", 2, "requirement-1"],
    ]);
    expect(
      snapshot?.elements.find(({ element }) => element.id === "criterion-1")
        ?.element.number,
    ).toBe(1);
  });

  it("keeps an element's position when an update omits it", async () => {
    const created = await createdSpec();
    const placed = await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      position: 7,
      payload: {
        kind: "criterion",
        text: "The original text.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });

    const updated = await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: {
        kind: "criterion",
        text: "The restated text.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: placed.version.elementVersion,
      actor: AGENT,
    });

    expect(updated.version.position).toBe(7);
  });
});
