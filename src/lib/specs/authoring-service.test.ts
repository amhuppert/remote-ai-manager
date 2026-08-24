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
  SpecRevisionInReviewError,
  SpecSlugTakenError,
  StageBlockedWriteError,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";

const PROJECT_PATH = "/repos/native-sdd";
const ACTOR = { kind: "agent", conversationId: "conversation-1" } as const;

const interventionRowSchema = z.object({ payload_json: z.string() });

/** Which composition seam of the specs repository a service call entered. */
interface SeamCall {
  readonly seam: "transaction" | "readOutsideWriteQueue";
  readonly label: string;
}

let db: Db;
let service: AuthoringService;
let specs: SpecsRepo;
let seamCalls: SeamCall[];
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
  // The real repository, with only its two composition seams instrumented, so
  // which seam a service call took is observable without faking any read.
  const realSpecs = createSpecsRepo(db, writeQueue);
  seamCalls = [];
  specs = {
    ...realSpecs,
    transaction(label, operation) {
      seamCalls.push({ seam: "transaction", label });
      return realSpecs.transaction(label, operation);
    },
    readOutsideWriteQueue(label, operation) {
      seamCalls.push({ seam: "readOutsideWriteQueue", label });
      return realSpecs.readOutsideWriteQueue(label, operation);
    },
  };
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

function criterion(text: string) {
  return {
    kind: "criterion" as const,
    text,
    validationStrategy: { kinds: ["test_run" as const] },
  };
}

