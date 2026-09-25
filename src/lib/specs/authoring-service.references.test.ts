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
import type { CriterionElementPayload, TaskElementPayload } from "./schemas";

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

function task(
  title: string,
  scope: Partial<
    Pick<
      TaskElementPayload,
      | "tracedRequirementElementIds"
      | "tracedDecisionElementIds"
      | "coveredCriterionElementIds"
      | "dependsOnTaskElementIds"
    >
  > = {},
): TaskElementPayload {
  return {
    kind: "task",
    title,
    instructions: "Implement the discovered work.",
    tracedRequirementElementIds: scope.tracedRequirementElementIds ?? [],
    tracedDecisionElementIds: scope.tracedDecisionElementIds ?? [],
    coveredCriterionElementIds: scope.coveredCriterionElementIds ?? [],
    dependsOnTaskElementIds: scope.dependsOnTaskElementIds ?? [],
  };
}

/** Create a spec through the same first-save surface used by the CLI. */
function createSpec(
  initialElement: Parameters<
    AuthoringService["createSpec"]
  >[0]["initialElement"],
  slug = "native-sdd-references",
) {
  return service.createSpec({
    projectPath: PROJECT_PATH,
    slug,
    name: "Native SDD references",
    gatePolicy: { preset: "fast-path" },
    initialElement,
    actor: ACTOR,
  });
}

function markLegacyPlanDraft(revisionId: string) {
  db.prepare(
    "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
  ).run(revisionId);
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

async function seedPlanDraft() {
  const created = await createSpec({
    elementId: "requirement-1",
    kind: "requirement",
    parentElementId: null,
    position: 0,
    payload: requirement("Discovered work stays traceable."),
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
  markLegacyPlanDraft(created.draft.id);
  const batch = await service.upsertDraftElements({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elements: [
      {
        elementId: "task-1",
        kind: "task",
        parentElementId: null,
        payload: task("Route the write", {
          tracedRequirementElementIds: ["requirement-1"],
          coveredCriterionElementIds: ["criterion-1"],
        }),
        baseElementVersion: null,
      },
    ],
    actor: ACTOR,
  });
  if (!batch.ok) throw new Error("seed batch was refused");
  return created;
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
  it("refuses a task whose traced requirement is absent and writes nothing", async () => {
    const created = await seedPlanDraft();

    const refusal = await refusalOf(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "task-2",
        kind: "task",
        parentElementId: null,
        payload: task("Trace a ghost", {
          tracedRequirementElementIds: ["requirement-9"],
        }),
        baseElementVersion: null,
        actor: ACTOR,
      }),
    );

    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions).toEqual([
      "task-2.tracedRequirementElementIds[0] traces to requirement requirement-9, which is not in this revision.",
    ]);
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
      "task-1",
    ]);
  });

  it("refuses an update that repoints a task at an element of the wrong kind", async () => {
    const created = await seedPlanDraft();

    const refusal = await refusalOf(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "task-1",
        kind: "task",
        parentElementId: null,
        payload: task("Route the write", {
          coveredCriterionElementIds: ["requirement-1"],
        }),
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );

    expect(refusal.details?.references).toEqual([
      {
        code: "wrong_kind",
        sourceElementId: "task-1",
        field: "coveredCriterionElementIds",
        index: 0,
        targetId: "requirement-1",
        expectedKind: "criterion",
        actualKind: "requirement",
        relation: "covers",
      },
    ]);
  });

  it("accepts a write whose references the revision already carries", async () => {
    const created = await seedPlanDraft();

    const written = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-2",
      kind: "task",
      parentElementId: null,
      payload: task("Follow task one", {
        tracedRequirementElementIds: ["requirement-1"],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: ["task-1"],
      }),
      baseElementVersion: null,
      actor: ACTOR,
    });

    expect(written.element.id).toBe("task-2");
  });
});

describe("removeDraftElement reference guard", () => {
  it("refuses a removal a surviving task still traces and names what to rewrite", async () => {
    const created = await seedPlanDraft();
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
    ).run(created.draft.id);

    const refusal = await refusalOf(
      service.removeDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    );

    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions).toEqual([
      "task-1.coveredCriterionElementIds[0] covers criterion criterion-1, which is not in this revision.",
    ]);
    expect(refusal.instruction).toContain("task-1");
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toContain(
      "criterion-1",
    );
  });

  it("refuses a requirement removal that would orphan its criterion child", async () => {
    const created = await seedPlanDraft();
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-1",
      kind: "task",
      parentElementId: null,
      payload: task("Route the write"),
      baseElementVersion: 1,
      actor: ACTOR,
    });
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
    ).run(created.draft.id);

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

  it("accepts the removal once the surviving source no longer references it", async () => {
    const created = await seedPlanDraft();
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-1",
      kind: "task",
      parentElementId: null,
      payload: task("Route the write", {
        tracedRequirementElementIds: ["requirement-1"],
      }),
      baseElementVersion: 1,
      actor: ACTOR,
    });
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
    ).run(created.draft.id);

    await service.removeDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      baseElementVersion: 1,
      actor: ACTOR,
    });

    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "task-1",
    ]);
  });
});

