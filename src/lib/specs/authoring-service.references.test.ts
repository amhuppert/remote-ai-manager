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
  StageBlockedWriteError,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import type {
  CriterionElementPayload,
  DecisionElementPayload,
} from "./schemas";

const PROJECT_PATH = "/repos/native-sdd-references";
const ACTOR = { kind: "agent", conversationId: "conversation-1" } as const;

let db: Db;
let service: AuthoringService;
let specs: SpecsRepo;
let idSequence: number;
let nowSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
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
      publish: () => ({ delivered: true }),
    }),
    attention: eventRows,
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      nowSequence += 1;
      return `2026-07-30T09:00:${String(nowSequence).padStart(2, "0")}.000Z`;
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

function criterion(text: string): CriterionElementPayload {
  return {
    kind: "criterion",
    text,
    validationStrategy: { kinds: ["test_run"] },
  };
}

function decision(
  title: string,
  tracedRequirementElementIds: string[] = [],
): DecisionElementPayload {
  return {
    kind: "decision",
    title,
    chosenApproach: "Keep every trace resolvable.",
    rejectedAlternatives: [],
    reason: "A dangling trace misleads review.",
    tracedRequirementElementIds,
  };
}

/** Create a spec through the same first-save surface used by the CLI. */
function createSpec(
  initialElement: Parameters<
    AuthoringService["createSpec"]
  >[0]["initialElement"],
) {
  return service.createSpec({
    projectPath: PROJECT_PATH,
    slug: "native-sdd-references",
    name: "Native SDD references",
    gatePolicy: { preset: "fast-path" },
    initialElement,
    actor: ACTOR,
  });
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

/** A requirements-stage draft: requirement-1 containing criterion-1. */
async function seedRequirementsDraft() {
  const created = await createSpec({
    elementId: "requirement-1",
    kind: "requirement",
    parentElementId: null,
    position: 0,
    payload: requirement("Recorded work stays traceable."),
  });
  await service.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: "criterion-1",
    kind: "criterion",
    parentElementId: "requirement-1",
    payload: criterion("Every reference resolves."),
    baseElementVersion: null,
    actor: ACTOR,
  });
  return created;
}

/** The seeded requirements, approved and opened as a design amendment. */
async function seedDesignDraft() {
  const created = await seedRequirementsDraft();
  await specs.approveRevision({
    revisionId: created.draft.id,
    approvedAt: "2026-07-30T09:10:00.000Z",
  });
  const design = await service.openAmendment({
    specId: created.spec.id,
    actor: ACTOR,
  });
  return { spec: created.spec, draft: design.revision };
}

/**
 * A requirements-stage draft that still carries an approved decision, as
 * returning to requirements from a design amendment leaves it. The decision
 * traces the given requirements; requirement-2 has no criterion, so removing
 * it breaks no containment.
 */
async function seedRequirementsDraftWithDecision(
  tracedRequirementElementIds: string[],
) {
  const created = await seedRequirementsDraft();
  await service.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: "requirement-2",
    kind: "requirement",
    parentElementId: null,
    payload: requirement("A second requirement a decision may trace."),
    baseElementVersion: null,
    actor: ACTOR,
  });
  await specs.approveRevision({
    revisionId: created.draft.id,
    approvedAt: "2026-07-30T09:10:00.000Z",
  });
  const design = await service.openAmendment({
    specId: created.spec.id,
    actor: ACTOR,
  });
  await service.upsertDraftElement({
    specId: created.spec.id,
    revisionId: design.revision.id,
    elementId: "decision-1",
    kind: "decision",
    parentElementId: null,
    payload: decision("Trace the requirements", tracedRequirementElementIds),
    baseElementVersion: null,
    actor: ACTOR,
  });
  await specs.approveRevision({
    revisionId: design.revision.id,
    approvedAt: "2026-07-30T09:11:00.000Z",
  });
  const amendment = await service.openAmendment({
    specId: created.spec.id,
    actor: ACTOR,
  });
  const returned = await service.returnToRequirements({
    specId: created.spec.id,
    expectedRevisionId: amendment.revision.id,
    reason: "Rework the requirements under the approved design.",
    actor: ACTOR,
  });
  return { spec: created.spec, draft: returned.revision };
}