function task(title: string) {
  return {
    kind: "task" as const,
    title,
    instructions: "Implement the task.",
    tracedRequirementElementIds: [],
    tracedDecisionElementIds: [],
    coveredCriterionElementIds: [],
    dependsOnTaskElementIds: [],
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
    expect(created.draft.authoringStage).toBe("requirements");
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

  it("returns the handle assigned to the created and drafted elements", async () => {
    const created = await createDraft();
    expect(created.handle).toBe("R1");

    const secondRequirement = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: requirement("Handles address elements."),
      baseElementVersion: null,
      actor: ACTOR,
    });
    expect(secondRequirement.handle).toBe("R2");

    const criterion = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-2",
      position: 2,
      payload: {
        kind: "criterion",
        text: "The create response names the handle.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: ACTOR,
    });
    expect(criterion.handle).toBe("R2.1");

    const section = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "section-intent",
      kind: "section",
      parentElementId: null,
      position: 3,
      payload: {
        kind: "section",
        role: "intent_problem",
        title: "Intent",
        body: "Why this spec.",
      },
      baseElementVersion: null,
      actor: ACTOR,
    });
    expect(section.handle).toBeNull();
  });

  it("refuses an out-of-stage first element without creating a spec or intervention", async () => {
    await expect(
      service.createSpec({
        projectPath: PROJECT_PATH,
        slug: "blocked-spec",
        name: "Blocked spec",
        gatePolicy: { preset: "contract-bearing" },
        initialElement: {
          elementId: "task-1",
          kind: "task",
          parentElementId: null,
          position: 0,
          payload: task("Premature task"),
        },
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "stage_blocked" });

    expect(db.prepare("SELECT COUNT(*) AS count FROM specs").get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_events").get(),
    ).toEqual({ count: 0 });
  });

  // The lint body writes nothing, and both GET paths that call it (the status
  // projection and the lint endpoint) paid for a write-queue admission anyway —
  // waiting behind every unrelated writer and then making the next one wait.
  it("lints a draft through the read seam, never the write-queue transaction", async () => {
    const created = await createDraft();
    seamCalls.length = 0;

    const findings = await service.lintDraft(created.spec.id, created.draft.id);

    expect(seamCalls).toEqual([
      { seam: "readOutsideWriteQueue", label: "specs.authoring.lint-draft" },
    ]);
    // The seam swap must not change the answer, and the ownership guard the
    // lint runs before reading still refuses a revision of another spec.
    expect(findings).toEqual([
      {
        ruleId: "9.2.empty-spec",
        severity: "blocks_propose",
        elementHandle: "native-sdd",
        message: "Empty spec — nothing to review.",
      },
    ]);
    await expect(
      service.lintDraft("spec-does-not-exist", created.draft.id),
    ).rejects.toThrow();
  });

  it("keeps fast-path evergreen authoring at the design stage", async () => {
    const created = await service.createSpec({
      projectPath: PROJECT_PATH,
      slug: "fast-path-spec",
      name: "Fast-path spec",
      gatePolicy: { preset: "fast-path" },
      initialElement: {
        elementId: "decision-fast",
        kind: "decision",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "decision",
          title: "Single-pass design",
          chosenApproach: "Author the design in one evergreen pass.",
          rejectedAlternatives: [],
          reason: "The delivery graph belongs to a delivery plan attempt.",
          tracedRequirementElementIds: [],
        },
      },
      actor: ACTOR,
    });

    expect(created.draft.authoringStage).toBe("design");
  });

  it("records a durable intervention and checks stage before element CAS", async () => {
    const created = await createDraft();
    const direct = await specs.createDraftElement({
      id: "task-1",
      specId: created.spec.id,
      revisionId: created.draft.id,
      kind: "task",
      parentElementId: null,
      position: 1,
      payload: task("Existing task"),
      createdAt: "2026-07-18T12:10:00.000Z",
      updatedAt: "2026-07-18T12:10:00.000Z",
    });

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: direct.element.id,
        kind: "task",
        parentElementId: null,
        position: 1,
        payload: task("Stale task write"),
        baseElementVersion: 99,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "stage_blocked" });

    const interventions = db
      .prepare(
        "SELECT payload_json FROM spec_events WHERE spec_id = ? AND event_type = 'spec-intervention-recorded'",
      )
      .all(created.spec.id) as Array<{ payload_json: string }>;
    expect(interventions).toHaveLength(1);
    expect(JSON.parse(interventions[0]!.payload_json)).toMatchObject({
      kind: "draft-write-refused",
      revisionId: created.draft.id,
      refusal: { code: "stage_blocked" },
    });
    expect(published).toHaveLength(1);
  });

  it("advances a Notify-governed stage with one admission and event", async () => {
    const created = await service.createSpec({
      projectPath: PROJECT_PATH,
      slug: "exploratory-spec",
      name: "Exploratory spec",
      gatePolicy: { preset: "exploratory" },
      initialElement: firstElement("Explore staged authoring."),
      actor: ACTOR,
    });

    const advanced = await service.advanceAuthoringStage({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedStage: "requirements",
      actor: ACTOR,
    });
    const replay = await service.advanceAuthoringStage({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedStage: "requirements",
      actor: ACTOR,
    });

    expect(advanced).toMatchObject({
      ok: true,
      revision: { authoringStage: "design" },
    });
    expect(replay).toEqual(advanced);
    expect(
      db
        .prepare(
          "SELECT gate, basis FROM spec_gate_admissions WHERE revision_id = ?",
        )
        .all(created.draft.id),
    ).toEqual([{ gate: "requirements", basis: "notify_policy" }]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM spec_events WHERE spec_id = ? AND payload_json LIKE '%authoring-stage-advanced%'",
        )
        .get(created.spec.id),
    ).toEqual({ count: 1 });
  });

  it("refuses direct advance when the current stage is Gate-governed", async () => {
    const created = await createDraft();

    await expect(
      service.advanceAuthoringStage({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedStage: "requirements",
        actor: ACTOR,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      authoringStage: "requirements",
    });
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
    expect(amended.draft.authoringStage).toBe("design");
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
    const copied = await service.getRevisionSnapshot(amendment.revision.id);

    expect(amendment.revision.basedOnRevisionId).toBe(created.draft.id);
    expect(amendment.revision.authoringStage).toBe("design");
    // Nothing was withdrawn above the approved base, so the amendment leaves
    // nothing behind to report.
    expect(amendment.skippedWithdrawnRevisions).toEqual([]);
    expect(reused.revision.id).toBe(amendment.revision.id);
    expect(reused.skippedWithdrawnRevisions).toEqual([]);
    expect(copied?.elements.map(({ version }) => version.payload)).toEqual(
      approved?.elements.map(({ version }) => version.payload),
    );
    expect(
      (await service.getRevisionSnapshot(created.draft.id))?.revision.state,
    ).toBe("approved");
  });

  it("keeps legacy Plan tasks in approved history without copying them into a design amendment", async () => {
    const created = await createDraft(firstElement("Approved requirement."));
    await specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-18T12:10:00.000Z",
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T12:11:00.000Z",
    });
    const legacyPlan = await specs.createDraftFromBase({
      id: "legacy-plan-revision",
      specId: created.spec.id,
      baseRevisionId: created.draft.id,
      authoringStage: "plan",
      createdAt: "2026-07-18T12:12:00.000Z",
    });
    await specs.createDraftElement({
      id: "legacy-task",
      specId: created.spec.id,
      revisionId: legacyPlan.id,
      kind: "task",
      parentElementId: null,
      position: 1,
      payload: task("Legacy delivery work"),
      createdAt: "2026-07-18T12:13:00.000Z",
      updatedAt: "2026-07-18T12:13:00.000Z",
    });
    await specs.proposeRevision({
      revisionId: legacyPlan.id,
      proposedAt: "2026-07-18T12:14:00.000Z",
    });
    await specs.approveRevision({
      revisionId: legacyPlan.id,
      approvedAt: "2026-07-18T12:15:00.000Z",
    });

    const { revision: amendment } = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    const legacySnapshot = await service.getRevisionSnapshot(legacyPlan.id);
    const amendmentSnapshot = await service.getRevisionSnapshot(amendment.id);

    expect(legacySnapshot?.elements).toContainEqual(
      expect.objectContaining({
        version: expect.objectContaining({
          payload: expect.objectContaining({ kind: "task" }),
        }),
      }),
    );
    expect(amendment.authoringStage).toBe("design");
    expect(
      amendmentSnapshot?.elements.some(
        ({ version }) => version.payload.kind === "task",
      ),
    ).toBe(false);
    expect(
      amendmentSnapshot?.elements.some(
        ({ version }) => version.payload.kind === "requirement",
      ),
    ).toBe(true);
  });
});