describe("upsertDraftElements reference guard", () => {
  it("resolves a forward reference no matter which order the batch arrives in", async () => {
    for (const [slug, reversed] of [
      ["batch-forward", false],
      ["batch-reverse", true],
    ] as const) {
      const created = await createSpec(
        {
          elementId: `${slug}-requirement`,
          kind: "requirement",
          parentElementId: null,
          position: 0,
          payload: requirement("Batches resolve forward references."),
        },
        slug,
      );
      markLegacyPlanDraft(created.draft.id);
      const elements = [
        {
          elementId: `${slug}-task-dependent`,
          kind: "task" as const,
          parentElementId: null,
          payload: task("Depend on the forward task", {
            dependsOnTaskElementIds: [`${slug}-task-target`],
          }),
          baseElementVersion: null,
        },
        {
          elementId: `${slug}-task-target`,
          kind: "task" as const,
          parentElementId: null,
          payload: task("The batch order does not matter."),
          baseElementVersion: null,
        },
      ];

      const result = await service.upsertDraftElements({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elements: reversed ? [...elements].reverse() : elements,
        actor: ACTOR,
      });

      expect(result.ok).toBe(true);
    }
  });

  it("rolls the whole batch back when one element's reference dangles and indexes the refusal", async () => {
    const created = await seedPlanDraft();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "task-2",
          kind: "task",
          parentElementId: null,
          payload: task("Good neighbour", {
            tracedRequirementElementIds: ["requirement-1"],
          }),
          baseElementVersion: null,
        },
        {
          elementId: "task-3",
          kind: "task",
          parentElementId: null,
          payload: task("Bad neighbour", {
            dependsOnTaskElementIds: ["task-9"],
          }),
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
          elementId: "task-3",
          code: "dangling_reference",
          danglingReferences: [
            {
              code: "missing_target",
              sourceElementId: "task-3",
              field: "dependsOnTaskElementIds",
              index: 0,
              targetId: "task-9",
              expectedKind: "task",
              actualKind: null,
              relation: "depends on",
            },
          ],
        },
      ],
    });
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
      "task-1",
    ]);
  });

  it("names the dangling reference by handle when a batch removal would strand it", async () => {
    const created = await seedPlanDraft();
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
    ).run(created.draft.id);

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [],
      removals: [{ elementId: "criterion-1", baseElementVersion: 1 }],
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
              sourceElementId: "task-1",
              sourceHandle: "T1",
              targetId: "criterion-1",
              targetHandle: "R1.1",
            },
          ],
        },
      ],
    });
  });

  it("removes a source and the referent it depends on together in one batch", async () => {
    const created = await seedPlanDraft();
    const paired = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "task-2",
          kind: "task",
          parentElementId: null,
          payload: task("Mutually bound", {
            dependsOnTaskElementIds: ["task-1"],
          }),
          baseElementVersion: null,
        },
        {
          elementId: "task-1",
          kind: "task",
          parentElementId: null,
          payload: task("Route the write", {
            coveredCriterionElementIds: ["criterion-1"],
            dependsOnTaskElementIds: ["task-2"],
          }),
          baseElementVersion: 1,
        },
      ],
      actor: ACTOR,
    });
    if (!paired.ok) throw new Error("pairing batch was refused");

    const singleRemoval = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [],
      removals: [{ elementId: "task-1", baseElementVersion: 2 }],
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
        { elementId: "task-1", baseElementVersion: 2 },
        { elementId: "task-2", baseElementVersion: 1 },
      ],
      actor: ACTOR,
    });

    expect(together.ok).toBe(true);
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
    ]);
  });

  it("removes an element while the same batch rewrites the source that referenced it", async () => {
    const created = await seedPlanDraft();
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-2",
      kind: "task",
      parentElementId: null,
      payload: task("Temporary dependency target"),
      baseElementVersion: null,
      actor: ACTOR,
    });
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-1",
      kind: "task",
      parentElementId: null,
      payload: task("Route the write", {
        dependsOnTaskElementIds: ["task-2"],
      }),
      baseElementVersion: 1,
      actor: ACTOR,
    });

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "task-1",
          kind: "task",
          parentElementId: null,
          payload: task("Route the write"),
          baseElementVersion: 2,
        },
      ],
      removals: [{ elementId: "task-2", baseElementVersion: 1 }],
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    const snapshot = await service.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-1",
      "criterion-1",
      "task-1",
    ]);
  });
});

describe("propose lint 9.6", () => {
  it("still reports content that dangled before the write guard existed", async () => {
    const created = await seedPlanDraft();
    // Written straight through the repository, which is below the guarded
    // mutation boundary: this is the shape of a revision authored before the
    // boundary existed, and the propose-time sweep is what still catches it.
    await specs.createDraftElement({
      id: "task-legacy",
      specId: created.spec.id,
      revisionId: created.draft.id,
      kind: "task",
      parentElementId: null,
      payload: task("Legacy content", {
        coveredCriterionElementIds: ["criterion-vanished"],
      }),
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
        elementHandle: "T2",
        message: "T2 covers unknown criterion element criterion-vanished.",
      },
    ]);
  });
});