describe("createSpec reference guard", () => {
  it("refuses a first save whose criterion parent is missing, and creates no spec", async () => {
    const refusal = await refusalOf(
      createSpec({
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: "requirement-typo",
        position: 0,
        payload: criterion("The missing requirement is refused."),
      }),
    );

    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.details?.references).toEqual([
      {
        code: "missing_target",
        sourceElementId: "criterion-1",
        field: "parentElementId",
        index: 0,
        targetId: "requirement-typo",
        expectedKind: "requirement",
        actualKind: null,
        relation: "is contained by",
      },
    ]);
    await expect(
      service.getSpec(PROJECT_PATH, "native-sdd-references"),
    ).resolves.toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_elements").get(),
    ).toEqual({ count: 0 });
  });

  it("keeps empty id arrays legal on a stage-admitted write", async () => {
    const created = await createSpec({
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: requirement("A decision may remain independent."),
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T12:00:01.000Z",
    });
    const design = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    const written = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: design.revision.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "decision",
        title: "Capture discovered work",
        chosenApproach: "Keep the decision independent.",
        rejectedAlternatives: [],
        reason: "No requirement trace is needed.",
        tracedRequirementElementIds: [],
      },
      baseElementVersion: null,
      actor: ACTOR,
    });

    expect(written.element.id).toBe("decision-1");
  });
});

describe("upsertDraftElement reference guard", () => {
  it("refuses a decision whose traced requirement is absent and writes nothing", async () => {
    const created = await seedDesignDraft();

    const refusal = await refusalOf(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "decision-1",
        kind: "decision",
        parentElementId: null,
        payload: decision("Trace a ghost", ["requirement-9"]),
        baseElementVersion: null,
        actor: ACTOR,
      }),
    );

    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions).toEqual([
      "decision-1.tracedRequirementElementIds[0] traces to requirement requirement-9, which is not in this revision.",
    ]);
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
    ]);
  });

  it("refuses an update that repoints a decision at an element of the wrong kind", async () => {
    const created = await seedDesignDraft();
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      payload: decision("Trace the requirement", ["requirement-1"]),
      baseElementVersion: null,
      actor: ACTOR,
    });

    const refusal = await refusalOf(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "decision-1",
        kind: "decision",
        parentElementId: null,
        payload: decision("Trace the requirement", ["criterion-1"]),
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );

    expect(refusal.details?.references).toEqual([
      {
        code: "wrong_kind",
        sourceElementId: "decision-1",
        field: "tracedRequirementElementIds",
        index: 0,
        targetId: "criterion-1",
        expectedKind: "requirement",
        actualKind: "criterion",
        relation: "traces to",
      },
    ]);
  });

  it("accepts a write whose references the revision already carries", async () => {
    const created = await seedDesignDraft();

    const written = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      payload: decision("Trace the requirement", ["requirement-1"]),
      baseElementVersion: null,
      actor: ACTOR,
    });

    expect(written.element.id).toBe("decision-1");
  });
});

describe("removeDraftElement reference guard", () => {
  it("refuses a removal a surviving decision still traces and names what to rewrite", async () => {
    const created = await seedRequirementsDraftWithDecision(["requirement-2"]);

    const refusal = await refusalOf(
      service.removeDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "requirement-2",
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );

    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions).toEqual([
      "decision-1.tracedRequirementElementIds[0] traces to requirement requirement-2, which is not in this revision.",
    ]);
    expect(refusal.instruction).toContain("decision-1");
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toContain(
      "requirement-2",
    );
  });

  it("refuses a requirement removal that would orphan its criterion child", async () => {
    const created = await seedRequirementsDraft();

    const refusal = await refusalOf(
      service.removeDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "requirement-1",
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );

    expect(refusal.details?.references).toEqual([
      {
        code: "missing_target",
        sourceElementId: "criterion-1",
        field: "parentElementId",
        index: 0,
        targetId: "requirement-1",
        expectedKind: "requirement",
        actualKind: null,
        relation: "is contained by",
      },
    ]);
  });

  it("accepts the removal when no surviving source references it", async () => {
    const created = await seedRequirementsDraftWithDecision(["requirement-1"]);

    await service.removeDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      baseElementVersion: 1,
      actor: ACTOR,
    });

    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
      "decision-1",
    ]);
  });
});