describe("AuthoringService amendment while a revision is under review", () => {
  function countRevisions() {
    return db.prepare("SELECT COUNT(*) AS count FROM spec_revisions").get() as {
      count: number;
    };
  }

  function countElementVersions() {
    return db
      .prepare("SELECT COUNT(*) AS count FROM spec_element_versions")
      .get() as { count: number };
  }

  function countEvents() {
    return db.prepare("SELECT COUNT(*) AS count FROM spec_events").get() as {
      count: number;
    };
  }

  async function approvedSpecWithProposal() {
    const created = await createDraft(firstElement("Approved requirement."));
    await specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-18T12:10:00.000Z",
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T12:11:00.000Z",
    });
    const { revision: amendment } = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: requirement("Amended requirement."),
      baseElementVersion: null,
      actor: ACTOR,
    });
    await specs.proposeRevision({
      revisionId: amendment.id,
      proposedAt: "2026-07-18T12:20:00.000Z",
    });
    return { created, amendment };
  }

  it("refuses openAmendment and writes nothing while a proposal is under review", async () => {
    const { created, amendment } = await approvedSpecWithProposal();
    const revisionsBefore = countRevisions();
    const elementsBefore = countElementVersions();
    const eventsBefore = countEvents();
    const publishedBefore = published.length;

    const refusal = await service
      .openAmendment({ specId: created.spec.id, actor: ACTOR })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(SpecRevisionInReviewError);
    if (!(refusal instanceof SpecRevisionInReviewError)) throw refusal;
    expect(refusal.code).toBe("revision_in_review");
    expect(refusal.proposals.map(({ id }) => id)).toEqual([amendment.id]);
    expect(refusal.proposals.map(({ number }) => number)).toEqual([2]);
    expect(refusal.approvedBase?.id).toBe(created.draft.id);
    expect(refusal.instruction).toContain("revision 2");
    expect(refusal.instruction).toContain("Spec Studio");
    // The verb an agent can run itself is named alongside the two human exits,
    // so a proposer is not left waiting on a human it could unblock.
    expect(refusal.instruction).toContain("cctl spec withdraw-proposal");

    expect(countRevisions()).toEqual(revisionsBefore);
    expect(countElementVersions()).toEqual(elementsBefore);
    expect(countEvents()).toEqual(eventsBefore);
    expect(published).toHaveLength(publishedBefore);
  });

  it("refuses openAmendment on a spec whose only revision is under review", async () => {
    const created = await createDraft(firstElement("First requirement."));
    await specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-18T12:10:00.000Z",
    });
    const revisionsBefore = countRevisions();

    const refusal = await service
      .openAmendment({ specId: created.spec.id, actor: ACTOR })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(SpecRevisionInReviewError);
    if (!(refusal instanceof SpecRevisionInReviewError)) throw refusal;
    expect(refusal.approvedBase).toBeNull();
    expect(refusal.proposals.map(({ number }) => number)).toEqual([1]);
    expect(countRevisions()).toEqual(revisionsBefore);
  });

  it("refuses an existing-slug create while a proposal is under review", async () => {
    const { created } = await approvedSpecWithProposal();
    const revisionsBefore = countRevisions();
    const elementsBefore = countElementVersions();
    const eventsBefore = countEvents();

    const refusal = await service
      .createSpec({
        projectPath: PROJECT_PATH,
        slug: "native-sdd",
        name: "Native SDD",
        gatePolicy: { preset: "contract-bearing" },
        initialElement: firstElement("Late requirement.", "requirement-late"),
        actor: ACTOR,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(SpecRevisionInReviewError);
    if (!(refusal instanceof SpecRevisionInReviewError)) throw refusal;
    expect(refusal.specId).toBe(created.spec.id);
    expect(countRevisions()).toEqual(revisionsBefore);
    expect(countElementVersions()).toEqual(elementsBefore);
    expect(countEvents()).toEqual(eventsBefore);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM spec_elements WHERE id = ?")
        .get("requirement-late"),
    ).toEqual({ count: 0 });
  });

  it("names the taken slug when a create collides with a spec that carries both a draft and a proposal", async () => {
    const { created } = await approvedSpecWithProposal();
    // An execution's scope capture opens a draft on the pinned approved
    // revision, so a draft and a proposal legitimately coexist here.
    await specs.createDraftFromBase({
      id: "revision-capture",
      specId: created.spec.id,
      baseRevisionId: created.draft.id,
      authoringStage: "design",
      createdAt: "2026-07-18T12:30:00.000Z",
    });
    const revisionsBefore = countRevisions();
    const elementsBefore = countElementVersions();

    const refusal = await service
      .createSpec({
        projectPath: PROJECT_PATH,
        slug: "native-sdd",
        name: "Competing Native SDD",
        gatePolicy: { preset: "contract-bearing" },
        initialElement: firstElement("Late requirement.", "requirement-late"),
        actor: ACTOR,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The caller asked for a NEW spec and hit a taken slug: it needs the
    // colliding spec's identity and the option of another slug, not the
    // recovery for continuing this spec's authoring line.
    expect(refusal).toBeInstanceOf(SpecSlugTakenError);
    if (!(refusal instanceof SpecSlugTakenError)) throw refusal;
    expect(refusal.slug).toBe("native-sdd");
    expect(refusal.existingSpecId).toBe(created.spec.id);
    expect(refusal.existingName).toBe("Native SDD");
    expect(countRevisions()).toEqual(revisionsBefore);
    expect(countElementVersions()).toEqual(elementsBefore);
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

describe("AuthoringService parent immutability", () => {
  /**
   * A draft carrying two requirements and one criterion nested under the
   * first, which is the smallest shape a rehoming attempt can be written
   * against: the criterion has a real parent, and a second legal parent exists
   * for the attempt to name.
   */
  async function draftWithNestedCriterion() {
    const created = await createDraft();
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-2",
      kind: "requirement",
      parentElementId: null,
      payload: requirement("A second home the criterion cannot move to."),
      baseElementVersion: null,
      actor: ACTOR,
    });
    const nested = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: criterion("Containment is fixed at creation."),
      baseElementVersion: null,
      actor: ACTOR,
    });
    return { created, nested };
  }

  async function storedElement(revisionId: string, elementId: string) {
    const snapshot = await service.getRevisionSnapshot(revisionId);
    return snapshot?.elements.find(({ element }) => element.id === elementId);
  }

  it("refuses an update that names a different parent and writes nothing", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: "requirement-2",
        payload: criterion("Rehomed under the second requirement."),
        baseElementVersion: nested.version.elementVersion,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "parent_immutable" });

    const stored = await storedElement(created.draft.id, "criterion-1");
    expect(stored?.element.parentElementId).toBe("requirement-1");
    expect(stored?.version.elementVersion).toBe(1);
    expect(stored?.version.payload).toEqual(
      criterion("Containment is fixed at creation."),
    );
  });

  it("refuses null against a stored parent and a parent against a stored null", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: null,
        payload: criterion("Orphaned out of its requirement."),
        baseElementVersion: nested.version.elementVersion,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "parent_immutable" });

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "requirement-2",
        kind: "requirement",
        parentElementId: "requirement-1",
        payload: requirement("A top-level requirement given a parent."),
        baseElementVersion: 1,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "parent_immutable" });

    expect(
      (await storedElement(created.draft.id, "criterion-1"))?.element
        .parentElementId,
    ).toBe("requirement-1");
    expect(
      (await storedElement(created.draft.id, "requirement-2"))?.element
        .parentElementId,
    ).toBeNull();
  });

  it("carries the handle, both parents, the rationale, and the replacement path", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    const error = await service
      .upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: "requirement-2",
        payload: criterion("Rehomed under the second requirement."),
        baseElementVersion: nested.version.elementVersion,
        actor: ACTOR,
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toMatchObject({
      refusal: {
        code: "parent_immutable",
        details: {
          elementId: "criterion-1",
          handle: "R1.1",
          currentParentElementId: "requirement-1",
          requestedParentElementId: "requirement-2",
        },
        rationale:
          "containment is identity: a moved element would retroactively change what every frozen revision contained",
      },
    });
    if (!(error instanceof StageBlockedWriteError)) throw error;
    expect(error.refusal.unmetConditions.join(" ")).toContain("R1.1");
    // The way out is a new element under the desired parent plus a removal of
    // the old one — an agent that is only told "no" writes the same thing again.
    expect(error.refusal.instruction).toContain("requirement-2");
    expect(error.refusal.instruction).toContain("cctl spec remove");
  });

  it("records the refused rehoming as a durable intervention", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: "requirement-2",
        payload: criterion("Rehomed under the second requirement."),
        baseElementVersion: nested.version.elementVersion,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "parent_immutable" });

    const interventions = db
      .prepare(
        "SELECT payload_json FROM spec_events WHERE spec_id = ? AND event_type = 'spec-intervention-recorded'",
      )
      .all(created.spec.id)
      .map((row) => JSON.parse(interventionRowSchema.parse(row).payload_json));
    expect(interventions).toEqual([
      expect.objectContaining({
        kind: "draft-write-refused",
        elementId: "criterion-1",
        refusal: expect.objectContaining({ code: "parent_immutable" }),
      }),
    ]);
  });

  it("keeps an echoed parent and an omitted-parent update legal", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    const updated = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: criterion("Edited in place, under the same requirement."),
      baseElementVersion: nested.version.elementVersion,
      actor: ACTOR,
    });

    expect(updated.version.elementVersion).toBe(2);
    expect(updated.element.parentElementId).toBe("requirement-1");
    expect(updated.handle).toBe("R1.1");
  });

  /**
   * An update cannot move an element, so requiring it to restate the parent is
   * ceremony that only creates opportunities to state it wrong. The omission
   * has to be legal through the accepting schema, not just past the admission
   * check — an author who leaves the field out is writing the ordinary shape.
   */
  it("accepts an update that omits parentElementId, in both write paths", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    const updated = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      payload: criterion("Edited without restating containment."),
      baseElementVersion: nested.version.elementVersion,
      actor: ACTOR,
    });

    expect(updated.version.elementVersion).toBe(2);
    expect(updated.element.parentElementId).toBe("requirement-1");
    expect(updated.handle).toBe("R1.1");

    const batched = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "criterion-1",
          kind: "criterion",
          payload: criterion("Edited in a batch without restating it either."),
          baseElementVersion: 2,
        },
      ],
      actor: ACTOR,
    });

    expect(batched.ok).toBe(true);
    const stored = await storedElement(created.draft.id, "criterion-1");
    expect(stored?.element.parentElementId).toBe("requirement-1");
    expect(stored?.version.elementVersion).toBe(3);
  });

  /**
   * The mirror of the omission rule. A create is the one moment containment is
   * choosable, and `parent_immutable` makes the choice permanent, so a create
   * that leaves it out is refused rather than handed a silent default it could
   * only undo by removing the element.
   */
  it("refuses a create that states no parent, in both write paths", async () => {
    const created = await createDraft();

    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        kind: "criterion",
        payload: criterion("Born without stating what contains it."),
        baseElementVersion: null,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "validation",
      refusal: {
        instruction: expect.stringContaining("parentElementId"),
      },
    });

    const batched = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "criterion-2",
          kind: "criterion",
          payload: criterion("Born parentless inside a batch."),
          baseElementVersion: null,
        },
      ],
      actor: ACTOR,
    });

    expect(batched).toMatchObject({
      ok: false,
      refusals: [{ input: "element", index: 0, code: "validation" }],
    });
    expect(
      await storedElement(created.draft.id, "criterion-1"),
    ).toBeUndefined();
    expect(
      await storedElement(created.draft.id, "criterion-2"),
    ).toBeUndefined();
  });

  it("leaves the create branch alone", async () => {
    const created = await createDraft();

    // A create names the parent the element is born under; there is no stored
    // parent to contradict.
    const born = await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: criterion("Born under its requirement."),
      baseElementVersion: null,
      actor: ACTOR,
    });
    expect(born.handle).toBe("R1.1");

    // A create over an element the revision already carries stays a
    // stale-version conflict whatever parent it names.
    await expect(
      service.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: null,
        payload: criterion("A create over live content."),
        baseElementVersion: null,
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "stale_element" });
  });

  it("refuses the rehoming batch item by index and rolls the whole batch back", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "requirement-3",
          kind: "requirement",
          parentElementId: null,
          payload: requirement("A legal sibling in the same batch."),
          baseElementVersion: null,
        },
        {
          elementId: "criterion-1",
          kind: "criterion",
          parentElementId: "requirement-2",
          payload: criterion("Rehomed inside a batch."),
          baseElementVersion: nested.version.elementVersion,
        },
      ],
      actor: ACTOR,
    });

    expect(result).toMatchObject({
      ok: false,
      refusals: [
        {
          input: "element",
          index: 1,
          elementId: "criterion-1",
          code: "parent_immutable",
          details: {
            handle: "R1.1",
            currentParentElementId: "requirement-1",
            requestedParentElementId: "requirement-2",
          },
          rationale:
            "containment is identity: a moved element would retroactively change what every frozen revision contained",
        },
      ],
    });
    expect(
      await storedElement(created.draft.id, "requirement-3"),
    ).toBeUndefined();
    expect(
      (await storedElement(created.draft.id, "criterion-1"))?.version
        .elementVersion,
    ).toBe(1);
  });

  it("keeps an echoed parent legal inside a batch", async () => {
    const { created, nested } = await draftWithNestedCriterion();

    const result = await service.upsertDraftElements({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elements: [
        {
          elementId: "criterion-1",
          kind: "criterion",
          parentElementId: "requirement-1",
          payload: criterion("Edited inside a batch, under the same parent."),
          baseElementVersion: nested.version.elementVersion,
        },
      ],
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(
      (await storedElement(created.draft.id, "criterion-1"))?.version
        .elementVersion,
    ).toBe(2);
  });
});