describe("upsertDraftElements reference guard", () => {
  it("rolls the whole batch back when one element's reference dangles and indexes the refusal", async () => {
    const created = await seedDesignDraft();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "decision-1",
          kind: "decision",
          parentElementId: null,
          payload: decision("Good neighbour", ["requirement-1"]),
          baseElementVersion: null,
        },
        {
          elementId: "decision-2",
          kind: "decision",
          parentElementId: null,
          payload: decision("Bad neighbour", ["requirement-9"]),
          baseElementVersion: null,
        },
      ],
      actor: ACTOR,
    });

    expect(result).toMatchObject({
      ok: false,
      refusals: [
        {
          index: 1,
          elementId: "decision-2",
          code: "dangling_reference",
          danglingReferences: [
            {
              code: "missing_target",
              sourceElementId: "decision-2",
              field: "tracedRequirementElementIds",
              index: 0,
              targetId: "requirement-9",
              expectedKind: "requirement",
              actualKind: null,
              relation: "traces to",
            },
          ],
        },
      ],
    });
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
    ]);
  });

  it("names the dangling reference by handle when a batch removal would strand it", async () => {
    const created = await seedRequirementsDraftWithDecision(["requirement-2"]);

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [],
      removals: [{ elementId: "requirement-2", baseElementVersion: 1 }],
      actor: ACTOR,
    });

    // Ids address storage; handles address the document the author wrote, so a
    // refusal that only quoted ids would make the author re-read the spec to
    // learn which handle it is talking about.
    expect(result).toMatchObject({
      ok: false,
      refusals: [
        {
          input: "removal",
          index: 0,
          code: "dangling_reference",
          danglingReferences: [
            {
              sourceElementId: "decision-1",
              sourceHandle: "D1",
              targetId: "requirement-2",
              targetHandle: "R2",
            },
          ],
        },
      ],
    });
  });

  it("removes a contained element and its container together in one batch", async () => {
    const created = await seedRequirementsDraft();

    const singleRemoval = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [],
      removals: [{ elementId: "requirement-1", baseElementVersion: 1 }],
      actor: ACTOR,
    });
    expect(singleRemoval).toMatchObject({
      ok: false,
      refusals: [{ code: "dangling_reference", input: "removal", index: 0 }],
    });

    const together = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [],
      removals: [
        { elementId: "requirement-1", baseElementVersion: 1 },
        { elementId: "criterion-1", baseElementVersion: 1 },
      ],
      actor: ACTOR,
    });

    expect(together.ok).toBe(true);
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements).toEqual([]);
  });
});

describe("propose lint 9.6", () => {
  it("still reports content that dangled before the write guard existed", async () => {
    const created = await seedDesignDraft();
    // Written straight through the repository, which is below the guarded
    // mutation boundary: this is the shape of a revision authored before the
    // boundary existed, and the propose-time sweep is what still catches it.
    await specs.createDraftElement({
      id: "decision-legacy",
      specId: created.spec.id,
      revisionId: created.draft.id,
      kind: "decision",
      parentElementId: null,
      payload: decision("Legacy content", ["requirement-vanished"]),
      createdAt: "2026-07-30T09:30:00.000Z",
      updatedAt: "2026-07-30T09:30:00.000Z",
    });

    const findings = await service.lintDraft(created.spec.id, created.draft.id);

    expect(
      findings.filter((finding) => finding.ruleId === "9.6.dangling-handle"),
    ).toEqual([
      {
        ruleId: "9.6.dangling-handle",
        severity: "blocks_propose",
        elementHandle: "D1",
        message:
          "D1 traces to unknown requirement element requirement-vanished.",
      },
    ]);
  });
});
